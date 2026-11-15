import type {
  HextechRoomConfiguration,
  HextechRoomLog,
  HextechRoomStatus
} from '@shared/types/hextech-room'
import { makeAutoObservable, observableRef } from 'mobx'

export class HextechRoomSettings {
  configuration: HextechRoomConfiguration = {
    pollIntervalMs: 2000,
    minPlayers: 5,
    maxInvites: 50,
    nameKeywords: ['10钢'],
    stallTimeoutMs: 30000
  }

  constructor() {
    makeAutoObservable(this, { configuration: observableRef })
  }
}

export class HextechRoomState {
  status: HextechRoomStatus | null = null
  logs: HextechRoomLog[] = []
  busy = false

  constructor() {
    makeAutoObservable(this, { status: observableRef, logs: observableRef })
  }
}
