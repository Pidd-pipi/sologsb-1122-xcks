import { defineStore } from 'pinia';
import { db, CHAIN_VERSION_KEY, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { formatChainage } from '../utils/geoMath';
import type { TunnelFace, TunnelFaceDraft } from '../types/face';
import type { JointSet, JointSetDraft } from '../types/joint';
import type { WaterInflow, WaterInflowDraft } from '../types/water';
import type { ChainConflict, ChainDraft, ChainCommitResult } from '../types/chain';

interface ChainState {
  /** 里程链全局版本：每次确认入链 +1 */
  version: number;
  loaded: boolean;
}

/** 掌子面表单数据（编辑时带 id） */
export type FaceFormInput = TunnelFaceDraft & { id?: string };

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && a[1] > b[0];
}

/**
 * 连续性重算：以 committed 为锚点向两侧传播，
 * 相邻区间首尾相接，各区间长度保持不变。
 * 用于提交确认后重算相邻区间。
 */
export function propagateFaces(
  faces: TunnelFace[],
  committedId: string,
  start: number,
  end: number,
): TunnelFace[] {
  const sorted = [...faces].sort((a, b) => a.chainage - b.chainage);
  const idx = sorted.findIndex((f) => f.id === committedId);
  if (idx < 0) return faces;
  const out = sorted.map((f) => ({ ...f }));
  out[idx].chainage = start;
  out[idx].mileageRange = [start, end];
  // 向大里程方向传播
  for (let i = idx + 1; i < out.length; i++) {
    const prev = out[i - 1];
    const len = out[i].mileageRange[1] - out[i].mileageRange[0];
    const s = prev.mileageRange[1];
    out[i].mileageRange = [s, s + len];
    out[i].chainage = s;
  }
  // 向小里程方向传播
  for (let i = idx - 1; i >= 0; i--) {
    const next = out[i + 1];
    const len = out[i].mileageRange[1] - out[i].mileageRange[0];
    const e = next.mileageRange[0];
    out[i].mileageRange = [e - len, e];
    out[i].chainage = e - len;
  }
  return out;
}

function faceChainageOf(faces: TunnelFace[], faceId: string): number {
  return faces.find((f) => f.id === faceId)?.chainage ?? 0;
}

