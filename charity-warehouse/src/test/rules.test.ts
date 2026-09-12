/**
 * 纯规则测试 —— 重点案例：一箱混入不适配物品、逐件交接、撤销安全性
 */
import { describe, expect, it } from 'vitest';
import { canRevertScan, canReturnBox, evaluateHandover, latestReview, validatePack } from '../lib/rules';
import type { Box, Item, OperationLog, Organization } from '../lib/types';

const org: Organization = {
  id: 'o1',
  name: '爱华儿童福利院',
  allowedCategories: ['clothing', 'book', 'toy'],
  maxDamage: 1
};

const box: Box = {
  id: 'b1',
  label: 'A-01',
  orgId: 'o1',
  categories: ['clothing'],
  maxDamage: 1,
  status: 'open',
  createdAt: 1,
  checks: {}
};

function item(over: Partial<Item> = {}): Item {
  return {
    barcode: 'X1',
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

describe('validatePack — 机构限制 / 污损等级 / 高价值复核', () => {
  it('适配物品可装箱', () => {
    expect(validatePack(item(), box, org)).toEqual([]);
  });

  it('案例3：一箱混入不适配物品 —— 品类不符 + 污损超标 + 机构不收，逐条列出', () => {
    const dirtyToy = item({ barcode: 'T1', name: '污损毛绒玩具', category: 'toy', damage: 3 });
    const reasons = validatePack(dirtyToy, box, org).map((r) => r.code);
    expect(reasons).toContain('BOX_CATEGORY');
    expect(reasons).toContain('BOX_DAMAGE');
    // 衣物箱 + 3 级污损：机构上限 1 也同时拦截
    expect(reasons).toContain('ORG_DAMAGE');
  });

  it('机构不接收的品类即使箱允许也不能装', () => {
    const food = item({ category: 'food', damage: 0 });
    const foodBox: Box = { ...box, categories: ['food'] };
    const reasons = validatePack(food, foodBox, org).map((r) => r.code);
    expect(reasons).toContain('ORG_CATEGORY');
  });

  it('高价值物品缺复核 / 复核不通过均被拦截，通过后可装', () => {
    const hv = item({ highValue: true });
    expect(validatePack(hv, box, org).map((r) => r.code)).toContain('REVIEW_MISSING');

    hv.reviews = [{ at: 2, by: '张三', verdict: 'rejected' }];
    expect(validatePack(hv, box, org).map((r) => r.code)).toContain('REVIEW_REJECTED');
    expect(latestReview(hv)?.verdict).toBe('rejected');

    hv.reviews.push({ at: 3, by: '李四', verdict: 'approved' });
    expect(validatePack(hv, box, org)).toEqual([]);
    expect(latestReview(hv)?.by).toBe('李四');
  });

  it('已交接锁定箱拒绝装入', () => {
    const locked = { ...box, status: 'handed' as const };
    expect(validatePack(item(), locked, org).map((r) => r.code)).toContain('BOX_LOCKED');
  });
});

describe('evaluateHandover — 整箱交接前逐件检查（不只是禁用按钮）', () => {
  it('未勾选逐件检查则每件都阻断', () => {
    const a = item({ barcode: 'A', location: { kind: 'box', boxId: 'b1' } });
    const r = evaluateHandover(box, [a], org);
    expect(r.ok).toBe(false);
    expect(r.perItem[0].violations.map((v) => v.code)).toContain('CHECK_MISSING');
  });

  it('混入的不适配物品在交接时再次被拦住（即使被错误勾选）', () => {
    const good = item({ barcode: 'A', location: { kind: 'box', boxId: 'b1' } });
    const bad = item({ barcode: 'B', category: 'toy', damage: 3, location: { kind: 'box', boxId: 'b1' } });
    const checkedBox: Box = {
      ...box,
      checks: {
        A: { at: 1, by: 'x' },
        B: { at: 1, by: 'x' }
      }
    };
    const r = evaluateHandover(checkedBox, [good, bad], org);
    expect(r.ok).toBe(false);
    expect(r.blockingCount).toBe(1);
    const rowB = r.perItem.find((p) => p.item.barcode === 'B')!;
    expect(rowB.violations.length).toBeGreaterThan(0);
    const rowA = r.perItem.find((p) => p.item.barcode === 'A')!;
    expect(rowA.violations).toEqual([]);
  });

  it('全部逐件检查且适配才允许交接；空箱不行', () => {
    const a = item({ barcode: 'A', location: { kind: 'box', boxId: 'b1' } });
    const checkedBox: Box = { ...box, checks: { A: { at: 1, by: 'x' } } };
    expect(evaluateHandover(checkedBox, [a], org).ok).toBe(true);
    expect(evaluateHandover(checkedBox, [], org).ok).toBe(false);
  });
});

describe('canRevertScan — 撤销不能误删后来追加的复核', () => {
  const scan = (id: number): OperationLog => ({ id, at: id, type: 'SCAN', operator: 'x', barcode: 'A' });

  it('队列中的新扫码可撤销', () => {
    const it = item({ barcode: 'A' });
    expect(canRevertScan(scan(1), it, [scan(1)]).ok).toBe(true);
  });

  it('扫码后追加了 REVIEW：撤销必须被阻止', () => {
    const it = item({ barcode: 'A', reviews: [{ at: 9, by: 'r', verdict: 'approved' }] });
    const logs = [
      scan(1),
      { id: 2, at: 2, type: 'REVIEW', operator: 'r', barcode: 'A' } as OperationLog
    ];
    const r = canRevertScan(logs[0], it, logs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('复核');
  });

  it('已装箱的物品不能撤销扫码（应先取出/退回）', () => {
    const it = item({ barcode: 'A', location: { kind: 'box', boxId: 'b1' } });
    expect(canRevertScan(scan(1), it, [scan(1)]).ok).toBe(false);
  });

  it('非扫码类日志不可撤销', () => {
    const pack = { id: 5, at: 5, type: 'PACK', operator: 'x', barcode: 'A' } as OperationLog;
    expect(canRevertScan(pack, item({ barcode: 'A' }), [pack]).ok).toBe(false);
  });
});

describe('canReturnBox', () => {
  it('只有已交接箱允许退回', () => {
    expect(canReturnBox({ ...box, status: 'handed' }).ok).toBe(true);
    expect(canReturnBox(box).ok).toBe(false);
  });
});
