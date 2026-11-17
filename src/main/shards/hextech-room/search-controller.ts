import { i18next } from '@main/i18n'
import {
  type HextechLobby,
  type HextechLobbyProvider,
  type HextechRoomConfiguration,
  type HextechRoomError,
  type HextechRoomEvent,
  type HextechRoomPhase,
  type HextechRoomPolicy,
  type HextechRoomStatus,
  asHextechRoomError
} from '@shared/types/hextech-room'

import {
  DEFAULT_POLICY,
  evaluateJoinedLobby,
  isInviteBudgetExhausted,
  rankLobbies,
  summarizeLobby
} from './eligibility'

interface SearchOptions {
  policy?: HextechRoomPolicy
  intervalMs?: number
  maxIntervalMs?: number
  sweepIntervalMs?: number
  maxSweepIntervalMs?: number
  refreshThrottleMs?: number
  exhaustedCooldownMs?: number
  populationCooldownMs?: number
  stallTimeoutMs?: number
  inviteLimitCooldownMs?: number
  watchIntervalFloorMs?: number
  attemptGapMs?: number
  pushDebounceMs?: number
  maxAttemptsPerSweep?: number
  clock?: () => number
  emit?: (event: HextechRoomEvent) => void
}

interface ParkedRoom {
  playerCount: number
  reason?: string
  minPlayers: number
  expiresAt: number
}

export const STATES = Object.freeze({
  idle: 'idle',
  connecting: 'connecting',
  searching: 'searching',
  joining: 'joining',
  verifying: 'verifying',
  joined: 'joined'
})

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// Browser ordering is cosmetic. Only fields used to select a room may wake a backed-off sweep.
function listSignature(lobbies: HextechLobby[]) {
  return JSON.stringify(
    lobbies
      .map((lobby) =>
        JSON.stringify([
          lobby.id,
          lobby.name,
          lobby.mapId,
          lobby.maxHumanPlayers,
          lobby.playerCount,
          lobby.requiresPassword,
          lobby.joinable,
          lobby.gameMode,
          lobby.gameMutator,
          lobby.displayName
        ])
      )
      .sort()
  )
}

function describeReason(reason?: string) {
  return i18next.t(`hextech-room-main.reasons.${reason}`, { defaultValue: String(reason) })
}

/** Join rejections with a room cooldown, or a client-busy response retried next sweep. */
const SKIP_RULES: Readonly<Record<string, { reason: string; park?: string; message: string }>> =
  Object.freeze({
    PARTY_INVITE_LIMIT: {
      reason: 'invite-limit',
      park: 'long',
      message: 'invite-limit'
    },
    PARTY_SIZE_LIMIT: {
      reason: 'not-joinable',
      park: 'long',
      message: 'room-full'
    },
    INVALID_ROLE_TRANSITION: {
      reason: 'not-joinable',
      park: 'long',
      message: 'role-conflict'
    },
    INVALID_GAME_VERSION: {
      reason: 'not-joinable',
      park: 'short',
      message: 'version-mismatch'
    },
    INVALID_WHILE_PARTY_IN_ACTION: {
      reason: 'not-joinable',
      park: undefined,
      message: 'client-busy'
    }
  })

/**
 * The code that explains an LCU rejection. `errorCode` is only the wrapper the client puts around
 * it ("RPC_ERROR"), so the body message the provider kept aside is matched as well - and the raw
 * message is matched too, because a build that reports the code only in the text must not regress
 * to a guess.
 */
function rejectionCode(error: HextechRoomError) {
  const blob =
    `${error?.errorCode ?? ''} ${error?.detailCode ?? ''} ${error?.message ?? ''}`.toUpperCase()
  return Object.keys(SKIP_RULES).find((code) => blob.includes(code))
}

/**
 * A rejection with no rule of its own still deserves a sentence: the code is the answer, and the
 * request line it arrived in is diagnostic detail for a bug report, not something to show instead.
 */
function describeRejection(error: HextechRoomError) {
  const code = error?.detailCode ?? error?.errorCode
  return code ? i18next.t('hextech-room-main.join-rejected', { code }) : describe(error)
}

export class SearchController {
  private _running = false
  private _timer: ReturnType<typeof setTimeout> | undefined = undefined
  private _delayMs: number
  private _state: HextechRoomPhase = STATES.idle
  private _abort: AbortController | undefined
  private _lastRefreshAt: number | undefined
  private _candidateCount = 0
  // How many of those rows survived the filters (map, password, full, name keywords). The raw list is
  // mostly other maps and rooms that have nothing to do with this search, so the two numbers are only
  // meaningful together.
  private _eligibleCount = 0
  private _selected: HextechLobby | undefined
  private _lastError: string | undefined
  // Lobby ids rejected during the current sweep. Cleared once a sweep is exhausted so the next
  // sweep retries them against a freshly fetched list.
  private _rejectedThisSweep = new Set<string>()
  // Rooms this run left because their invitation budget was spent while they were still too small.
  // A spent budget never refills, so the room is only re-entered once the browser shows a bigger
  // room than the one that was abandoned, or after the cooldown - otherwise the search would join
  // and leave the same hopeless room on every sweep.
  private _exhaustedRooms = new Map<string, ParkedRoom>()
  // Player counts of the newest browser snapshot, keyed by room id. Replaced on every sweep.
  private _snapshotCounts = new Map<string, number>()
  private _sweepDelayMs: number
  private _sweepCount = 0
  private _lastForcedRefreshAt = Number.NEGATIVE_INFINITY
  private _refreshInFlight = false
  private _cycleTask: { signal: AbortSignal } | undefined
  private _listPushTimer: ReturnType<typeof setTimeout> | undefined
  private _pendingList: HextechLobby[] | undefined
  private _hasPendingList = false
  private _listSignature: string | undefined
  private _nextSearchAt = 0
  private _retryAt = 0
  private _attemptedSnapshots = new Map<string, string>()
  private _cooldownCount = 0
  private _nextRoomRetryAt: number | undefined
  private _watchTask: { signal: AbortSignal } | undefined
  private _pendingWatch: { lobby?: HextechLobby } | undefined
  // A joined room is watched until it fills, spends its invitation budget, or stops growing below the
  // player floor. `_adoptedRoom` marks the one exception: a room the user was already in is watched the
  // same way but never vacated by the tool.
  private _watchJoined = false
  private _watchingSummary: string | undefined
  // Progress of the watched room: a room that keeps gaining players is never abandoned, while one
  // that sits below the player floor without growing is left again after `stallTimeoutMs`.
  private _watchPlayerCount = 0
  private _watchProgressAt = 0
  // Whether the watched room is currently under the player floor, and when it will be given up on.
  // Surfaced through `status()` so the UI can explain a wait instead of looking stuck.
  private _belowFloor = false
  private _watchDeadlineAt: number | undefined
  // Cadence for the watch loop while reads keep failing; 0 means "use the normal poll interval".
  private _watchDelayMs = 0
  // Trailing debounce for WebSocket lobby pushes, so a burst of client events coalesces into one
  // watch run instead of one run per event.
  private _pushTimer: ReturnType<typeof setTimeout> | undefined = undefined
  // A room the user was already sitting in when the search started. It is watched under the same rules
  // as a joined one, but never left automatically, because the tool did not put the user there.
  private _adoptedRoom = false
  // Distinct rooms whose join was refused with INVALID_GAME_VERSION, and whether that cluster has
  // already been reported. One mismatched room is the room's problem; several are the client's.
  private _versionMismatchRooms = new Set<string>()
  private _versionMismatchWarned = false

