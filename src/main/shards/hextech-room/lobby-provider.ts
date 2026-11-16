import type {
  HextechLobby,
  HextechLobbyProvider,
  HextechRoomError
} from '@shared/types/hextech-room'
import type { AxiosInstance } from 'axios'

import type { SearchController } from './search-controller'

export interface CustomLobbyPayload {
  partyId?: string
  id?: string | number
  lobbyName?: string
  name?: string
  mapId?: number
  teamSize?: number
  maxPlayerSlots?: number
  maxHumanPlayers?: number
  filledPlayerSlots?: number
  playerCount?: number
  hasPassword?: boolean
  gameType?: string
  joinable?: boolean
  createdAt?: string | number
  creationDate?: string | number
  gameModeDisplayName?: string
  members?: LobbyMember[]
  participants?: LobbyMember[]
  invitations?: { state?: string }[]
  gameConfig?: LobbyConfiguration
  configuration?: LobbyConfiguration
}

interface LobbyMember {
  isSpectator?: boolean
  position?: string
  firstPositionPreference?: string
}

interface LobbyConfiguration {
  partyId?: string
  customLobbyName?: string
  mapId?: number
  teamSize?: number
  maxTeamSize?: number
  numPlayersPerTeam?: number
  maxHumanPlayers?: number
  maxLobbySize?: number
  playerCount?: number
  passwordRequired?: boolean
  hasPassword?: boolean
  spectatorPolicy?: string
  allowSpectators?: boolean
  gameMode?: string
  gameMutator?: string
  customMutatorName?: string
  mutator?: string
  gameModeDisplayName?: string
}

export function normalizeBrowserLobby(raw: CustomLobbyPayload): HextechLobby {
  return {
    id: String(raw.partyId ?? raw.id),
    browserId: typeof raw.id === 'number' ? raw.id : undefined,
    gameType: raw.gameType,
    name: raw.lobbyName ?? raw.name,
    mapId: raw.mapId,
    teamSize: raw.teamSize ?? (raw.maxPlayerSlots === 10 ? 5 : undefined),
    maxHumanPlayers: raw.maxPlayerSlots ?? raw.maxHumanPlayers,
    playerCount: Number(raw.filledPlayerSlots ?? raw.playerCount ?? 0),
    requiresPassword: raw.hasPassword,
    joinable:
      raw.joinable !== false &&
      (raw.filledPlayerSlots === undefined ||
        raw.maxPlayerSlots === undefined ||
        raw.filledPlayerSlots < raw.maxPlayerSlots),
    createdAt: raw.createdAt ?? raw.creationDate
  }
}

export function handleHextechLobbyEvent(
  controller: Pick<SearchController, 'acceptLobbyListPush' | 'acceptLobbyPush'>,
  event: { uri: string; eventType?: string; data?: unknown }
) {
  const validId = (id: unknown) =>
    typeof id === 'string' ? id.length > 0 : typeof id === 'number' && Number.isFinite(id)
  if (['/lol-lobby/v1/custom-games', '/lol-lobby/v2/custom-games'].includes(event.uri)) {
    const payload = event.data as
      { games?: CustomLobbyPayload[]; lobbies?: CustomLobbyPayload[] } | undefined
    const rows: unknown = Array.isArray(event.data)
      ? event.data
      : (payload?.games ?? payload?.lobbies)
    if (
      event.eventType !== 'Delete' &&
      Array.isArray(rows) &&
      rows.every((row) => row && typeof row === 'object' && validId(row.partyId ?? row.id))
    )
      return controller.acceptLobbyListPush(rows.map(normalizeBrowserLobby))
    return controller.acceptLobbyListPush()
  }
  const child = event.uri.match(/^\/lol-lobby\/v[12]\/custom-games\/([^/]+)$/)
  if (child) return child[1] !== 'refresh' ? controller.acceptLobbyListPush() : false
  if (!['/lol-lobby/v2/lobby', '/lol-lobby/v1/lobby'].includes(event.uri)) return false
  if (event.eventType === 'Delete' || event.data == null) return controller.acceptLobbyPush()
  if (typeof event.data !== 'object' || Array.isArray(event.data)) return false
  const lobby = event.data as CustomLobbyPayload
  if (!validId(lobby.partyId ?? lobby.id ?? lobby.gameConfig?.partyId)) return false
  return controller.acceptLobbyPush(normalizeJoinedLobby(lobby))
}

