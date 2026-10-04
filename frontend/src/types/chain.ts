import type { TunnelFaceDraft } from './face';
import type { JointSetDraft } from './joint';
import type { WaterInflowDraft } from './water';

/** 入链对象类型 */
export type ChainEntityKind = 'face' | 'joint' | 'water';

/** 冲突类型：区间重叠 / 提交基线落后于链（已被别人改过）/ 掌子面区间待整理 */
export type ConflictType = 'overlap' | 'concurrent' | 'pending';

export interface ChainConflict {
  type: ConflictType;
  /** 冲突说明（可直接展示） */
  message: string;
  /** 关联掌子面 */
  faceId?: string;
  faceNo?: string;
  /** 关联区间（重叠冲突） */
  interval?: [number, number];
}

/** 未确认提交的草稿（冲突保留，不丢弃） */
export interface ChainDraft {
  id: string;
  kind: ChainEntityKind;
  /** draft=冲突保留待处理；resolved=已确认入链；discarded=已放弃 */
  status: 'draft' | 'resolved' | 'discarded';
  /** 提交的表单数据 */
  payload: TunnelFaceDraft | JointSetDraft | WaterInflowDraft;
  /** 节理/涌水所属掌子面 */
  faceId?: string;
  /** 提交时所依据的里程链版本 */
  baseVersion: number;
  conflicts: ChainConflict[];
  createdAt: number;
  geologist?: string;
  /** 摘要（列表展示用） */
  summary: string;
}

/** 提交结果：ok=false 时草稿已保留，冲突随返回 */
export interface ChainCommitResult {
  ok: boolean;
  conflicts: ChainConflict[];
  draftId?: string;
  version: number;
}
