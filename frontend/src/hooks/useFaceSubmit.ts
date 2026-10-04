import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useChainStore, CommitConflictError } from '../stores/chainStore';
import { useFaceStore } from '../stores/faceStore';
import { useJointStore } from '../stores/jointStore';
import { useGradeStore } from '../stores/gradeStore';
import type { CommitPlan } from '../utils/chain';
import type { FaceSubmitRequest } from '../types/chain';

/**
 * 掌子面里程提交流程（新建 / 修改 / pending 激活共用）：
 * 1. evaluate 检测冲突；有冲突则草稿已入库，返回 false 并列出冲突；
 * 2. 无冲突返回确认计划，由页面弹出 CommitConfirmDialog；
 * 3. 用户确认后 confirm() 在事务内复检并落库，随后刷新全部 store。
 */
export function useFaceSubmit() {
  const chainStore = useChainStore();
  const faceStore = useFaceStore();
  const jointStore = useJointStore();
  const gradeStore = useGradeStore();

  const plan = ref<CommitPlan | null>(null);
  const pendingRequest = ref<FaceSubmitRequest | null>(null);
  const submitting = ref(false);

  const currentRevision = computed(() => chainStore.revision);

  /** 返回 true 表示已得到确认计划；false 表示冲突已保留为草稿 */
  async function stage(req: FaceSubmitRequest): Promise<boolean> {
    const result = await chainStore.evaluate(req);
    if (result.conflicts.length > 0) {
      ElMessage.warning(`里程存在 ${result.conflicts.length} 处冲突，草稿已保留，请处理后重提`);
      return false;
    }
    plan.value = result.plan ?? null;
    pendingRequest.value = req;
    return true;
  }

  function cancelConfirm() {
    plan.value = null;
    pendingRequest.value = null;
  }

  async function confirm(): Promise<boolean> {
    if (!plan.value || !pendingRequest.value) return false;
    submitting.value = true;
    try {
      await chainStore.commitPreview(plan.value, pendingRequest.value);
      ElMessage.success(`里程链已提交至 v${plan.value.newRevision}，相邻区间 / 节理 / 涌水趋势已重算`);
      plan.value = null;
      pendingRequest.value = null;
      await Promise.all([faceStore.load(), jointStore.load(), gradeStore.load(), chainStore.load()]);
      return true;
    } catch (err) {
      if (err instanceof CommitConflictError) {
        ElMessage.error('确认期间里程又被他人改动，本次提交已撤回，草稿已保留');
        await chainStore.refreshDrafts();
      } else {
        throw err;
      }
      plan.value = null;
      pendingRequest.value = null;
      return false;
    } finally {
      submitting.value = false;
    }
  }

  return { plan, pendingRequest, submitting, currentRevision, stage, confirm, cancelConfirm };
}
