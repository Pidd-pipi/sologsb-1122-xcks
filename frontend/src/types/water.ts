import type { RangeVersion } from './chain';

/** 出水类型 */
export type InflowType = '渗水' | '滴水' | '线流' | '股状';

export const INFLOW_TYPES: InflowType[] = ['渗水', '滴水', '线流', '股状'];

/** 变化趋势 */
export type ChangeTrend = '减小' | '稳定' | '增大' | '突增';

export const CHANGE_TRENDS: ChangeTrend[] = ['减小', '稳定', '增大', '突增'];

/** 涌水记录 */
export interface WaterInflow {
  id: string;
  faceId: string;
  /** 出水部位 */
  position: string;
  type: InflowType;
  /** 估算涌水量 L/min */
  estimatedFlow: number;
  /** 水温 ℃ */
  waterTemp: number;
  /** 水压 MPa */
  waterPressure: number;
  changeTrend: ChangeTrend;
  measuredAt: number;
  /** 沿里程位置（米），用于趋势折线；随所属掌子面区间重算 */
  chainage: number;
  /** 由当前里程链推导的变化趋势（链版本变化时重算，不覆盖人工填写的 changeTrend） */
  derivedTrend?: ChangeTrend;
  /** 版本戳 */
  version: RangeVersion;
}

export type WaterInflowDraft = Omit<WaterInflow, 'id' | 'measuredAt' | 'derivedTrend' | 'version'>;

/** 实际生效的趋势：优先用里程链重算的推导值，缺省回退人工填写值 */
export function effectiveTrend(point: WaterInflow): ChangeTrend {
  return point.derivedTrend ?? point.changeTrend;
}

/** 是否突变点（趋势突增或涌水量超过阈值） */
export function isSurge(point: WaterInflow, all: WaterInflow[]): boolean {
  if (effectiveTrend(point) === '突增') return true;
  const sorted = [...all].sort((a, b) => a.chainage - b.chainage);
  const index = sorted.findIndex((p) => p.id === point.id);
  if (index <= 0) return false;
  const prev = sorted[index - 1];
  if (prev.estimatedFlow <= 0) return false;
  return point.estimatedFlow / prev.estimatedFlow >= 2;
}

/**
 * 沿里程链重算所有涌水点的推导趋势（不修改人工填写的 changeTrend）。
 * 用于里程提交确认后及旧数据升级：保证趋势引用的是当前桩号顺序。
 */
export function recomputeTrends(points: WaterInflow[]): WaterInflow[] {
  const sorted = [...points].sort((a, b) => a.chainage - b.chainage);
  return sorted.map((p, i) => {
    let derived: ChangeTrend = '稳定';
    if (i > 0) {
      const prev = sorted[i - 1];
      if (prev.estimatedFlow > 0 && p.estimatedFlow / prev.estimatedFlow >= 2) derived = '突增';
      else if (p.estimatedFlow > prev.estimatedFlow * 1.1) derived = '增大';
      else if (p.estimatedFlow < prev.estimatedFlow * 0.9) derived = '减小';
      else derived = '稳定';
    }
    return { ...p, derivedTrend: derived };
  });
}
