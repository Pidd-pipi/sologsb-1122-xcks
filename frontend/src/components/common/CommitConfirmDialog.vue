<script setup lang="ts">
import { computed } from 'vue';
import type { CommitPlan } from '../../utils/chain';
import type { TunnelFace } from '../../types/face';
import type { JointSet } from '../../types/joint';
import type { WaterInflow } from '../../types/water';
import { formatChainage } from '../../utils/geoMath';

const props = defineProps<{
  plan: CommitPlan;
  faces: TunnelFace[];
  joints: JointSet[];
  waters: WaterInflow[];
  mode: 'create' | 'update';
}>();

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const faceById = computed(() => new Map(props.faces.map((f) => [f.id, f])));
const jointById = computed(() => new Map(props.joints.map((j) => [j.id, j])));
const waterById = computed(() => new Map(props.waters.map((w) => [w.id, w])));

function rangeText(r: [number, number]): string {
  return `${formatChainage(r[0])} ~ ${formatChainage(r[1])}`;
}

const movedWaters = computed(() =>
  props.plan.waters
    .map((ww) => ({ write: ww, current: waterById.value.get(ww.id) }))
    .filter((x) => x.current && Math.abs(x.current.chainage - x.write.chainage) > 1e-6),
);

const trendRecount = computed(() =>
  props.plan.waters.filter(
    (ww) =>
      !movedWaters.value.some((m) => m.write.id === ww.id) &&
      ww.derivedTrend !== (waterById.value.get(ww.id)?.derivedTrend ?? waterById.value.get(ww.id)?.changeTrend),
  ).length,
);
const versionOnlyWaters = computed(() => props.plan.waters.length - movedWaters.value.length - trendRecount.value);

const clampedJoints = computed(() =>
  props.plan.clamped
    .filter((c) => c.kind === 'joint')
    .map((c) => ({ c, joint: jointById.value.get(c.id) })),
);
const clampedWaters = computed(() =>
  props.plan.clamped
    .filter((c) => c.kind === 'water')
    .map((c) => ({ c, water: waterById.value.get(c.id) })),
);
</script>

<template>
  <el-dialog :model-value="true" title="确认里程链重算" width="760px" :close-on-click-modal="false" @close="emit('cancel')">
    <el-alert type="info" :closable="false" style="margin-bottom: 12px">

        确认后里程链将提交为 <strong>v{{ plan.newRevision }}</strong>：相邻区间、节理位置与涌水趋势会按下列明细重算；
        人工确认的级别结论保留不变。
      </el-alert>

    <el-descriptions :column="1" border size="small" title="目标掌子面">
      <el-descriptions-item label="操作">{{ mode === 'create' ? '新建入链' : '修改里程' }}</el-descriptions-item>
      <el-descriptions-item label="里程区间">
        {{ rangeText(plan.target.mileageRange) }}（桩号 {{ formatChainage(plan.target.chainage) }}）
        <el-tag v-if="plan.target.status === 'active'" size="small" type="success" style="margin-left: 6px">
          {{ mode === 'update' && faceById.get(plan.target.id)?.status === 'pending' ? '待整理 → 激活' : '正式入链' }}
        </el-tag>
      </el-descriptions-item>
    </el-descriptions>

    <el-divider content-position="left">相邻区间重算（{{ plan.neighbors.length }} 个）</el-divider>
    <el-table v-if="plan.neighbors.length" :data="plan.neighbors" size="small" border>
      <el-table-column label="掌子面" min-width="110">
        <template #default="{ row }">{{ faceById.get(row.id)?.faceNo ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="原区间" min-width="170">
        <template #default="{ row }">
          {{ faceById.get(row.id) ? rangeText(faceById.get(row.id)!.mileageRange) : '—' }}
        </template>
      </el-table-column>
      <el-table-column label="重算后" min-width="170">
        <template #default="{ row }">{{ rangeText(row.mileageRange) }}</template>
      </el-table-column>
      <el-table-column label="桩号" width="120">
        <template #default="{ row }">{{ formatChainage(row.chainage) }}</template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="无端点相接的相邻区间" :image-size="50" />

    <el-divider content-position="left">节理位置重算（{{ plan.joints.length }} 条）</el-divider>
    <el-table v-if="plan.joints.length" :data="plan.joints" size="small" border max-height="180">
      <el-table-column label="所属掌子面" min-width="100">
        <template #default="{ row }">{{ faceById.get(jointById.get(row.id)?.faceId ?? '')?.faceNo ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="节理组" width="80">
        <template #default="{ row }">J{{ jointById.get(row.id)?.setNo ?? '?' }}</template>
      </el-table-column>
      <el-table-column label="新里程" min-width="130">
        <template #default="{ row }">{{ formatChainage(row.chainage) }}（r{{ row.recordVersion }}）</template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="无需重算的节理" :image-size="50" />
    <el-alert
      v-if="clampedJoints.length"
      type="warning"
      :closable="false"
      style="margin-top: 6px"
      :title="`${clampedJoints.length} 条节理按比例映射后越界，已钳制到新区间边界`"
    />

    <el-divider content-position="left">涌水位置与趋势</el-divider>
    <ul class="summary">
      <li>随动重定位涌水点 <strong>{{ movedWaters.length }}</strong> 个</li>
      <li>沿新里程链重新推导趋势的涌水点 <strong>{{ trendRecount }}</strong> 个（人工填写的趋势记录保留并并排显示）</li>
      <li v-if="versionOnlyWaters > 0">相邻区间内仅同步依据版本的涌水点 <strong>{{ versionOnlyWaters }}</strong> 个</li>
    </ul>
    <el-table v-if="movedWaters.length" :data="movedWaters" size="small" border max-height="160">
      <el-table-column label="出水部位" min-width="140">
        <template #default="{ row }">{{ row.current?.position ?? '—' }}</template>
      </el-table-column>
      <el-table-column label="原里程" width="130">
        <template #default="{ row }">{{ formatChainage(row.current!.chainage) }}</template>
      </el-table-column>
      <el-table-column label="新里程" width="130">
        <template #default="{ row }">{{ formatChainage(row.write.chainage) }}</template>
      </el-table-column>
    </el-table>
    <el-alert
      v-if="clampedWaters.length"
      type="warning"
      :closable="false"
      style="margin-top: 6px"
      :title="`${clampedWaters.length} 个涌水点映射后越界，已钳制到区间边界`"
    />

    <el-divider content-position="left">保留的人工级别结论（{{ plan.preservedGrades.length }} 条）</el-divider>
    <el-table v-if="plan.preservedGrades.length" :data="plan.preservedGrades" size="small" border>
      <el-table-column label="掌子面" min-width="100">
        <template #default="{ row }">{{ faceById.get(row.faceId)?.faceNo ?? '—' }}</template>
      </el-table-column>
      <el-table-column prop="grade" label="级别" width="80" />
      <el-table-column label="依据版本" min-width="180">
        <template #default="{ row }">
          链 v{{ row.version?.chainRevision ?? '?' }} · 记录 r{{ row.version?.recordVersion ?? '?' }} ·
          {{ rangeText(row.version?.basisRange ?? [0, 0]) }}
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="本次重算不涉及人工确认级别" :image-size="50" />

    <template #footer>
      <el-button @click="emit('cancel')">取消</el-button>
      <el-button type="primary" @click="emit('confirm')">确认提交（链版本 → v{{ plan.newRevision }}）</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.summary {
  margin: 0 0 8px;
  padding-left: 18px;
  color: #5b6470;
  font-size: 13px;
  line-height: 1.9;
}
</style>
