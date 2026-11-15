import type {
  HextechAugmentDiagnostics,
  HextechAugmentSnapshot
} from '@shared/types/hextech-augment'
import { defineStore } from 'pinia'
import { shallowReactive, shallowRef } from 'vue'

export const useHextechAugmentStore = defineStore('shard:hextech-augment-renderer', () => {
  const settings = shallowReactive({ enabled: true })
  const snapshot = shallowRef<HextechAugmentSnapshot | null>(null)
  const diagnostics = shallowRef<HextechAugmentDiagnostics | null>(null)
  const status = shallowRef('waiting')
  const error = shallowRef<string | null>(null)
  const language = shallowRef<string | null>(null)
  return { settings, snapshot, diagnostics, status, error, language }
})
