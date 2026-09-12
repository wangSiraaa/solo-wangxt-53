/**
 * 公益仓库离线扫码装箱 —— 领域类型
 *
 * 设计要点：
 * - Item 代表唯一的一件实物（条码唯一）。重复扫描只定位原物品，绝不产生第二份库存。
 * - Box(箱) 按「机构 + 适用品类 + 污损等级上限」组织；物品装箱必须同时满足三类约束。
 * - 高价值物品必须先有复核结论才能装箱。
 * - 所有变更都以 OperationLog 追加记录（append-only），撤销也是追加一条 REVERT，而非物理删除。
 */

/** 污损等级：数字越小成色越好 */
export type DamageGrade = 0 | 1 | 2 | 3;

export const DAMAGE_LABEL: Record<DamageGrade, string> = {
  0: '全新/吊牌',
  1: '九成新（轻微痕迹）',
  2: '可用（明显磨损）',
  3: '污损（需处理）'
};

export type ItemCategory =
  | 'clothing' // 衣物
  | 'book' // 书籍文具
  | 'toy' // 玩具
  | 'food' // 食品
  | 'medical'; // 医疗用品

export const CATEGORY_LABEL: Record<ItemCategory, string> = {
  clothing: '衣物',
  book: '书籍文具',
  toy: '玩具',
  food: '食品',
  medical: '医疗用品'
};

/** 接收/发放机构（箱只能属于一个机构；物资只能进入被授权品类的机构箱） */
export interface Organization {
  id: string;
  name: string;
  /** 该机构授权接收的品类 */
  allowedCategories: ItemCategory[];
  /** 该机构可接收的最高污损等级（含）。例如只收全新则为 0 */
  maxDamage: DamageGrade;
  note?: string;
}

/** 复核结论（高价值物品必填） */
export type ReviewVerdict = 'approved' | 'rejected';

export interface Review {
  at: number;
  by: string;
  verdict: ReviewVerdict;
  note?: string;
}

/** 物品所处位置 */
export type ItemLocation =
  | { kind: 'queue' } // 待装箱队列
  | { kind: 'box'; boxId: string } // 某只箱内
  | { kind: 'handed'; boxId: string }; // 已随整箱交接（锁定）

export interface Item {
  barcode: string; // 主键，唯一
  name: string;
  category: ItemCategory;
  damage: DamageGrade;
  highValue: boolean;
  /** 最近一次扫码时间 */
  scannedAt: number;
  /** 扫码累计次数（重复扫描累加，用于“定位原物品”） */
  scanCount: number;
  /** 高价值复核记录，可追加多条；以最后一条结论为准 */
  reviews: Review[];
  location: ItemLocation;
  createdAt: number;
}

export type BoxStatus = 'open' | 'handed';

export interface Box {
  id: string;
  label: string; // 箱号/标签，如 A-01
  orgId: string;
  /** 装箱允许的品类（通常取机构授权品类的子集） */
  categories: ItemCategory[];
  /** 装箱允许的最高污损等级（含） */
  maxDamage: DamageGrade;
  status: BoxStatus;
  createdAt: number;
  handedAt?: number;
  /** 交接前“逐件检查”勾选：barcode -> 检查员/时间 */
  checks: Record<string, { at: number; by: string }>;
  /** 交接接收人 */
  receiver?: string;
  /** 退回说明（已交接箱若发生退回） */
  returnedAt?: number;
  returnReason?: string;
}

export type OperationType =
  | 'SCAN' // 扫码新增（连续扫码可撤销的那类）
  | 'RESCAN' // 重复扫码（仅定位，无库存变化）
  | 'IMPORT' // 文件导入新增
  | 'REVIEW' // 高价值复核追加
  | 'PACK' // 装箱
  | 'UNPACK' // 从打开的箱取出 / 退回处理
  | 'MOVE' // 移箱（同时改来源箱与目标箱）
  | 'CHECK' // 整箱交接前逐件检查
  | 'HANDOVER' // 整箱交接（锁定）
  | 'RETURN' // 已交接清单的错误通过退回处理
  | 'REVERT'; // 撤销：补偿记录，不物理删除历史

export interface OperationLog {
  id: number; // 自增
  at: number;
  type: OperationType;
  operator: string;
  barcode?: string;
  boxId?: string;
  fromBoxId?: string;
  toBoxId?: string;
  /** 被撤销的原始日志 id（仅 REVERT） */
  revertsId?: number;
  detail?: string;
}

export interface DatabaseShape {
  organizations: Organization;
  items: Item;
  boxes: Box;
  logs: OperationLog;
}