  intervalMs: number
  maxIntervalMs: number
  sweepIntervalMs: number
  maxSweepIntervalMs: number
  refreshThrottleMs: number
  exhaustedCooldownMs: number
  populationCooldownMs: number
  stallTimeoutMs: number
  inviteLimitCooldownMs: number
  watchIntervalFloorMs: number
  attemptGapMs: number
  pushDebounceMs: number
  maxAttemptsPerSweep: number
  policy: HextechRoomPolicy
  clock: () => number
  emit: (event: HextechRoomEvent) => void

  constructor(
    public readonly provider: HextechLobbyProvider,
    {
      policy = DEFAULT_POLICY,
      intervalMs = 2_000,
      maxIntervalMs = 15_000,
      // A sweep is one full pass over the current list. When a sweep is exhausted the list is
      // re-fetched and the pass repeats after `sweepIntervalMs`, backing off up to `maxSweepIntervalMs`
      // while the list keeps returning nothing new.
      sweepIntervalMs = 3_000,
      maxSweepIntervalMs = 15_000,
      // The client is asked to re-scan its lobby browser at most this often.
      refreshThrottleMs = 3_000,
      // How long a room abandoned for a spent invitation budget stays out of the running when the
      // browser still reports it as unchanged.
      exhaustedCooldownMs = 120_000,
      // Population is transient, and the browser may never update its stale slot count.
      // Recheck a small room soon without repeatedly joining it at the list poll cadence.
      populationCooldownMs = 10_000,
      // How long a watched room may sit below the player floor without gaining a single player before
      // it is abandoned. A room that keeps filling never reaches this, because progress resets it.
      // 0 makes the floor a hard gate: such a room is left on the very first check.
      stallTimeoutMs = 30_000,
      // A party whose invitation list is already full refuses browser joins outright
      // (HTTP 400 / PARTY_INVITE_LIMIT), so it is set aside for far longer than a merely stale room.
      inviteLimitCooldownMs = 600_000,
      // The watch loop (holding a joined room) never polls faster than this, even when the browser
      // poll interval is small: every watch rule works on seconds, so a faster tick is pure load.
      // 0 disables the floor - the tests drive time with 10ms intervals.
      watchIntervalFloorMs = 1_000,
      // Pacing inside one sweep, so a long list of plausible rooms cannot flood the client.
      attemptGapMs = 500,
      // How long a burst of WebSocket lobby pushes is coalesced before the watch reacts.
      pushDebounceMs = 200,
      maxAttemptsPerSweep = 20,
      clock = () => Date.now(),
      emit = () => {}
    }: SearchOptions = {}
  ) {
    this.policy = { ...policy }
    this.intervalMs = intervalMs
    this.maxIntervalMs = maxIntervalMs
    this.sweepIntervalMs = sweepIntervalMs
    this.maxSweepIntervalMs = Math.max(maxSweepIntervalMs, sweepIntervalMs)
    this.refreshThrottleMs = refreshThrottleMs
    this.exhaustedCooldownMs = exhaustedCooldownMs
    this.populationCooldownMs = populationCooldownMs
    this.stallTimeoutMs = stallTimeoutMs
    this.inviteLimitCooldownMs = inviteLimitCooldownMs
    this.watchIntervalFloorMs = watchIntervalFloorMs
    this.attemptGapMs = attemptGapMs
    this.pushDebounceMs = pushDebounceMs
    this.maxAttemptsPerSweep = maxAttemptsPerSweep
    this.clock = clock
    this.emit = emit
    this._delayMs = intervalMs
    this._sweepDelayMs = sweepIntervalMs
  }

  get running() {
    return this._running
  }
  get state() {
    return this._state
  }

  /** Read-only snapshot for the renderer; contains no credentials or raw lobby payloads. */
  status(): HextechRoomStatus {
    return {
      state: this._state,
      running: this._running,
      lastRefreshAt: this._lastRefreshAt,
      candidateCount: this._candidateCount,
      eligibleCount: this._eligibleCount,
      cooldownCount: this._cooldownCount,
      nextRoomRetryAt: this._nextRoomRetryAt,
      sweepCount: this._sweepCount,
      sweepIntervalMs: this.sweepIntervalMs,
      selectedSummary: summarizeLobby(this._selected),
      lastError: this._lastError,
      pollIntervalMs: this.intervalMs,
      minPlayers: this.policy.minPlayers,
      // A watched room under the floor is being waited on; the deadline makes that wait legible.
      belowFloor: this._belowFloor,
      watchDeadlineAt: this._watchDeadlineAt,
      maxInvites: this.policy.maxInvites,
      nameKeywords: [...(this.policy.nameKeywords ?? [])]
    }
  }

  /**
   * Whether the client's WebSocket is currently connected and pushing lobby events. While it is,
   * the watch is driven by `acceptLobbyPush` and the periodic backstop widens to `maxIntervalMs`;
   * the main process flips this with the socket's up/down signal.
   */
  watchPushConnected = false

