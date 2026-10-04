import Dexie, { type Table } from 'dexie';
import type { TunnelFace } from '../types/face';
import type { JointSet } from '../types/joint';
import type { RockMassGrade } from '../types/grade';
import type { WaterInflow } from '../types/water';
import type { ChainDraft } from '../types/chain';
import { newId } from './id';

export const DB_NAME = 'gbtunnelface';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbtunnelface:db-version';
/** 里程链全局版本在 meta 表中的键 */
export const CHAIN_VERSION_KEY = 'chain-version';

/** 键值元数据（里程链版本等） */
export interface MetaRow {
  key: string;
  value: number;
}

class TunnelFaceDB extends Dexie {
  faces!: Table<TunnelFace, string>;
  joints!: Table<JointSet, string>;
  grades!: Table<RockMassGrade, string>;
  waters!: Table<WaterInflow, string>;
  drafts!: Table<ChainDraft, string>;
  meta!: Table<MetaRow, string>;

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
    this.version(3)
      .stores({
        faces: 'id, faceNo, chainage, lithology, excavationMethod, weathering, recordedAt, status, chainVersion',
        joints: 'id, faceId, setNo, dipDirection, dipAngle, fillMaterial, chainVersion',
        grades: 'id, faceId, grade, judgedAt, bqValue, chainVersion',
        waters: 'id, faceId, chainage, type, changeTrend, chainVersion',
        drafts: 'id, kind, status, baseVersion, createdAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        // 旧数据补齐版本：全部视为链 v1 入链
        await tx
          .table('faces')
          .toCollection()
          .modify((row: any) => {
            if (row.chainVersion === undefined) row.chainVersion = 1;
            if (row.status === undefined) row.status = 'active';
          });
        await tx
          .table('joints')
          .toCollection()
          .modify((row: any) => {
            if (row.chainVersion === undefined) row.chainVersion = 1;
            if (row.offset === undefined) row.offset = 0;
          });
        await tx
          .table('grades')
          .toCollection()
          .modify((row: any) => {
            if (row.chainVersion === undefined) row.chainVersion = 1;
          });
        // 涌水：按掌子面桩号补齐偏移与版本
        const faceRows: any[] = await tx.table('faces').toArray();
        const faceChainage = new Map<string, number>(faceRows.map((f) => [f.id, f.chainage ?? 0]));
        await tx
          .table('joints')
          .toCollection()
          .modify((row: any) => {
            if (row.chainage === undefined) row.chainage = faceChainage.get(row.faceId) ?? 0;
          });
        await tx
          .table('waters')
          .toCollection()
          .modify((row: any) => {
            if (row.chainVersion === undefined) row.chainVersion = 1;
            if (row.offset === undefined) {
              const base = faceChainage.get(row.faceId) ?? row.chainage ?? 0;
              row.offset = (row.chainage ?? 0) - base;
            }
          });
        // 重叠区间不丢弃：涉事掌子面进入待整理（两两比对，避免漏判）
        const pending = new Set<string>();
        for (let i = 0; i < faceRows.length; i++) {
          for (let j = i + 1; j < faceRows.length; j++) {
            const a = faceRows[i];
            const b = faceRows[j];
            const ra: [number, number] = a.mileageRange ?? [a.chainage, a.chainage];
            const rb: [number, number] = b.mileageRange ?? [b.chainage, b.chainage];
            if (ra[0] < rb[1] && ra[1] > rb[0]) {
              pending.add(a.id);
              pending.add(b.id);
            }
          }
        }
        if (pending.size > 0) {
          await tx.table('faces').where('id').anyOf([...pending]).modify({ status: 'pending' });
        }
        await tx.table('meta').put({ key: CHAIN_VERSION_KEY, value: 1 });
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

/** 首次进入灌入示范掌子面数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.faces.count();
  if (count > 0) return;

  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 24 * hour;

  const face1 = newId('face');
  const face2 = newId('face');

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
      chainVersion: 1,
      status: 'active',
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
      chainVersion: 1,
      status: 'active',
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
      chainVersion: 1,
      offset: 0,
      chainage: 12480,
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
      chainVersion: 1,
      offset: 0,
      chainage: 12480,
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
      chainVersion: 1,
      offset: 0,
      chainage: 12480,
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
      chainVersion: 1,
      offset: 0,
      chainage: 12483,
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
      chainVersion: 1,
    },
  ];

  const mkWater = (
    partial: Partial<WaterInflow> & { faceId: string; chainage: number },
    baseChainage: number,
  ): WaterInflow => ({
    id: newId('water'),
    position: '',
    type: '滴水',
    estimatedFlow: 0,
    waterTemp: 15,
    waterPressure: 0.1,
    changeTrend: '稳定',
    measuredAt: now,
    chainVersion: 1,
    offset: partial.chainage - baseChainage,
    ...partial,
  });

  const waters: WaterInflow[] = [
    mkWater({ faceId: face1, position: '拱顶右侧 3 m', type: '滴水', estimatedFlow: 6, waterTemp: 14, waterPressure: 0.12, changeTrend: '稳定', measuredAt: now - 2 * day, chainage: 12478 }, 12480),
    mkWater({ faceId: face1, position: '拱腰右侧', type: '线流', estimatedFlow: 22, waterTemp: 15, waterPressure: 0.32, changeTrend: '增大', measuredAt: now - day, chainage: 12481 }, 12480),
    mkWater({ faceId: face1, position: '拱脚左侧', type: '股状', estimatedFlow: 68, waterTemp: 16, waterPressure: 0.58, changeTrend: '突增', measuredAt: now - 4 * hour, chainage: 12484 }, 12480),
  ];

  await db.transaction('rw', db.faces, db.joints, db.grades, db.waters, db.meta, async () => {
    await db.faces.bulkPut(faces);
    await db.joints.bulkPut(joints);
    await db.grades.bulkPut(grades);
    await db.waters.bulkPut(waters);
    await db.meta.put({ key: CHAIN_VERSION_KEY, value: 1 });
  });
}
