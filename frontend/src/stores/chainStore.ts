import { defineStore } from 'pinia';
import { db, META_CHAIN_REVISION, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { buildPlan, detectConflicts, stamp, type CommitPlan } from '../utils/chain';
import type { FaceDraftRecord, FaceSubmitRequest } from '../types/chain';

export interface EvaluateResult {
  conflicts: ReturnType<typeof detectConflicts>;
  revision: number;
  /** 无冲突时给出确认预览（未落库） */
  plan?: CommitPlan;
  draftId?: string;
}

interface ChainState {
  revision: number;
  drafts: FaceDraftRecord[];
  loaded: boolean;
}

/**
 * 版本化里程链：
 * - evaluate() 在只读事务里检测冲突并计算重算计划，冲突时把草稿保留进 drafts 表；
 * - commitPreview() 按已确认的计划在读写事务里落库（提交前再做一次冲突复检）。
 */
export const useChainStore = defineStore('chain', {
  state: (): ChainState => ({ revision: 0, drafts: [], loaded: false }),

  actions: {
    async load() {
      const meta = await db.meta.get(META_CHAIN_REVISION);
      this.revision = meta?.value ?? 1;
      this.drafts = await db.drafts.orderBy('savedAt').reverse().toArray();
      this.loaded = true;
    },

    async refreshRevision() {
      const meta = await db.meta.get(META_CHAIN_REVISION);
      this.revision = meta?.value ?? 1;
    },

    async refreshDrafts() {
      this.drafts = await db.drafts.orderBy('savedAt').reverse().toArray();
    },

    /**
     * 提交检测：
     * - 有重叠 / 版本过期 → 保留草稿并返回冲突清单；
     * - 无冲突 → 返回确认计划（不写业务数据）。
     */
    async evaluate(req: FaceSubmitRequest): Promise<EvaluateResult> {
      return db.transaction('rw', [db.faces, db.joints, db.waters, db.grades, db.drafts, db.meta], async () => {
        const [faces, joints, waters, grades, meta] = await Promise.all([
          db.faces.toArray(),
          db.joints.toArray(),
          db.waters.toArray(),
          db.grades.toArray(),
          db.meta.get(META_CHAIN_REVISION),
        ]);
        const revision = meta?.value ?? 1;
        const conflicts = detectConflicts(req, faces, revision);
        if (conflicts.length > 0) {
          const record: FaceDraftRecord = {
            id: newId('draft'),
            mode: req.mode,
            faceId: req.faceId,
            baseRevision: req.baseRevision,
            faceNo: req.faceNo,
            chainage: req.chainage,
            mileageRange: [...req.mileageRange] as [number, number],
            updatedBy: req.updatedBy,
            fullDraft: req.fullDraft ? toPlain(req.fullDraft) : undefined,
            activate: req.activate,
            conflicts,
            savedAt: Date.now(),
          };
          await db.drafts.put(toPlain(record));
          this.drafts = [record, ...this.drafts];
          return { conflicts, revision, draftId: record.id };
        }
        const plan = buildPlan(req, faces, joints, waters, grades, revision, newId('face'));
        return { conflicts: [], revision, plan };
      });
    },

    /**
     * 确认后提交：在同一读写事务里复检冲突（防止两个页面同时确认），
     * 随后写入目标/相邻掌子面、节理与涌水重算结果，链版本 +1。
     */
    async commitPreview(plan: CommitPlan, req: FaceSubmitRequest): Promise<void> {
      await db.transaction(
        'rw',
        [db.faces, db.joints, db.waters, db.grades, db.drafts, db.meta],
        async () => {
          const [faces, meta] = await Promise.all([
            db.faces.toArray(),
            db.meta.get(META_CHAIN_REVISION),
          ]);
          const revision = meta?.value ?? 1;
          const conflicts = detectConflicts(req, faces, revision);
          if (conflicts.length > 0) {
            const record: FaceDraftRecord = {
              id: newId('draft'),
              mode: req.mode,
              faceId: req.faceId,
              baseRevision: req.baseRevision,
              faceNo: req.faceNo,
              chainage: req.chainage,
              mileageRange: [...req.mileageRange] as [number, number],
              updatedBy: req.updatedBy,
              fullDraft: req.fullDraft ? toPlain(req.fullDraft) : undefined,
              activate: req.activate,
              conflicts,
              savedAt: Date.now(),
            };
            await db.drafts.put(toPlain(record));
            throw new CommitConflictError(record, revision);
          }

          const rev = plan.newRevision;

          // 目标掌子面（新建或修改）
          if (plan.target.create) {
            await db.faces.put(toPlain(plan.target.create));
          } else {
            await db.faces.update(plan.target.id, {
              chainage: plan.target.chainage,
              mileageRange: plan.target.mileageRange,
              status: plan.target.status,
              updatedBy: plan.target.updatedBy,
              version: stamp(plan.target.recordVersion, plan.target.mileageRange, rev),
            });
          }

          // 相邻区间
          for (const nb of plan.neighbors) {
            await db.faces.update(nb.id, {
              chainage: nb.chainage,
              mileageRange: nb.mileageRange,
              version: stamp(nb.recordVersion, nb.mileageRange, rev),
            });
          }

          // 提交后各掌子面区间（用于节理/涌水版本戳的依据区间）
          const rangeAfter = new Map<string, [number, number]>();
          faces.forEach((f) => rangeAfter.set(f.id, [...f.mileageRange] as [number, number]));
          rangeAfter.set(plan.target.id, plan.target.mileageRange);
          plan.neighbors.forEach((nb) => rangeAfter.set(nb.id, nb.mileageRange));

          // 节理位置
          for (const jw of plan.joints) {
            const joint = await db.joints.get(jw.id);
            const basis = (joint && rangeAfter.get(joint.faceId)) ?? plan.target.mileageRange;
            await db.joints.update(jw.id, {
              chainage: jw.chainage,
              version: stamp(jw.recordVersion, basis, rev),
            });
          }

          // 涌水位置 / 推导趋势（人工填写的 changeTrend 不动）
          for (const ww of plan.waters) {
            const water = await db.waters.get(ww.id);
            const basis = (water && rangeAfter.get(water.faceId)) ?? plan.target.mileageRange;
            await db.waters.update(ww.id, {
              chainage: ww.chainage,
              derivedTrend: ww.derivedTrend,
              version: stamp(ww.recordVersion, basis, rev),
            });
          }

          // 级别结论（含人工确认）一律不重算、不覆盖；只在首次提交时确保带版本戳
          const grades = await db.grades.toArray();
          for (const g of grades) {
            if (!g.version) {
              const face = faces.find((f) => f.id === g.faceId);
              await db.grades.update(g.id, {
                version: stamp(1, face?.mileageRange ?? [0, 0], rev),
              });
            }
          }

          await db.meta.put({ key: META_CHAIN_REVISION, value: rev });
          this.revision = rev;
        },
      );
      await this.refreshDrafts();
    },

    async discardDraft(id: string) {
      await db.drafts.delete(id);
      this.drafts = this.drafts.filter((d) => d.id !== id);
    },

    /**
     * 把过期草稿的依据版本更新到当前链版本（"仍按此里程提交"前消除 stale 冲突）。
     * 注意：只更新 baseRevision，区间不变，重叠冲突仍会照常检出。
     */
    async rebaseDraft(id: string) {
      await this.refreshRevision();
      const draft = this.drafts.find((d) => d.id === id);
      if (!draft) return;
      const next = { ...draft, baseRevision: this.revision, savedAt: Date.now() };
      await db.drafts.put(toPlain(next));
      this.drafts = this.drafts.map((d) => (d.id === id ? next : d));
    },
  },
});

/** 提交确认后复检发现冲突时抛出，携带保留下来的草稿 */
export class CommitConflictError extends Error {
  draft: FaceDraftRecord;
  revision: number;
  constructor(draft: FaceDraftRecord, revision: number) {
    super('提交前复检发现里程冲突，草稿已保留');
    this.name = 'CommitConflictError';
    this.draft = draft;
    this.revision = revision;
  }
}

