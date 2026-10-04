import type { JointSet } from '../types/joint';
import type { TunnelFace } from '../types/face';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import { recomputeTrends } from '../types/water';
import type { ChainConflict, FaceSubmitRequest } from '../types/chain';

/** 两个区间是否重叠（端点相接不算重叠） */
export function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

/**
 * 提交前检测冲突：
 * 1. 修改模式下 baseRevision 与当前链版本不一致 → stale（编辑期间被别人改过）；
 * 2. 新里程区间与其它 active 掌子面区间重叠，或与待整理（pending）掌子面区间重叠 → overlap；
 * 3. 新建模式下编号重复 → overlap（归入同一冲突清单）。
 * pending 自身激活时排除自身。
 */
export function detectConflicts(
  req: FaceSubmitRequest,
  faces: TunnelFace[],
  currentRevision: number,
): ChainConflict[] {
  const conflicts: ChainConflict[] = [];

  if (req.mode === 'update' && req.baseRevision !== currentRevision) {
    conflicts.push({
      kind: 'stale',
      faceId: req.faceId,
      faceNo: req.faceNo,
      message: `该掌子面里程在你编辑期间已被他人改动（链版本 v${req.baseRevision} → v${currentRevision}），请核对后再提交`,
    });
  }

  faces.forEach((f) => {
    if (f.id === req.faceId) return;
    if (f.status !== 'active' && f.status !== 'pending') return;
    // 他人修改自己时，不会同时 pending；pending 只在激活时与自身以外比较
    if (rangesOverlap(req.mileageRange, f.mileageRange)) {
      conflicts.push({
        kind: 'overlap',
        faceId: f.id,
        faceNo: f.faceNo,
        message:
          f.status === 'pending'
            ? `区间与待整理掌子面「${f.faceNo}」(${fmt(f.mileageRange)}) 重叠，应先整理其桩号`
            : `里程区间与相邻编录「${f.faceNo}」(${fmt(f.mileageRange)}) 重叠`,
      });
    }
  });

  if (req.mode === 'create' && faces.some((f) => f.faceNo === req.faceNo)) {
    conflicts.push({ kind: 'overlap', message: `掌子面编号「${req.faceNo}」已存在，请更换` });
  }

  return conflicts;
}

function fmt(range: [number, number]): string {
  return `${range[0]}~${range[1]} m`;
}

/** 版本戳是否过期（引用的链版本落后于当前版本） */
export function isVersionStale(version: { chainRevision?: number } | undefined, currentRevision: number): boolean {
  if (!version || typeof version.chainRevision !== 'number') return true;
  return version.chainRevision < currentRevision;
}

export interface FaceWrite {
  id: string;
  create?: TunnelFace;
  chainage: number;
  mileageRange: [number, number];
  status: TunnelFace['status'];
  recordVersion: number;
  updatedBy?: string;
}

export interface JointWrite {
  id: string;
  chainage: number;
  recordVersion: number;
}

export interface WaterWrite {
  id: string;
  chainage: number;
  derivedTrend: WaterInflow['derivedTrend'];
  recordVersion: number;
}

/** 提交确认后执行的重算计划（全部为幂等写操作） */
export interface CommitPlan {
  newRevision: number;
  target: FaceWrite;
  neighbors: FaceWrite[];
  joints: JointWrite[];
  waters: WaterWrite[];
  /** 被钳制到区间边界的节理/涌水，供确认页提示 */
  clamped: { kind: 'joint' | 'water'; id: string; chainage: number }[];
  /** 人工确认的级别结论（提交不重算、不覆盖），供确认页展示 */
  preservedGrades: RockMassGrade[];
}

/** 把旧区间内的位置按比例映射到新区间；旧区间退化为零长度时按平移处理 */
export function remapChainage(oldC: number, oldRange: [number, number], newRange: [number, number]): number {
  const [a0, a1] = oldRange;
  const [b0, b1] = newRange;
  if (a1 === a0) return b0 + (oldC - a0);
  const ratio = (oldC - a0) / (a1 - a0);
  return b0 + ratio * (b1 - b0);
}

