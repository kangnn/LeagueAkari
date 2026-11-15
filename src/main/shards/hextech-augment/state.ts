import type {
  HextechAugmentDiagnostics,
  HextechAugmentSnapshot
} from '@shared/types/hextech-augment'
import { makeAutoObservable, observableRef } from 'mobx'

export class HextechAugmentSettings {
  enabled = true
  constructor() {
    makeAutoObservable(this)
  }
}

export class HextechAugmentState {
  snapshot: HextechAugmentSnapshot | null = null
  diagnostics: HextechAugmentDiagnostics | null = null
  status:
    | 'waiting'
    | 'starting'
    | 'scanning'
    | 'cards'
    | 'unrecognized'
    | 'background'
    | 'error'
    | 'disabled' = 'waiting'
  error: string | null = null
  language: string | null = null
  constructor() {
    makeAutoObservable(this, { snapshot: observableRef, diagnostics: observableRef })
  }
}
