param([string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
    $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
}
function Write-Result($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Compress -Depth 12)) }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HextechWindow {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref Point point);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { Write-Result @{ type = 'error'; message = 'No Windows OCR language model is installed' }; exit 2 }
$languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
Write-Result @{ type = 'ready'; languages = $languages; language = $engine.RecognizerLanguage.LanguageTag }

function Recognize-Frame {
    $bitmap = $null; $graphics = $null; $memory = $null; $stream = $null; $writer = $null; $software = $null
    $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
        $left = 0; $top = 0; $handle = [IntPtr]::Zero
        if ($ImagePath) {
            $bitmap = New-Object System.Drawing.Bitmap($ImagePath)
        } else {
            $handle = [HextechWindow]::GetForegroundWindow()
            $processNumber = [uint32]0
            $null = [HextechWindow]::GetWindowThreadProcessId($handle, [ref]$processNumber)
            $process = Get-Process -Id $processNumber -ErrorAction SilentlyContinue
            if (-not $process -or $process.ProcessName -ne 'League of Legends' -or [HextechWindow]::IsIconic($handle)) { Write-Result @{ type = 'hidden'; capturedAt = $startedAt }; return }
            $previousContext = [HextechWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
            try {
                $rect = New-Object HextechWindow+Rect
                $point = New-Object HextechWindow+Point
                if (-not [HextechWindow]::GetClientRect($handle, [ref]$rect) -or -not [HextechWindow]::ClientToScreen($handle, [ref]$point)) { throw 'Cannot locate the game client area' }
                $left = $point.X; $top = $point.Y
                $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
                if ($width -lt 640 -or $height -lt 360) { Write-Result @{ type = 'hidden'; capturedAt = $startedAt }; return }
                $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                $graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
                $graphics.Dispose(); $graphics = $null
            } finally { if ($previousContext -ne [IntPtr]::Zero) { $null = [HextechWindow]::SetThreadDpiAwarenessContext($previousContext) } }
        }
        $width = $bitmap.Width; $height = $bitmap.Height
        # Limit OCR work on very large monitors; coordinates are mapped back to physical pixels.
        $scale = [Math]::Min(1.5, [Math]::Min(1920.0 / $width, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension / [double][Math]::Max($width, $height)))
        if ($scale -ne 1) {
            $scaled = New-Object System.Drawing.Bitmap($bitmap, [int]($width * $scale), [int]($height * $scale))
            $bitmap.Dispose(); $bitmap = $scaled
        }
        $memory = New-Object System.IO.MemoryStream
        $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
        $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
        $writer = New-Object Windows.Storage.Streams.DataWriter($stream)
        $writer.WriteBytes($memory.ToArray())
        $null = Await-Operation ($writer.StoreAsync()) ([uint32])
        $writer.DetachStream() | Out-Null
        $stream.Seek(0)
        $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $software = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await-Operation ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
        $lines = @($result.Lines | ForEach-Object {
            @{ words = @($_.Words | ForEach-Object {
                @{ text = $_.Text; x = $_.BoundingRect.X / $scale; y = $_.BoundingRect.Y / $scale; width = $_.BoundingRect.Width / $scale; height = $_.BoundingRect.Height / $scale }
            }) }
        })
        Write-Result @{ type = 'frame'; capturedAt = $startedAt; elapsedMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $startedAt; window = @{ id = $handle.ToInt64().ToString(); x = $left; y = $top; width = $width; height = $height }; lines = $lines }
    } catch { Write-Result @{ type = 'error'; message = $_.Exception.Message; capturedAt = $startedAt } }
    finally {
        foreach ($resource in @($software, $writer, $stream, $memory, $graphics, $bitmap)) { if ($null -ne $resource) { $resource.Dispose() } }
    }
}

if ($ImagePath) { Recognize-Frame; exit }
while ($null -ne ($line = [Console]::ReadLine())) {
    try { $command = $line | ConvertFrom-Json; if ($command.type -eq 'capture') { Recognize-Frame } } catch { Write-Result @{ type = 'error'; message = $_.Exception.Message } }
}
