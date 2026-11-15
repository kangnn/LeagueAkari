import 'reflect-metadata'

import { APP_DISTRIBUTION } from '@shared/distribution'
import { app } from 'electron'
import path from 'node:path'

import { bootstrap } from './bootstrap'

app.setName(APP_DISTRIBUTION.name)
app.setPath('userData', path.join(app.getPath('appData'), APP_DISTRIBUTION.dataDirectory))

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_DISTRIBUTION.id)
}

const gotTheLock = app.requestSingleInstanceLock()

if (gotTheLock) {
  bootstrap()
} else {
  app.quit()
}
