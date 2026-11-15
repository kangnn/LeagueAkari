import { i18next } from '@main/i18n'
import type {
  HextechLobby,
  HextechLobbyProvider,
  HextechRoomError,
  HextechRoomEvent
} from '@shared/types/hextech-room'
import fs from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'

import { DEFAULT_POLICY, evaluateJoinedLobby, evaluateLobby } from './eligibility'
import {
  HextechLobbyApiProvider,
  normalizeBrowserLobby,
  normalizeJoinedLobby
} from './lobby-provider'
import { SearchController } from './search-controller'

vi.mock('@main/i18n', async () => ({ i18next: (await import('i18next')).default }))

beforeAll(async () => {
  await i18next.init({
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    defaultNS: 'main',
    resources: {
      en: { main: YAML.parse(fs.readFileSync('src/shared/i18n/en/main.yaml', 'utf8')) },
      'zh-CN': { main: YAML.parse(fs.readFileSync('src/shared/i18n/zh-CN/main.yaml', 'utf8')) }
    }
  })
})

const candidate = (id = 'room', players = 2): HextechLobby => ({
  id,
  mapId: 12,
  maxHumanPlayers: 10,
  playerCount: players,
  requiresPassword: false,
  joinable: true
})
const joined = (id = 'room', players = 3, invites = 0): HextechLobby => ({
  ...candidate(id, players),
  joined: true,
  gameMode: 'KIWI',
  inviteCount: invites
})

class Provider implements HextechLobbyProvider {
  rows = [candidate()]
  room: HextechLobby | undefined
  joins: string[] = []
  left = 0
  listReads = 0
  joinFailure?: HextechRoomError
  currentPlayers = 3
  async currentLobby() {
    return this.room
  }
  async listLobbies() {
    this.listReads += 1
    return this.rows
  }
  async joinLobby(id: string) {
    this.joins.push(id)
    if (this.joinFailure) throw this.joinFailure
    this.room = joined(id, this.currentPlayers)
  }
  async leaveLobby() {
    this.left += 1
    this.room = undefined
  }
}

describe('migrated room search behavior', () => {
  const controllers: SearchController[] = []
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))
  })
  afterEach(() => {
    controllers.forEach((controller) => controller.stop())
    controllers.length = 0
    vi.useRealTimers()
  })
  function search(
    provider: Provider,
    options: ConstructorParameters<typeof SearchController>[1] = {}
  ) {
    const controller = new SearchController(provider, { attemptGapMs: 0, ...options })
    controllers.push(controller)
    return controller
  }

  it('probes stale small browser counts and verifies real membership', async () => {
    const provider = new Provider()
    provider.currentPlayers = 8
    const controller = search(provider)
    await controller.start()
    expect(provider.joins).toEqual(['room'])
    expect(controller.status()).toMatchObject({ state: 'joined', belowFloor: false })
    expect(provider.left).toBe(0)
  })

  it('cools a small room for ten seconds when the configured wait is zero', async () => {
    const provider = new Provider()
    const controller = search(provider, { stallTimeoutMs: 0, intervalMs: 500 })
    await controller.start()
    expect(provider.left).toBe(1)
    await vi.advanceTimersByTimeAsync(9500)
    expect(provider.joins).toEqual(['room'])
    expect(controller.status()).toMatchObject({ cooldownCount: 1, sweepCount: 1 })
    await vi.advanceTimersByTimeAsync(500)
    expect(provider.joins).toEqual(['room', 'room'])
  })

  it('wakes population cooldown only when growth can meet the floor including ourselves', async () => {
    const provider = new Provider()
    const controller = search(provider, { stallTimeoutMs: 0 })
    await controller.start()
    provider.rows = [candidate('room', 3)]
    controller.acceptLobbyListPush(provider.rows)
    await vi.advanceTimersByTimeAsync(200)
    expect(provider.joins).toHaveLength(1)
    provider.rows = [candidate('room', 4)]
    provider.currentPlayers = 5
    controller.acceptLobbyListPush(provider.rows)
    await vi.advanceTimersByTimeAsync(200)
    expect(provider.joins).toHaveLength(2)
    expect(controller.state).toBe('joined')
  })

  it('does not wake an explicit invitation-limit refusal just because the room grows', async () => {
    const provider = new Provider()
    provider.joinFailure = Object.assign(new Error('PARTY_INVITE_LIMIT'), {
      skip: true,
      status: 400
    })
    const controller = search(provider)
    await controller.start()
    provider.rows = [candidate('room', 9)]
    controller.acceptLobbyListPush(provider.rows)
    await vi.advanceTimersByTimeAsync(20000)
    expect(provider.joins).toHaveLength(1)
  })

  it('tries a new room immediately while unchanged failures are backing off', async () => {
    const provider = new Provider()
    provider.joinFailure = Object.assign(new Error('busy'), { skip: true, status: 400 })
    const controller = search(provider)
    await controller.start()
    provider.rows = [candidate(), candidate('new', 8)]
    controller.acceptLobbyListPush(provider.rows)
    await vi.advanceTimersByTimeAsync(200)
    expect(provider.joins).toEqual(['room', 'new'])
  })

  it('coalesces duplicate snapshots without repeated join attempts', async () => {
    const provider = new Provider()
    provider.joinFailure = Object.assign(new Error('busy'), { skip: true })
    const controller = search(provider)
    await controller.start()
    for (let index = 0; index < 50; index++) controller.acceptLobbyListPush(provider.rows)
    await vi.advanceTimersByTimeAsync(200)
    expect(provider.joins).toHaveLength(1)
  })

  it('never abandons a room the user entered manually when population stalls', async () => {
    const provider = new Provider()
    provider.room = joined()
    const controller = search(provider, { stallTimeoutMs: 1000 })
    await controller.start()
    await vi.advanceTimersByTimeAsync(1500)
    expect(provider.left).toBe(0)
    expect(controller.running).toBe(false)
  })

  it('never leaves a manually entered room when its invitations become exhausted', async () => {
    const provider = new Provider()
    provider.room = joined()
    const controller = search(provider, { stallTimeoutMs: 1000 })
    await controller.start()
    provider.room = joined('room', 3, 50)
    controller.acceptLobbyPush(provider.room)
    await vi.advanceTimersByTimeAsync(1500)
    expect(provider.left).toBe(0)
    expect(controller.running).toBe(false)
  })

  it('ignores a list response that arrives after stop', async () => {
    const provider = new Provider()
    let resolve!: (rows: HextechLobby[]) => void
    provider.listLobbies = () =>
      new Promise((done) => {
        resolve = done
      })
    const controller = search(provider)
    const started = controller.start()
    await vi.advanceTimersByTimeAsync(0)
    controller.stop()
    resolve(provider.rows)
    await started
    expect(provider.joins).toHaveLength(0)
    expect(controller.state).toBe('idle')
  })

  it('reports a failed leave so continue cannot silently re-adopt the room', async () => {
    const provider = new Provider()
    const events: HextechRoomEvent[] = []
    const controller = search(provider, { emit: (event) => events.push(event) })
    await controller.start()
    provider.leaveLobby = async () => {
      throw new Error('client busy')
    }
    expect(await controller.leave()).toMatchObject({ left: false, lastError: 'client busy' })
    expect(events.at(-1)?.type).toBe('error')
  })

  it('uses the selected app language for rejection explanations and room details', async () => {
    const previousLanguage = i18next.language
    try {
      for (const [language, explanation, roomDetails] of [
        ['zh-CN', '邀请名额已满（上限 50），无法加入', '2/10 人'],
        ['en', 'Cannot join; invitation capacity is full (limit 50)', 'Players 2/10']
      ]) {
        await i18next.changeLanguage(language)
        const provider = new Provider()
        provider.joinFailure = Object.assign(new Error('PARTY_INVITE_LIMIT'), { skip: true })
        const events: HextechRoomEvent[] = []
        const controller = search(provider, { emit: (event) => events.push(event) })
        await controller.start()
        const rejected = events.find((event) => event.type === 'skipped')
        expect(rejected?.message).toBe(explanation)
        expect(rejected?.selectedSummary).toContain(roomDetails)
        controller.stop()
      }
    } finally {
      await i18next.changeLanguage(previousLanguage)
    }
  })
})