  /**
   * Feeds a joined-lobby state that the client pushed over its WebSocket (`/lol-lobby/v2/lobby`).
   * A push makes the next scheduled watch fetch redundant - the data has already arrived - so the
   * pending timer is cancelled and the watch runs on the pushed payload after a short coalescing
   * debounce (a burst of client events then costs one run, not one per event). A `null`/`undefined`
   * payload means the room is gone (the client pushes a Delete with no data).
   *
   * Returns whether the push was consumed; anything but a watched joined room ignores it, since
   * search sweeps and verification must read fresh data for their own decisions.
   */
  acceptLobbyPush(lobby?: HextechLobby) {
    if (!this._running || this._state !== STATES.joined || !this._watchJoined) return false
    const signal = this._abort!.signal
    clearTimeout(this._timer)
    clearTimeout(this._pushTimer)
    if (this._watchTask?.signal === signal) {
      this._pendingWatch = { lobby }
      return true
    }
    this._pushTimer = setTimeout(() => {
      this._pushTimer = undefined
      if (this._stale(signal) || !this._watchJoined) return
      this._watch(signal, { lobby }).catch((error) => this._watchFailure(signal, error))
    }, this._watchDeadlineDelay(this.pushDebounceMs))
    return true
  }

  /** Complete browser snapshots skip a GET; child events only invalidate the current snapshot. */
  acceptLobbyListPush(lobbies?: HextechLobby[]) {
    if (!this._running || this._state !== STATES.searching || this._lastError) return false
    if (lobbies !== undefined && !Array.isArray(lobbies)) return false
    if (lobbies && !this._hasPendingList && listSignature(lobbies) === this._listSignature)
      return true
    this._pendingList = lobbies
    this._hasPendingList = true
    this._scheduleListPush(this._abort!.signal)
    return true
  }

  private _scheduleListPush(signal: AbortSignal) {
    clearTimeout(this._timer)
    // Fixed coalescing window: continuous pushes cannot postpone the wake indefinitely.
    if (this._listPushTimer !== undefined) return
    this._listPushTimer = setTimeout(() => {
      this._listPushTimer = undefined
      if (this._stale(signal) || this._state !== STATES.searching) return
      if (!this._hasPendingList) return
      if (this._cycleTask?.signal === signal) return // its finally block drains the pending update
      const snapshot = this._pendingList
      this._pendingList = undefined
      this._hasPendingList = false
      void this._cycle(signal, snapshot, true)
    }, this.pushDebounceMs)
  }

  /** Applies non-sensitive settings without restarting an active search. */
  configure({
    pollIntervalMs,
    minPlayers,
    nameKeywords,
    maxInvites,
    stallTimeoutMs
  }: Partial<HextechRoomConfiguration> = {}) {
    if (
      typeof pollIntervalMs === 'number' &&
      Number.isFinite(pollIntervalMs) &&
      pollIntervalMs > 0
    ) {
      this.intervalMs = pollIntervalMs
      this._delayMs = pollIntervalMs
    }
    if (typeof minPlayers === 'number' && Number.isFinite(minPlayers) && minPlayers >= 0)
      this.policy.minPlayers = minPlayers
    if (Array.isArray(nameKeywords)) this.policy.nameKeywords = [...nameKeywords]
    if (typeof maxInvites === 'number' && Number.isFinite(maxInvites) && maxInvites >= 0)
      this.policy.maxInvites = maxInvites
    if (
      typeof stallTimeoutMs === 'number' &&
      Number.isFinite(stallTimeoutMs) &&
      stallTimeoutMs >= 0
    )
      this.stallTimeoutMs = stallTimeoutMs
    if (this._watchJoined) {
      this._rememberFloorWait(this._selected?.playerCount)
      this._scheduleWatch(this._abort!.signal)
    }
    this._emit({ type: 'configured' })
    return this.status()
  }

  async start() {
    if (this._running) return
    this._running = true
    this._delayMs = this.intervalMs
    this._sweepDelayMs = this.sweepIntervalMs
    this._sweepCount = 0
    this._rejectedThisSweep.clear()
    this._exhaustedRooms.clear()
    this._snapshotCounts = new Map()
    this._lastForcedRefreshAt = Number.NEGATIVE_INFINITY
    this._hasPendingList = false
    this._pendingList = undefined
    this._listSignature = undefined
    this._nextSearchAt = 0
    this._retryAt = 0
    this._attemptedSnapshots.clear()
    this._cooldownCount = 0
    this._nextRoomRetryAt = undefined
    this._pendingWatch = undefined
    this._watchJoined = false
    this._watchingSummary = undefined
    this._watchPlayerCount = 0
    this._watchProgressAt = 0
    this._belowFloor = false
    this._watchDeadlineAt = undefined
    this._adoptedRoom = false
    this._watchDelayMs = 0
    this._lastError = undefined
    this._versionMismatchRooms.clear()
    this._versionMismatchWarned = false
    // The connection readout in the UI keys off this, so a new session must not inherit the old one.
    this._lastRefreshAt = undefined
    this._abort = new AbortController()
    this._transition(STATES.connecting)
    const signal = this._abort!.signal

    // Already sitting in a room: verify it instead of joining another party. A room that already meets
    // the floor is the result; one below it is watched like any other, but is never vacated by the tool.
    let existing
    try {
      existing = await this.provider.currentLobby({ signal })
    } catch {
      if (this._stale(signal)) return
    }
    if (this._stale(signal)) return
    if (existing) {
      const verdict = evaluateJoinedLobby(existing, this.policy)
      // `evaluateJoinedLobby` accepts a room below the floor on purpose - being inside a room while it
      // fills is the point - so the floor has to be compared here, where the real member list is known.
      const floor = Number(this.policy.minPlayers) || 0
      const belowFloor = (Number(existing.playerCount) || 0) < floor
      if (verdict.eligible && !belowFloor) {
        this._running = false
        this._selected = existing
        return this._transition(STATES.joined, {
          type: 'joined',
          lobby: existing,
          alreadyInRoom: true,
          modeVerified: verdict.modeVerified === true,
          message: i18next.t('hextech-room-main.already-in-room'),
          selectedSummary: summarizeLobby(existing)
        })
      }
      if (verdict.eligible && belowFloor) {
        // Below the floor. Sitting in it is allowed, but only for the same bounded wait a room this
        // tool joined would get - reporting a half-empty room as the finished result forever, with the
        // player floor silently ignored, is what made the search look stuck.
        this._selected = existing
        this._watchJoined = true
        this._adoptedRoom = true
        this._watchPlayerCount = Number(existing.playerCount) || 0
        this._watchProgressAt = this.clock()
        this._rememberFloorWait()
        this._watchingSummary = summarizeLobby(existing)
        this._transition(STATES.joined, {
          type: 'joined',
          lobby: existing,
          alreadyInRoom: true,
          modeVerified: verdict.modeVerified === true,
          message: i18next.t('hextech-room-main.adopted-below-floor', {
            players: this._watchPlayerCount,
            floor
          }),
          selectedSummary: this._watchingSummary
        })
        if (this.stallTimeoutMs === 0) return this._watch(signal, { lobby: existing })
        return this._scheduleWatch(signal)
      }
      this._running = false
      return this._transition(STATES.idle, {
        type: 'error',
        fatal: true,
        message: i18next.t('hextech-room-main.other-room', { room: summarizeLobby(existing) })
      })
    }

    return this._cycle(signal)
  }

