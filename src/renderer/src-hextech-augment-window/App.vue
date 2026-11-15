<template>
  <SetupInAppScope />
  <div v-if="snapshot" class="augment-overlay" aria-live="polite">
    <div
      v-for="(label, slot) in snapshot.labels"
      :key="`${slot}-${label.id}`"
      class="augment-label"
      :style="position(label)"
    >
      <div class="augment-name">{{ label.name }}</div>
      <div class="augment-rating">
        <span class="augment-tier" :data-tier="label.tier">{{ label.tier ?? '—' }}</span
        ><span>{{
          label.performance === null
            ? t('hextechAugment.noData')
            : t('hextechAugment.performance', { value: label.performance })
        }}</span>
      </div>
      <div class="augment-source">
        {{ snapshot.source ?? t('hextechAugment.noSource') }} ·
        {{ snapshot.patch ?? t('hextechAugment.versionUnknown') }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useColorThemeAttr } from '@renderer-shared/composables/useColorThemeAttr'
import { useAppCommonStore } from '@renderer-shared/shards/app-common/store'
import { useHextechAugmentStore } from '@renderer-shared/shards/hextech-augment/store'
import { SetupInAppScope } from '@renderer-shared/shards/setup-in-app-scope/setup-in-app-scope-component'
import type { HextechAugmentLabel } from '@shared/types/hextech-augment'
import { useTranslation } from 'i18next-vue'
import { useNow } from '@vueuse/core'
import { computed } from 'vue'

const store = useHextechAugmentStore()
const appCommon = useAppCommonStore()
const { t } = useTranslation()
const now = useNow({ interval: 100 })
const snapshot = computed(() =>
  store.snapshot && now.value.getTime() - store.snapshot.capturedAt <= 1200 ? store.snapshot : null
)
useColorThemeAttr(
  () => appCommon.colorTheme,
  () => appCommon.themeId
)
function position(label: HextechAugmentLabel) {
  if (!snapshot.value) return {}
  return {
    left: `${(100 * (label.x + label.width / 2)) / snapshot.value.window.width}%`,
    top: `${(100 * label.y) / snapshot.value.window.height}%`
  }
}
</script>

<style>
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
  pointer-events: none;
}
.augment-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: 'Microsoft YaHei', sans-serif;
  color: #f4f5f8;
}
.augment-label {
  position: absolute;
  transform: translate(-50%, -115%);
  min-width: 150px;
  max-width: 240px;
  padding: 7px 12px;
  border: 1px solid rgb(255 255 255 / 25%);
  border-radius: 8px;
  background: rgb(13 17 27 / 90%);
  box-shadow: 0 2px 12px rgb(0 0 0 / 35%);
  text-align: center;
}
.augment-name {
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.augment-rating {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12px;
}
.augment-tier {
  font-size: 28px;
  font-weight: 800;
  line-height: 34px;
  color: #c7cbd4;
}
.augment-tier[data-tier='S'] {
  color: #d7b4ff;
}
.augment-tier[data-tier='A'] {
  color: #90c5ff;
}
.augment-tier[data-tier='B'] {
  color: #83e4b5;
}
.augment-source {
  font-size: 10px;
  line-height: 16px;
  opacity: 0.65;
}
</style>
