/**
 * 演示数据 v2：两个独立工程（时钟故意相差一年），天然覆盖合并验收场景：
 *  - P1 本机仓库：扫码、复核、改码（6901005→6901009）、装箱、交接后退回；
 *  - P2 城南分拣点（另一台离线电脑）：独立创建同一实物码 6901001 但成色/去向不同、
 *    且创建了 P1 已改码前旧码 6901005 的另一件实物 → ITEM_COLLISION；
 *    同一件外套 P1#op-c1 在两边被记录交给不同机构 → DUAL_HANDOVER。
 *
 * 实体（items/boxes）由 merge.analyzeWorld 从操作日志物化，保证日志即事实、状态可重放。
 */
import { atomic, emptyLedger, STORES } from './db';
import { analyzeWorld, type WorldData } from './merge';
import {
  opKey,
  refOf,
  type Box,
  type DamageGrade,
  type ItemCategory,
  type MergeLedger,
  type OperationLog,
  type Organization,
  type ProjectMeta,
  type Review
} from './types';

export const PID_LOCAL = 'p1-beni';
export const PID_OTHER = 'p2-chengnan';

interface OpSpec {
  uid: string;
  at: number;
  type: OperationLog['type'];
  operator: string;
  itemId?: string;
  barcode?: string;
  oldBarcode?: string;
  from?: DamageGrade;
  to?: DamageGrade;
  boxId?: string;
  fromBoxId?: string;
  toBoxId?: string;
  receiver?: string;
  evidence?: OperationLog['evidence'];
  revertsUid?: string;
  detail?: string;
  payload?: Record<string, unknown>;
}

function ops(pid: string, startSeq: number, specs: OpSpec[]): OperationLog[] {
  return specs.map((s, i) => ({ ...s, projectId: pid, seq: startSeq + i + 1 } as OperationLog));
}

const T1 = Date.UTC(2026, 8, 1, 9, 0, 0);
const min = (base: number, n: number) => base + n * 60_000;
// 另一工程时钟快/慢约一年 —— 验收：合并不得依赖时钟
const T2 = Date.UTC(2025, 7, 15, 14, 30, 0);