  /** Stops polling and cancels in-flight requests; the client keeps whatever room it is in. */
  stop() {
    // An adopted room leaves no search running but still has a joined state and a watch timer to clear.
    if (!this._running && this._state !== STATES.joined) return
    this._running = false
    this._abort?.abort()
    clearTimeout(this._timer)
    this._timer = undefined
    clearTimeout(this._pushTimer)
    this._pushTimer = undefined
    clearTimeout(this._listPushTimer)
    this._listPushTimer = undefined
    this._hasPendingList = false
    this._pendingList = undefined
    this._pendingWatch = undefined
    this._selected = undefined
    this._watchJoined = false
    this._watchingSummary = undefined
    this._belowFloor = false
    this._watchDeadlineAt = undefined
    this._adoptedRoom = false
    this._watchDelayMs = 0
    this._transition(STATES.idle, { type: 'stopped' })
  }

  /** Reports whether the client confirmed leaving before another search can start. */
  async leave() {
    this.stop()
    this._emit({ type: 'leaving', message: i18next.t('hextech-room-main.leaving') })
    const startedAt = this.clock()
    try {
      await this.provider.leaveLobby({})
      this._transition(STATES.idle, { type: 'left', elapsedMs: this.clock() - startedAt })
      return { ...this.status(), left: true }
    } catch (caughtError) {
      const error = asHextechRoomError(caughtError)
      this._lastError = describe(error)
      this._emit({ type: 'error', message: this._lastError })
      return { ...this.status(), left: false }
    }
  }

  private _transition(state: HextechRoomPhase, event: HextechRoomEvent = {}) {
    this._state = state
    this._emit(event)
  }

  /** Every event carries the full status snapshot so the renderer never has to merge partial state. */
  private _emit(event: HextechRoomEvent) {
    this.emit({ ...this.status(), ...event, type: event.type ?? this._state })
  }

  /**
   * Ends the current sweep: the rejections are forgotten, the client is asked to re-scan its
   * browser, and the next pass starts after a backoff. This is what keeps the search alive once
   * every room of the current list has failed.
   */
  private async _exhaustSweep(signal: AbortSignal, { attempted }: { attempted?: number } = {}) {
    this._sweepCount += 1
    this._rejectedThisSweep.clear()
    // Expired entries are dropped here so an all-night run cannot accumulate dead room ids.
    for (const [id, record] of this._exhaustedRooms) {
      if (this.clock() >= record.expiresAt) this._exhaustedRooms.delete(id)
    }
    // Fire and forget, for the same reason as in `_cycle`: the client's rescan and the backoff
    // sleep now overlap instead of adding up before the next sweep.
    void this._maybeRefresh(signal)
    if (this._stale(signal)) return
    this._delayMs = this._sweepDelayMs
    this._retryAt = this.clock() + this._sweepDelayMs
    this._sweepDelayMs = Math.min(this._sweepDelayMs * 2, this.maxSweepIntervalMs)
    this._transition(STATES.searching, {
      type: 'sweep-exhausted',
      count: attempted,
      retryInMs: this._delayMs
    })
    // Keep observing the browser at the configured cadence while individual retries back off.
    return this._schedule(signal, Math.min(this.intervalMs, this._delayMs))
  }

  /** Best-effort forced re-scan of the public browser; throttled and never fatal. */
  private async _maybeRefresh(signal: AbortSignal) {
    if (!this.provider.refreshLobbyList || this._refreshInFlight || this._stale(signal)) return
    const now = this.clock()
    if (now - this._lastForcedRefreshAt < this.refreshThrottleMs) return
    this._refreshInFlight = true
    this._lastForcedRefreshAt = now
    try {
      await this.provider.refreshLobbyList({ signal })
    } catch {
      // A client build without this endpoint is not an error; the previously fetched list is reused.
    } finally {
      this._refreshInFlight = false
      // A slow refresh gets the same quiet period as a fast one. Old sessions cannot alter a new clock.
      if (!this._stale(signal)) this._lastForcedRefreshAt = this.clock()
    }
  }

  /** Short pacing delay between join attempts; the caller re-checks `_stale` afterwards. */
  private _sleep(ms: number) {
    return ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
  }

  private _stale(signal: AbortSignal) {
    return signal.aborted || !this._running
  }

  private async _cycle(
    signal: AbortSignal,
    snapshot?: HextechLobby[],
    fromPush = false
  ): Promise<void> {
    if (this._stale(signal) || this._cycleTask?.signal === signal) return
    const task = { signal }
    this._cycleTask = task
    try {
      await this._runCycle(signal, snapshot, fromPush)
    } finally {
      if (this._cycleTask === task) {
        this._cycleTask = undefined
        if (
          !this._stale(signal) &&
          this._state === STATES.searching &&
          !this._lastError &&
          this._hasPendingList
        ) {
          this._scheduleListPush(signal)
        } else if (!this._stale(signal)) {
          this._hasPendingList = false
          this._pendingList = undefined
        }
      }
    }
  }

