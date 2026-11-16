import type {
  HextechRoomConfiguration,
  HextechRoomLog,
  HextechRoomStatus
} from '@shared/types/hextech-room'
import { defineStore } from 'pinia'
import { shallowReactive, shallowRef } from 'vue'

export const useHextechRoomStore = defineStore('shard:hextech-room-renderer', () => {
  const settings = shallowReactive({
    configuration: {
      pollIntervalMs: 2000,
      minPlayers: 5,
      maxInvites: 50,
      nameKeywords: ['10钢'],
      stallTimeoutMs: 30000
    } as HextechRoomConfiguration
  })
  const status = shallowRef<HextechRoomStatus | null>(null)
  const logs = shallowRef<HextechRoomLog[]>([])
  const busy = shallowRef(false)
  return { settings, status, logs, busy }
})
