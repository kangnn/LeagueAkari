import { Dep, IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import type { HextechRoomConfiguration } from '@shared/types/hextech-room'

import { AkariIpcRenderer } from '../ipc'
import { PiniaMobxUtilsRenderer } from '../pinia-mobx-utils'
import { SettingUtilsRenderer } from '../setting-utils'
import { useHextechRoomStore } from './store'

@Shard(HextechRoomRenderer.id)
export class HextechRoomRenderer implements IAkariShardInitDispose {
  static id = 'hextech-room-renderer'

  constructor(
    @Dep(AkariIpcRenderer) private readonly _ipc: AkariIpcRenderer,
    @Dep(PiniaMobxUtilsRenderer) private readonly _piniaMobxUtils: PiniaMobxUtilsRenderer,
    @Dep(SettingUtilsRenderer) private readonly _settingUtils: SettingUtilsRenderer
  ) {}

  async onInit() {
    const store = useHextechRoomStore()
    await this._piniaMobxUtils.sync('hextech-room-main', 'settings', store.settings)
    await this._piniaMobxUtils.sync('hextech-room-main', 'state', store)
  }

  command(command: 'start' | 'stop' | 'leave' | 'continue') {
    return this._ipc.call('hextech-room-main', command)
  }

  configure(configuration: HextechRoomConfiguration) {
    return this._settingUtils.set('hextech-room-main', 'configuration', configuration)
  }
}