  private async _runCycle(
    signal: AbortSignal,
    snapshot: HextechLobby[] | undefined,
    fromPush: boolean
  ): Promise<void> {
    if (this._stale(signal)) return
    try {
      this._state = STATES.searching
      // Ask the client to re-scan its browser, but do not wait for it: the refresh POST can take
      // seconds (5s was observed on a busy client), and serialising it in front of every list fetch
      // slowed the whole search loop by exactly that much every cycle. The rescan lands in time for
      // the next cycle's list read.
      if (!fromPush) void this._maybeRefresh(signal)
      let lobbies = snapshot ?? (await this.provider.listLobbies({ signal }))
      if (this._stale(signal)) return
      // A child event received during GET makes that response obsolete. The queued cycle
      // must read again; joining from a known-invalid response wastes a request or picks a stale room.
      if (this._hasPendingList && this._pendingList === undefined) return
      if (this._hasPendingList && this._pendingList) {
        lobbies = this._pendingList
        this._pendingList = undefined
        this._hasPendingList = false
      }
      const signature = listSignature(lobbies)
      if (fromPush && signature === this._listSignature) {
        return this._schedule(signal, Math.max(0, this._nextSearchAt - this.clock()))
      }
      this._listSignature = signature
      // The client answered, so whatever failed before is over. Without this a single stalled request
      // left "最近错误" showing for the rest of the session even though the search had recovered.
      this._lastError = undefined
      if (this._stale(signal)) return
      this._lastRefreshAt = this.clock()
      this._candidateCount = lobbies.length

      this._snapshotCounts = new Map(
        lobbies.map((lobby) => [String(lobby.id), Number(lobby.playerCount) || 0])
      )
      const ranked = rankLobbies(lobbies, this.policy)
      this._eligibleCount = ranked.length
      const backingOff = this.clock() < this._retryAt
      if (!backingOff) this._attemptedSnapshots.clear()
      // Only a new or changed eligible candidate may bypass the retry delay. Churn in
      // unrelated rows must not turn an unchanged busy room into two join requests per second.
      const unparked = ranked.filter(({ lobby }) => !this._isExhaustedRoom(lobby))
      this._cooldownCount = ranked.length - unparked.length
      this._nextRoomRetryAt = this._cooldownCount
        ? Math.min(
            ...ranked
              .filter(({ lobby }) => this._isExhaustedRoom(lobby))
              .map(({ lobby }) => this._exhaustedRooms.get(String(lobby.id))!.expiresAt)
          )
        : undefined
      if (ranked.length > 0 && unparked.length === 0) {
        // No join was attempted. Do not invent another failed sweep or extend retryAt.
        // The per-room records already provide pacing; new rooms still bypass them.
        this._rejectedThisSweep.clear()
        this._selected = undefined
        this._emit({
          type: 'cooldown-wait',
          message: i18next.t('hextech-room-main.cooldown-wait')
        })
        return this._schedule(
          signal,
          Math.min(this.intervalMs, (this._nextRoomRetryAt ?? this.clock()) - this.clock())
        )
      }
      const available = backingOff
        ? unparked.filter(
            ({ lobby }) => this._attemptedSnapshots.get(String(lobby.id)) !== listSignature([lobby])
          )
        : unparked
      if (backingOff && available.length === 0) {
        this._emit({ type: 'searching', message: i18next.t('hextech-room-main.refreshing') })
        return this._schedule(signal, Math.min(this.intervalMs, this._retryAt - this.clock()))
      }
      if (ranked.length === 0) {
        this._selected = undefined
        this._delayMs = this.intervalMs
        this._emit({ type: 'no-match', count: lobbies.length })
        return this._schedule(signal)
      }

      const retryable = available.filter(
        (candidate) =>
          !this._rejectedThisSweep.has(String(candidate.lobby.id)) &&
          !this._isExhaustedRoom(candidate.lobby)
      )
      if (retryable.length === 0) {
        // Nothing left to attempt: every room was rejected, or the rest are known-dead rooms.
        // Either way the next sweep starts over from a freshly fetched list.
        return this._exhaustSweep(signal, { attempted: 0 })
      }

      // With more candidates than the per-sweep budget, rotate the start so the tail is not starved.
      const offset =
        retryable.length > this.maxAttemptsPerSweep ? this._sweepCount % retryable.length : 0
      const ordered = [...retryable.slice(offset), ...retryable.slice(0, offset)]

      let attempts = 0
      let budgetSpent = false
      if (backingOff) this._sweepDelayMs = this.sweepIntervalMs
      for (const candidate of ordered) {
        if (this._stale(signal)) return
        if (attempts >= this.maxAttemptsPerSweep) {
          budgetSpent = true
          break
        }
        if (attempts > 0) {
          await this._sleep(this.attemptGapMs)
          if (this._stale(signal)) return
        }
        attempts += 1
        this._attemptedSnapshots.set(String(candidate.lobby.id), listSignature([candidate.lobby]))
        this._selected = candidate.lobby
        this._transition(STATES.joining, {
          type: 'joining',
          lobby: candidate.lobby,
          reason: candidate.result.reason,
          message: i18next.t('hextech-room-main.joining'),
          selectedSummary: summarizeLobby(candidate.lobby)
        })
        try {
          await this.provider.joinLobby(candidate.lobby.id, { signal })
          if (this._stale(signal)) return
        } catch (caughtError) {
          const error = asHextechRoomError(caughtError)
          if (this._stale(signal)) return
          if (error?.skip) {
            // A full, locked or revoked room is not retried until the next sweep.
            this._rejectedThisSweep.add(String(candidate.lobby.id))
            // The client reports rejections as errorCode "RPC_ERROR" with the meaningful code in
            // the message body, so matching the code field alone never fired - every rejection
            // showed the raw HTTP line instead of an explanation. The rules table carries the
            // explanation and the parking decision for each code the log has seen so far.
            const code = rejectionCode(error)
            const rule = code ? SKIP_RULES[code] : undefined
            if (rule?.park === 'long')
              this._rememberExhausted(
                candidate.lobby,
                this.inviteLimitCooldownMs,
                code === 'PARTY_INVITE_LIMIT' ? 'invite-limit' : undefined
              )
            else if (rule?.park === 'short') this._rememberExhausted(candidate.lobby)
            if (code === 'INVALID_GAME_VERSION') this._noteVersionMismatch(candidate.lobby)
            this._emit({
              type: 'skipped',
              lobby: candidate.lobby,
              reason: rule?.reason ?? 'not-joinable',
              message: rule
                ? i18next.t(`hextech-room-main.${rule.message}`)
                : describeRejection(error),
              selectedSummary: summarizeLobby(candidate.lobby)
            })
            continue
          }
          throw error
        }

        this._transition(STATES.verifying, {
          type: 'verifying',
          lobby: candidate.lobby,
          message: i18next.t('hextech-room-main.verifying')
        })
        const current = await this.provider.currentLobby({ signal })
        if (this._stale(signal)) return
        if (current && current.id !== candidate.lobby.id) {
          this.stop()
          return
        }
        let verification = this._verify(current, candidate.lobby.id)
        if (
          verification.ok &&
          this.stallTimeoutMs === 0 &&
          Number(current?.playerCount) < Number(this.policy.minPlayers)
        ) {
          verification = { ok: false, reason: 'too-few-players' }
        }
        if (verification.ok && current) {
          this._selected = current
          this._delayMs = this.intervalMs
          this._watchJoined = true
          // Getting into a room proves this client is usable, so a later cluster of version
          // mismatches is news again instead of something the log has already dismissed.
          this._versionMismatchRooms.clear()
          this._versionMismatchWarned = false
          // Progress is counted from the join, so a room that is still small only gets a stall timeout.
          this._watchPlayerCount = Number(current?.playerCount) || 0
          this._watchProgressAt = this.clock()
          this._rememberFloorWait()
          const summary = summarizeLobby(current)
          this._watchingSummary = summary
          this._transition(STATES.joined, {
            type: 'joined',
            lobby: current,
            modeVerified: verification.modeVerified,
            // Saying "waiting for the room to grow" up front is what separates a deliberate wait from
            // the tool looking stuck on a half-empty room.
            message: this._belowFloor
              ? i18next.t('hextech-room-main.below-floor', {
                  players: this._watchPlayerCount,
                  floor: Number(this.policy.minPlayers) || 0
                })
              : i18next.t('hextech-room-main.watching'),
            selectedSummary: summary
          })
          return this._scheduleWatch(signal)
        }

        await this.provider.leaveLobby({ signal })
        if (this._stale(signal)) return
        this._selected = undefined
        this._delayMs = this.intervalMs
        // Without this the same wrong-mode room would be joined and left on every sweep.
        this._rejectedThisSweep.add(String(candidate.lobby.id))
        if (verification.reason === 'invites-exhausted') {
          // This room's invitation list is already at the cap, which is the same dead end the browser
          // refuses outright with PARTY_INVITE_LIMIT. Remembering it only for the current sweep was not
          // enough: the next sweep forgot it and joined the same hopeless room again, burning a join
          // attempt, a leave, and an extra LCU round trip every minute.
          this._rememberExhausted(
            current ?? candidate.lobby,
            this.inviteLimitCooldownMs,
            'invites-exhausted'
          )
        } else if (verification.reason === 'too-few-players') {
          this._rememberExhausted(
            current ?? candidate.lobby,
            this.populationCooldownMs,
            'too-few-players'
          )
        } else {
          this._rememberExhausted(candidate.lobby)
        }
        const immediateFloor = verification.reason === 'too-few-players'
        this._transition(STATES.searching, {
          type: immediateFloor ? 'left-stalled-room' : 'rejected-after-join',
          lobby: current ?? candidate.lobby,
          message: immediateFloor
            ? i18next.t('hextech-room-main.left-below-floor', {
                players: current?.playerCount,
                floor: Number(this.policy.minPlayers) || 0
              })
            : i18next.t('hextech-room-main.left-rejected', {
                reason: describeReason(verification.reason)
              }),
          reason: verification.reason,
          modeVerified: verification.modeVerified
        })
        continue
      }

      this._delayMs = this.intervalMs
      if (budgetSpent) return this._schedule(signal)
      return this._exhaustSweep(signal, { attempted: attempts })
    } catch (caughtError) {
      const error = asHextechRoomError(caughtError)
      if (this._stale(signal)) return
      const message = describe(error)
      this._lastError = message
      if (error?.fatal) {
        this._running = false
        clearTimeout(this._timer)
        this._timer = undefined
        return this._transition(STATES.idle, { type: 'error', message, fatal: true })
      }
      this._emit({ type: 'error', message, retryInMs: this._delayMs })
      this._delayMs = Math.min(this._delayMs * 2, this.maxIntervalMs)
      return this._schedule(signal)
    }
  }

