<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useFaceStore } from '../stores/faceStore';
import { useGradeStore } from '../stores/gradeStore';
import { useJointStore } from '../stores/jointStore';
import { useChainStore } from '../stores/chainStore';
import { useGradeCalc } from '../hooks/useGradeCalc';
import { useFaceSubmit } from '../hooks/useFaceSubmit';
import SketchCanvas from '../components/common/SketchCanvas.vue';
import GradeTag from '../components/common/GradeTag.vue';
import ConflictPanel from '../components/common/ConflictPanel.vue';
import CommitConfirmDialog from '../components/common/CommitConfirmDialog.vue';
import { attitudeText, formatChainage } from '../utils/geoMath';
import { GRADE_SUPPORT } from '../types/grade';
import { isVersionStale } from '../utils/chain';
import type { FaceDraftRecord } from '../types/chain';

const route = useRoute();
const router = useRouter();
const faceStore = useFaceStore();
const jointStore = useJointStore();
const gradeStore = useGradeStore();
const chainStore = useChainStore();

const faceId = computed(() => String(route.params.id ?? ''));
const face = computed(() => faceStore.byId(faceId.value));
const joints = computed(() => jointStore.byFace(faceId.value));
const grades = computed(() => gradeStore.byFace(faceId.value));
const latest = computed(() => grades.value[0]);
const previousGrade = computed(() => grades.value[1]);
const faceDrafts = computed(() => chainStore.drafts.filter((d) => d.faceId === faceId.value));

const { result, patch } = useGradeCalc(() => joints.value);
const segmentCount = ref(0);

const { plan, currentRevision, stage, confirm, cancelConfirm } = useFaceSubmit();

const editVisible = ref(false);
const editError = ref('');
const editForm = reactive({
  chainage: 0,
  mileageRange: [0, 0] as [number, number],
  operator: '',
});
const editBaseRevision = ref(0);
const editDraftId = ref<string | null>(null);

function openMileageDialog(draft?: FaceDraftRecord) {
  if (!face.value) return;
  editError.value = '';
  if (draft) {
    editBaseRevision.value = draft.baseRevision;
    editDraftId.value = draft.id;
    editForm.chainage = draft.chainage;
    editForm.mileageRange = [...draft.mileageRange] as [number, number];
    editForm.operator = draft.updatedBy;
  } else {
    // 主动改里程：始终以当前链版本为依据，避免页面挂得久造成误判 stale
    editBaseRevision.value = chainStore.revision;
    editDraftId.value = null;
    editForm.chainage = face.value.chainage;
    editForm.mileageRange = [...face.value.mileageRange] as [number, number];
    editForm.operator = '';
  }
  editVisible.value = true;
}

async function submitMileage() {
  editError.value = '';
  if (!face.value) return;
  if (editForm.mileageRange[1] < editForm.mileageRange[0]) {
    editError.value = '编录里程区间终点不能小于起点';
    return;
  }
  const ok = await stage({
    mode: 'update',
    faceId: face.value.id,
    baseRevision: editBaseRevision.value,
    faceNo: face.value.faceNo,
    chainage: editForm.chainage,
    mileageRange: [...editForm.mileageRange] as [number, number],
    updatedBy: editForm.operator.trim() || face.value.geologist,
    activate: face.value.status === 'pending',
  });
  if (ok) {
    editVisible.value = false;
  } else {
    editVisible.value = false;
    ElMessage.warning('里程冲突，草稿已保留在下方冲突列表');
  }
}

async function onConfirmed() {
  const ok = await confirm();
  if (ok && editDraftId.value) {
    await chainStore.discardDraft(editDraftId.value);
    editDraftId.value = null;
    if (route.query.draft) router.replace({ query: {} });
  }
}

function onResubmit(draft: FaceDraftRecord) {
  openMileageDialog(draft);
}

/** SketchCanvas 变更回调（用命名函数避免模板内联箭头参数丢类型） */
function onSketchChange(segs: { id: string }[]): void {
  segmentCount.value = segs.length;
}

/** 与上循环级别比对结论 */
const gradeCompare = computed(() => {
  if (!latest.value) return '本掌子面尚无级别判定记录';
  if (!previousGrade.value) return `本掌子面首次判定为 ${latest.value.grade} 级围岩`;
  const order = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ'];
  const delta = order.indexOf(latest.value.grade) - order.indexOf(previousGrade.value.grade);
  if (delta === 0) return `与上一循环一致（${latest.value.grade} 级）`;
  return delta > 0
    ? `较上一循环变差 ${delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`
    : `较上一循环变好 ${-delta} 级：${previousGrade.value.grade} → ${latest.value.grade}`;
});

const gradeStale = computed(
  () => latest.value && isVersionStale(latest.value.version, currentRevision.value),
);

watch(faceId, () => {
  // 路由切换（草稿跳转）后若带 activate/draft 参数则自动打开编辑框
  void tryOpenFromQuery();
});

