/**
 * 公益仓库离线扫码装箱 —— 领域类型（v2：支持多工程合并）
 *
 * 身份模型（关键）：
 * - 每件物品有全局稳定身份 itemId = `${来源工程ID}#${创建操作uid}`；
 *   条码只是可变属性（允许人工改写 RELABEL），不能再当作身份。
 * - 每条操作日志有 (originProjectId, uid, seq)：
 *   uid 为工程内稳定编号，seq 为工程内单调序号（因果顺序），
 *   at 只是该工程本机时钟，仅用于展示，合并判定绝不使用它。
 * - 箱/机构同样用全局引用 globalRef = `${工程ID}#${本地ID}`。
 */

export type DamageGrade = 0 | 1 | 2 | 3;

export const DAMAGE_LABEL: Record<DamageGrade, string> = {
  0: '全新/吊牌',
  1: '九成新（轻微痕迹）',
  2: '可用（明显磨损）',
  3: '污损（需处理）'
};

export type ItemCategory = 'clothing' | 'book' | 'toy' | 'food' | 'medical';

export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  clothing: '衣物',
  book: '书籍文具',
  toy: '玩具',
  food: '食品',
  medical: '医疗用品'
};

export interface Organization {
  /** 全局引用 projectId#localId */
  id: string;
  originProjectId: string;
  name: string;
  allowedCategories: ItemCategory[];
  maxDamage: DamageGrade;
  note?: string;
}

export type ReviewVerdict = 'approved' | 'rejected';

export interface Review {
  /** 稳定编号，跨工程合并去重靠它 */
  uid: string;
  projectId: string;
  seq: number;
  at: number;
  by: string;
  verdict: ReviewVerdict;
  note?: string;
}

export type ItemLocation =
  | { kind: 'queue' }
  | { kind: 'box'; boxId: string }
  | { kind: 'handed'; boxId: string };

export interface Item {
  /** 全局稳定身份 */
  itemId: string;
  originProjectId: string;
  /** 当前条码（可能被人工改写） */
  barcode: string;
  /** 历史条码（曾用码），RELABEL 时留存 */
  aliases: string[];
  name: string;
  category: ItemCategory;
  damage: DamageGrade;
  highValue: boolean;
  scannedAt: number;
  scanCount: number;
  reviews: Review[];
  location: ItemLocation;
  createdAt: number;
  /** 被合并身份的其他 itemId（同一实物裁决后） */
  mergedFrom?: string[];
  /** 不同工程都声称“已交接”时保留双方证据，冻结转移 */
  handoverClaims?: HandoverClaim[];
  /** 双向交接等未决：冻结一切转移 */
  frozen?: boolean;
  frozenReason?: string;
  /** 还有待裁决项（成色/去向/同码）：未裁决前阻止装箱转移 */
  awaitingArbitration?: boolean;
  arbitrationKinds?: string[];
}

export type BoxStatus = 'open' | 'handed';

export interface HandoverEvidence {
  itemId: string;
  barcode: string;
  name: string;
  category: ItemCategory;
  damage: DamageGrade;
}

/** 一件物品被两个工程分别记录交接时，双方证据都保留；active=false 表示该次交接已退回 */
export interface HandoverClaim {
  projectId: string;
  boxId: string;
  receiver?: string;
  at: number;
  damage: DamageGrade;
  barcode: string;
  active?: boolean;
}

export interface Box {
  /** 全局引用 projectId#localId */
  id: string;
  originProjectId: string;
  /** 工程内箱号，如 A-01 */
  label: string;
  orgId: string;
  categories: ItemCategory[];
  maxDamage: DamageGrade;
  status: BoxStatus;
  createdAt: number;
  handedAt?: number;
  receiver?: string;
  /** 逐件检查：键为 itemId（条码改写也不受影响） */
  checks: Record<string, { at: number; by: string }>;
  returnedAt?: number;
  returnReason?: string;
}

