import type { HextechRoomEvent } from '@shared/types/hextech-room'
import type { LcuEvent } from '@shared/types/league-client/event'
import { type IReactionDisposer, reaction, runInAction } from 'mobx'

import type { LeagueClientMain } from '../league-client'
import type { AkariLogger } from '../logger-factory'
import { HextechLobbyApiProvider, handleHextechLobbyEvent } from './lobby-provider'
import { SearchController } from './search-controller'
import type { HextechRoomSettings, HextechRoomState } from './state'

export class HextechRoomSearchFlowController {
  readonly search: SearchController
  private _disposers: (() => void)[] = []
  private _busy = false
  private _commandGeneration = 0

  constructor(
    private readonly _leagueClient: LeagueClientMain,
    private readonly _settings: HextechRoomSettings,
    private readonly _state: HextechRoomState,
    private readonly _logger: AkariLogger
  ) {
    this.search = new SearchController(new HextechLobbyApiProvider(() => this._leagueClient.http), {
      emit: (event) => this._onEvent(event)
    })
  }

  watch() {
    this._disposers.push(
      reaction(
        () => this._settings.configuration,
        (configuration) => this.search.configure(configuration),
        { fireImmediately: true }
      ) as IReactionDisposer
    )
    this._disposers.push(
      reaction(
        () =>
          [
            this._leagueClient.state.connectionState,
            this._leagueClient.data.gameflow.phase
          ] as const,
        ([connection, phase]) => {
          this.search.watchPushConnected = connection === 'connected'
          if (connection !== 'connected' || (phase && !['None', 'Lobby'].includes(phase)))
            this.search.stop()
        },
        { fireImmediately: true }
      )
    )
    for (const uri of [
      '/lol-lobby/v1/custom-games',
      '/lol-lobby/v2/custom-games',
      '/lol-lobby/v1/custom-games/:id',
      '/lol-lobby/v2/custom-games/:id',
      '/lol-lobby/v2/lobby',
      '/lol-lobby/v1/lobby'
    ]) {
      this._disposers.push(
        this._leagueClient.events.on<LcuEvent<unknown>>(uri, (event) => {
          handleHextechLobbyEvent(this.search, event)
        })
      )
    }
    runInAction(() => {
      this._state.status = this.search.status()
    })
  }

  private _onEvent(event: HextechRoomEvent) {
    runInAction(() => {
      this._state.status = this.search.status()
      this._state.logs = [...this._state.logs.slice(-199), { ...event, timestamp: Date.now() }]
    })
    if (event.type === 'error') this._logger.warn('Room search failed', { message: event.message })
  }

  async command(command: 'start' | 'stop' | 'leave' | 'continue') {
    if (command === 'stop') {
      this._commandGeneration += 1
      this.search.stop()
      return this.search.status()
    }
    if (this._busy) throw new Error('A room operation is already in progress')
    if (this._leagueClient.state.connectionState !== 'connected')
      throw new Error('League Client is disconnected')
    if (
      this._leagueClient.data.gameflow.phase &&
      !['None', 'Lobby'].includes(this._leagueClient.data.gameflow.phase)
    )
      throw new Error('Room search is unavailable during a game')
    this._busy = true
    const generation = ++this._commandGeneration
    runInAction(() => {
      this._state.busy = true
    })
    try {
      if (command === 'leave' || command === 'continue') {
        const result = await this.search.leave()
        if (command === 'leave' || !result.left || generation !== this._commandGeneration)
          return result
      }
      await this.search.start()
      return this.search.status()
    } finally {
      this._busy = false
      runInAction(() => {
        this._state.busy = false
      })
    }
  }

  dispose() {
    this._commandGeneration += 1
    this.search.stop()
    this._disposers.splice(0).forEach((dispose) => dispose())
  }
}
