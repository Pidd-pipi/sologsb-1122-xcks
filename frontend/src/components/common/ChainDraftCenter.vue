<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { useChainStore } from '../../stores/chainStore';
import type { TunnelFace } from '../../types/face';
import type { ChainDraft } from '../../types/chain';
import { formatChainage } from '../../utils/geoMath';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  /** 草稿/待整理变动后通知父级刷新 */
  (e: 'changed'): void;
}>();

const chainStore = useChainStore();

const pendingFaces = ref<TunnelFace[]>([]);
const drafts = ref<ChainDraft[]>([]);
const loading = ref(false);

const kindLabel: Record<ChainDraft['kind'], string> = {
  face: '掌子面',
  joint: '节理',
  water: '涌水',
};

async function refresh() {
  loading.value = true;
  const [faces, list] = await Promise.all([chainStore.fetchPendingFaces(), chainStore.fetchActiveDrafts()]);
  pendingFaces.value = faces;
  drafts.value = list;
  loading.value = false;
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void refresh();
  },
);

async function recomputeFace(face: TunnelFace) {
  await chainStore.recomputePending(face.id);
  ElMessage.success(`已以 ${face.faceNo} 区间为锚点重算相邻区间，共推进到链 v${chainStore.version}`);
  await refresh();
  emit('changed');
}

async function resolve(draft: ChainDraft) {
  const res = await chainStore.resolveDraft(draft.id);
  if (res.ok) {
    ElMessage.success(`已确认入链，里程链推进到 v${chainStore.version}`);
    await refresh();
    emit('changed');
  } else {
    ElMessage.warning('该草稿仍存在冲突，请调整后再提交');
  }
}

async function discard(draft: ChainDraft) {
  await chainStore.discardDraft(draft.id);
  ElMessage.info('已放弃草稿');
  await refresh();
  emit('changed');
}

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="草稿箱 · 待整理数据"
    width="820px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="重叠数据不丢弃"
      description="升级前相互重叠的掌子面区间保留在下方待整理；冲突提交的内容保留为草稿。确认后将以指定区间为锚点重算相邻区间，保持里程连续。"
      style="margin-bottom: 12px"
    />

    <div v-loading="loading">
      <el-card shadow="never" style="margin-bottom: 12px">
        <template #header><strong>待整理掌子面区间（{{ pendingFaces.length }}）</strong></template>
        <el-table :data="pendingFaces" size="small" border>
          <el-table-column label="掌子面编号" prop="faceNo" width="120" />
          <el-table-column label="重叠区间" min-width="200">
            <template #default="{ row }">
              {{ formatChainage(row.mileageRange[0]) }} ~ {{ formatChainage(row.mileageRange[1]) }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default>
              <el-tag type="danger" size="small">待整理</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="170">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="recomputeFace(row)">重算相邻区间</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loading && pendingFaces.length === 0" description="没有待整理的重叠区间" :image-size="50" />
      </el-card>

      <el-card shadow="never">
        <template #header><strong>冲突草稿（{{ drafts.length }}）</strong></template>
        <el-table :data="drafts" size="small" border>
          <el-table-column label="类型" width="80">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ kindLabel[(row as ChainDraft).kind] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="内容" min-width="200">
            <template #default="{ row }">
              <div>{{ row.summary }}</div>
              <div v-for="(c, i) in row.conflicts" :key="i" class="conflict-msg">· {{ c.message }}</div>
            </template>
          </el-table-column>
          <el-table-column label="基线" width="90">
            <template #default="{ row }">v{{ row.baseVersion }}</template>
          </el-table-column>
          <el-table-column label="提交时间" width="160">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="操作" width="150">
            <template #default="{ row }">
              <el-button size="small" type="primary" @click="resolve(row)">确认重算</el-button>
              <el-button size="small" danger plain @click="discard(row)">放弃</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="!loading && drafts.length === 0" description="没有保留的冲突草稿" :image-size="50" />
      </el-card>
    </div>

    <template #footer>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.conflict-msg {
  color: #d93025;
  font-size: 12px;
  line-height: 1.6;
}
</style>
