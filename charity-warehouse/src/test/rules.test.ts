/**
 * 纯规则测试 —— 装箱适配 / 逐件交接 / 撤销保护（v2：itemId 身份）
 */
import { describe, expect, it } from 'vitest';
import { canRevertScan, canReturnBox, evaluateHandover, latestReview, validatePack } from '../lib/rules';
import type { Box, Item, OperationLog, Organization } from '../lib/types';

const org: Organization = {
  id: 'p1#o1',
  originProjectId: 'p1',
  name: '爱华儿童福利院',
  allowedCategories: ['clothing', 'book', 'toy'],
  maxDamage: 1
};

const box: Box = {
  id: 'p1#b1',
  originProjectId: 'p1',
  label: 'A-01',
  orgId: 'p1#o1',
  categories: ['clothing'],
  maxDamage: 1,
  status: 'open',
  createdAt: 1,
  checks: {}
};

let n = 0;
function item(over: Partial<Item> = {}): Item {
  n += 1;
  return {
    itemId: `p1#x${n}`,
    originProjectId: 'p1',
    barcode: `X${n}`,
    aliases: [],
    name: '卫衣',
    category: 'clothing',
    damage: 1,
    highValue: false,
    scannedAt: 1,
    scanCount: 1,
    reviews: [],
    location: { kind: 'queue' },
    createdAt: 1,
    ...over
  };
}

describe('validatePack', () => {
  it('适配物品可装箱', () => {
    expect(validatePack(item(), box, org)).toEqual([]);
  });

  it('一箱混入不适配物品：品类 + 污损 + 机构限制逐条列出', () => {
    const codes = validatePack(item({ barcode: 'T1', name: '污损玩具', category: 'toy', damage: 3 }), box, org).map((r) => r.code);
    expect(codes).toContain('BOX_CATEGORY');
    expect(codes).toContain('BOX_DAMAGE');
    expect(codes).toContain('ORG_DAMAGE');
  });

  it('高价值复核缺失/不通过拦截，通过放行（以最后一条为准）', () => {
    const hv = item({ highValue: true });
    expect(validatePack(hv, box, org).map((r) => r.code)).toContain('REVIEW_MISSING');
    hv.reviews = [{ uid: 'u1', projectId: 'p1', seq: 1, at: 2, by: '张', verdict: 'rejected' }];
    expect(validatePack(hv, box, org).map((r) => r.code)).toContain('REVIEW_REJECTED');
    hv.reviews.push({ uid: 'u2', projectId: 'p1', seq: 2, at: 3, by: '李', verdict: 'approved' });
    expect(validatePack(hv, box, org)).toEqual([]);
    expect(latestReview(hv)?.by).toBe('李');
  });

  it('冻结 / 待裁决物品不能装箱', () => {
    expect(validatePack(item({ frozen: true, frozenReason: '双交接' }), box, org).map((r) => r.code)).toContain('ITEM_FROZEN');
    expect(validatePack(item({ awaitingArbitration: true, arbitrationKinds: ['DAMAGE'] }), box, org).map((r) => r.code)).toContain('ITEM_PENDING_ARBITRATION');
  });

  it('已交接锁定箱拒绝装入', () => {
    expect(validatePack(item(), { ...box, status: 'handed' }, org).map((r) => r.code)).toContain('BOX_LOCKED');
  });
});

describe('evaluateHandover（逐件检查，不只是禁用按钮）', () => {
  it('未勾检每件都阻断；不适配物品即使勾选也拦住；全部通过才放行', () => {
    const a = item({ location: { kind: 'box', boxId: box.id } });
    let r = evaluateHandover(box, [a], org);
    expect(r.ok).toBe(false);
    expect(r.perItem[0].violations.map((v) => v.code)).toContain('CHECK_MISSING');

    const bad = item({ category: 'toy', damage: 3, location: { kind: 'box', boxId: box.id } });
    const checked: Box = { ...box, checks: { [a.itemId]: { at: 1, by: 'x' }, [bad.itemId]: { at: 1, by: 'x' } } };
    r = evaluateHandover(checked, [a, bad], org);
    expect(r.blockingCount).toBe(1);
    expect(evaluateHandover({ ...box, checks: { [a.itemId]: { at: 1, by: 'x' } } }, [a], org).ok).toBe(true);
    expect(evaluateHandover(box, [], org).ok).toBe(false);
  });
});

describe('canRevertScan（v2：seq 因果、不误删复核）', () => {
  const scan = (): OperationLog => ({ uid: 'u-scan', projectId: 'p1', seq: 1, at: 1, type: 'SCAN', operator: 'x', itemId: 'p1#u-scan', barcode: 'A' });
  it('队列新扫码可撤销', () => {
    const it = item({ itemId: 'p1#u-scan', barcode: 'A' });
    expect(canRevertScan(scan(), it, [scan()]).ok).toBe(true);
  });
  it('其后有 REVIEW 阻止撤销', () => {
    const it = item({ itemId: 'p1#u-scan', barcode: 'A', reviews: [{ uid: 'r', projectId: 'p1', seq: 2, at: 2, by: 'r', verdict: 'approved' }] });
    const review: OperationLog = { uid: 'r', projectId: 'p1', seq: 2, at: 2, type: 'REVIEW', operator: 'r', itemId: 'p1#u-scan', barcode: 'A' };
    expect(canRevertScan(scan(), it, [scan(), review]).ok).toBe(false);
  });
  it('已装箱不能撤销；非扫码类不可撤销', () => {
    const it = item({ itemId: 'p1#u-scan', location: { kind: 'box', boxId: 'p1#b1' } });
    expect(canRevertScan(scan(), it, [scan()]).ok).toBe(false);
    const pack: OperationLog = { uid: 'p', projectId: 'p1', seq: 2, at: 2, type: 'PACK', operator: 'x', itemId: 'p1#u-scan' };
    expect(canRevertScan(pack, item({ itemId: 'p1#u-scan' }), [pack]).ok).toBe(false);
  });
});

describe('canReturnBox', () => {
  it('只有已交接箱允许退回', () => {
    expect(canReturnBox({ ...box, status: 'handed' }).ok).toBe(true);
    expect(canReturnBox(box).ok).toBe(false);
  });
});