describe('LCU lobby adaptation', () => {
  it('distinguishes player capacity and reserved spectator seats', () => {
    const lobby = normalizeJoinedLobby({
      partyId: 'room',
      gameConfig: { mapId: 12, gameMode: 'KIWI', maxLobbySize: 14, spectatorPolicy: 'AllAllowed' },
      members: [{}, {}, { isSpectator: true }]
    })
    expect(lobby).toMatchObject({
      playerCount: 2,
      maxHumanPlayers: 10,
      spectatorCount: 1,
      maxSpectators: 4
    })
    expect(evaluateJoinedLobby(lobby).eligible).toBe(true)
  })

  it('rejects unknown passwords but keeps stale low populations eligible for one probe', () => {
    const raw = { partyId: 'room', mapId: 12, maxPlayerSlots: 10, filledPlayerSlots: 1 }
    expect(evaluateLobby(normalizeBrowserLobby(raw)).eligible).toBe(false)
    expect(
      evaluateLobby(normalizeBrowserLobby({ ...raw, hasPassword: false }), DEFAULT_POLICY).eligible
    ).toBe(true)
  })

  it('uses the authenticated client, falls back only on missing endpoints, and forwards cancellation', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, data: {} })
      .mockResolvedValueOnce({ status: 200, data: [{ partyId: 'room', filledPlayerSlots: 2 }] })
    const provider = new HextechLobbyApiProvider(
      () =>
        ({ request }) as unknown as ReturnType<
          ConstructorParameters<typeof HextechLobbyApiProvider>[0]
        >
    )
    const abort = new AbortController()
    expect(await provider.listLobbies({ signal: abort.signal })).toHaveLength(1)
    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: '/lol-lobby/v1/custom-games', signal: abort.signal })
    )
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: '/lol-lobby/v2/custom-games' })
    )
    request.mockResolvedValueOnce({ status: 401, data: { message: 'expired' } })
    await expect(provider.listLobbies()).rejects.toMatchObject({ fatal: true, status: 401 })
    expect(request).toHaveBeenCalledTimes(3)
  })
})
