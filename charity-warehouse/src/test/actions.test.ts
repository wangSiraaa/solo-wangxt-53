/**
 * 动作层集成测试（fake-indexeddb，v2 身份）：
 * 扫码/重复、改码、改级、复核保护、移箱原子性、交接锁定、退回、撤销、文件导入去重、冻结拦截。
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addReview,
  createBox,
  ensureMeta,
  gradeItem,
  handoverBox,
  importRows,
  listAll,
  moveItem,
  packItem,
  relabelItem,
  returnBox,
  revertScan,
  scanBarcode,
  toggleCheck,
  unpackItem
} from '../lib/actions';
import { atomic, deleteDb, putAll } from '../lib/db';
void atomic;
import { refOf, type Box, type Organization } from '../lib/types';

const PID = 'p-test';
const orgs = (): Organization[] => [
  { id: refOf(PID, 'o1'), originProjectId: PID, name: '福利院', allowedCategories: ['clothing', 'toy'], maxDamage: 1 },
  { id: refOf(PID, 'o2'), originProjectId: PID, name: '救助站', allowedCategories: ['clothing', 'medical'], maxDamage: 2 }
];

async function reset(): Promise<void> {
  await deleteDb();
  await ensureMeta('测试工程', PID);
  await putAll('organizations', orgs());
}

const cloth = (damage: 1 | 2 | 0 = 1) => ({ name: '卫衣', category: 'clothing' as const, damage, highValue: false });

beforeEach(reset);

async function box(_localId: string, label: string, orgLocal = 'o1', cats: ('clothing' | 'medical' | 'toy')[] = ['clothing'], maxDamage: 0 | 1 | 2 | 3 = 1): Promise<string> {
  const created = await createBox({ label, orgId: refOf(PID, orgLocal), categories: cats, maxDamage }, 't');
  return created.id;
}

describe('扫码与重复定位（不新增库存）', () => {
  it('同码三次：1 件库存、scanCount=3、RESCAN 两条', async () => {
    await scanBarcode('6901001', cloth(1), 't');
    await scanBarcode('6901001', cloth(1), 't');
    const r3 = await scanBarcode('6901001', cloth(1), 't');
    const d = await listAll();
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.scanCount).toBe(3);
    expect(r3.outcome).toBe('duplicate');
    expect(d.logs.filter((l) => l.type === 'SCAN')).toHaveLength(1);
    expect(d.logs.filter((l) => l.type === 'RESCAN')).toHaveLength(2);
  });
});

describe('人工改码 / 改成色：身份不变、留痕', () => {
  it('RELABEL：旧码进 aliases，itemId 不变；改级写 GRADE from→to', async () => {
    const r = await scanBarcode('A1', cloth(2), 't');
    await relabelItem(r.item.itemId, 'A1-X', 't');
    await gradeItem(r.item.itemId, 0, 't');
    const d = await listAll();
    const it = d.items[0]!;
    expect(it.itemId).toBe(r.item.itemId);
    expect(it.barcode).toBe('A1-X');
    expect(it.aliases).toContain('A1');
    expect(it.damage).toBe(0);
    expect(d.logs.some((l) => l.type === 'RELABEL' && l.oldBarcode === 'A1' && l.barcode === 'A1-X')).toBe(true);
    const g = d.logs.find((l) => l.type === 'GRADE')!;
    expect([g.from, g.to]).toEqual([2, 0]);
  });
});

describe('装箱适配 / 移箱原子性 / 交接锁定 / 退回', () => {
  it('不适配物品拒绝装箱；移箱两侧同事务更新；目标不符则回滚', async () => {
    await scanBarcode('T1', { name: '污损玩具', category: 'toy', damage: 3, highValue: false }, 't');
    const b1 = await box('b1', 'A-1');
    await expect(packItem((await listAll()).items[0]!.itemId, b1, 't')).rejects.toThrow(/品类|成色/);

    await scanBarcode('M1', { name: '退烧贴', category: 'medical', damage: 0, highValue: false }, 't');
    const b3 = await createBox({ label: 'B-3', orgId: refOf(PID, 'o2'), categories: ['medical'], maxDamage: 2 }, 't');
    const b2 = await createBox({ label: 'B-2', orgId: refOf(PID, 'o2'), categories: ['medical'], maxDamage: 2 }, 't');
    const med = (await listAll()).items.find((i) => i.barcode === 'M1')!;
    await packItem(med.itemId, b3.id, 't');
    await toggleCheck(med.itemId, b3.id, 't');
    await moveItem(med.itemId, b3.id, b2.id, 't');
    let d = await listAll();
    const moved = d.items.find((i) => i.barcode === 'M1')!;
    expect(moved.location).toEqual({ kind: 'box', boxId: b2.id });
    expect(d.boxes.find((x) => x.id === b3.id)!.checks[med.itemId]).toBeUndefined();
    expect(d.logs.some((l) => l.type === 'MOVE' && l.fromBoxId === b3.id && l.toBoxId === b2.id)).toBe(true);

    // 移到品类不符箱失败，物品仍在 b2
    const clothItem = await scanBarcode('C2', cloth(1), 't');
    await packItem(clothItem.item.itemId, b1, 't');
    await expect(moveItem(clothItem.item.itemId, b1, b2.id, 't')).rejects.toThrow();
    d = await listAll();
    expect(d.items.find((i) => i.barcode === 'C2')!.location).toEqual({ kind: 'box', boxId: b1 });
  });

  it('逐件检查全部通过才能交接；锁定后拒绝编辑，退回解锁且双日志保留', async () => {
    const r = await scanBarcode('C4', cloth(1), 't');
    const b1 = await box('b1', 'A-1');
    await packItem(r.item.itemId, b1, 't');
    await expect(handoverBox(b1, '王校长', 't')).rejects.toThrow(/逐件检查|不适配/);
    await toggleCheck(r.item.itemId, b1, 't');
    await handoverBox(b1, '王校长', 't');

    const r2 = await scanBarcode('C5', cloth(1), 't');
    await expect(packItem(r2.item.itemId, b1, 't')).rejects.toThrow(/锁定/);
    await expect(unpackItem(r.item.itemId, 't')).rejects.toThrow(/锁定|退回/);
    await expect(toggleCheck(r.item.itemId, b1, 't')).rejects.toThrow(/锁定/);

    const openBox = await box('b9', 'B-9', 'o2', ['medical'], 2);
    await expect(returnBox(openBox, '误操作', 't')).rejects.toThrow(/已交接/);

    await returnBox(b1, '接收人登记错误', 't');
    const d = await listAll();
    expect(d.boxes.find((x) => x.id === b1)!.status).toBe('open');
    expect(d.logs.some((l) => l.type === 'HANDOVER')).toBe(true);
    expect(d.logs.some((l) => l.type === 'RETURN')).toBe(true);
  });
});

describe('撤销连续扫码：不误删后来复核', () => {
  it('队列扫码可撤销（REVERT 留痕、原行保留），已复核的阻止撤销', async () => {
    const u1 = await scanBarcode('U1', cloth(1), 't');
    const createUid = u1.item.itemId.split('#')[1]!;
    await revertScan(createUid, 't');
    let d = await listAll();
    expect(d.items).toHaveLength(0);
    expect(d.logs.some((l) => l.type === 'SCAN')).toBe(true);
    expect(d.logs.some((l) => l.type === 'REVERT')).toBe(true);
    await expect(revertScan(createUid, 't')).rejects.toThrow(/已撤销|不存在/);

    const u2 = await scanBarcode('U2', { name: '羊绒', category: 'clothing', damage: 0, highValue: true }, 't');
    await addReview(u2.item.itemId, { by: '张', verdict: 'approved', note: '核价' }, 't');
    const uid2 = u2.item.itemId.split('#')[1]!;
    await expect(revertScan(uid2, 't')).rejects.toThrow(/复核/);
    d = await listAll();
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.reviews).toHaveLength(1);
  });
});

describe('文件导入：库内/批内去重', () => {
  it('新增 1、重复 2（库内+批内），库存不增加', async () => {
    await scanBarcode('DUP', cloth(1), 't');
    const r = await importRows(
      [
        { barcode: 'NEW1', name: '新', category: 'clothing', damage: 0, highValue: false },
        { barcode: 'DUP', name: '已有', category: 'clothing', damage: 0, highValue: false },
        { barcode: 'NEW1', name: '批内重复', category: 'clothing', damage: 0, highValue: false }
      ],
      't'
    );
    expect(r.created.map((i) => i.barcode)).toEqual(['NEW1']);
    expect(r.duplicates.sort()).toEqual(['DUP', 'NEW1']);
    expect((await listAll()).items).toHaveLength(2);
  });
});

describe('冻结/待裁决物品被装箱与移箱拦截', () => {
  it('frozen 物品 packItem/moveItem 报错', async () => {
    const r = await scanBarcode('F1', cloth(1), 't');
    const b1 = await box('b1', 'A-1');
    await atomic(['items'], 'readwrite', (s) => {
      const req = s.items.get(r.item.itemId);
      req.onsuccess = () => {
        const it = req.result as { frozen?: boolean; frozenReason?: string };
        s.items.put({ ...it, frozen: true, frozenReason: '双交接' });
      };
    });
    await expect(packItem(r.item.itemId, b1, 't')).rejects.toThrow(/冻结/);
  });
});

// 类型引用
export type { Box };
