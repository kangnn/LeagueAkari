<template>
  <div class="h-full w-full">
    <NScrollbar class="h-full">
      <div class="mx-auto flex max-w-240 flex-col gap-6 p-6">
        <div class="flex items-center justify-between gap-3">
          <div class="text-xl font-bold">{{ t('hextechRoom.title') }}</div>
          <NTag :type="leagueClient.isConnected ? 'success' : 'default'" size="small">
            {{ t(leagueClient.isConnected ? 'hextechRoom.connected' : 'hextechRoom.disconnected') }}
          </NTag>
        </div>
        <SettingsSection :title="t('hextechRoom.search')">
          <div class="flex flex-col gap-3 p-3">
            <div class="flex flex-wrap gap-2">
              <NButton
                type="primary"
                size="small"
                :disabled="!canSearch || store.busy || store.status?.running"
                @click="command('start')"
                >{{ t('hextechRoom.start') }}</NButton
              >
              <NButton
                size="small"
                :disabled="!store.status?.running && !store.busy"
                @click="command('stop')"
                >{{ t('hextechRoom.stop') }}</NButton
              >
              <NButton
                size="small"
                :disabled="!canSearch || store.busy"
                @click="command('leave')"
                >{{ t('hextechRoom.leave') }}</NButton
              >
              <NButton
                size="small"
                :disabled="!canSearch || store.busy"
                @click="command('continue')"
                >{{ t('hextechRoom.continue') }}</NButton
              >
            </div>
            <NAlert v-if="error" type="error" :show-icon="false">{{ error }}</NAlert>
            <div class="flex flex-wrap items-center gap-3 text-sm">
              <NTag size="small">{{
                t(`hextechRoom.phases.${store.status?.state ?? 'idle'}`)
              }}</NTag>
              <span>{{
                t('hextechRoom.matched', { count: store.status?.eligibleCount ?? 0 })
              }}</span>
              <span>{{
                t('hextechRoom.cooling', { count: store.status?.cooldownCount ?? 0 })
              }}</span>
              <span>{{
                t('hextechRoom.lastRefresh', { time: formatTime(store.status?.lastRefreshAt) })
              }}</span>
            </div>
            <div v-if="store.status?.selectedSummary" class="text-sm">
              {{ store.status.selectedSummary }}
            </div>
            <NText v-if="store.status?.belowFloor" depth="3">{{
              t('hextechRoom.floorWait', { seconds: secondsUntil(store.status.watchDeadlineAt) })
            }}</NText>
            <NText v-if="store.status?.nextRoomRetryAt" depth="3">{{
              t('hextechRoom.retryWait', { seconds: secondsUntil(store.status.nextRoomRetryAt) })
            }}</NText>
            <NText v-if="!canSearch" depth="3">{{ t('hextechRoom.unavailable') }}</NText>
          </div>
        </SettingsSection>
        <SettingsSection :title="t('hextechAugment.title')">
          <SettingsRow
            :label="t('hextechAugment.enabled')"
            :label-description="t('hextechAugment.description')"
          >
            <NSwitch :value="augmentStore.settings.enabled" @update:value="setAugmentEnabled" />
          </SettingsRow>
          <div class="flex flex-col gap-2 p-3 text-sm">
            <NAlert v-if="augmentStore.settings.enabled" type="info" :show-icon="false">
              {{ t('hextechAugment.displayHelp') }}
            </NAlert>
            <NText depth="3">{{ t(`hextechAugment.statuses.${augmentStore.status}`) }}</NText>
            <NAlert v-if="augmentStore.error" type="warning" :show-icon="false">{{
              augmentStore.error
            }}</NAlert>
            <NText v-if="augmentStore.diagnostics" depth="3">{{
              t('hextechAugment.diagnostics', {
                time: formatTime(augmentStore.diagnostics.capturedAt),
                milliseconds: augmentStore.diagnostics.elapsedMs,
                words: augmentStore.diagnostics.wordCount,
                names: augmentStore.diagnostics.dictionarySize,
                cards: augmentStore.diagnostics.matchedCards
              })
            }}</NText>
            <template v-if="augmentStore.snapshot">
              <NText depth="3">{{
                t('hextechAugment.latency', { milliseconds: augmentStore.snapshot.recognitionMs })
              }}</NText>
              <NText depth="3">{{
                t('hextechAugment.source', {
                  source: augmentStore.snapshot.source ?? '—',
                  patch: augmentStore.snapshot.patch ?? t('hextechAugment.versionUnknown'),
                  time: formatTime(augmentStore.snapshot.fetchedAt ?? undefined)
                })
              }}</NText>
            </template>
          </div>
        </SettingsSection>
        <SettingsSection :title="t('hextechRoom.settings')">
          <SettingsRow
            :label="t('hextechRoom.keywords')"
            :label-description="t('hextechRoom.keywordsHelp')"
          >
            <NInput class="w-60!" size="small" v-model:value="keywords" :disabled="store.busy" />
          </SettingsRow>
          <SettingsRow :label="t('hextechRoom.minPlayers')"
            ><NInputNumber
              size="small"
              class="w-40!"
              :min="0"
              :max="10"
              :precision="0"
              v-model:value="draft.minPlayers"
          /></SettingsRow>
          <SettingsRow :label="t('hextechRoom.pollInterval')"
            ><NInputNumber
              size="small"
              class="w-40!"
              :min="500"
              :max="30000"
              :step="500"
              :precision="0"
              v-model:value="draft.pollIntervalMs"
          /></SettingsRow>
          <SettingsRow
            :label="t('hextechRoom.stallTimeout')"
            :label-description="t('hextechRoom.stallHelp')"
            ><NInputNumber
              size="small"
              class="w-40!"
              :min="0"
              :max="300000"
              :step="1000"
              :precision="0"
              v-model:value="draft.stallTimeoutMs"
          /></SettingsRow>
          <SettingsRow :label="t('hextechRoom.maxInvites')"
            ><NInputNumber
              size="small"
              class="w-40!"
              :min="0"
              :max="50"
              :precision="0"
              v-model:value="draft.maxInvites"
          /></SettingsRow>
          <div class="flex justify-end p-3">
            <NButton size="small" :loading="saving" @click="save">{{
              t('hextechRoom.save')
            }}</NButton>
          </div>
        </SettingsSection>
        <SettingsSection :title="t('hextechRoom.logs')">
          <NEmpty v-if="!store.logs.length" class="p-6" :description="t('hextechRoom.noLogs')" />
          <NScrollbar v-else class="max-h-80">
            <div class="flex flex-col gap-2 p-3 text-xs">
              <div
                v-for="(entry, index) in recentLogs"
                :key="`${entry.timestamp}-${index}`"
                class="flex gap-3"
              >
                <NText depth="3" class="shrink-0">{{ formatTime(entry.timestamp) }}</NText>
                <span>{{ eventText(entry) }}</span>
              </div>
            </div>
          </NScrollbar>
        </SettingsSection>
      </div>
    </NScrollbar>
  </div>