  /**
   * Re-checks a joined room so a room that goes stale is abandoned instead of sat in. The fetch
   * and the judgment are split (`_watchWith`) so a WebSocket push can run the judgment on data
   * the client already delivered, without another round trip.
   */
  private async _watch(signal: AbortSignal, pushed?: { lobby?: HextechLobby }): Promise<void> {
    if (this._stale(signal) || !this._watchJoined) return
    if (this._watchTask?.signal === signal) {
      if (pushed) this._pendingWatch = pushed
      return
    }
    const task = { signal }
    this._watchTask = task
    try {
      await this._runWatch(signal, pushed)
    } finally {
      if (this._watchTask === task) {
        this._watchTask = undefined
        const pending = this._pendingWatch
        this._pendingWatch = undefined
        if (pending && !this._stale(signal) && this._watchJoined)
          this.acceptLobbyPush(pending.lobby)
      }
    }
  }

  private async _runWatch(signal: AbortSignal, pushed?: { lobby?: HextechLobby }): Promise<void> {
    if (this._stale(signal) || !this._watchJoined) return
    if (pushed) return this._watchWith(signal, pushed.lobby)
    let current
    try {
      current = await this.provider.currentLobby({ signal })
      if (this._stale(signal)) return
      // A newer push beats a slower GET that was already in flight when the event arrived.
      if (this._pendingWatch) {
        current = this._pendingWatch.lobby
        this._pendingWatch = undefined
      }
      // Same as in the sweep: a successful read clears whatever the previous failure left behind.
      this._lastError = undefined
      this._watchDelayMs = 0
    } catch (caughtError) {
      const error = asHextechRoomError(caughtError)
      return this._watchFailure(signal, error)
    }
    return this._watchWith(signal, current)
  }

