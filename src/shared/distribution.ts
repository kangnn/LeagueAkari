/** Keep the fork's installation, state and binary update channel separate from official Akari. */
export const APP_DISTRIBUTION = {
  id: 'kangnn.league-akari-hextech',
  name: 'League Akari',
  dataDirectory: 'LeagueAkariHextech',
  officialUpdatesEnabled: false
} as const