</template>

<script setup lang="ts">
import SettingsRow from '@renderer-shared/components/SettingsRow.vue'
import SettingsSection from '@renderer-shared/components/SettingsSection.vue'
import { useInstance } from '@renderer-shared/shards'
import { HextechAugmentRenderer } from '@renderer-shared/shards/hextech-augment'
import { useHextechAugmentStore } from '@renderer-shared/shards/hextech-augment/store'
import { HextechRoomRenderer } from '@renderer-shared/shards/hextech-room'
import { useHextechRoomStore } from '@renderer-shared/shards/hextech-room/store'
import { useLeagueClientStore } from '@renderer-shared/shards/league-client/store'
import type { HextechRoomLog } from '@shared/types/hextech-room'
import { useNow } from '@vueuse/core'
import { useTranslation } from 'i18next-vue'
import {
  NAlert,
  NButton,
  NEmpty,
  NInput,
  NInputNumber,
  NScrollbar,
  NSwitch,
  NTag,
  NText
} from 'naive-ui'
import { computed, reactive, ref, watch } from 'vue'

const { t } = useTranslation()
const store = useHextechRoomStore()
const leagueClient = useLeagueClientStore()
const room = useInstance(HextechRoomRenderer)
const augment = useInstance(HextechAugmentRenderer)
const augmentStore = useHextechAugmentStore()
const draft = reactive({ ...store.settings.configuration })
const keywords = ref(draft.nameKeywords.join(', '))
const error = ref('')
const saving = ref(false)
const now = useNow({ interval: 500 })
const canSearch = computed(
  () =>
    leagueClient.isConnected &&
    (!leagueClient.gameflow.phase || ['None', 'Lobby'].includes(leagueClient.gameflow.phase))
)
const recentLogs = computed(() => [...store.logs].reverse())
const formatTime = (timestamp?: number) =>
  timestamp ? new Date(timestamp).toLocaleTimeString() : '—'
const secondsUntil = (timestamp?: number) =>
  timestamp ? Math.max(0, Math.ceil((timestamp - now.value.getTime()) / 1000)) : 0

watch(
  () => store.settings.configuration,
  (configuration) => {
    Object.assign(draft, configuration)
    keywords.value = configuration.nameKeywords.join(', ')
  }
)

async function command(action: 'start' | 'stop' | 'leave' | 'continue') {
  error.value = ''
  try {
    await room.command(action)
  } catch (caught) {
    error.value = String(caught)
  }
}

async function setAugmentEnabled(enabled: boolean) {
  try {
    await augment.setEnabled(enabled)
  } catch (caught) {
    error.value = String(caught)
  }
}

async function save() {
  error.value = ''
  saving.value = true
  try {
    await room.configure({
      ...draft,
      nameKeywords: keywords.value
        .split(/[,，\n]/)
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    })
  } catch (caught) {
    error.value = String(caught)
  } finally {
    saving.value = false
  }
}

function eventText(entry: HextechRoomLog) {
  if (entry.message) return entry.message
  if (entry.type === 'sweep-exhausted')
    return t('hextechRoom.sweepFinished', {
      count: entry.count ?? 0,
      seconds: Math.ceil((entry.retryInMs ?? 0) / 1000)
    })
  if (entry.type === 'no-match') return t('hextechRoom.noMatch', { count: entry.count ?? 0 })
  if (entry.type === 'stopped') return t('hextechRoom.stopped')
  if (entry.type === 'configured') return t('hextechRoom.saved')
  if (entry.type === 'left') return t('hextechRoom.left')
  return t(`hextechRoom.phases.${entry.state ?? 'idle'}`)
}
</script>
