/**
 * 演示数据：覆盖三类预置案例
 *  1) 摄像头不可用 —— 由 UI 状态模拟/真实探测；
 *  2) 重复扫描 —— 羽绒服 6901001 已入库，再扫同一码只会定位；
 *  3) 一箱混入不适配物品 —— 箱 A-01 只收全新/九成新衣物，
 *     队列里有一件 3 级污损玩具试图装入会被逐条拦截。
 * 另含一只已交接锁定箱，用于演示“清单锁定 + 退回处理”。
 */
import { atomic, getAll, STORES } from './db';
import type { Box, Item, OperationLog, Organization } from './types';

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);
const min = (n: number) => T0 + n * 60_000;

export const SEED_ORGS: Organization[] = [
  {
    id: 'org-aihua',
    name: '爱华儿童福利院',
    allowedCategories: ['clothing', 'book', 'toy'],
    maxDamage: 1,
    note: '只收九成新及以上'
  },
  {
    id: 'org-jieshan',
    name: '捷善社区救助站',
    allowedCategories: ['clothing', 'food', 'medical'],
    maxDamage: 2,
    note: '食品须在保质期内'
  },
  {
    id: 'org-yuanmeng',
    name: '圆梦乡村学校',
    allowedCategories: ['book', 'clothing'],
    maxDamage: 1
  }
];

export const SEED_BOXES: Box[] = [
  {
    id: 'box-a01',
    label: 'A-01',
    orgId: 'org-aihua',
    categories: ['clothing'],
    maxDamage: 1,
    status: 'open',
    createdAt: min(1),
    checks: {}
  },
  {
    id: 'box-b02',
    label: 'B-02',
    orgId: 'org-jieshan',
    categories: ['medical', 'clothing'],
    maxDamage: 2,
    status: 'open',
    createdAt: min(2),
    checks: {}
  },
  {
    id: 'box-c03',
    label: 'C-03（已交接存档）',
    orgId: 'org-yuanmeng',
    categories: ['book'],
    maxDamage: 1,
    status: 'handed',
    createdAt: min(-600),
    handedAt: min(-300),
    receiver: '王校长',
    checks: {}
  }
];

export const SEED_ITEMS: Item[] = [
  {
    barcode: '6901001',
    name: '儿童羽绒服',
    category: 'clothing',
    damage: 0,
    highValue: true,
    scannedAt: min(3),
    scanCount: 1,
    reviews: [{ at: min(4), by: '张社工', verdict: 'approved', note: '吊牌齐全，已核价' }],
    location: { kind: 'box', boxId: 'box-a01' },
    createdAt: min(3)
  },
  {
    barcode: '6901002',
    name: '纯棉卫衣',
    category: 'clothing',
    damage: 1,
    highValue: false,
    scannedAt: min(5),
    scanCount: 1,
    reviews: [],
    location: { kind: 'box', boxId: 'box-a01' },
    createdAt: min(5)
  },
  {
    barcode: '6901003',
    name: '毛绒玩具（污渍）',
    category: 'toy',
    damage: 3,
    highValue: false,
    scannedAt: min(6),
    scanCount: 1,
    reviews: [],
    location: { kind: 'queue' },
    createdAt: min(6)
  },
  {
    barcode: '6901004',
    name: '退烧贴（一盒）',
    category: 'medical',
    damage: 0,
    highValue: false,
    scannedAt: min(7),
    scanCount: 1,
    reviews: [],
    location: { kind: 'queue' },
    createdAt: min(7)
  },
  {
    barcode: '6901005',
    name: '旧牛仔裤',
    category: 'clothing',
    damage: 2,
    highValue: false,
    scannedAt: min(8),
    scanCount: 1,
    reviews: [],
    location: { kind: 'queue' },
    createdAt: min(8)
  },
  {
    barcode: '6902001',
    name: '新华字典',
    category: 'book',
    damage: 1,
    highValue: false,
    scannedAt: min(-600),
    scanCount: 1,
    reviews: [],
    location: { kind: 'handed', boxId: 'box-c03' },
    createdAt: min(-600)
  },
  {
    barcode: '6902002',
    name: '铅笔套装',
    category: 'book',
    damage: 0,
    highValue: false,
    scannedAt: min(-599),
    scanCount: 1,
    reviews: [],
    location: { kind: 'handed', boxId: 'box-c03' },
    createdAt: min(-599)
  }
];

// 已交接箱的逐件检查记录
for (const barcode of ['6902001', '6902002']) {
  SEED_BOXES[2].checks[barcode] = { at: min(-301), by: '李仓管' };
}

const SEED_LOGS: Omit<OperationLog, 'id'>[] = [
  { at: min(1), type: 'IMPORT', operator: '李仓管', boxId: 'box-a01', detail: '建档箱「A-01」' },
  { at: min(3), type: 'SCAN', operator: '李仓管', barcode: '6901001', detail: '新扫入：儿童羽绒服' },
  { at: min(4), type: 'REVIEW', operator: '张社工', barcode: '6901001', detail: '高价值复核：通过 / 吊牌齐全，已核价' },
  { at: min(5), type: 'PACK', operator: '李仓管', barcode: '6901001', boxId: 'box-a01', detail: '装入箱「A-01」' },
  { at: min(5.2), type: 'SCAN', operator: '李仓管', barcode: '6901002', detail: '新扫入：纯棉卫衣' },
  { at: min(5.6), type: 'PACK', operator: '李仓管', barcode: '6901002', boxId: 'box-a01', detail: '装入箱「A-01」' },
  { at: min(6), type: 'SCAN', operator: '李仓管', barcode: '6901003', detail: '新扫入：毛绒玩具（污渍）' },
  { at: min(7), type: 'SCAN', operator: '李仓管', barcode: '6901004', detail: '新扫入：退烧贴（一盒）' },
  { at: min(8), type: 'SCAN', operator: '李仓管', barcode: '6901005', detail: '新扫入：旧牛仔裤' },
  { at: min(-300), type: 'HANDOVER', operator: '李仓管', boxId: 'box-c03', detail: '整箱交接给 王校长，共 2 件' }
];

export async function seedIfEmpty(force = false): Promise<boolean> {
  const existingItems = await getAll<Item>('items');
  const existingBoxes = await getAll<Box>('boxes');
  if (!force && (existingItems.length > 0 || existingBoxes.length > 0)) return false;

  await atomic([...STORES], 'readwrite', async (s) => {
    for (const name of STORES) s[name].clear();
    for (const o of SEED_ORGS) s.organizations.put(o);
    for (const b of SEED_BOXES) s.boxes.put(b);
    for (const it of SEED_ITEMS) s.items.put(it);
    let seq = 1;
    for (const log of SEED_LOGS) s.logs.put({ ...log, id: seq++ });
  });
  return true;
}
