import { APP_DISTRIBUTION } from '@shared/distribution'

export function shouldRunSelfUpdateLifecycle(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return APP_DISTRIBUTION.officialUpdatesEnabled && platform === 'win32' && arch === 'x64'
}

export function shouldDownloadUpdateArchive(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return shouldRunSelfUpdateLifecycle(platform, arch)
}

export function shouldApplyDownloadedUpdate(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return shouldRunSelfUpdateLifecycle(platform, arch)
}

export function shouldLaunchUpdaterOnQuit(
  isPackaged: boolean,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return isPackaged && shouldApplyDownloadedUpdate(platform, arch)
}

export function shouldUninstallWithUpdater(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): boolean {
  return shouldRunSelfUpdateLifecycle(platform, arch)
}
