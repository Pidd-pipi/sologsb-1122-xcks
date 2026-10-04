import Dexie, { type Table } from 'dexie';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import type { FaceDraftRecord, MetaRecord } from '../types/chain';
import { recomputeTrends } from '../types/water';
import { newId } from './id';

export const DB_NAME = 'gbtunnelface';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbtunnelface:db-version';
export const META_CHAIN_REVISION = 'chainRevision';

class TunnelFaceDB extends Dexie {
  faces!: Table<TunnelFace, string>;
  joints!: Table<JointSet, string>;
  grades!: Table<RockMassGrade, string>;
  waters!: Table<WaterInflow, string>;
  drafts!: Table<FaceDraftRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      faces: 'id, faceNo, chainage, lithology, excavationMethod, recordedAt',
      joints: 'id, faceId, setNo, dipDirection, dipAngle',
      grades: 'id, faceId, grade, judgedAt',
      waters: 'id, faceId, chainage, type',
    });
    this.version(2)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial',
        grades: 'id, faceId, grade, judgedAt, bqValue',
        waters: 'id, faceId, chainage, type, changeTrend',
      })
      .upgrade(async (tx) => {
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (!row.attitude) row.attitude = { strike: 0, dipDirection: 0, dipAngle: 0 };
            if (row.mileageRange === undefined) row.mileageRange = [row.chainage ?? 0, row.chainage ?? 0];
          });
        await tx
          .table('grades')
          .toCollection()
          .modify((row: any) => {
            if (row.correctedBq === undefined) row.correctedBq = row.bqValue ?? 0;
            if (row.manualAdjusted === undefined) row.manualAdjusted = false;
          });
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (row.chainage === undefined) row.chainage = 0;
          });
      });
    // v3：版本化里程链。faces/joints/waters/grades 补版本戳；
    // 区间重叠的旧掌子面进入 pending（待整理）而不是丢弃；
    // 新增 meta（链版本）与 drafts（冲突保留草稿）两张表。
    this.version(3)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, status, recordedAt',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial, chainage',
        grades: 'id, faceId, grade, judgedAt, bqValue',
        waters: 'id, faceId, chainage, type, changeTrend',
        drafts: 'id, mode, faceId, savedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const faceRows: any[] = await tx.table('faces').toCollection().toArray();

        // 重叠检测（保留最早编录的一个 active，其余重叠的进入待整理）
        const ordered = [...faceRows].sort((a, b) => (a.recordedAt ?? 0) - (b.recordedAt ?? 0));
        const activeRanges: [number, number][] = [];
        const pendingIds = new Set<string>();
        for (const row of ordered) {
          const range: [number, number] = row.mileageRange ?? [row.chainage ?? 0, row.chainage ?? 0];
          const overlap = activeRanges.some((r) => r[0] < range[1] && range[0] < r[1]);
          if (overlap) {
            pendingIds.add(row.id);
          } else {
            activeRanges.push(range);
          }
        }

        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (row.status === undefined) row.status = pendingIds.has(row.id) ? 'pending' : 'active';
            if (!row.version) {
              row.version = {
                chainRevision: 1,
                recordVersion: 1,
                basisRange: [row.mileageRange?.[0] ?? 0, row.mileageRange?.[1] ?? 0],
              };
            }
          });

        const faceRangeById = new Map<string, [number, number]>(
          faceRows.map((r) => [r.id, r.mileageRange ?? [r.chainage ?? 0, r.chainage ?? 0]]),
        );

        await tx
          .table('joints')
          .toCollection()
          .modify((row: any) => {
            const range = faceRangeById.get(row.faceId) ?? [0, 0];
            if (typeof row.chainage !== 'number') row.chainage = range[0];
            if (!row.version) row.version = { chainRevision: 1, recordVersion: 1, basisRange: [...range] };
          });

        const waterRows: any[] = await tx.table('waters').toCollection().toArray();
        waterRows.forEach((row) => {
          const range = faceRangeById.get(row.faceId) ?? [row.chainage ?? 0, row.chainage ?? 0];
          if (typeof row.chainage !== 'number') row.chainage = range[0];
          if (!row.version) row.version = { chainRevision: 1, recordVersion: 1, basisRange: [...range] };
        });
        const derivedById = new Map(
          recomputeTrends(waterRows as WaterInflow[]).map((w) => [w.id, w.derivedTrend]),
        );
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (typeof row.chainage !== 'number') {
              const range = faceRangeById.get(row.faceId) ?? [0, 0];
              row.chainage = range[0];
            }
            if (!row.version) {
              const range = faceRangeById.get(row.faceId) ?? [row.chainage ?? 0, row.chainage ?? 0];
              row.version = { chainRevision: 1, recordVersion: 1, basisRange: [...range] };
            }
            if (row.derivedTrend === undefined) row.derivedTrend = derivedById.get(row.id) ?? '稳定';
          });

        await tx
          .table('grades')
          .toCollection()
          .modify((row: any) => {
            const range = faceRangeById.get(row.faceId) ?? [0, 0];
            if (!row.version) row.version = { chainRevision: 1, recordVersion: 1, basisRange: [...range] };
          });

        await tx.table('meta').put({ key: META_CHAIN_REVISION, value: 1 });
      });
  }
}