export function buildSeedWorld(): { local: WorldData; other: WorldData } {
  const lOrgs: Organization[] = [
    { id: refOf(PID_LOCAL, 'org-aihua'), originProjectId: PID_LOCAL, name: '爱华儿童福利院', allowedCategories: ['clothing', 'book', 'toy'], maxDamage: 1, note: '只收九成新及以上' },
    { id: refOf(PID_LOCAL, 'org-jieshan'), originProjectId: PID_LOCAL, name: '捷善社区救助站', allowedCategories: ['clothing', 'food', 'medical'], maxDamage: 2 },
    { id: refOf(PID_LOCAL, 'org-yuanmeng'), originProjectId: PID_LOCAL, name: '圆梦乡村学校', allowedCategories: ['book', 'clothing'], maxDamage: 1 }
  ];
  const rOrgs: Organization[] = [
    { id: refOf(PID_OTHER, 'org-aixin'), originProjectId: PID_OTHER, name: '爱心衣物银行', allowedCategories: ['clothing'], maxDamage: 2 }
  ];

  const lMeta: ProjectMeta = { key: 'meta', projectId: PID_LOCAL, projectName: '本机仓库（P1）', createdAt: T1, seq: 0 };
  const rMeta: ProjectMeta = { key: 'meta', projectId: PID_OTHER, projectName: '城南分拣点（P2，时钟不同）', createdAt: T2, seq: 0 };

  const L = (uid: string) => refOf(PID_LOCAL, uid);
  const R = (uid: string) => refOf(PID_OTHER, uid);

  const lSpecs: OpSpec[] = [
    { uid: 'op-b01', at: min(T1, 1), type: 'BOX_CREATE', operator: '李仓管', boxId: L('box-a01'), detail: '建档箱 A-01', payload: { label: 'A-01', orgId: lOrgs[0]!.id, categories: ['clothing'], maxDamage: 1 } },
    { uid: 'op-b02', at: min(T1, 2), type: 'BOX_CREATE', operator: '李仓管', boxId: L('box-b02'), detail: '建档箱 B-02', payload: { label: 'B-02', orgId: lOrgs[1]!.id, categories: ['medical', 'clothing'], maxDamage: 2 } },
    { uid: 'op-b03', at: min(T1, 3), type: 'BOX_CREATE', operator: '李仓管', boxId: L('box-d04'), detail: '建档箱 D-04', payload: { label: 'D-04', orgId: lOrgs[1]!.id, categories: ['clothing'], maxDamage: 2 } },
    { uid: 'op-c01', at: min(T1, 10), type: 'SCAN', operator: '李仓管', itemId: L('op-c01'), barcode: '6901001', detail: '新扫入：儿童羽绒服', payload: { name: '儿童羽绒服', category: 'clothing', damage: 0, highValue: true } },
    { uid: 'op-r01', at: min(T1, 11), type: 'REVIEW', operator: '张社工', itemId: L('op-c01'), barcode: '6901001', detail: '高价值复核：通过', payload: { uid: 'op-r01', by: '张社工', verdict: 'approved', note: '吊牌齐全，已核价' } },
    { uid: 'op-p01', at: min(T1, 12), type: 'PACK', operator: '李仓管', itemId: L('op-c01'), barcode: '6901001', boxId: L('box-a01'), detail: '装入箱 A-01' },
    { uid: 'op-c02', at: min(T1, 13), type: 'SCAN', operator: '李仓管', itemId: L('op-c02'), barcode: '6901002', detail: '新扫入：纯棉卫衣', payload: { name: '纯棉卫衣', category: 'clothing', damage: 1, highValue: false } },
    { uid: 'op-p02', at: min(T1, 14), type: 'PACK', operator: '李仓管', itemId: L('op-c02'), barcode: '6901002', boxId: L('box-a01'), detail: '装入箱 A-01' },
    { uid: 'op-c03', at: min(T1, 15), type: 'SCAN', operator: '李仓管', itemId: L('op-c03'), barcode: '6901003', detail: '新扫入：毛绒玩具（污渍）', payload: { name: '毛绒玩具（污渍）', category: 'toy', damage: 3, highValue: false } },
    { uid: 'op-c04', at: min(T1, 16), type: 'SCAN', operator: '李仓管', itemId: L('op-c04'), barcode: '6901004', detail: '新扫入：退烧贴', payload: { name: '退烧贴（一盒）', category: 'medical', damage: 0, highValue: false } },
    { uid: 'op-c05', at: min(T1, 17), type: 'SCAN', operator: '李仓管', itemId: L('op-c05'), barcode: '6901005', detail: '新扫入：旧牛仔裤', payload: { name: '旧牛仔裤', category: 'clothing', damage: 2, highValue: false } },
    { uid: 'op-rl05', at: min(T1, 18), type: 'RELABEL', operator: '李仓管', itemId: L('op-c05'), barcode: '6901009', oldBarcode: '6901005', detail: '人工改写条码：6901005 → 6901009' },
    // 同一实物两边交接给不同机构（DUAL_HANDOVER 案例）
    { uid: 'op-c06', at: min(T1, 20), type: 'SCAN', operator: '李仓管', itemId: L('op-c06'), barcode: '6902001', detail: '新扫入：男士外套', payload: { name: '男士外套', category: 'clothing', damage: 1, highValue: false } },
    { uid: 'op-p06', at: min(T1, 21), type: 'PACK', operator: '李仓管', itemId: L('op-c06'), barcode: '6902001', boxId: L('box-d04'), detail: '装入箱 D-04' },
    { uid: 'op-ck06', at: min(T1, 22), type: 'CHECK', operator: '李仓管', itemId: L('op-c06'), barcode: '6902001', boxId: L('box-d04'), payload: { checked: true }, detail: '逐件检查：已核' },
    { uid: 'op-h06', at: min(T1, 23), type: 'HANDOVER', operator: '李仓管', itemId: L('op-c06'), barcode: '6902001', boxId: L('box-d04'), receiver: '捷善-周干事', detail: '整箱交接给 捷善-周干事', evidence: [{ itemId: L('op-c06'), barcode: '6902001', name: '男士外套', category: 'clothing', damage: 1 }] },
    // 整箱交接后出现退回（验收场景）：A-01 交接 → 退回
    { uid: 'op-ck01', at: min(T1, 30), type: 'CHECK', operator: '李仓管', itemId: L('op-c01'), barcode: '6901001', boxId: L('box-a01'), payload: { checked: true }, detail: '逐件检查：已核' },
    { uid: 'op-ck02', at: min(T1, 31), type: 'CHECK', operator: '李仓管', itemId: L('op-c02'), barcode: '6901002', boxId: L('box-a01'), payload: { checked: true }, detail: '逐件检查：已核' },
    { uid: 'op-ha01', at: min(T1, 32), type: 'HANDOVER', operator: '李仓管', boxId: L('box-a01'), receiver: '爱华-赵老师', detail: '整箱交接给 爱华-赵老师', evidence: [
      { itemId: L('op-c01'), barcode: '6901001', name: '儿童羽绒服', category: 'clothing', damage: 0 },
      { itemId: L('op-c02'), barcode: '6901002', name: '纯棉卫衣', category: 'clothing', damage: 1 }
    ] },
    { uid: 'op-rt01', at: min(T1, 40), type: 'RETURN', operator: '李仓管', boxId: L('box-a01'), detail: '交接退回：接收人电话登记错误', payload: { reason: '接收人电话登记错误，需更正' } }
  ];

  const rSpecs: OpSpec[] = [
    { uid: 'op-rb1', at: min(T2, 1), type: 'BOX_CREATE', operator: '王分拣', boxId: R('box-e05'), detail: '建档箱 E-05', payload: { label: 'E-05', orgId: rOrgs[0]!.id, categories: ['clothing'], maxDamage: 2 } },
    // 独立创建同码 6901001：不同成色 → ITEM_COLLISION
    { uid: 'op-x01', at: min(T2, 5), type: 'SCAN', operator: '王分拣', itemId: R('op-x01'), barcode: '6901001', detail: '新扫入：厚羽绒服（旧）', payload: { name: '厚羽绒服（旧）', category: 'clothing', damage: 2, highValue: false } },
    { uid: 'op-xp01', at: min(T2, 6), type: 'PACK', operator: '王分拣', itemId: R('op-x01'), barcode: '6901001', boxId: R('box-e05'), detail: '装入箱 E-05' },
    // 占用 P1 已改写前的旧码 6901005（人工改写条码验收）
    { uid: 'op-x02', at: min(T2, 7), type: 'SCAN', operator: '王分拣', itemId: R('op-x02'), barcode: '6901005', detail: '新扫入：牛仔裤B', payload: { name: '牛仔裤（城南）', category: 'clothing', damage: 1, highValue: false } },
    // 同一实物 6902001 被 P2 交给另一机构 → DUAL_HANDOVER
    { uid: 'op-x03', at: min(T2, 8), type: 'SCAN', operator: '王分拣', itemId: R('op-x03'), barcode: '6902001', detail: '新扫入：男士外套', payload: { name: '男士外套', category: 'clothing', damage: 2, highValue: false } },
    { uid: 'op-xp03', at: min(T2, 9), type: 'PACK', operator: '王分拣', itemId: R('op-x03'), barcode: '6902001', boxId: R('box-e05'), detail: '装入箱 E-05' },
    { uid: 'op-xck3', at: min(T2, 10), type: 'CHECK', operator: '王分拣', itemId: R('op-x03'), barcode: '6902001', boxId: R('box-e05'), payload: { checked: true }, detail: '逐件检查：已核' },
    { uid: 'op-xh03', at: min(T2, 11), type: 'HANDOVER', operator: '王分拣', itemId: R('op-x03'), barcode: '6902001', boxId: R('box-e05'), receiver: '爱心衣物银行-陈行长', detail: '整箱交接给 爱心衣物银行', evidence: [{ itemId: R('op-x03'), barcode: '6902001', name: '男士外套', category: 'clothing', damage: 2 }] }
  ];

  const lLogs = ops(PID_LOCAL, 0, lSpecs);
  lMeta.seq = lLogs.length;
  const rLogs = ops(PID_OTHER, 0, rSpecs);
  rMeta.seq = rLogs.length;

  const ledger: MergeLedger = emptyLedger();
  void opKey;

  const lReplay = analyzeWorld([lMeta], ledger, lOrgs, lLogs).canonical;
  const rReplay = analyzeWorld([rMeta], ledger, rOrgs, rLogs).canonical;

  const local: WorldData = { meta: lMeta, ledger: structuredClone(ledger), organizations: lOrgs, boxes: lReplay.boxes as Box[], items: lReplay.items, logs: lLogs };
  const other: WorldData = { meta: rMeta, ledger: structuredClone(ledger), organizations: rOrgs, boxes: rReplay.boxes as Box[], items: rReplay.items, logs: rLogs };
  return { local, other };
}