function clamp(v: number, range: [number, number]): number {
  return Math.min(range[1], Math.max(range[0], v));
}

/** 按里程排序 active 掌子面 */
export function sortedActive(faces: TunnelFace[]): TunnelFace[] {
  return faces
    .filter((f) => f.status === 'active')
    .sort((a, b) => a.mileageRange[0] - b.mileageRange[0] || b.recordedAt - a.recordedAt);
}

/**
 * 根据提交请求与当前数据，计算确认后的完整重算计划（不落库）。
 * - 相邻区间：与目标区间端点相接的前/后掌子面，边界对齐到新区间；
 * - 节理位置：目标掌子面的节理按区间比例 remap；被带动的相邻掌子面仅钳制越界值；
 * - 涌水趋势：目标掌子面涌水点同样 remap，随后全部涌水点沿新里程链重算推导趋势；
 * - 人工确认级别：不动。
 */
export function buildPlan(
  req: FaceSubmitRequest,
  faces: TunnelFace[],
  joints: JointSet[],
  waters: WaterInflow[],
  grades: RockMassGrade[],
  currentRevision: number,
  newFaceId: string,
): CommitPlan {
  const newRevision = currentRevision + 1;
  const targetId = req.mode === 'create' ? newFaceId : req.faceId!;
  const targetCurrent = faces.find((f) => f.id === targetId);

  const clamped: CommitPlan['clamped'] = [];

  const target: FaceWrite = {
    id: targetId,
    create: undefined,
    chainage: req.chainage,
    mileageRange: [...req.mileageRange] as [number, number],
    status: req.activate ? 'active' : targetCurrent?.status ?? 'active',
    recordVersion: (targetCurrent?.version.recordVersion ?? 0) + 1,
    updatedBy: req.updatedBy,
  };
  if (req.mode === 'create' && req.fullDraft) {
    target.create = {
      ...req.fullDraft,
      id: targetId,
      chainage: req.chainage,
      mileageRange: target.mileageRange,
      recordedAt: Date.now(),
      status: 'active',
      version: stamp(0, target.mileageRange, newRevision),
      updatedBy: req.updatedBy,
    };
  }

  // 相邻区间：找与新区间端点相接的 active 掌子面
  const neighbors: FaceWrite[] = [];
  const neighborUpdates = new Map<string, { range: [number, number]; chainage: number }>();
  for (const f of faces) {
    if (f.id === targetId || f.status !== 'active') continue;
    const range: [number, number] = [...f.mileageRange] as [number, number];
    let changed = false;
    if (f.mileageRange[1] === (targetCurrent?.mileageRange[0] ?? req.mileageRange[0])) {
      // 前邻：终点对齐新起点
      range[1] = req.mileageRange[0];
      if (range[0] > range[1]) range[0] = range[1];
      changed = true;
    } else if (f.mileageRange[0] === (targetCurrent?.mileageRange[1] ?? req.mileageRange[1])) {
      // 后邻：起点对齐新终点
      range[0] = req.mileageRange[1];
      if (range[1] < range[0]) range[1] = range[0];
      changed = true;
    } else if (req.mode === 'create') {
      // 新建时也允许恰好与新区间相接
      if (Math.abs(f.mileageRange[1] - req.mileageRange[0]) < 1e-9) {
        range[1] = req.mileageRange[0];
        if (range[0] > range[1]) range[0] = range[1];
        changed = true;
      } else if (Math.abs(f.mileageRange[0] - req.mileageRange[1]) < 1e-9) {
        range[0] = req.mileageRange[1];
        if (range[1] < range[0]) range[1] = range[0];
        changed = true;
      }
    }
    if (changed) {
      const chainage = clamp(f.chainage, range);
      neighbors.push({
        id: f.id,
        chainage,
        mileageRange: range,
        status: 'active',
        recordVersion: f.version.recordVersion + 1,
      });
      neighborUpdates.set(f.id, { range, chainage });
    }
  }

  // 节理位置重算
  const jointWrites: JointWrite[] = [];
  for (const j of joints) {
    if (j.faceId === targetId) {
      const oldRange = targetCurrent?.mileageRange ?? req.mileageRange;
      let c = remapChainage(j.chainage ?? oldRange[0], oldRange, req.mileageRange);
      if (c < req.mileageRange[0] || c > req.mileageRange[1]) {
        c = clamp(c, req.mileageRange);
        clamped.push({ kind: 'joint', id: j.id, chainage: c });
      }
      jointWrites.push({ id: j.id, chainage: c, recordVersion: (j.version?.recordVersion ?? 0) + 1 });
    } else if (neighborUpdates.has(j.faceId)) {
      const nb = neighborUpdates.get(j.faceId)!;
      let c = j.chainage ?? nb.range[0];
      if (c < nb.range[0] || c > nb.range[1]) {
        c = clamp(c, nb.range);
        clamped.push({ kind: 'joint', id: j.id, chainage: c });
      }
      // 相邻区间被带动：无论里程是否移动，其节理依据版本都随区间 +1
      jointWrites.push({ id: j.id, chainage: c, recordVersion: (j.version?.recordVersion ?? 0) + 1 });
    }
  }

  // 涌水位置重算：目标掌子面按比例 remap；被带动的相邻掌子面仅钳制越界点。
  // 随后沿新里程链重算全部推导趋势（人工填写的 changeTrend 不动）。
  const movedWaters = new Map<string, number>();
  const waterWrites: WaterWrite[] = [];
  for (const w of waters) {
    if (w.faceId === targetId) {
      const oldRange = targetCurrent?.mileageRange ?? req.mileageRange;
      let c = remapChainage(w.chainage, oldRange, req.mileageRange);
      if (c < req.mileageRange[0] || c > req.mileageRange[1]) {
        c = clamp(c, req.mileageRange);
        clamped.push({ kind: 'water', id: w.id, chainage: c });
      }
      movedWaters.set(w.id, c);
    } else if (neighborUpdates.has(w.faceId)) {
      const nb = neighborUpdates.get(w.faceId)!;
      let c = w.chainage ?? nb.range[0];
      if (c < nb.range[0] || c > nb.range[1]) {
        c = clamp(c, nb.range);
        clamped.push({ kind: 'water', id: w.id, chainage: c });
        movedWaters.set(w.id, c);
      }
    }
  }

  const watersAfter = waters.map((w) =>
    movedWaters.has(w.id) ? { ...w, chainage: movedWaters.get(w.id)! } : w,
  );
  const derivedMap = new Map(recomputeTrends(watersAfter).map((w) => [w.id, w.derivedTrend]));
  for (const w of watersAfter) {
    const newChainage = movedWaters.get(w.id) ?? w.chainage;
    const newDerived = derivedMap.get(w.id) ?? w.derivedTrend;
    const trendChanged = newDerived !== w.derivedTrend;
    const neighborBumped = neighborUpdates.has(w.faceId);
    if (movedWaters.has(w.id) || trendChanged || neighborBumped) {
      waterWrites.push({
        id: w.id,
        chainage: newChainage,
        derivedTrend: newDerived,
        recordVersion: (w.version?.recordVersion ?? 0) + 1,
      });
    }
  }

  // 人工确认的级别结论：保留，仅用于确认页展示
  const preservedGrades = grades.filter(
    (g) => g.manualAdjusted && (g.faceId === targetId || neighborUpdates.has(g.faceId)),
  );

  return {
    newRevision,
    target,
    neighbors,
    joints: jointWrites,
    waters: waterWrites,
    clamped,
    preservedGrades,
  };
}

/** 构造版本戳 */
export function stamp(recordVersion: number, basisRange: [number, number], chainRevision: number) {
  return {
    chainRevision,
    recordVersion,
    basisRange: [...basisRange] as [number, number],
  };
}