export const db = new TunnelFaceDB();

/**
 * 把 Vue 响应式代理转成可结构化克隆的普通对象。
 * IndexedDB 的 put/add 无法克隆 Proxy，否则抛 DataCloneError。
 */
export function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 首次进入灌入示范掌子面数据（已带 v3 版本戳，含待整理重叠掌子面与冲突草稿示例） */
export async function ensureSeedData(): Promise<void> {
  const count = await db.faces.count();
  if (count > 0) return;

  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const face1 = newId('face');
  const face2 = newId('face');
  const face3 = newId('face');
  const revision = 1;

  const faces: TunnelFace[] = [
    {
      id: face1,
      faceNo: 'ZK-102',
      chainage: 12480,
      mileageRange: [12480, 12483],
      excavationMethod: '台阶法',
      faceSize: '12.6×9.8',
      lithology: '石灰岩',
      weathering: '微风化',
      rockStrength: 62,
      attitude: { strike: 42, dipDirection: 132, dipAngle: 34 },
      recordedAt: now - 2 * day,
      geologist: '岑柏川',
      status: 'active',
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: face2,
      faceNo: 'ZK-103',
      chainage: 12483,
      mileageRange: [12483, 12486],
      excavationMethod: '台阶法',
      faceSize: '12.6×9.8',
      lithology: '泥岩',
      weathering: '强风化',
      rockStrength: 18,
      attitude: { strike: 48, dipDirection: 138, dipAngle: 28 },
      recordedAt: now - 6 * hour,
      geologist: '岑柏川',
      status: 'active',
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12483, 12486] },
    },
    {
      // 旧数据升级时检出的区间重叠掌子面：里程与 ZK-102/ZK-103 冲突，进入待整理
      id: face3,
      faceNo: 'ZK-101',
      chainage: 12482,
      mileageRange: [12481, 12484],
      excavationMethod: '全断面',
      faceSize: '12.4×9.6',
      lithology: '砂岩',
      weathering: '弱风化',
      rockStrength: 41,
      attitude: { strike: 55, dipDirection: 145, dipAngle: 41 },
      recordedAt: now - 5 * day,
      geologist: '测量组·傅衡',
      status: 'pending',
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12481, 12484] },
    },
  ];

  const joints: JointSet[] = [
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 1,
      dipDirection: 128,
      dipAngle: 72,
      spacing: 42,
      persistence: 3.6,
      aperture: 1.2,
      fillMaterial: '方解石',
      roughness: '粗糙',
      waterWet: '潮湿',
      jointCount: 9,
      chainage: 12481,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 2,
      dipDirection: 216,
      dipAngle: 46,
      spacing: 68,
      persistence: 2.4,
      aperture: 0.6,
      fillMaterial: '泥质',
      roughness: '平整',
      waterWet: '滴水',
      jointCount: 5,
      chainage: 12482,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: newId('joint'),
      faceId: face1,
      setNo: 3,
      dipDirection: 312,
      dipAngle: 84,
      spacing: 25,
      persistence: 4.1,
      aperture: 2.4,
      fillMaterial: '无',
      roughness: '起伏粗糙',
      waterWet: '干燥',
      jointCount: 12,
      chainage: 12482.5,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: newId('joint'),
      faceId: face2,
      setNo: 1,
      dipDirection: 140,
      dipAngle: 22,
      spacing: 120,
      persistence: 5.2,
      aperture: 3.1,
      fillMaterial: '泥质',
      roughness: '平直光滑',
      waterWet: '线流',
      jointCount: 4,
      chainage: 12484,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12483, 12486] },
    },
    {
      id: newId('joint'),
      faceId: face3,
      setNo: 1,
      dipDirection: 168,
      dipAngle: 55,
      spacing: 75,
      persistence: 2.8,
      aperture: 1.5,
      fillMaterial: '泥质',
      roughness: '粗糙',
      waterWet: '滴水',
      jointCount: 6,
      chainage: 12482,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12481, 12484] },
    },
  ];

  const grades: RockMassGrade[] = [
    {
      id: newId('grade'),
      faceId: face1,
      grade: 'Ⅲ',
      bqValue: 358,
      rqd: 78,
      jv: 6.2,
      kv: 0.61,
      groundwater: '点滴状出水',
      spanWidth: 12.6,
      correction: 0.1,
      correctedBq: 348,
      supportSuggestion: '系统锚杆（φ25，L=3.0 m，间距 1.0 m）+ 喷射混凝土 12 cm + 钢筋网',
      manualAdjusted: false,
      judgedAt: now - 2 * day,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      // 人工确认的级别结论：里程链重算后仍保留，并显示所依据版本
      id: newId('grade'),
      faceId: face2,
      grade: 'Ⅳ',
      bqValue: 322,
      rqd: 46,
      jv: 9.8,
      kv: 0.42,
      groundwater: '线状出水',
      spanWidth: 12.6,
      correction: 0.24,
      correctedBq: 298,
      supportSuggestion: '钢拱架（I16，间距 1.0 m）+ 系统锚杆（φ25，L=3.5 m）+ 喷射混凝土 20 cm',
      manualAdjusted: true,
      judgedAt: now - 5 * hour,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12483, 12486] },
    },
  ];

  const waters: WaterInflow[] = [
    {
      id: newId('water'),
      faceId: face1,
      position: '拱顶右侧 3 m',
      type: '滴水',
      estimatedFlow: 6,
      waterTemp: 14,
      waterPressure: 0.12,
      changeTrend: '稳定',
      derivedTrend: '稳定',
      measuredAt: now - 2 * day,
      chainage: 12478,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: newId('water'),
      faceId: face1,
      position: '拱腰右侧',
      type: '线流',
      estimatedFlow: 22,
      waterTemp: 15,
      waterPressure: 0.32,
      changeTrend: '增大',
      derivedTrend: '增大',
      measuredAt: now - day,
      chainage: 12481,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12480, 12483] },
    },
    {
      id: newId('water'),
      faceId: face2,
      position: '拱脚左侧',
      type: '股状',
      estimatedFlow: 68,
      waterTemp: 16,
      waterPressure: 0.58,
      changeTrend: '突增',
      derivedTrend: '突增',
      measuredAt: now - 4 * hour,
      chainage: 12484,
      version: { chainRevision: revision, recordVersion: 1, basisRange: [12483, 12486] },
    },
  ];

  // 一条提交时被保留的冲突草稿示例：区间与 ZK-103 重叠
  const draft: FaceDraftRecord = {
    id: newId('draft'),
    mode: 'create',
    baseRevision: revision,
    faceNo: 'ZK-104',
    chainage: 12485,
    mileageRange: [12484, 12487],
    updatedBy: '测量组·傅衡',
    fullDraft: {
      faceNo: 'ZK-104',
      chainage: 12485,
      mileageRange: [12484, 12487],
      excavationMethod: '台阶法',
      faceSize: '12.6×9.8',
      lithology: '石灰岩',
      weathering: '微风化',
      rockStrength: 55,
      attitude: { strike: 45, dipDirection: 135, dipAngle: 30 },
      geologist: '测量组·傅衡',
    },
    conflicts: [
      { kind: 'overlap', faceId: face2, faceNo: 'ZK-103', message: '里程区间与相邻编录「ZK-103」(12483~12486 m) 重叠' },
    ],
    savedAt: now - 2 * hour,
  };

  await db.transaction(
    'rw',
    [db.faces, db.joints, db.grades, db.waters, db.drafts, db.meta],
    async () => {
      await db.meta.put({ key: META_CHAIN_REVISION, value: revision });
      await db.faces.bulkPut(faces);
      await db.joints.bulkPut(joints);
      await db.grades.bulkPut(grades);
      await db.waters.bulkPut(waters);
      await db.drafts.put(draft);
    },
  );
}
