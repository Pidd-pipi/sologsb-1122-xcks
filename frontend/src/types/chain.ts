import type { TunnelFaceDraft } from './face';

/** 里程链版本戳：标明该记录依据的链版本、自身版本与区间 */
export interface RangeVersion {
  /** 所依据的里程链全局版本（每次成功提交递增） */
  chainRevision: number;
  /** 记录自身版本（相邻区间重算使其随动时 +1） */
  recordVersion: number;
  /** 所依据的编录里程区间 m */
  basisRange: [number, number];
}

/** 掌子面状态：active 正式入链 / pending 里程待整理（如旧数据升级时发现区间重叠） */
export type FaceStatus = 'active' | 'pending';

/** 冲突类别：区间重叠 / 编辑依据的链版本已过期（被别人改过） */
export type ConflictKind = 'overlap' | 'stale';

export interface ChainConflict {
  kind: ConflictKind;
  /** 冲突对象掌子面（重叠时） */
  faceId?: string;
  faceNo?: string;
  message: string;
}

/** 一次掌子面里程提交请求（新建 / 修改里程通用） */
export interface FaceSubmitRequest {
  mode: 'create' | 'update';
  /** update 模式下的掌子面 id */
  faceId?: string;
  /** 打开编辑（或草稿建立）时所依据的链版本，用于乐观并发检测 */
  baseRevision: number;
  faceNo: string;
  chainage: number;
  mileageRange: [number, number];
  /** 本次提交人（地质员 / 测量员） */
  updatedBy: string;
  /** create 模式下的完整编录草稿 */
  fullDraft?: TunnelFaceDraft;
  /** update 模式下是否顺带把 pending 掌子面激活入链 */
  activate?: boolean;
}

/** 冲突后保留下来的草稿（drafts 表） */
export interface FaceDraftRecord {
  id: string;
  mode: 'create' | 'update';
  faceId?: string;
  baseRevision: number;
  faceNo: string;
  chainage: number;
  mileageRange: [number, number];
  updatedBy: string;
  fullDraft?: TunnelFaceDraft;
  activate?: boolean;
  conflicts: ChainConflict[];
  savedAt: number;
}

export interface MetaRecord {
  key: string;
  value: number;
}

export function draftToRequest(draft: FaceDraftRecord): FaceSubmitRequest {
  return {
    mode: draft.mode,
    faceId: draft.faceId,
    baseRevision: draft.baseRevision,
    faceNo: draft.faceNo,
    chainage: draft.chainage,
    mileageRange: draft.mileageRange,
    updatedBy: draft.updatedBy,
    fullDraft: draft.fullDraft,
    activate: draft.activate,
  };
}