  /** Watch rules applied to lobby data, whether it was fetched or pushed in. */
  private async _watchWith(signal: AbortSignal, current?: HextechLobby): Promise<void> {
    if (this._stale(signal) || !this._watchJoined) return
    if (current) {
      this._lastError = undefined
      this._watchDelayMs = 0
    }
    if (!current) {
      // The lobby is gone: the game started, or the room was closed or left. Nothing to watch.
      this._watchJoined = false
      this._running = false
      this._belowFloor = false
      this._watchDeadlineAt = undefined
      this._selected = undefined
      return this._transition(STATES.idle, {
        type: 'room-gone',
        message: i18next.t('hextech-room-main.room-gone')
      })
    }
    if (this._selected && current.id !== this._selected.id) {
      this.stop()
      return
    }
    const playerCount = Number(current?.playerCount) || 0
    if (playerCount > this._watchPlayerCount) {
      this._watchPlayerCount = playerCount
      this._watchProgressAt = this.clock()
    }
    // The room spent its invite budget without filling, so it is left and the search resumes.
    if (!this._adoptedRoom && isInviteBudgetExhausted(current, this.policy)) {
      return this._abandonRoom(signal, current, {
        type: 'left-stale-room',
        message: i18next.t('hextech-room-main.left-invite-limit', { players: playerCount })
      })
    }
    // Judged on the count just read, not on the high-water mark: a room that peaked at the floor and
    // then lost players is under it again, and has to be waited on (and eventually left) like any other.
    this._rememberFloorWait(playerCount)
    if (this._belowFloor) {
      // The invitation rule cannot catch a room whose owner simply invited nobody, so the floor is
      // enforced on a clock as well: `stallTimeoutMs` without a single new player means the room is not
      // filling. At 0 the wait is skipped entirely and the floor acts as a hard gate.
      const floor = Number(this.policy.minPlayers) || 0
      const waited = this.clock() - this._watchProgressAt
      if (this.stallTimeoutMs === 0 || waited >= this.stallTimeoutMs) {
        if (this._adoptedRoom) {
          // The user is in this room by their own choice, so the tool reports instead of kicking them
          // out of it - but it no longer pretends the floor was met either.
          this._watchJoined = false
          this._running = false
          this._adoptedRoom = false
          this._belowFloor = false
          this._watchDeadlineAt = undefined
          this._selected = undefined
          return this._transition(STATES.idle, {
            type: 'left-stalled-room',
            lobby: current,
            message: i18next.t('hextech-room-main.adopted-stalled', {
              players: playerCount,
              floor
            }),
            selectedSummary: summarizeLobby(current)
          })
        }
        return this._abandonRoom(signal, current, {
          type: 'left-stalled-room',
          message:
            this.stallTimeoutMs === 0
              ? i18next.t('hextech-room-main.left-below-floor', { players: playerCount, floor })
              : i18next.t('hextech-room-main.left-stalled', {
                  players: playerCount,
                  floor,
                  seconds: Math.round(this.stallTimeoutMs / 1000)
                })
        })
      }
    }
    this._selected = current
    // Only emitted when the room actually changed, so a long wait cannot flood the log.
    const summary = summarizeLobby(current)
    if (summary !== this._watchingSummary) {
      this._watchingSummary = summary
      this._transition(STATES.joined, {
        type: 'watching',
        lobby: current,
        message: this._belowFloor
          ? i18next.t('hextech-room-main.still-below-floor', {
              players: playerCount,
              floor: Number(this.policy.minPlayers) || 0
            })
          : i18next.t('hextech-room-main.population-changed'),
        selectedSummary: summary
      })
    }
    return this._scheduleWatch(signal)
  }

  /**
   * Leaves a watched room that cannot pay off, remembers it, and resumes the search. The tool only
   * ever does this to a room it joined itself; a room the user was already sitting in is never left.
   */
  private async _abandonRoom(
    signal: AbortSignal,
    current: HextechLobby,
    { type, message }: { type: string; message: string }
  ): Promise<void> {
    await this.provider.leaveLobby({ signal })
    if (this._stale(signal)) return
    this._rejectedThisSweep.add(String(current.id))
    this._rememberExhausted(
      current,
      type === 'left-stalled-room' ? this.populationCooldownMs : this.inviteLimitCooldownMs,
      type === 'left-stalled-room' ? 'too-few-players' : 'invites-exhausted'
    )
    this._watchJoined = false
    this._watchingSummary = undefined
    this._belowFloor = false
    this._watchDeadlineAt = undefined
    this._adoptedRoom = false
    this._selected = undefined
    this._sweepDelayMs = this.sweepIntervalMs
    this._delayMs = this.intervalMs
    this._transition(STATES.searching, {
      type,
      lobby: current,
      message,
      selectedSummary: summarizeLobby(current),
      retryInMs: this._delayMs
    })
    return this._schedule(signal)
  }

  /**
   * Recomputes whether the watched room sits under the player floor and when it will be given up on.
   * The deadline is what the UI shows, so a deliberate wait never looks like the tool being stuck.
   *
   * The floor is judged against the count just observed, never against `_watchPlayerCount`: that field
   * is a high-water mark kept for "has this room ever gained a player", so judging the floor by it meant
   * a room that reached the floor and then lost players stayed "above" it forever - `_belowFloor` stayed
   * false, the stall branch was never entered, and the tool sat in a collapsing room indefinitely.
   *
   * Entering the below-floor state restarts the stall clock. The clock measures "no progress while under
   * the floor", and a room that just lost players has not made progress - but `_watchProgressAt` may
   * still hold a timestamp from minutes ago, when the room was last filling, which would abandon the
   * room on the spot instead of granting the bounded wait the setting promises.
   */
  _rememberFloorWait(playerCount = this._watchPlayerCount) {
    const floor = Number(this.policy.minPlayers) || 0
    const belowFloor = (Number(playerCount) || 0) < floor
    if (belowFloor && !this._belowFloor) this._watchProgressAt = this.clock()
    this._belowFloor = belowFloor
    this._watchDeadlineAt =
      belowFloor && this.stallTimeoutMs > 0
        ? this._watchProgressAt + this.stallTimeoutMs
        : undefined
  }

