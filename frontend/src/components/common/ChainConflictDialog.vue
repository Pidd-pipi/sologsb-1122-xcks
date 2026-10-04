<script setup lang="ts">
import type { ChainConflict } from '../../types/chain';
import { formatChainage } from '../../utils/geoMath';

defineProps<{
  modelValue: boolean;
  conflicts: ChainConflict[];
  summary?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 确认提交：强制入链并重算相邻区间 */
  (e: 'resolve'): void;
  /** 放弃草稿 */
  (e: 'discard'): void;
}>();

const typeTag: Record<ChainConflict['type'], { label: string; type: 'danger' | 'warning' | 'info' }> = {
  overlap: { label: '区间重叠', type: 'danger' },
  concurrent: { label: '已被别人改过', type: 'warning' },
  pending: { label: '区间待整理', type: 'info' },
};

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog :model-value="modelValue" title="提交冲突：已保留为草稿" width="560px" @update:model-value="emit('update:modelValue', $event)">
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="提交未入链，草稿已保留"
      description="检测到下列冲突。为避免覆盖相邻编录的连续里程，本次内容已存入草稿箱，可在整理后重新提交；确认无误也可强制入链并自动重算相邻区间、节理位置与涌水趋势。"
      style="margin-bottom: 12px"
    />
    <div v-if="summary" class="summary">{{ summary }}</div>
    <div class="conflict-list">
      <div v-for="(c, i) in conflicts" :key="i" class="conflict-item">
        <el-tag :type="typeTag[c.type].type" size="small">{{ typeTag[c.type].label }}</el-tag>
        <span class="msg">{{ c.message }}</span>
        <span v-if="c.interval" class="interval">
          {{ formatChainage(c.interval[0]) }} ~ {{ formatChainage(c.interval[1]) }}
        </span>
      </div>
    </div>
    <template #footer>
      <el-button @click="close">关闭</el-button>
      <el-button type="danger" plain @click="emit('discard')">放弃草稿</el-button>
      <el-button type="primary" @click="emit('resolve')">确认提交（重算相邻区间）</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.summary {
  font-weight: 600;
  margin-bottom: 10px;
  color: #2f3a46;
}
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conflict-item {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  background: #f7f8fa;
  border-radius: 6px;
}
.msg {
  color: #5b6470;
  font-size: 13px;
}
.interval {
  margin-left: auto;
  color: #97a0ad;
  font-size: 12px;
}
</style>
