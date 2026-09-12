/**
 * 装箱/交接/撤销的业务规则（纯函数，无 DOM、无 IndexedDB，可直接单测）
 */
import type {
  Box,
  DamageGrade,
  Item,
  OperationLog,
  Organization,
  Review
} from './types';

export type RuleViolationCode =
    | 'BOX_LOCKED'
    | 'ORG_CATEGORY'
    | 'ORG_DAMAGE'
    | 'BOX_CATEGORY'
    | 'BOX_DAMAGE'
    | 'REVIEW_MISSING'
    | 'REVIEW_REJECTED'
    | 'ITEM_LOCKED'
    | 'ITEM_FROZEN'
    | 'ITEM_PENDING_ARBITRATION'
    | 'ITEM_ALREADY_IN_BOX'
    | 'CHECK_MISSING';

export interface RuleViolation {
  code: RuleViolationCode;
  message: string;
}

/** 高价值物品的“当前有效复核结论”：以最后一条为准 */
export function latestReview(item: Item): Review | undefined {
  return item.reviews.length ? item.reviews[item.reviews.length - 1] : undefined;
}

function damageText(d: DamageGrade): string {
  return `${d}级`;
}

/**
 * 判断一件物品能否进入某只箱。
 * 机构限制、箱级品类/污损限制、高价值复核，三类约束任一不满足都返回具体原因。
 */
export function validatePack(
  item: Item,
  box: Box,
  org: Organization | undefined,
  opts: { sameBoxOk?: boolean } = {}
): RuleViolation[] {
  const reasons: RuleViolation[] = [];

  if (box.status === 'handed' && !box.returnedAt) {
    reasons.push({ code: 'BOX_LOCKED', message: `箱「${box.label}」已交接锁定，不能装入` });
  }

  if (item.location.kind === 'handed') {
    reasons.push({ code: 'ITEM_LOCKED', message: `物品 ${item.barcode} 已随箱交接锁定，需先走退回流程` });
  }

  if (item.frozen) {
    reasons.push({ code: 'ITEM_FROZEN', message: `物品已冻结：${item.frozenReason ?? '存在待人工核实的合并冲突'}` });
  }
  if (item.awaitingArbitration) {
    reasons.push({
      code: 'ITEM_PENDING_ARBITRATION',
      message: `存在未裁决合并冲突（${(item.arbitrationKinds ?? []).join('、')}），裁决前不能装箱`
    });
  }

  if (
    item.location.kind === 'box' &&
    item.location.boxId === box.id &&
    !opts.sameBoxOk
  ) {
    reasons.push({ code: 'ITEM_ALREADY_IN_BOX', message: `物品已在箱「${box.label}」中` });
  }

  // —— 机构限制 ——
  if (org) {
    if (!org.allowedCategories.includes(item.category)) {
      reasons.push({
        code: 'ORG_CATEGORY',
        message: `机构「${org.name}」不接收该品类`
      });
    }
    if (item.damage > org.maxDamage) {
      reasons.push({
        code: 'ORG_DAMAGE',
        message: `成色 ${damageText(item.damage)} 超出机构「${org.name}」可接收上限 ${damageText(org.maxDamage)}`
      });
    }
  } else {
    reasons.push({ code: 'ORG_CATEGORY', message: '箱未关联有效机构' });
  }

  // —— 箱级限制（一箱不得混入不适配物品）——
  if (!box.categories.includes(item.category)) {
    reasons.push({
      code: 'BOX_CATEGORY',
      message: `该箱仅收纳限定品类，当前物品品类不适配`
    });
  }
  if (item.damage > box.maxDamage) {
    reasons.push({
      code: 'BOX_DAMAGE',
      message: `成色 ${damageText(item.damage)} 超出箱上限 ${damageText(box.maxDamage)}`
    });
  }

  // —— 高价值复核 ——
  if (item.highValue) {
    const review = latestReview(item);
    if (!review) {
      reasons.push({
        code: 'REVIEW_MISSING',
        message: '高价值物品缺少复核结论，不能装箱'
      });
    } else if (review.verdict === 'rejected') {
      reasons.push({
        code: 'REVIEW_REJECTED',
        message: `高价值复核结论为“不通过”（${review.by}），不能装箱`
      });
    }
  }

  return reasons;
}

export interface HandoverItemState {
  item: Item;
  checked: boolean;
  violations: RuleViolation[];
}

export interface HandoverReadiness {
  ok: boolean;
  perItem: HandoverItemState[];
  blockingCount: number;
}

/**
 * 整箱交接前的逐件检查：
 * 每一件都必须 (a) 被实际勾选检查过 (b) 仍满足全部适配规则。
 * 注意：这不是“一个禁用按钮”，而是逐件列出状态；混入的不适配物品在此被拦住。
 */
export function evaluateHandover(
  box: Box,
  itemsInBox: Item[],
  org: Organization | undefined
): HandoverReadiness {
  const perItem = itemsInBox.map((item) => {
    const violations = validatePack(item, box, org, { sameBoxOk: true }).filter(
      // 已在本箱内不算违规
      (v) => v.code !== 'ITEM_ALREADY_IN_BOX'
    );
    const checked = Boolean(box.checks[item.itemId]);
    if (!checked) {
      violations.push({ code: 'CHECK_MISSING', message: '尚未逐件检查勾选' });
    }
    return { item, checked, violations };
  });
  const blockingCount = perItem.reduce((n, p) => n + (p.violations.length ? 1 : 0), 0);
  return { ok: box.status === 'open' && blockingCount === 0 && itemsInBox.length > 0, perItem, blockingCount };
}

/**
 * 撤销一条“扫码新增”操作是否安全：
 * - 只能撤销本工程 SCAN / IMPORT 产生的新增；
 * - 物品必须仍在待装箱队列（没有装箱/移箱/交接）；
 * - 其后不得追加过复核记录 —— 撤销绝不误删后来的复核。
 */
export function canRevertScan(
  creation: OperationLog,
  item: Item | undefined,
  laterLogs: OperationLog[]
): { ok: true } | { ok: false; reason: string } {
  if (creation.type !== 'SCAN' && creation.type !== 'IMPORT') {
    return { ok: false, reason: '只能撤销扫码/导入产生的新增记录' };
  }
  if (!item) {
    return { ok: false, reason: '物品不存在，可能已被撤销' };
  }
  if (item.location.kind !== 'queue') {
    return { ok: false, reason: '物品已装箱或已交接，不能撤销扫码（请先移回队列/走退回流程）' };
  }
  const itemId = item.itemId;
  if (laterLogs.some((l) => l.itemId === itemId && l.seq > creation.seq && l.type === 'REVIEW')) {
    return { ok: false, reason: '该物品扫码后已追加高价值复核记录，撤销会破坏复核痕迹，已阻止' };
  }
  if (laterLogs.some((l) => l.itemId === itemId && l.seq > creation.seq && ['PACK', 'MOVE', 'CHECK'].includes(l.type))) {
    return { ok: false, reason: '该物品扫码后已发生装箱/移箱操作，不能直接撤销' };
  }
  return { ok: true };
}

/** 已交接箱的错误只能通过退回进入修正；未交接箱不存在“退回”概念 */
export function canReturnBox(box: Box): { ok: true } | { ok: false; reason: string } {
  if (box.status !== 'handed') {
    return { ok: false, reason: '仅已交接锁定的清单需要退回处理' };
  }
  return { ok: true };
}