export const useChainStore = defineStore('chain', {
  state: (): ChainState => ({ version: 0, loaded: false }),
  getters: {},
  actions: {
    async load() {
      const meta = await db.meta.get(CHAIN_VERSION_KEY);
      this.version = meta?.value ?? 1;
      if (!meta) await db.meta.put({ key: CHAIN_VERSION_KEY, value: 1 });
      this.loaded = true;
    },
    /** 草稿箱：待整理掌子面 + 冲突草稿 */
    async fetchPendingFaces(): Promise<TunnelFace[]> {
      return db.faces.filter((f) => f.status === 'pending').toArray();
    },
    async fetchActiveDrafts(): Promise<ChainDraft[]> {
      const rows = await db.drafts.where('status').equals('draft').toArray();
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    },
    async bumpVersion(): Promise<number> {
      const next = this.version + 1;
      await db.meta.put({ key: CHAIN_VERSION_KEY, value: next });
      this.version = next;
      return next;
    },

    async saveDraft(
      kind: ChainDraft['kind'],
      payload: FaceFormInput | JointSetDraft | WaterInflowDraft,
      baseVersion: number,
      conflicts: ChainConflict[],
      summary: string,
      faceId?: string,
    ): Promise<ChainDraft> {
      const draft: ChainDraft = {
        id: newId('draft'),
        kind,
        status: 'draft',
        payload: toPlain(payload),
        faceId,
        baseVersion,
        conflicts,
        createdAt: Date.now(),
        summary,
      };
      await db.drafts.put(draft);
      return draft;
    },

    /** 提交掌子面区间：重叠或基线落后则保留草稿并列出冲突 */
    async submitFace(input: FaceFormInput, baseVersion: number): Promise<ChainCommitResult> {
      const conflicts: ChainConflict[] = [];
      const all = await db.faces.toArray();
      if (baseVersion < this.version) {
        conflicts.push({
          type: 'concurrent',
          message: `里程链已更新到 v${this.version}（本提交基于 v${baseVersion}），区间可能已被他人修改`,
        });
      }
      for (const f of all) {
        if (f.id === input.id) continue;
        if (rangesOverlap(input.mileageRange, f.mileageRange)) {
          conflicts.push({
            type: 'overlap',
            faceId: f.id,
            faceNo: f.faceNo,
            interval: f.mileageRange,
            message: `与掌子面 ${f.faceNo} 的区间 ${formatChainage(f.mileageRange[0])} ~ ${formatChainage(f.mileageRange[1])} 重叠`,
          });
        }
      }
      if (conflicts.length > 0) {
        const draft = await this.saveDraft(
          'face',
          input,
          baseVersion,
          conflicts,
          `掌子面 ${input.faceNo} 区间 ${formatChainage(input.mileageRange[0])} ~ ${formatChainage(input.mileageRange[1])}`,
        );
        return { ok: false, conflicts, draftId: draft.id, version: this.version };
      }
      const version = await this.applyFace(input);
      return { ok: true, conflicts: [], version };
    },

    /** 提交节理组：掌子面待整理或链已更新时保留草稿 */
    async submitJoint(input: JointSetDraft, baseVersion: number): Promise<ChainCommitResult> {
      const conflicts: ChainConflict[] = [];
      const face = await db.faces.get(input.faceId);
      if (!face) {
        conflicts.push({ type: 'pending', message: '未找到所属掌子面' });
      } else {
        if (face.status === 'pending') {
          conflicts.push({
            type: 'pending',
            faceId: face.id,
            faceNo: face.faceNo,
            message: `掌子面 ${face.faceNo} 区间待整理，里程链尚未确认`,
          });
        }
        if (baseVersion < this.version) {
          conflicts.push({
            type: 'concurrent',
            message: `里程链已更新到 v${this.version}（本提交基于 v${baseVersion}），节理位置可能引用旧桩号`,
          });
        }
      }
      if (conflicts.length > 0) {
        const draft = await this.saveDraft(
          'joint',
          input,
          baseVersion,
          conflicts,
          `节理组 J${input.setNo}（${face?.faceNo ?? '未知掌子面'}）`,
          input.faceId,
        );
        return { ok: false, conflicts, draftId: draft.id, version: this.version };
      }
      const version = await this.applyJoint(input);
      return { ok: true, conflicts: [], version };
    },

    /** 提交涌水记录：掌子面待整理或链已更新时保留草稿 */
    async submitWater(input: WaterInflowDraft, baseVersion: number): Promise<ChainCommitResult> {
      const conflicts: ChainConflict[] = [];
      const face = await db.faces.get(input.faceId);
      if (!face) {
        conflicts.push({ type: 'pending', message: '未找到所属掌子面' });
      } else {
        if (face.status === 'pending') {
          conflicts.push({
            type: 'pending',
            faceId: face.id,
            faceNo: face.faceNo,
            message: `掌子面 ${face.faceNo} 区间待整理，里程链尚未确认`,
          });
        }
        if (baseVersion < this.version) {
          conflicts.push({
            type: 'concurrent',
            message: `里程链已更新到 v${this.version}（本提交基于 v${baseVersion}），涌水趋势可能引用旧桩号`,
          });
        }
      }
      if (conflicts.length > 0) {
        const draft = await this.saveDraft(
          'water',
          input,
          baseVersion,
          conflicts,
          `涌水 ${input.position || '未命名出水点'} · ${formatChainage(input.chainage)}（${face?.faceNo ?? '未知掌子面'}）`,
          input.faceId,
        );
        return { ok: false, conflicts, draftId: draft.id, version: this.version };
      }
      const version = await this.applyWater(input);
      return { ok: true, conflicts: [], version };
    },

    /** 确认掌子面入链并连续性重算相邻区间、节理位置与涌水趋势 */
    async applyFace(input: FaceFormInput): Promise<number> {
      return db.transaction('rw', db.faces, db.joints, db.waters, db.meta, async () => {
        const oldFaces = await db.faces.toArray();
        const version = await this.bumpVersion();
        const isEdit = Boolean(input.id);
        const committedId = isEdit ? (input.id as string) : newId('face');
        let faces: TunnelFace[];
        if (isEdit) {
          faces = oldFaces.map((f) =>
            f.id === input.id
              ? ({ ...toPlain(input), id: f.id, recordedAt: f.recordedAt, chainVersion: version, status: 'active' } as TunnelFace)
              : f,
          );
        } else {
          const record: TunnelFace = {
            ...toPlain(input as TunnelFaceDraft),
            id: committedId,
            recordedAt: Date.now(),
            chainVersion: version,
            status: 'active',
          };
          faces = [...oldFaces, record];
        }
        faces = propagateFaces(faces, committedId, input.mileageRange[0], input.mileageRange[1]);
        await this.recomputeDependents(oldFaces, faces, version);
        await db.faces.bulkPut(faces);
        return version;
      });
    },

    async applyJoint(input: JointSetDraft): Promise<number> {
      return db.transaction('rw', db.joints, db.meta, async () => {
        const version = await this.bumpVersion();
        const faces = await db.faces.toArray();
        const faceChainage = faceChainageOf(faces, input.faceId);
        const record: JointSet = {
          ...toPlain(input),
          id: newId('joint'),
          chainVersion: version,
          chainage: faceChainage + (input.offset ?? 0),
        };
        await db.joints.put(record);
        return version;
      });
    },

    async applyWater(input: WaterInflowDraft): Promise<number> {
      return db.transaction('rw', db.waters, db.meta, async () => {
        const version = await this.bumpVersion();
        const faces = await db.faces.toArray();
        const faceChainage = faceChainageOf(faces, input.faceId);
        const offset = input.chainage - faceChainage;
        const record: WaterInflow = {
          ...toPlain(input),
          id: newId('water'),
          measuredAt: Date.now(),
          chainVersion: version,
          offset,
          chainage: faceChainage + offset,
        };
        await db.waters.put(record);
        return version;
      });
    },

    /** 掌子面区间变动后，重算受影响掌子面下节理位置与涌水趋势桩号 */
    async recomputeDependents(oldFaces: TunnelFace[], newFaces: TunnelFace[], version: number): Promise<void> {
      const oldChainage = new Map(oldFaces.map((f) => [f.id, f.chainage]));
      const moved = new Set(
        newFaces.filter((f) => oldChainage.get(f.id) !== f.chainage).map((f) => f.id),
      );
      const joints = await db.joints.toArray();
      const nextJoints = joints.map((j) =>
        moved.has(j.faceId)
          ? { ...j, chainage: faceChainageOf(newFaces, j.faceId) + j.offset, chainVersion: version }
          : j,
      );
      const waters = await db.waters.toArray();
      const nextWaters = waters.map((w) =>
        moved.has(w.faceId)
          ? { ...w, chainage: faceChainageOf(newFaces, w.faceId) + w.offset, chainVersion: version }
          : w,
      );
      await db.joints.bulkPut(nextJoints);
      await db.waters.bulkPut(nextWaters);
    },

    /** 草稿箱中确认：强制入链并连续性重算相邻区间 */
    async resolveDraft(draftId: string): Promise<ChainCommitResult> {
      const draft = await db.drafts.get(draftId);
      if (!draft || draft.status !== 'draft') return { ok: false, conflicts: [], version: this.version };
      if (draft.kind === 'face') {
        const version = await this.applyFace(draft.payload as FaceFormInput);
        await db.drafts.update(draftId, { status: 'resolved' });
        return { ok: true, conflicts: [], draftId, version };
      }
      if (draft.kind === 'joint') {
        const input = draft.payload as JointSetDraft;
        const faces = await db.faces.toArray();
        const face = faces.find((f) => f.id === input.faceId);
        const version = await db.transaction('rw', db.joints, db.meta, async () => {
          const v = await this.bumpVersion();
          const record: JointSet = {
            ...toPlain(input),
            id: newId('joint'),
            chainVersion: v,
            chainage: (face?.chainage ?? 0) + (input.offset ?? 0),
          };
          await db.joints.put(record);
          return v;
        });
        await db.drafts.update(draftId, { status: 'resolved' });
        return { ok: true, conflicts: [], draftId, version };
      }
      const input = draft.payload as WaterInflowDraft;
      const faces = await db.faces.toArray();
      const face = faces.find((f) => f.id === input.faceId);
      const version = await db.transaction('rw', db.waters, db.meta, async () => {
        const v = await this.bumpVersion();
        const offset = input.chainage - (face?.chainage ?? 0);
        const record: WaterInflow = {
          ...toPlain(input),
          id: newId('water'),
          measuredAt: Date.now(),
          chainVersion: v,
          offset,
          chainage: (face?.chainage ?? 0) + offset,
        };
        await db.waters.put(record);
        return v;
      });
      await db.drafts.update(draftId, { status: 'resolved' });
      return { ok: true, conflicts: [], draftId, version };
    },

    async discardDraft(draftId: string): Promise<void> {
      await db.drafts.delete(draftId);
    },

    /** 整理重叠掌子面：以其当前区间为锚点连续性重算，全部转 active */
    async recomputePending(faceId: string): Promise<number> {
      return db.transaction('rw', db.faces, db.joints, db.waters, db.meta, async () => {
        const oldFaces = await db.faces.toArray();
        const anchor = oldFaces.find((f) => f.id === faceId);
        if (!anchor || anchor.status !== 'pending') return this.version;
        const version = await this.bumpVersion();
        let faces = propagateFaces(oldFaces, faceId, anchor.mileageRange[0], anchor.mileageRange[1]);
        faces = faces.map((f) => ({ ...f, status: 'active' as const, chainVersion: version }));
        await this.recomputeDependents(oldFaces, faces, version);
        await db.faces.bulkPut(faces);
        return version;
      });
    },
  },
});