export async function seedIfEmpty(force = false): Promise<boolean> {
  // 用户显式清空过（重建空工程）就不再自动播种
  const noSeed =
    typeof globalThis !== 'undefined' &&
    (globalThis as { localStorage?: Storage }).localStorage?.getItem('cw-noseed') === '1';
  await atomic([...STORES], 'readwrite', async (s) => {
    const countItems = await new Promise<number>((resolve, reject) => {
      const r = s.items.count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const countBoxes = await new Promise<number>((resolve, reject) => {
      const r = s.boxes.count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const hasMeta = await new Promise<boolean>((resolve, reject) => {
      const r = s.meta.get('meta');
      r.onsuccess = () => resolve(Boolean(r.result));
      r.onerror = () => reject(r.error);
    });
    void hasMeta;
    if (!force && (noSeed || countItems > 0 || countBoxes > 0)) return;

    for (const name of STORES) s[name].clear();
    const { local } = buildSeedWorld();
    s.meta.put(local.meta);
    s.ledger.put(local.ledger);
    for (const o of local.organizations) s.organizations.put(o);
    for (const b of local.boxes) s.boxes.put(b);
    for (const it of local.items) s.items.put(it);
    for (const l of local.logs) s.logs.put(l);
  });
  return true;
}

/** 生成“另一个仓库”的工程快照文本（供演示合并下载/测试） */
export function buildOtherSnapshot(): string {
  const { other } = buildSeedWorld();
  return JSON.stringify(
    {
      format: 'charity-warehouse/v2',
      exportedAt: T2,
      payload: {
        meta: other.meta,
        ledger: other.ledger,
        organizations: other.organizations,
        items: other.items,
        boxes: other.boxes,
        logs: other.logs
      }
    },
    null,
    2
  );
}

// 保持类型引用（Review 在物化实体中需要）
export type { Review, ItemCategory };
