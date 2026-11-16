<template>
  <div id="aux-window-frame">
    <SetupInAppScope />
    <AuxWindowTitlebar />
    <div class="content">
      <IndicatorView />
    </div>
    <MayhemAugmentControl class="mx-3 mb-3 shrink-0" />
  </div>
</template>

<script setup lang="ts">
import { SetupInAppScope } from '@renderer-shared/shards/setup-in-app-scope/setup-in-app-scope-component'
import MayhemAugmentControl from '@renderer-shared/shards/hextech-augment/MayhemAugmentControl.vue'

import AuxWindowTitlebar from './components/AuxWindowTitlebar.vue'
import IndicatorView from './views/Indicator.vue'
</script>

<style>
#aux-window-frame {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: var(--la-app-min-width);
  min-height: var(--la-app-min-height);

  > .content {
    height: 0;
    flex: 1;
    overflow: hidden;
  }
}
</style>
