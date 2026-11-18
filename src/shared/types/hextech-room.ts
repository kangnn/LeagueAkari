export interface HextechLobby {
  id: string
  name?: string
  mapId?: number
  teamSize?: number
  maxHumanPlayers?: number
  spectatorsAllowed?: boolean
  maxSpectators?: number
  spectatorCount?: number
  playerCount: number
  inviteCount?: number
  requiresPassword?: boolean
  joinable: boolean
  joined?: boolean
  createdAt?: string | number
  gameMode?: string
  gameMutator?: string
  displayName?: string
}

export interface HextechRoomPolicy {
  mapIds: readonly number[]
  teamSize: number
  maxHumanPlayers: number
  minPlayers: number
  maxInvites: number
  nameKeywords: readonly string[]
}

export interface HextechRoomConfiguration {
  pollIntervalMs: number
  minPlayers: number
  maxInvites: number
  nameKeywords: string[]
  stallTimeoutMs: number
}

export interface HextechLobbyProvider {
  currentLobby(options?: { signal?: AbortSignal }): Promise<HextechLobby | undefined>
  listLobbies(options?: { signal?: AbortSignal }): Promise<HextechLobby[]>
  joinLobby(id: string, options?: { signal?: AbortSignal }): Promise<unknown>
  leaveLobby(options?: { signal?: AbortSignal }): Promise<void>
  refreshLobbyList?(options?: { signal?: AbortSignal }): Promise<boolean>
}

export interface HextechRoomVerdict {
  eligible: boolean
  reason: string
  modeVerified?: boolean
}

export type HextechRoomPhase =
  'idle' | 'connecting' | 'searching' | 'joining' | 'verifying' | 'joined'

export interface HextechRoomStatus {
  state: HextechRoomPhase
  running: boolean
  lastRefreshAt?: number
  candidateCount: number
  eligibleCount: number
  sweepCount: number
  sweepIntervalMs: number
  selectedSummary?: string
  lastError?: string
  pollIntervalMs: number
  minPlayers: number
  belowFloor: boolean
  watchDeadlineAt?: number
  maxInvites: number
  nameKeywords: string[]
}

export interface HextechRoomEvent extends Partial<HextechRoomStatus> {
  type?: string
  message?: string
  lobby?: HextechLobby
  reason?: string
  count?: number
  retryInMs?: number
  elapsedMs?: number
  alreadyInRoom?: boolean
  modeVerified?: boolean
  fatal?: boolean
}

export interface HextechRoomLog extends HextechRoomEvent {
  timestamp: number
}

export interface HextechRoomError extends Error {
  status?: number
  skip?: boolean
  fatal?: boolean
  errorCode?: string
  detailCode?: string
}

export function asHextechRoomError(error: unknown): HextechRoomError {
  return error instanceof Error ? error : new Error(String(error))
}
