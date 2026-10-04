<script setup lang="ts">
import { useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import type { FaceDraftRecord } from '../../types/chain';
import { useChainStore } from '../../stores/chainStore';
import { formatChainage } from '../../utils/geoMath';

const props = defineProps<{
  drafts: FaceDraftRecord[];
  /** 编辑模式：不显示"用此草稿新建/修改"的跳转按钮，只允许解决后重提 */
  embedded?: boolean;
}>();

const emit = defineEmits<{
  (e: 'resubmit', draft: FaceDraftRecord): void;
}>();

const router = useRouter();
const chainStore = useChainStore();

async function discard(d: FaceDraftRecord) {
  await ElMessageBox.confirm(`确定丢弃草稿「${d.faceNo}」？丢弃后需重新录入。`, '丢弃冲突草稿', {
    type: 'warning',
  });
  await chainStore.discardDraft(d.id);
}

async function rebase(d: FaceDraftRecord) {
  await chainStore.rebaseDraft(d.id);
  emit('resubmit', { ...d, baseRevision: chainStore.revision });
}

function openFace(d: FaceDraftRecord) {
  if (d.mode === 'update' && d.faceId) void router.push(`/faces/${d.faceId}`);
}

function hasStale(d: FaceDraftRecord): boolean {
  return d.conflicts.some((c) => c.kind === 'stale');
}
</script>

<template>
  <el-table :data="drafts" size="small" border>
    <el-table-column label="类型" width="90">
      <template #default="{ row }">
        <el-tag size="small" :type="row.mode === 'create' ? 'primary' : 'warning'">
          {{ row.mode === 'create' ? '新建' : '修改' }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column prop="faceNo" label="编号" width="100" />
    <el-table-column label="提交区间" min-width="180">
      <template #default="{ row }">
        {{ formatChainage(row.mileageRange[0]) }} ~ {{ formatChainage(row.mileageRange[1]) }}
      </template>
    </el-table-column>
    <el-table-column label="冲突" min-width="260">
      <template #default="{ row }">
        <div v-for="(c, i) in row.conflicts" :key="i" class="conflict">
          <el-tag size="small" :type="c.kind === 'stale' ? 'danger' : 'warning'" effect="plain">
            {{ c.kind === 'stale' ? '已被他人改过' : '区间重叠' }}
          </el-tag>
          <span>{{ c.message }}</span>
        </div>
      </template>
    </el-table-column>
    <el-table-column prop="updatedBy" label="提交人" width="110" />
    <el-table-column label="依据版本" width="90">
      <template #default="{ row }">
        <el-tag size="small" effect="plain" :type="row.baseRevision < chainStore.revision ? 'danger' : 'info'">
          v{{ row.baseRevision }}
        </el-tag>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="240">
      <template #default="{ row }">
        <el-button size="small" type="primary" @click="emit('resubmit', row)">调整后重提</el-button>
        <el-button v-if="hasStale(row)" size="small" @click="rebase(row)">
          仍按此里程
        </el-button>
        <el-button
          v-if="!embedded && row.mode === 'update' && row.faceId"
          size="small"
          @click="openFace(row)"
        >
          打开掌子面
        </el-button>
        <el-button size="small" danger @click="discard(row)">丢弃</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>

<style scoped>
.conflict {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.8;
}
</style>
