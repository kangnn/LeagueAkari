import type { ChampionAugment, ChampionDataDetails } from '@shared/data-adapter/champion-data'
import type { OcrFrame, RecognizedAugment } from '@shared/types/hextech-augment'
import { reaction, runInAction } from 'mobx'

import type { ChampionDataMain } from '../champion-data'
import type { LeagueClientMain } from '../league-client'
import type { AkariLogger } from '../logger-factory'
import type { AkariHextechAugmentWindow } from '../window-manager/hextech-augment-window/window'
import { recognizeAugmentCards } from './card-recognition'
import {
  RecognitionWorkerController,
  type RecognitionWorkerMessage
} from './recognition-worker-controller'
import type { HextechAugmentSettings, HextechAugmentState } from './state'

const MAX_FRAME_AGE_MS = 1200
const RATINGS_TTL_MS = 10 * 60 * 1000
const TIER_NAMES = ['S', 'A', 'B', 'C', 'D', 'E', 'F']

export class HextechAugmentOverlayController {
  private readonly _worker: RecognitionWorkerController
  private _disposeReaction: (() => void) | null = null
  private _timer: ReturnType<typeof setInterval> | null = null
  private _expiry: ReturnType<typeof setTimeout> | null = null
  private _ratingsAbort: AbortController | null = null
  private _championId = 0
  private _generation = 0
  private _details: ChampionDataDetails | null = null
  private _fetchedAt: number | null = null
  private _latest: { frame: OcrFrame; cards: RecognizedAugment[] } | null = null
  private _failed = false
  private _workerReady = false
  private _retryRatingsAt = 0

  constructor(
    private readonly _leagueClient: LeagueClientMain,
    private readonly _championData: ChampionDataMain,
    private readonly _window: AkariHextechAugmentWindow,
    private readonly _settings: HextechAugmentSettings,
    private readonly _state: HextechAugmentState,
    private readonly _logger: AkariLogger
  ) {
    this._worker = new RecognitionWorkerController((message) => this._handleMessage(message))
  }

  watch() {
    this._disposeReaction = reaction(
      () => {
        const session = this._leagueClient.data.gameflow.session
        const ownPuuid = this._leagueClient.data.summoner.me?.puuid
        const selections = session
          ? [
              ...session.gameData.playerChampionSelections,
              ...session.gameData.teamOne,
              ...session.gameData.teamTwo
            ]
          : []
        const championId = ownPuuid
          ? (selections.find(
              (selection) => selection.puuid === ownPuuid && selection.championId > 0
            )?.championId ?? 0)
          : 0
        return {
          enabled: this._settings.enabled,
          active:
            process.platform === 'win32' &&
            this._leagueClient.state.connectionState === 'connected' &&
            this._leagueClient.data.gameflow.phase === 'InProgress' &&
            (session?.gameData.queue.gameMode === 'KIWI' || session?.map.gameMode === 'KIWI'),
          championId,
          source: this._championData.settings.preferredSource,
          preferences: this._championData.settings.preferences
        }
      },
      ({ enabled, active, championId }) => {
        this._stop()
        if (!enabled || !active || !championId) {
          runInAction(() => {
            this._state.status = enabled ? 'waiting' : 'disabled'
          })
          return
        }
        this._championId = championId
        this._failed = false
        runInAction(() => {
          this._state.status = 'starting'
          this._state.error = null
        })
        this._worker.start()
        void this._loadRatings(this._generation, championId)
        this._timer = setInterval(() => {
          if (this._failed) return
          if (this._workerReady) this._worker.capture()
          if (
            !this._ratingsAbort &&
            Date.now() >= this._retryRatingsAt &&
            (!this._fetchedAt || Date.now() - this._fetchedAt > RATINGS_TTL_MS)
          ) {
            this._details = null
            this._publish()
            void this._loadRatings(this._generation, championId)
          }
        }, 350)
      },
      {
        fireImmediately: true,
        equals: (previous, next) =>
          previous.enabled === next.enabled &&
          previous.active === next.active &&
          previous.championId === next.championId &&
          previous.source === next.source &&
          previous.preferences === next.preferences
      }
    )
  }

