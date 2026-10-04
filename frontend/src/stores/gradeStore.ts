import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import { stamp } from '../utils/chain';
import { useChainStore } from './chainStore';
import { useFaceStore } from './faceStore';
import type { RockMassGrade, RockMassGradeDraft } from '../types/grade';
import { recomputeTrends, type WaterInflow, type WaterInflowDraft } from '../types/water';

interface GradeState {
  items: RockMassGrade[];
  waters: WaterInflow[];
  loaded: boolean;
}

export const useGradeStore = defineStore('grade', {
  state: (): GradeState => ({ items: [], waters: [], loaded: false }),
  getters: {
    byFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt),
    latestByFace: (state) => (faceId: string) =>
      state.items.filter((it) => it.faceId === faceId).sort((a, b) => b.judgedAt - a.judgedAt)[0],
    watersByFace: (state) => (faceId: string) =>
      state.waters.filter((it) => it.faceId === faceId).sort((a, b) => a.chainage - b.chainage),
  },
  actions: {
    async load() {
      const grades = await db.grades.toArray();
      this.items = grades.sort((a, b) => b.judgedAt - a.judgedAt);
      const waters = await db.waters.toArray();
      this.waters = waters.sort((a, b) => a.chainage - b.chainage);
      this.loaded = true;
    },
    async addGrade(draft: RockMassGradeDraft) {
      const chainStore = useChainStore();
      const faceStore = useFaceStore();
      const face = faceStore.byId(draft.faceId);
      const revision = chainStore.revision || 1;
      const record: RockMassGrade = {
        ...toPlain(draft),
        id: newId('grade'),
        judgedAt: Date.now(),
        // 级别结论（尤其人工修正）自保存起即冻结，附带所依据的链版本与区间
        version: stamp(1, face?.mileageRange ?? [face?.chainage ?? 0, face?.chainage ?? 0], revision),
      };
      await db.grades.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    async addWater(draft: WaterInflowDraft) {
      const chainStore = useChainStore();
      const faceStore = useFaceStore();
      const face = faceStore.byId(draft.faceId);
      const revision = chainStore.revision || 1;
      const base: WaterInflow = {
        ...toPlain(draft),
        id: newId('water'),
        derivedTrend: undefined,
        measuredAt: Date.now(),
        version: stamp(1, face?.mileageRange ?? [draft.chainage, draft.chainage], revision),
      };
      // 新点加入后沿当前里程链重算全部推导趋势
      const recomputed = recomputeTrends([...this.waters, base]);
      const record = recomputed.find((w) => w.id === base.id)!;
      const updates = recomputed.filter(
        (w) => w.id !== record.id && w.derivedTrend !== this.waters.find((x) => x.id === w.id)?.derivedTrend,
      );
      await db.waters.bulkPut(updates.map((w) => toPlain(w)));
      await db.waters.put(toPlain(record));
      this.waters = recomputed.sort((a, b) => a.chainage - b.chainage);
      return record;
    },
    async removeWater(id: string) {
      await db.waters.delete(id);
      const remain = this.waters.filter((it) => it.id !== id);
      // 删除后趋势顺序可能变化，重新推导
      const recomputed = recomputeTrends(remain);
      const touched = recomputed.filter(
        (w) => w.derivedTrend !== remain.find((x) => x.id === w.id)?.derivedTrend,
      );
      if (touched.length > 0) await db.waters.bulkPut(touched.map((w) => toPlain(w)));
      this.waters = recomputed.sort((a, b) => a.chainage - b.chainage);
    },
  },
});
