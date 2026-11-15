# Hextech fork development

This fork adds a sidebar room-search page and local recognition of the three offered Mayhem augments. The implementation uses Akari shards, the existing authenticated LCU connection, champion-data providers and WindowManager.

## Isolation

The custom app ID is `kangnn.league-akari-hextech`, executable is `LeagueAkariHextech.exe`, and user data is stored under `LeagueAkariHextech` in Electron's app-data directory. Custom protocol names are `league-akari-hextech` and `league-akari-hextech-dev`. The official binary updater is disabled so it cannot replace the fork with an official build.

## Upstream synchronization

`origin` is the personal fork; `upstream` is `https://github.com/LeagueAkari/LeagueAkari.git`. A fork does not automatically merge upstream changes. Commit or safely save local work first, then merge on the integration branch:

```powershell
git fetch upstream dev
git switch hextech-integration
git merge upstream/dev
```

Review conflicts in bootstrap, sidebar, routes and renderer/window registrations. Preserve both upstream fixes and custom features. If a merge is unfinished and cannot be resolved yet, `git merge --abort` returns to the pre-merge state. Do not force-push over either project's history.

Format touched files, run `yarn typecheck`, `yarn test`, `yarn build` and the Windows package smoke check. Recheck search cancellation/cooldowns and recognition after rerolls before pushing to `origin`. No automatic synchronization or automatic merge is configured.

## Local recognition

The Windows-only worker in `resources/hextech/recognize.ps1` uses the installed Windows OCR language model. It needs no remote OCR service. Only the foreground `League of Legends` client area is captured during an active KIWI game with a known current champion. Screenshots are processed in memory and are not uploaded or persisted by the worker.

Names must match the client's augment dictionary unambiguously and form three horizontally aligned, separated card slots. Uncertain or incomplete matches hide the overlay. Ratings use the current champion's existing champion-data provider and raw tier/performance data. Missing ratings remain missing. The in-game overlay shows only the tier and performance; source/patch information stays in the companion page.

The independent transparent window is non-focusable, mouse-through and protected from capture. Window coordinates are converted from physical pixels to Electron display coordinates. Images and tests alone do not prove real-game placement, exclusive-fullscreen support or recognition accuracy. These require real visible card selections, including rerolls and resolution/DPI changes.

For offline diagnostics, the worker supports `-ImagePath <local-image>` and emits JSON lines. This mode does not capture the desktop. Synthetic fixtures are for recognition regression, not proof of a real-game pass.

## Packaged verification (2026-11-16)

The Windows unpacked build launched and connected to the real League Client. A private, password-protected custom KIWI game (queue 3270) was created through the existing authenticated client. With Taliyah (163), the live 3840×2160 frame repeatedly recognized Inferno Trigger (2005), Wooglet's Witchcap (1156), and Jeweled Gauntlet (1048). The real OP.GG response produced D/72.94, A/86.87, and S/84.49. Recognition took 312–318 ms in the recorded samples. The provider supplied no patch version, so the UI correctly displayed version unknown.

The actual overlay renderer contained all three labels at the corresponding horizontal card centers. Electron reported the overlay visible, topmost and non-focusable, with 2560×1440 DIP bounds for the 3840×2160 physical display (150% scaling). Switching to the League Client cleared the snapshot and changed status to background. Capture protection excludes the overlay from game capture, so a game-only screenshot does not prove the overlay is absent.

The user reported that no ratings were visible in the game despite the renderer and window-state evidence above. The current game configuration is fullscreen (`WindowMode=0`). Borderless-mode comparison is pending; actual on-screen acceptance has **not** passed.

Real reroll/selection click-through verification remains pending: the elevated game did not accept the desktop automation clicks. A modal covering the middle card correctly caused incomplete recognition to hide all labels. Unit tests for reroll replacement are supplementary and do not substitute for that remaining real-game check. Other display resolutions and exclusive fullscreen remain unverified.

The cleaned app.asar contains 4,956 entries and no nested dist artifacts. Distribution staging excludes runtime logs. Build/type checks and the full 618-test suite passed before this packaged run; the recorded unit result is not a claim of complete in-game acceptance.

### Borderless visibility comparison

The disconnected test process was terminated with an administrator taskkill request and the private KIWI game was restarted with `General.WindowMode=2` through LCU. The running borderless client area was 1024×768. With Fiora (114), the production OCR/rating flow recognized Don't Blink (1026, A/102.54), Infernal Soul (1046, D/88.62), and Poltergeist (1347, D/83.58). A computer-use capture of the actual game composition visibly showed all three rating panels above the corresponding card names. This capture temporarily disabled only the custom overlay's capture protection for two seconds via the Electron inspector; restoration was scheduled in the same operation. Production code was unchanged. No synthetic labels or scores were injected.

This proves actual borderless composition for that test resolution. It does not prove exclusive-fullscreen support, physical 4K borderless placement, or reroll click-through. The elevated game still did not accept the desktop automation click, so the real reroll gate remains open. The original WindowMode=0 is recorded for restoration after the test.

### Lower-card layout reference

The [Huya official product page](https://lolgametool.huya.com/) illustrates a large tier letter in each card's lower area with a smaller statistic beneath it. It does not publish the internal recognition implementation. The fork follows that visual hierarchy, retaining its own provider's performance metric rather than presenting it as Huya's pick rate. Duplicate names and the source/version footer are omitted in game. Placement follows each OCR title's horizontal center and uses a client-height-relative offset into the lower blank area; typography scales with the overlay height. This is a calibrated picker layout, not detected card boundaries.

Public implementation references include [Hexsight](https://github.com/bard58/hexsight) (Windows OCR for the three offers) and [Paradox's badge window](https://github.com/Danielxpj/Paradox-LoL-Companion/blob/main/src/ParadoxLoLCompanion.App/AugmentBadgeWindow.xaml.cs) (transparent, topmost, no-activation, click-through positioning). These support the existing screen-recognition and separate-window approach. No third-party application was installed, and no source code or assets were copied from these projects. The layout remains independently implemented in the Akari Vue renderer. Borderless/windowed composition still needs to be distinguished from exclusive fullscreen support.

The rebuilt Windows package was launched in a fresh private KIWI game at 1024×768 borderless. Qiyana (246) produced Veil of Warding (1034, B/78.86), Blunt Force (1007, S/78.71), and Don't Blink (1026, C/81.88). The actual game-composition screenshot showed the large tier and smaller performance line in each lower blank area, clear of descriptions and reroll controls, without repeated names or a source/version footer. Capture protection was temporarily suspended for two seconds for this screenshot and restored. The recorded OCR frame took 245 ms. Build and both type checks passed. Reroll clicks, exclusive fullscreen and additional resolutions remain outside this visual pass. The temporary video-mode test setting was restored to the original WindowMode=0 through LCU and verified by a read-back; the verified overlay composition still requires Borderless/Windowed.
