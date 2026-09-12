/**
 * IndexedDB 集成测试（fake-indexeddb）：
 * 重复扫描不新增库存、移箱同事务更新两侧、交接锁定、退回纠错、撤销与 REVERT 留痕、文件导入去重。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addReview,
  handoverBox,
  importRows,
  listAll,
  moveItem,
  packItem,
  revertScan,
  returnBox,
  scanBarcode,
  toggleCheck,
  unpackItem
} from '../lib/actions';
import { deleteDb, putAll } from '../lib/db';
import type { Box, Organization } from '../lib/types';

const ORGS: Organization[] = [
  { id: 'o1', name: '爱华儿童福利院', allowedCategories: ['clothing', 'toy'], maxDamage: 1 },
  { id: 'o2', name: '捷善救助站', allowedCategories: ['clothing', 'medical'], maxDamage: 2 }
];

const BOXES: Box[] = [
  { id: 'b1', label: 'A-01', orgId: 'o1', categories: ['clothing'], maxDamage: 1, status: 'open', createdAt: 1, checks: {} },
  { id: 'b2', label: 'B-02', orgId: 'o2', categories: ['medical'], maxDamage: 2, status: 'open', createdAt: 1, checks: {} }
];

const clothingDraft = { name: '卫衣', category: 'clothing' as const, damage: 1 as const, highValue: false };

beforeEach(async () => {
  await deleteDb();
  await putAll('organizations', ORGS);
  await putAll('boxes', BOXES);
});

describe('案例2：重复扫描定位原物品，不新增第二份库存', () => {
  it('同一条码扫三次：只有一件库存，scanCount=3', async () => {
    await scanBarcode('6901001', clothingDraft, '仓管');
    await scanBarcode('6901001', clothingDraft, '仓管');
    const r3 = await scanBarcode('6901001', clothingDraft, '仓管');
    const { items, logs } = await listAll();
    expect(items).toHaveLength(1);
    expect(items[0].scanCount).toBe(3);
    expect(r3.outcome).toBe('duplicate');
    expect(logs.filter((l) => l.type === 'SCAN')).toHaveLength(1);
    expect(logs.filter((l) => l.type === 'RESCAN')).toHaveLength(2);
  });

  it('装箱后重复扫描：定位到箱内，位置不变、库存不变', async () => {
    await scanBarcode('6901001', clothingDraft, '仓管');
    await packItem('6901001', 'b1', '仓管');
    const dup = await scanBarcode('6901001', clothingDraft, '仓管');
    const { items } = await listAll();
    expect(items).toHaveLength(1);
    expect(dup.item.location).toEqual({ kind: 'box', boxId: 'b1' });
  });
});

describe('案例3：一箱混入不适配物品', () => {
  it('污损玩具不能装入仅收 1 级衣物的箱，错误含具体原因', async () => {
    await scanBarcode('T1', { name: '污损玩具', category: 'toy', damage: 3, highValue: false }, '仓管');
    await expect(packItem('T1', 'b1', '仓管')).rejects.toThrow(/品类|成色/);
    const { items } = await listAll();
    expect(items[0].location.kind).toBe('queue'); // 留在队列
  });

  it('逐件检查不全 / 有不适配项时交接拒绝，全部满足后才锁定', async () => {
    await scanBarcode('C1', clothingDraft, '仓管');
    await packItem('C1', 'b1', '仓管');
    // 未勾检 → 拒绝
    await expect(handoverBox('b1', '王校长', '仓管')).rejects.toThrow(/逐件检查|不适配/);

    await toggleCheck('C1', 'b1', '仓管');
    await handoverBox('b1', '王校长', '仓管');
    const { boxes, items, logs } = await listAll();
    expect(boxes[0].status).toBe('handed');
    expect(items[0].location.kind).toBe('handed');
    expect(logs.some((l) => l.type === 'HANDOVER')).toBe(true);
  });
});

describe('移箱必须同时更新来源箱和目标箱', () => {
  it('一次 MOVE 事务：物品落目标箱、来源箱勾检记录清除、日志留痕', async () => {
    await scanBarcode('M1', { name: '退烧贴', category: 'medical', damage: 0, highValue: false }, '仓管');
    // 先装入衣物箱 b1 不可能（品类不符），所以构造一件医疗物品装入 b2 后再…这里直接测 b2 内部无来源；
    // 改为：医疗箱 b2 是目标。来源需要另一只医疗箱：
    const b3: Box = { id: 'b3', label: 'B-03', orgId: 'o2', categories: ['medical'], maxDamage: 2, status: 'open', createdAt: 1, checks: {} };
    await putAll('boxes', [b3]);
    await packItem('M1', 'b3', '仓管');
    await toggleCheck('M1', 'b3', '仓管');
    await moveItem('M1', 'b3', 'b2', '仓管');

    const { items, boxes, logs } = await listAll();
    expect(items[0].location).toEqual({ kind: 'box', boxId: 'b2' });
    const src = boxes.find((b) => b.id === 'b3')!;
    expect(src.checks['M1']).toBeUndefined();
    const move = logs.find((l) => l.type === 'MOVE')!;
    expect(move.fromBoxId).toBe('b3');
    expect(move.toBoxId).toBe('b2');
  });

  it('目标箱规则不符时移箱整体失败，物品仍在来源箱（原子回滚）', async () => {
    // 衣物在 b1（允许），尝试移到医疗箱 b2（品类不符）
    await scanBarcode('C2', clothingDraft, '仓管');
    await packItem('C2', 'b1', '仓管');
    await expect(moveItem('C2', 'b1', 'b2', '仓管')).rejects.toThrow();
    const { items } = await listAll();
    expect(items[0].location).toEqual({ kind: 'box', boxId: 'b1' });
  });

  it('已交接箱内物品不能移箱', async () => {
    await scanBarcode('C3', clothingDraft, '仓管');
    await packItem('C3', 'b1', '仓管');
    await toggleCheck('C3', 'b1', '仓管');
    await handoverBox('b1', '王校长', '仓管');
    await expect(moveItem('C3', 'b1', 'b2', '仓管')).rejects.toThrow(/锁定|退回/);
  });
});

describe('已交接清单锁定，错误通过退回处理', () => {
  it('锁定后不能装箱/取出/复核；退回后解锁且历史日志保留', async () => {
    await scanBarcode('C4', clothingDraft, '仓管');
    await packItem('C4', 'b1', '仓管');
    await toggleCheck('C4', 'b1', '仓管');
    await handoverBox('b1', '王校长', '仓管');

    await scanBarcode('C5', clothingDraft, '仓管');
    await expect(packItem('C5', 'b1', '仓管')).rejects.toThrow(/锁定/);
    await expect(unpackItem('C4', '仓管')).rejects.toThrow(/锁定|退回/);
    await expect(toggleCheck('C4', 'b1', '仓管')).rejects.toThrow(/锁定/);

    // 未交接箱不能“退回”
    await expect(returnBox('b2', '误操作', '仓管')).rejects.toThrow(/已交接/);

    await returnBox('b1', '接收人登记错误', '仓管');
    const { boxes, items, logs } = await listAll();
    const b1 = boxes.find((b) => b.id === 'b1')!;
    expect(b1.status).toBe('open');
    expect(b1.returnReason).toContain('接收人');
    expect(items.find((i) => i.barcode === 'C4')!.location.kind).toBe('box');
    // 交接与退回记录都在
    expect(logs.some((l) => l.type === 'HANDOVER')).toBe(true);
    expect(logs.some((l) => l.type === 'RETURN')).toBe(true);
  });
});

describe('撤销尚未交接的连续扫码，且不误删复核', () => {
  it('队列中的扫码可撤销：物品删除、REVERT 留痕、原 SCAN 行保留', async () => {
    await scanBarcode('U1', clothingDraft, '仓管');
    const { logs: before } = await listAll();
    const scanId = before.find((l) => l.type === 'SCAN')!.id;
    await revertScan(scanId, '仓管');
    const { items, logs } = await listAll();
    expect(items).toHaveLength(0);
    expect(logs.some((l) => l.type === 'SCAN')).toBe(true); // 原始行仍在
    const rev = logs.find((l) => l.type === 'REVERT')!;
    expect(rev.revertsId).toBe(scanId);
    // 不能重复撤销
    await expect(revertScan(scanId, '仓管')).rejects.toThrow(/已撤销/);
  });

  it('扫码后追加复核：撤销被阻止，物品与复核都安全', async () => {
    await scanBarcode('U2', { ...clothingDraft, highValue: true }, '仓管');
    await addReview('U2', { by: '张社工', verdict: 'approved', note: '核价' }, '仓管');
    const { logs } = await listAll();
    const scanId = logs.find((l) => l.type === 'SCAN')!.id;
    await expect(revertScan(scanId, '仓管')).rejects.toThrow(/复核/);
    const after = await listAll();
    expect(after.items).toHaveLength(1);
    expect(after.items[0].reviews).toHaveLength(1);
  });
});

describe('文件导入入口与库内/批内去重', () => {
  it('新增入库、库内重复与批内重复分类处理', async () => {
    await scanBarcode('DUP', clothingDraft, '仓管');
    const r = await importRows(
      [
        { barcode: 'NEW1', name: '新物1', category: 'clothing', damage: 0, highValue: false },
        { barcode: 'DUP', name: '库里已有', category: 'clothing', damage: 0, highValue: false },
        { barcode: 'NEW1', name: '批内重复', category: 'clothing', damage: 0, highValue: false }
      ],
      '仓管'
    );
    expect(r.created.map((i) => i.barcode)).toEqual(['NEW1']);
    expect(r.duplicates.sort()).toEqual(['DUP', 'NEW1']);
    const { items } = await listAll();
    expect(items).toHaveLength(2);
  });
});