  private _handleMessage(message: RecognitionWorkerMessage) {
    if (!this._championId || !this._settings.enabled) return
    if (message.type === 'ready') {
      this._workerReady = true
      runInAction(() => {
        this._state.language = message.language
        this._state.status = 'scanning'
      })
      this._worker.capture()
      return
    }
    if (message.type === 'error') {
      this._failed = true
      this._clear()
      runInAction(() => {
        this._state.status = 'error'
        this._state.error = message.message
      })
      this._logger.warn('Augment recognition unavailable', { message: message.message })
      this._worker.stop()
      return
    }
    if (message.type === 'hidden') {
      this._clear()
      runInAction(() => {
        this._state.status = 'background'
      })
      return
    }
    if (Date.now() - message.capturedAt > MAX_FRAME_AGE_MS) {
      this._clear()
      return
    }
    const cards = recognizeAugmentCards(
      message,
      Object.values(this._leagueClient.data.gameData.augments).map((augment) => ({
        id: augment.id,
        name: augment.nameTRA,
        augmentNameId: augment.augmentNameId
      }))
    )
    runInAction(() => {
      this._state.diagnostics = {
        capturedAt: message.capturedAt,
        elapsedMs: message.elapsedMs,
        wordCount: message.lines.reduce((count, line) => count + line.words.length, 0),
        dictionarySize: Object.keys(this._leagueClient.data.gameData.augments).length,
        matchedCards: cards.length
      }
    })
    if (cards.length !== 3) {
      this._clear()
      runInAction(() => {
        this._state.status = 'unrecognized'
      })
      return
    }
    // Always replace the whole selection. A rerolled card cannot retain a previous card's score.
    this._latest = { frame: message, cards }
    this._publish()
    if (this._expiry) clearTimeout(this._expiry)
    this._expiry = setTimeout(
      () => this._clear(),
      Math.max(0, MAX_FRAME_AGE_MS - (Date.now() - message.capturedAt))
    )
  }

  private async _loadRatings(generation: number, championId: number) {
    const abort = new AbortController()
    this._retryRatingsAt = Date.now() + 30000
    this._ratingsAbort = abort
    try {
      const preferences = this._championData.settings.preferences
      const result = await this._championData.loadDetails(
        { ...preferences, mode: 'aram_mayhem', position: 'none' },
        championId,
        { signal: abort.signal }
      )
      if (
        abort.signal.aborted ||
        generation !== this._generation ||
        championId !== this._championId
      )
        return
      this._details =
        result.status === 'success' && result.data.championId === championId ? result.data : null
      this._fetchedAt = this._details ? Date.now() : null
      this._publish()
    } catch (error) {
      if (!abort.signal.aborted)
        this._logger.warn(
          'Augment ratings unavailable',
          error instanceof Error ? error.message : String(error)
        )
    } finally {
      if (this._ratingsAbort === abort) this._ratingsAbort = null
    }
  }

  private _publish() {
    const latest = this._latest
    if (!latest || Date.now() - latest.frame.capturedAt > MAX_FRAME_AGE_MS) return
    const details =
      this._details &&
      this._details.championId === this._championId &&
      this._fetchedAt &&
      Date.now() - this._fetchedAt <= RATINGS_TTL_MS
        ? this._details
        : null
    const ratings = new Map<number, ChampionAugment>(
      (details?.sections.augments ?? []).map((augment) => [augment.augmentId, augment])
    )
    const snapshot = {
      championId: this._championId,
      capturedAt: latest.frame.capturedAt,
      recognitionMs: latest.frame.elapsedMs,
      source: details?.metadata.source ?? null,
      patch: details?.metadata.patch ?? null,
      fetchedAt: details ? this._fetchedAt : null,
      window: latest.frame.window,
      labels: latest.cards.map((card) => {
        const rating = ratings.get(card.id)
        return {
          ...card,
          tier:
            rating?.tier === null || rating?.tier === undefined
              ? null
              : (TIER_NAMES[rating.tier] ?? null),
          performance: rating?.performanceScore ?? null
        }
      })
    }
    runInAction(() => {
      this._state.snapshot = snapshot
      this._state.status = 'cards'
    })
    this._window.present(snapshot)
  }

  private _clear() {
    this._latest = null
    if (this._expiry) clearTimeout(this._expiry)
    this._expiry = null
    runInAction(() => {
      this._state.snapshot = null
      if (this._state.status === 'cards') this._state.status = 'scanning'
    })
    this._window.present(null)
  }

  private _stop() {
    this._generation += 1
    this._championId = 0
    this._workerReady = false
    this._worker.stop()
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this._ratingsAbort?.abort()
    this._ratingsAbort = null
    this._details = null
    this._fetchedAt = null
    this._retryRatingsAt = 0
    this._clear()
  }

  dispose() {
    this._disposeReaction?.()
    this._disposeReaction = null
    this._stop()
    this._window.close(true)
  }
}
