import { describe, expect, test } from 'vitest'

import {
  shouldApplyDownloadedUpdate,
  shouldDownloadUpdateArchive,
  shouldLaunchUpdaterOnQuit,
  shouldRunSelfUpdateLifecycle,
  shouldUninstallWithUpdater
} from './platform'

describe('self-update platform guards', () => {
  test('prevents the fork from downloading or applying official binaries on every platform', () => {
    expect(shouldDownloadUpdateArchive('win32', 'x64')).toBe(false)
    expect(shouldApplyDownloadedUpdate('win32', 'x64')).toBe(false)
    expect(shouldRunSelfUpdateLifecycle('win32', 'x64')).toBe(false)
    expect(shouldUninstallWithUpdater('win32', 'x64')).toBe(false)

    expect(shouldDownloadUpdateArchive('win32', 'arm64')).toBe(false)
    expect(shouldApplyDownloadedUpdate('darwin', 'x64')).toBe(false)
    expect(shouldRunSelfUpdateLifecycle('darwin', 'arm64')).toBe(false)
    expect(shouldUninstallWithUpdater('darwin', 'x64')).toBe(false)

    expect(shouldDownloadUpdateArchive('linux', 'x64')).toBe(false)
    expect(shouldApplyDownloadedUpdate('linux', 'x64')).toBe(false)
    expect(shouldRunSelfUpdateLifecycle('linux', 'x64')).toBe(false)
    expect(shouldUninstallWithUpdater('linux', 'x64')).toBe(false)
  })

  test('never launches the official updater on quit from the fork', () => {
    expect(shouldLaunchUpdaterOnQuit(true, 'win32', 'x64')).toBe(false)
    expect(shouldLaunchUpdaterOnQuit(false, 'win32', 'x64')).toBe(false)
    expect(shouldLaunchUpdaterOnQuit(true, 'win32', 'arm64')).toBe(false)
    expect(shouldLaunchUpdaterOnQuit(true, 'darwin', 'x64')).toBe(false)
    expect(shouldLaunchUpdaterOnQuit(true, 'linux', 'x64')).toBe(false)
  })
})
