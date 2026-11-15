import type {
  ChampionDataDetails,
  ChampionDataLoadResult
} from '@shared/data-adapter/champion-data'
import type { OcrFrame } from '@shared/types/hextech-augment'
import { observable, runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HextechAugmentOverlayController } from './augment-overlay-controller'
import type { RecognitionWorkerMessage } from './recognition-worker-controller'
import { HextechAugmentSettings, HextechAugmentState } from './state'

const worker = vi.hoisted(() => ({
  send: null as null | ((message: RecognitionWorkerMessage) => void),
  stop: vi.fn()
}))
vi.mock('./recognition-worker-controller', () => ({
  RecognitionWorkerController: class {
    constructor(send: (message: RecognitionWorkerMessage) => void) {
      worker.send = send
    }
    start() {}
    capture() {}
    stop() {
      worker.stop()
    }
  }
}))

type Dependencies = ConstructorParameters<typeof HextechAugmentOverlayController>
const augmentNames = [
  { id: 1, nameTRA: '双重打击' },
  { id: 2, nameTRA: '针插垫' },
  { id: 3, nameTRA: '面包和黄油' },
  { id: 4, nameTRA: '珠光护手' }
]
function frame(ids = [1, 2, 3]): OcrFrame {
  return {
    type: 'frame',
    capturedAt: Date.now(),
    elapsedMs: 150,
    window: { id: 'game', x: 0, y: 0, width: 1600, height: 900 },
    lines: ids.map((id, slot) => ({
      words: [
        {
          text: augmentNames.find((augment) => augment.id === id)!.nameTRA,
          x: 180 + 480 * slot,
          y: 330,
          width: 140,
          height: 30
        }
      ]
    }))
  }
}

function ratings(championId = 1): ChampionDataLoadResult<ChampionDataDetails> {
  return {
    status: 'success',
    preferredSource: 'opgg',
    effectiveSource: 'opgg',
    fallbackReason: null,
    attempts: [],
    data: {
      metadata: {
        source: 'opgg',
        mode: 'aram_mayhem',
        patch: null,
        dataDate: null,
        updatedAt: null
      },
      championId,
      summary: {
        championId,
        position: 'none',
        counterChampionIds: [],
        performance: {
          games: null,
          wins: null,
          winRate: null,
          pickRate: null,
          banRate: null,
          kda: null,
          rank: null,
          rankChange: null,
          strengthTier: null,
          averagePlacement: null,
          firstPlaceRate: null
        }
      },
      sections: {
        augments: augmentNames.slice(0, 3).map((augment, tier) => ({
          augmentId: augment.id,
          tier,
          rank: null,
          rankChange: null,
          performanceScore: 50 + tier,
          popularity: null,
          bestChampionIds: [],
          performance: {
            games: null,
            wins: null,
            winRate: null,
            pickRate: null,
            rank: null,
            averagePlacement: null,
            firstPlaceRate: null
          }
        }))
      }
    }
  }
}

describe.skipIf(process.platform !== 'win32')('augment overlay state and async freshness', () => {
  const controllers: HextechAugmentOverlayController[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
  })
  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose())
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function setup(loadDetails = vi.fn().mockResolvedValue(ratings())) {
    const league = observable({
      state: { connectionState: 'connected' },
      data: {
        summoner: { me: { puuid: 'self' } },
        gameflow: {
          phase: 'InProgress',
          session: {
            gameData: {
              queue: { gameMode: 'KIWI' },
              playerChampionSelections: [{ puuid: 'self', championId: 1 }],
              teamOne: [],
              teamTwo: []
            },
            map: { gameMode: 'KIWI' }
          }
        },
        gameData: {
          augments: Object.fromEntries(augmentNames.map((augment) => [augment.id, augment]))
        }
      }
    })
    const championData = {
      settings: observable({
        preferredSource: 'opgg',
        preferences: { mode: 'ranked', region: 'global', tier: 'all', position: 'top' }
      }),
      loadDetails
    }
    const window = { present: vi.fn(), close: vi.fn() }
    const settings = new HextechAugmentSettings()
    const state = new HextechAugmentState()
    const controller = new HextechAugmentOverlayController(
      league as unknown as Dependencies[0],
      championData as unknown as Dependencies[1],
      window as unknown as Dependencies[2],
      settings,
      state,
      { warn: vi.fn() } as unknown as Dependencies[5]
    )
    controllers.push(controller)
    controller.watch()
    return { controller, league, settings, state, window, loadDetails }
  }

  it('shows champion-specific raw grades and leaves an unavailable patch unknown', async () => {
    const { state, loadDetails } = setup()
    await vi.advanceTimersByTimeAsync(0)
    worker.send!(frame())
    expect(state.snapshot?.labels.map((label) => label.tier)).toEqual(['S', 'A', 'B'])
    expect(state.snapshot).toMatchObject({ championId: 1, patch: null, source: 'opgg' })
    expect(loadDetails).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'aram_mayhem' }),
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('clears the previous rating when a card is rerolled to an unrated augment', async () => {
    const { state } = setup()
    await vi.advanceTimersByTimeAsync(0)
    worker.send!(frame())
    worker.send!(frame([1, 4, 3]))
    expect(state.snapshot?.labels[1]).toMatchObject({ id: 4, tier: null, performance: null })
  })

  it('hides unrecognized selections and expires a frame when capture stalls', async () => {
    const { state, window } = setup()
    await vi.advanceTimersByTimeAsync(0)
    worker.send!(frame())
    await vi.advanceTimersByTimeAsync(1201)
    expect(state.snapshot).toBeNull()
    expect(window.present).toHaveBeenLastCalledWith(null)
    worker.send!(frame())
    const incomplete = frame()
    incomplete.lines.pop()
    worker.send!(incomplete)
    expect(state.snapshot).toBeNull()
  })

  it('cannot publish a late data response after the champion context changes', async () => {
    let resolve!: (value: ChampionDataLoadResult<ChampionDataDetails>) => void
    const load = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      .mockResolvedValue(ratings(2))
    const { league, state } = setup(load)
    worker.send!(frame())
    runInAction(() => {
      league.data.gameflow.session.gameData.playerChampionSelections[0].championId = 2
    })
    await vi.advanceTimersByTimeAsync(0)
    resolve(ratings(1))
    await vi.advanceTimersByTimeAsync(0)
    worker.send!(frame())
    expect(state.snapshot?.championId).toBe(2)
    expect(state.snapshot?.labels[0].tier).toBe('S')
  })

  it('rejects wrong-champion data and stops immediately when disabled or backgrounded', async () => {
    const { settings, state, window } = setup(vi.fn().mockResolvedValue(ratings(99)))
    await vi.advanceTimersByTimeAsync(0)
    worker.send!(frame())
    expect(state.snapshot?.labels.every((label) => label.tier === null)).toBe(true)
    worker.send!({ type: 'hidden' })
    expect(state.snapshot).toBeNull()
    runInAction(() => {
      settings.enabled = false
    })
    expect(state.status).toBe('disabled')
    expect(window.present).toHaveBeenLastCalledWith(null)
    expect(worker.stop).toHaveBeenCalled()
  })
})