export function normalizeJoinedLobby(raw: CustomLobbyPayload): HextechLobby {
  const configuration = raw.gameConfig ?? raw.configuration ?? {}
  const members = raw.members ?? raw.participants ?? []
  const spectatorCount = members.filter(
    (member) =>
      member.isSpectator === true ||
      String(member.position ?? member.firstPositionPreference ?? '').toUpperCase() === 'SPECTATOR'
  ).length
  const lobbySeats = Number(configuration.maxLobbySize) || 0
  const maxHumanPlayers =
    Number(configuration.maxHumanPlayers) > 0
      ? Number(configuration.maxHumanPlayers)
      : Math.min(lobbySeats, 10) || undefined
  const spectatorPolicy = configuration.spectatorPolicy
  const spectatorsAllowed = spectatorPolicy
    ? !/notallowed|forbidden|none|denied|off/i.test(spectatorPolicy)
    : configuration.allowSpectators
  return {
    id: String(raw.partyId ?? raw.id ?? configuration.partyId),
    name: raw.lobbyName ?? configuration.customLobbyName ?? raw.name,
    mapId: configuration.mapId ?? raw.mapId,
    teamSize:
      configuration.teamSize ??
      configuration.maxTeamSize ??
      configuration.numPlayersPerTeam ??
      raw.teamSize,
    maxHumanPlayers,
    spectatorsAllowed,
    maxSpectators:
      spectatorsAllowed === true
        ? Math.max(4, lobbySeats - (maxHumanPlayers ?? 0))
        : Math.max(lobbySeats - (maxHumanPlayers ?? 0), 0),
    spectatorCount,
    playerCount: Number(members.length || configuration.playerCount || 0) - spectatorCount,
    requiresPassword:
      raw.hasPassword ?? configuration.passwordRequired ?? configuration.hasPassword,
    joinable: true,
    joined: true,
    inviteCount: raw.invitations?.length,
    pendingInviteCount: raw.invitations?.filter(
      (invitation) => String(invitation.state ?? '').toLowerCase() === 'pending'
    ).length,
    createdAt: raw.createdAt ?? raw.creationDate,
    gameMode: configuration.gameMode,
    gameMutator:
      configuration.gameMutator ?? configuration.customMutatorName ?? configuration.mutator,
    displayName: configuration.gameModeDisplayName ?? raw.gameModeDisplayName
  }
}

function requestError(
  status: number,
  body?: { errorCode?: string; message?: string }
): HextechRoomError {
  const error: HextechRoomError = new Error(
    `LCU HTTP ${status}${body?.message ? `: ${body.message}` : ''}`
  )
  error.status = status
  error.fatal = status === 401 || status === 403
  error.errorCode = body?.errorCode
  error.detailCode = body?.message
  return error
}

/** Uses Akari's authenticated connection; never discovers credentials or creates a second socket. */
export class HextechLobbyApiProvider implements HextechLobbyProvider {
  constructor(private readonly _getClient: () => AxiosInstance) {}

  private async _request<T>(
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
    signal?: AbortSignal
  ): Promise<T | undefined> {
    const response = await this._getClient().request<T>({
      url,
      method,
      signal,
      validateStatus: () => true
    })
    if (response.status >= 200 && response.status < 300)
      return response.status === 204 ? undefined : response.data
    throw requestError(response.status, response.data as { errorCode?: string; message?: string })
  }

  async listLobbies({ signal }: { signal?: AbortSignal } = {}) {
    for (const url of ['/lol-lobby/v1/custom-games', '/lol-lobby/v2/custom-games']) {
      try {
        const data = await this._request<
          CustomLobbyPayload[] | { games?: CustomLobbyPayload[]; lobbies?: CustomLobbyPayload[] }
        >(url, 'GET', signal)
        const rows = Array.isArray(data) ? data : (data?.games ?? data?.lobbies ?? [])
        return rows
          .filter((row) => row.partyId !== undefined || row.id !== undefined)
          .map(normalizeBrowserLobby)
      } catch (error) {
        if ((error as HextechRoomError).status !== 404) throw error
      }
    }
    const error = requestError(404)
    error.fatal = true
    throw error
  }

  async refreshLobbyList({ signal }: { signal?: AbortSignal } = {}) {
    for (const url of [
      '/lol-lobby/v1/custom-games/refresh',
      '/lol-lobby/v2/custom-games/refresh'
    ]) {
      try {
        await this._request(url, 'POST', signal)
        return true
      } catch (error) {
        if (signal?.aborted) throw error
        if ((error as HextechRoomError).status !== 404) return false
      }
    }
    return false
  }

  async joinLobby(id: string, { signal }: { signal?: AbortSignal } = {}) {
    for (const url of [
      `/lol-lobby/v2/party/${encodeURIComponent(id)}/join`,
      `/lol-lobby/v1/custom-games/${encodeURIComponent(id)}/join`
    ]) {
      try {
        await this._request(url, 'POST', signal)
        return
      } catch (error) {
        const rejection = error as HextechRoomError
        if (rejection.status === 404) continue
        rejection.skip = !rejection.fatal && Boolean(rejection.status && rejection.status < 500)
        throw rejection
      }
    }
    throw requestError(404)
  }

  async currentLobby({ signal }: { signal?: AbortSignal } = {}) {
    for (const url of ['/lol-lobby/v2/lobby', '/lol-lobby/v1/lobby']) {
      try {
        const data = await this._request<CustomLobbyPayload>(url, 'GET', signal)
        return data ? normalizeJoinedLobby(data) : undefined
      } catch (error) {
        if ((error as HextechRoomError).status !== 404) throw error
      }
    }
    return undefined
  }

  async leaveLobby({ signal }: { signal?: AbortSignal } = {}) {
    for (const url of ['/lol-lobby/v2/lobby', '/lol-lobby/v1/lobby']) {
      try {
        await this._request(url, 'DELETE', signal)
        return
      } catch (error) {
        if ((error as HextechRoomError).status !== 404) throw error
      }
    }
  }
}