export type OperationType =
  | 'SCAN' // 扫码新增
  | 'RESCAN' // 重复扫码（仅定位）
  | 'IMPORT' // 文件导入新增
  | 'RELABEL' // 人工改写条码
  | 'GRADE' // 成色复核改级（from/to 形成因果链）
  | 'BOX_CREATE' // 建箱
  | 'REVIEW' // 高价值复核追加
  | 'PACK'
  | 'UNPACK'
  | 'MOVE'
  | 'CHECK'
  | 'HANDOVER' // 整箱交接（带交接时刻证据快照）
  | 'RETURN' // 交接退回
  | 'REVERT' // 撤销扫码（补偿记录）
  | 'MERGE_IMPORT' // 合并导入审计（不参与状态重放）
  | 'MERGE_RESOLVE'; // 冲突裁决审计（不参与状态重放）

export interface OperationLog {
  /** 工程内稳定编号（主键） */
  uid: string;
  /** 操作来源工程 */
  projectId: string;
  /** 工程内单调序号：同一工程内的因果顺序 */
  seq: number;
  /** 该工程本机时钟，仅展示用，合并判定不依赖 */
  at: number;
  type: OperationType;
  operator: string;
  itemId?: string;
  /** 条码快照（展示用；身份看 itemId） */
  barcode?: string;
  oldBarcode?: string; // RELABEL
  from?: DamageGrade; // GRADE
  to?: DamageGrade; // GRADE
  boxId?: string;
  fromBoxId?: string;
  toBoxId?: string;
  receiver?: string; // HANDOVER
  evidence?: HandoverEvidence[]; // HANDOVER
  revertsUid?: string;
  detail?: string;
  /** BOX_CREATE/CHECK/REVIEW/HANDOVER 等操作的结构化载荷 */
  payload?: Record<string, unknown>;
}

/** 工程元信息（meta store 单例） */
export interface ProjectMeta {
  key: 'meta';
  projectId: string;
  projectName: string;
  createdAt: number;
  /** 本工程已分配的最大操作序号 */
  seq: number;
}

/**
 * 合并台账：
 * - ingested：已导入的操作键 projectId#uid（幂等：同一包反复导入不重复）
 * - adjudications：冲突裁决（稳定 conflictKey -> 决定），随工程快照一起导出
 */
export interface MergeLedger {
  key: 'ledger';
  ingested: Record<string, { packageId?: string }>;
  adjudications: Record<string, Adjudication>;
  packages: Record<string, { name?: string }>;
}

export type Adjudication =
  | {
      kind: 'ITEM_COLLISION';
      /** 同一实物：loser 身份并入 winner，双方证据都保留 */
      decision: 'same_item';
      winner: string;
      loser: string;
      by: string;
      note?: string;
      /** 裁决时的证据指纹；证据变化则冲突重新出现 */
      signature: string;
    }
  | {
      kind: 'ITEM_COLLISION';
      /** 不同实物：给其中一件改派新条码 */
      decision: 'separate';
      relabelItemId: string;
      newBarcode: string;
      by: string;
      note?: string;
      signature: string;
    }
  | { kind: 'DAMAGE'; decision: DamageGrade; by: string; note?: string; signature: string }
  | { kind: 'LOCATION'; decision: ItemLocation; by: string; note?: string; signature: string }
  | { kind: 'DUAL_HANDOVER'; decision: string /* chosenBoxId */; by: string; note: string; signature: string };

export function opKey(projectId: string, uid: string): string {
  return `${projectId}#${uid}`;
}

export function refOf(projectId: string, localId: string): string {
  return `${projectId}#${localId}`;
}

export interface SnapshotV2 {
  format: 'charity-warehouse/v2';
  exportedAt: number;
  payload: {
    meta: ProjectMeta;
    ledger: MergeLedger;
    organizations: Organization[];
    items: Item[];
    boxes: Box[];
    logs: OperationLog[];
  };
}