  /**
   * Counts rooms refused for a version mismatch and states the fact once, when the count stops
   * being about one room: a single mismatched party is the room's problem, while several are this
   * client being out of step with the patch - which the per-room line cannot say. It stays a
   * statement: which side is behind, and what to do about it, is the user's to judge.
   */
  private _noteVersionMismatch(lobby: HextechLobby) {
    this._versionMismatchRooms.add(String(lobby.id))
    if (this._versionMismatchWarned || this._versionMismatchRooms.size < 3) return
    this._versionMismatchWarned = true
    this._emit({
      type: 'warning',
      message: i18next.t('hextech-room-main.version-warning', {
        count: this._versionMismatchRooms.size
      })
    })
  }

  /**
   * Remember why a room was parked. Joined counts include us; browser counts do not.
   * Keep the high-water mark in browser units so a near-full room can recover one player earlier.
   */
  private _rememberExhausted(
    lobby: HextechLobby,
    cooldownMs = this.exhaustedCooldownMs,
    reason?: string
  ) {
    const id = String(lobby.id)
    this._exhaustedRooms.set(id, {
      playerCount: Math.max(
        (Number(lobby.playerCount) || 0) - (lobby.joined ? 1 : 0),
        this._snapshotCounts.get(id) ?? 0
      ),
      reason,
      minPlayers: Number(this.policy.minPlayers) || 0,
      expiresAt: this.clock() + cooldownMs
    })
  }

  /**
   * Watching a joined room needs ~1s granularity, not the user's poll cadence: it halves the request
   * rate while a room is being held without delaying any decision the watch actually makes, since
   * every watch rule (invite budget, stall timeout) works on seconds anyway. While the client's
   * WebSocket is pushing lobby events, the timer demotes to a backstop against a silent push loss:
   * one fetch per `maxIntervalMs` instead of one per second.
   */
  _watchIntervalMs() {
    if (this.watchPushConnected) return Math.max(this.maxIntervalMs, this.watchIntervalFloorMs)
    return Math.max(this.intervalMs, this.watchIntervalFloorMs)
  }

  private _watchDeadlineDelay(delay: number) {
    if (!this._belowFloor || this._watchDelayMs) return delay
    if (this.stallTimeoutMs === 0) return 0
    return Math.min(delay, Math.max(0, (this._watchDeadlineAt ?? this.clock()) - this.clock()))
  }

  private _scheduleWatch(signal: AbortSignal) {
    if (this._stale(signal) || !this._watchJoined) return
    clearTimeout(this._timer)
    this._timer = setTimeout(
      () => {
        this._watch(signal).catch((error) => this._watchFailure(signal, error))
      },
      this._watchDeadlineDelay(this._watchDelayMs || this._watchIntervalMs())
    )
  }

  /** A failure while watching a joined room: retried, unless the client session itself is gone. */
  private _watchFailure(signal: AbortSignal, error: HextechRoomError) {
    if (this._stale(signal)) return
    this._lastError = describe(error)
    if (error?.fatal) {
      this._watchJoined = false
      this._running = false
      return this._transition(STATES.idle, { type: 'error', message: this._lastError, fatal: true })
    }
    // A failing watch must not retry at the poll cadence. Leaving a room that keeps timing out would
    // otherwise fire a DELETE every interval - at a 500ms poll that is two futile writes a second aimed
    // at a client that is already not answering.
    this._watchDelayMs = Math.min(
      Math.max(this._watchDelayMs || this._watchIntervalMs(), this.intervalMs) * 2,
      this.maxIntervalMs
    )
    this._emit({ type: 'error', message: this._lastError, retryInMs: this._watchDelayMs })
    return this._scheduleWatch(signal)
  }

  /**
   * Post-join verification. The browser snapshot that led here cannot be trusted on the two things
   * only a joined lobby reports - the game mode and the invitation record count - and a room that
   * emptied out between the snapshot and the join is not worth sitting in either.
   */
  private _verify(
    lobby: HextechLobby | undefined,
    expectedId: string
  ): { ok: boolean; reason?: string; modeVerified?: boolean } {
    if (!lobby) return { ok: false, reason: i18next.t('hextech-room-main.room-missing') }
    if (String(lobby.id) !== String(expectedId)) {
      return {
        ok: false,
        reason: i18next.t('hextech-room-main.room-mismatch', {
          actual: String(lobby.id),
          expected: String(expectedId)
        })
      }
    }
    const result = evaluateJoinedLobby(lobby, this.policy)
    if (!result.eligible)
      return { ok: false, reason: result.reason, modeVerified: result.modeVerified }
    return { ok: true, modeVerified: result.modeVerified === true }
  }

  /**
   * Population growth only helps when it can close the actual gap. A known explicit
   * PARTY_INVITE_LIMIT refusal is different: more players do not reopen invitation capacity.
   * All records expire, because even an unchanged browser snapshot can be stale.
   */
  private _isExhaustedRoom(lobby: HextechLobby) {
    const id = String(lobby.id)
    const record = this._exhaustedRooms.get(id)
    if (!record) return false
    const players = Number(lobby.playerCount) || 0
    const floor = Number(this.policy.minPlayers) || 0
    const gapRequired =
      record.reason === 'invites-exhausted' ||
      (record.reason === 'too-few-players' && this.stallTimeoutMs === 0)
    const grown = players > record.playerCount || (gapRequired && floor < record.minPlayers)
    const recovered =
      record.reason !== 'invite-limit' && grown && (!gapRequired || players + 1 >= floor)
    if (this.clock() >= record.expiresAt || recovered) {
      this._exhaustedRooms.delete(id)
      // A recovered per-room cooldown must not fall back into the unrelated sweep backoff.
      this._attemptedSnapshots.delete(id)
      return false
    }
    return true
  }

  private _schedule(signal: AbortSignal, delay = this._delayMs) {
    if (this._stale(signal)) return
    clearTimeout(this._timer)
    this._nextSearchAt = this.clock() + delay
    this._timer = setTimeout(() => this._cycle(signal), delay)
  }
}