async function tryOpenFromQuery() {
  if (route.query.activate !== undefined || route.query.draft) {
    const draftId = typeof route.query.draft === 'string' ? route.query.draft : undefined;
    const draft = draftId ? chainStore.drafts.find((d) => d.id === draftId) : undefined;
    openMileageDialog(draft);
    if (route.query.activate !== undefined) router.replace({ query: {} });
  }
}

onMounted(async () => {
  await chainStore.load();
  await faceStore.load();
  await jointStore.load();
  await gradeStore.load();
  if (face.value) {
    patch({ rockStrength: face.value.rockStrength, spanWidth: Number(face.value.faceSize.split('×')[0]) || 12 });
  }
  await tryOpenFromQuery();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>掌子面详情 · {{ face?.faceNo ?? '未找到' }}</h2>
      <GradeTag v-if="latest && face?.status !== 'pending'" :grade="latest.grade" />
      <el-tag v-else-if="face?.status === 'pending'" type="warning">里程待整理 · 未入链</el-tag>
      <el-tag v-else type="info">未判定级别</el-tag>
      <el-tag type="info" effect="plain">节理 {{ joints.length }} 组</el-tag>
      <el-tag type="info" effect="plain">里程链 v{{ currentRevision }}</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openMileageDialog()">修改里程</el-button>
      <el-button @click="router.push(`/faces/${faceId}/joints`)">节理录入</el-button>
      <el-button @click="router.push(`/faces/${faceId}/water`)">涌水记录</el-button>
      <el-button @click="router.push(`/grade/${faceId}`)">围岩级别判定</el-button>
      <el-button @click="router.push('/faces')">返回台账</el-button>
    </div>

    <el-alert v-if="!face" type="warning" :closable="false" show-icon title="未找到该掌子面（可能已被删除）" />

    <el-alert
      v-if="face?.status === 'pending'"
      type="warning"
      show-icon
      :closable="false"
      title="该掌子面里程区间与其它编录重叠（旧数据升级检出），目前处于「待整理」状态，未进入里程链"
    >
      <div style="margin-top: 6px">
        <el-button size="small" type="primary" @click="openMileageDialog()">调整里程并激活入链</el-button>
      </div>
    </el-alert>

    <el-card v-if="faceDrafts.length" shadow="never">
      <template #header><strong>本掌子面的冲突草稿（{{ faceDrafts.length }}）</strong></template>
      <ConflictPanel :drafts="faceDrafts" embedded @resubmit="onResubmit" />
    </el-card>

    <div v-if="face" class="grid">
      <div class="left">
        <el-card shadow="never">
          <template #header><strong>基本信息</strong></template>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="掌子面编号">{{ face.faceNo }}</el-descriptions-item>
            <el-descriptions-item label="里程桩号">{{ formatChainage(face.chainage) }}</el-descriptions-item>
            <el-descriptions-item label="编录里程区间">
              {{ formatChainage(face.mileageRange[0]) }} ~ {{ formatChainage(face.mileageRange[1]) }}
            </el-descriptions-item>
            <el-descriptions-item label="开挖方式">{{ face.excavationMethod }}</el-descriptions-item>
            <el-descriptions-item label="开挖断面尺寸">{{ face.faceSize }} m</el-descriptions-item>
            <el-descriptions-item label="岩性 / 风化">{{ face.lithology }} / {{ face.weathering }}</el-descriptions-item>
            <el-descriptions-item label="饱和抗压强度">{{ face.rockStrength }} MPa</el-descriptions-item>
            <el-descriptions-item label="岩层产状">
              走向 {{ face.attitude.strike }}° · {{ attitudeText(face.attitude.dipDirection, face.attitude.dipAngle) }}
            </el-descriptions-item>
            <el-descriptions-item label="地质员">{{ face.geologist }}</el-descriptions-item>
            <el-descriptions-item label="编录时间">
              {{ new Date(face.recordedAt).toLocaleString('zh-CN') }}
            </el-descriptions-item>
            <el-descriptions-item label="里程版本">
              <el-tag size="small" effect="plain">链 v{{ face.version?.chainRevision ?? '?' }}</el-tag>
              <el-tag size="small" effect="plain" style="margin-left: 6px">记录 r{{ face.version?.recordVersion ?? '?' }}</el-tag>
              <el-tag v-if="face.updatedBy" size="small" type="info" effect="plain" style="margin-left: 6px">
                最后改里程：{{ face.updatedBy }}
              </el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </el-card>

        <el-card shadow="never">
          <template #header><strong>级别与支护</strong></template>
          <div v-if="latest" class="grade-box">
            <div class="grade-line">
              <GradeTag :grade="latest.grade" />
              <el-tag v-if="latest.manualAdjusted" type="warning" size="small">人工确认结论 · 里程重算不覆盖</el-tag>
              <el-tag v-if="gradeStale" type="danger" size="small" effect="plain">
                依据链 v{{ latest.version?.chainRevision ?? '?' }}（当前 v{{ currentRevision }}）
              </el-tag>
              <el-tag v-else size="small" type="success" effect="plain">
                依据当前链 v{{ latest.version?.chainRevision ?? '?' }}
              </el-tag>
            </div>
            <span class="muted">[BQ] = {{ latest.correctedBq }}（BQ {{ latest.bqValue }}，修正 {{ latest.correction }}）</span>
            <p class="support">{{ latest.supportSuggestion || GRADE_SUPPORT[latest.grade] }}</p>
            <p class="muted">
              {{ gradeCompare }} · 结论保存于
              {{ new Date(latest.judgedAt).toLocaleString('zh-CN') }}，所依据区间
              {{ formatChainage(latest.version?.basisRange[0] ?? face.mileageRange[0]) }} ~
              {{ formatChainage(latest.version?.basisRange[1] ?? face.mileageRange[1]) }}
              （链 v{{ latest.version?.chainRevision ?? '?' }} · 记录 r{{ latest.version?.recordVersion ?? '?' }}）
            </p>
          </div>
          <div v-else>
            <p class="muted">尚未判定级别，按当前参数实时试算：</p>
            <GradeTag :grade="result.grade" />
            <p class="support">{{ result.support }}</p>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <strong>节理组列表（{{ joints.length }} 组）</strong>
              <el-tag v-if="joints.some((j) => isVersionStale(j.version, currentRevision))" type="danger" size="small" effect="plain">
                存在引用旧桩号的节理
              </el-tag>
            </div>
          </template>
          <el-table :data="joints" size="small" border>
            <el-table-column label="组号" width="70">
              <template #default="{ row }">J{{ row.setNo }}</template>
            </el-table-column>
            <el-table-column label="产状" width="130">
              <template #default="{ row }">{{ attitudeText(row.dipDirection, row.dipAngle) }}</template>
            </el-table-column>
            <el-table-column label="里程" width="120">
              <template #default="{ row }">
                {{ formatChainage(row.chainage) }}
                <el-tooltip content="该节理位置依据的里程链版本已落后" :disabled="!isVersionStale(row.version, currentRevision)">
                  <el-tag
                    size="small"
                    :type="isVersionStale(row.version, currentRevision) ? 'danger' : 'info'"
                    effect="plain"
                    style="margin-left: 4px"
                  >
                    v{{ row.version?.chainRevision ?? '?' }}
                  </el-tag>
                </el-tooltip>
              </template>
            </el-table-column>
            <el-table-column prop="spacing" label="间距 cm" width="80" />
            <el-table-column prop="jointCount" label="条数" width="70" />
            <el-table-column prop="fillMaterial" label="充填" width="80" />
            <el-table-column prop="waterWet" label="渗水" width="80" />
          </el-table>
          <el-empty v-if="joints.length === 0" description="暂无节理组记录" :image-size="60" />
        </el-card>
      </div>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>岩性素描图</strong>
            <span class="muted">已布置 {{ segmentCount }} 条结构面线段（自动保存在浏览器本地）</span>
          </div>
        </template>
        <SketchCanvas
          :face-id="face.id"
          :lithology="face.lithology"
          :attitude="face.attitude"
          @change="onSketchChange"
        />
      </el-card>
    </div>

    <el-dialog v-model="editVisible" :title="face?.status === 'pending' ? '调整里程并激活入链' : '修改掌子面里程'" width="560px">
      <el-alert v-if="editError" :title="editError" type="error" :closable="false" style="margin-bottom: 10px" />
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom: 12px"
        :title="`提交依据：里程链 v${editBaseRevision}；提交时会与前后区间比较，重叠或期间被他人改动都会保留草稿并列出冲突`"
      />
      <el-form label-width="130px">
        <el-form-item label="里程提交人">
          <el-input v-model="editForm.operator" style="width: 220px" placeholder="地质员 / 测量员姓名" />
        </el-form-item>
        <el-form-item label="里程桩号 m">
          <el-input-number v-model="editForm.chainage" :min="0" :max="999999" :step="1" />
          <span class="hint">{{ formatChainage(editForm.chainage) }}</span>
        </el-form-item>
        <el-form-item label="编录里程区间 m">
          <el-input-number v-model="editForm.mileageRange[0]" :min="0" :max="999999" />
          <span style="margin: 0 6px">—</span>
          <el-input-number v-model="editForm.mileageRange[1]" :min="0" :max="999999" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="submitMileage">检查冲突并预览重算</el-button>
      </template>
    </el-dialog>

    <CommitConfirmDialog
      v-if="plan"
      :plan="plan"
      :faces="faceStore.items"
      :joints="jointStore.items"
      :waters="gradeStore.waters"
      mode="update"
      @confirm="onConfirmed"
      @cancel="cancelConfirm"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 620px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.support {
  margin: 8px 0;
  color: #2f3a46;
}
.grade-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.grade-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hint {
  margin-left: 8px;
  color: #97a0ad;
  font-size: 12px;
}
</style>
