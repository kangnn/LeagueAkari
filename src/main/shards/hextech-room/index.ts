import { IAkariShardInitDispose, Shard } from '@shared/akari-shard'
import { z } from 'zod'

import { AkariIpcMain } from '../ipc'
import { LeagueClientMain } from '../league-client'
import { LoggerFactoryMain } from '../logger-factory'
import { MobxUtilsMain } from '../mobx-utils'
import { SettingFactoryMain } from '../setting-factory'
import type { SetterSettingService } from '../setting-factory/setter-setting-service'
import { HextechRoomSearchFlowController } from './search-flow-controller'
import { HextechRoomSettings, HextechRoomState } from './state'

@Shard(HextechRoomMain.id)
export class HextechRoomMain implements IAkariShardInitDispose {
  static id = 'hextech-room-main'
  readonly settings = new HextechRoomSettings()
  readonly state = new HextechRoomState()
  private readonly _settingService: SetterSettingService<HextechRoomSettings>
  private readonly _controller: HextechRoomSearchFlowController

  constructor(
    private readonly _ipc: AkariIpcMain,
    private readonly _mobxUtils: MobxUtilsMain,
    _leagueClient: LeagueClientMain,
    _loggerFactory: LoggerFactoryMain,
    _settingFactory: SettingFactoryMain
  ) {
    this._settingService = _settingFactory.register(
      HextechRoomMain.id,
      {
        configuration: {
          default: this.settings.configuration,
          schema: z.object({
            pollIntervalMs: z.number().int().min(500).max(30000),
            minPlayers: z.number().int().min(0).max(10),
            maxInvites: z.number().int().min(0).max(50),
            nameKeywords: z.array(z.string().trim().min(1).max(100)).max(20),
            stallTimeoutMs: z.number().int().min(0).max(300000)
          })
        }
      },
      this.settings
    )
    this._controller = new HextechRoomSearchFlowController(
      _leagueClient,
      this.settings,
      this.state,
      _loggerFactory.create(HextechRoomMain.id)
    )
  }

  async onInit() {
    await this._settingService.applyToState()
    this._mobxUtils.propSync(HextechRoomMain.id, 'state', this.state, ['status', 'logs', 'busy'])
    this._mobxUtils.propSync(HextechRoomMain.id, 'settings', this.settings, ['configuration'])
    for (const command of ['start', 'stop', 'leave', 'continue'] as const) {
      this._ipc.onCall(HextechRoomMain.id, command, () => this._controller.command(command))
    }
    this._controller.watch()
  }

  async onDispose() {
    this._controller.dispose()
  }
}
