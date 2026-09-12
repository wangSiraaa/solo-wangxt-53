/**
 * 应用动作层：每个动作都在单个 IndexedDB 事务内完成「数据变更 + 追加日志」。
 * 日志只追加不修改；撤销 = 追加 REVERT 补偿记录 + 删除队列中的新建物品，历史仍可追溯。
 */
import { atomic, getAll, get } from './db';
import {
  canReturnBox,
  canRevertScan,
  evaluateHandover,
  validatePack
} from './rules';
import type {
  Box,
  Item,
  ItemCategory,
  OperationLog,
  OperationType,
  Organization,
  Review
} from './types';

export interface ScanResult {
  outcome: 'created' | 'duplicate';
  item: Item;
}

export interface ImportResult {
  created: Item[];
  duplicates: string[];
  rejected: { barcode: string; reason: string }[];
}

function nowId(): number {
  return Date.now();
}

async function appendLog(
  s: Record<'logs', IDBObjectStore>,
  entry: Omit<OperationLog, 'id' | 'at'> & { at?: number }
): Promise<number> {
  // id 由 autoIncrement 生成，不能显式给 0（否则第二条会主键冲突）
  const log = { at: nowId(), ...entry } as OperationLog;
  const req = s.logs.add(log);
  return new Promise<number>((resolve, reject) => {
    req.onsuccess = () => resolve(Number(req.result));
    req.onerror = () => reject(req.error);
  });
}

/** 摄像头 / 键盘 / 文件导入最终都汇聚到这一个入口：重复条码只定位原物品 */
export async function scanBarcode(
  barcode: string,
  draft: { name: string; category: ItemCategory; damage: Item['damage']; highValue: boolean },
  operator: string,
  source: 'SCAN' | 'IMPORT' = 'SCAN'
): Promise<ScanResult> {
  barcode = barcode.trim();
  if (!barcode) throw new Error('条码为空');
  let outcome: 'created' | 'duplicate' = 'created';
  let created: Item | null = null;

  await atomic(['items', 'logs'], 'readwrite', async (s) => {
    const existing = await new Promise<Item | undefined>((resolve, reject) => {
      const r = s.items.get(barcode);
      r.onsuccess = () => resolve(r.result as Item | undefined);
      r.onerror = () => reject(r.error);
    });

    if (existing) {
      // 重复扫描：不新增第二份库存，只累加次数并报告原物品位置
      existing.scanCount += 1;
      existing.scannedAt = nowId();
      s.items.put(existing);
      await appendLog(s, {
        type: 'RESCAN',
        operator,
        barcode,
        detail: `重复扫描，已定位原物品（${describeLocation(existing)}），库存未增加`
      });
      outcome = 'duplicate';
      created = existing;
      return;
    }

    const item: Item = {
      barcode,
      name: draft.name?.trim() || `物品 ${barcode}`,
      category: draft.category,
      damage: draft.damage,
      highValue: draft.highValue,
      scannedAt: nowId(),
      scanCount: 1,
      reviews: [],
      location: { kind: 'queue' },
      createdAt: nowId()
    };
    s.items.add(item);
    await appendLog(s, {
      type: source,
      operator,
      barcode,
      detail: `新扫入：${item.name}`
    });
    created = item;
  });

  return { outcome, item: created as unknown as Item };
}

function describeLocation(item: Item): string {
  switch (item.location.kind) {
    case 'queue':
      return '待装箱队列';
    case 'box':
      return `箱 ${item.location.boxId}`;
    case 'handed':
      return `已交接（随箱 ${item.location.boxId}）`;
  }
}

export interface ImportRow {
  barcode: string;
  name: string;
  category: ItemCategory;
  damage: Item['damage'];
  highValue: boolean;
}

/** 文件导入：批内去重 + 库内去重，重复条码同样不会产生第二份库存 */
export async function importRows(rows: ImportRow[], operator: string): Promise<ImportResult> {
  const result: ImportResult = { created: [], duplicates: [], rejected: [] };
  const seen = new Set<string>();
  for (const row of rows) {
    const code = row.barcode.trim();
    if (!code) {
      result.rejected.push({ barcode: '(空)', reason: '条码为空' });
      continue;
    }
    if (seen.has(code)) {
      result.duplicates.push(code);
      continue;
    }
    seen.add(code);
    try {
      const r = await scanBarcode(
        code,
        { name: row.name, category: row.category, damage: row.damage, highValue: row.highValue },
        operator,
        'IMPORT'
      );
      if (r.outcome === 'created') result.created.push(r.item);
      else result.duplicates.push(code);
    } catch (e) {
      result.rejected.push({ barcode: code, reason: (e as Error).message });
    }
  }
  return result;
}

/** 追加高价值复核（历史复核全部保留） */
export async function addReview(
  barcode: string,
  review: Omit<Review, 'at'>,
  operator: string
): Promise<void> {
  await atomic(['items', 'logs'], 'readwrite', async (s) => {
    const item = (await reqAs<Item>(s.items.get(barcode)))!;
    if (item.location.kind === 'handed') {
      throw new Error('物品已随箱交接锁定，复核请先走退回流程');
    }
    item.reviews.push({ ...review, at: nowId() });
    s.items.put(item);
    await appendLog(s, {
      type: 'REVIEW',
      operator,
      barcode,
      detail: `高价值复核：${review.verdict === 'approved' ? '通过' : '不通过'}${review.note ? ' / ' + review.note : ''}`
    });
  });
}

function reqAs<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

/** 装箱：规则不过即抛错（UI 显示全部原因） */
export async function packItem(barcode: string, boxId: string, operator: string): Promise<void> {
  await atomic(['items', 'boxes', 'logs', 'organizations'], 'readwrite', async (s) => {
    const item = (await reqAs<Item | undefined>(s.items.get(barcode)))!;
    const box = (await reqAs<Box | undefined>(s.boxes.get(boxId)))!;
    const org = await reqAs<Organization | undefined>(s.organizations.get(box.orgId));
    if (!item) throw new Error('物品不存在');
    if (!box) throw new Error('箱不存在');
    const violations = validatePack(item, box, org);
    if (violations.length) {
      throw new Error(violations.map((v) => v.message).join('；'));
    }
    item.location = { kind: 'box', boxId };
    s.items.put(item);
    await appendLog(s, { type: 'PACK', operator, barcode, boxId, detail: `装入箱「${box.label}」` });
  });
}

/** 从打开的箱取出回队列 */
export async function unpackItem(barcode: string, operator: string, reason = ''): Promise<void> {
  await atomic(['items', 'boxes', 'logs'], 'readwrite', async (s) => {
    const item = (await reqAs<Item | undefined>(s.items.get(barcode)))!;
    if (!item || item.location.kind === 'queue') throw new Error('物品不在箱内');
    if (item.location.kind === 'handed') throw new Error('已交接物品请走退回流程');
    const boxId = item.location.boxId;
    const box = (await reqAs<Box | undefined>(s.boxes.get(boxId)))!;
    if (box.status === 'handed') throw new Error('箱已交接锁定');
    delete box.checks[barcode];
    s.boxes.put(box);
    item.location = { kind: 'queue' };
    s.items.put(item);
    await appendLog(s, { type: 'UNPACK', operator, barcode, boxId, detail: reason || '取出回队列' });
  });
}

/**
 * 移箱：同一事务内同时更新来源箱（勾检记录移除）与目标箱（物品落位）。
 * 任一侧校验失败，整笔事务回滚 —— 不会出现物品悬空或两边重复。
 */
export async function moveItem(
  barcode: string,
  fromBoxId: string,
  toBoxId: string,
  operator: string
): Promise<void> {
  if (fromBoxId === toBoxId) throw new Error('来源箱与目标箱相同');
  await atomic(['items', 'boxes', 'logs', 'organizations'], 'readwrite', async (s) => {
    const item = (await reqAs<Item | undefined>(s.items.get(barcode)))!;
    const fromBox = (await reqAs<Box | undefined>(s.boxes.get(fromBoxId)))!;
    const toBox = (await reqAs<Box | undefined>(s.boxes.get(toBoxId)))!;
    if (!item || !fromBox || !toBox) throw new Error('物品或箱不存在');
    if (item.location.kind === 'handed' || fromBox.status === 'handed' || toBox.status === 'handed') {
      throw new Error('涉及已交接锁定的箱或物品，移箱被阻止（请走退回流程）');
    }
    if (item.location.kind !== 'box' || item.location.boxId !== fromBoxId) {
      throw new Error('物品不在来源箱中');
    }
    const org = await reqAs<Organization | undefined>(s.organizations.get(toBox.orgId));
    const violations = validatePack(item, toBox, org);
    if (violations.length) throw new Error(violations.map((v) => v.message).join('；'));

    delete fromBox.checks[barcode];
    s.boxes.put(fromBox);
    item.location = { kind: 'box', boxId: toBoxId };
    s.items.put(item);
    await appendLog(s, {
      type: 'MOVE',
      operator,
      barcode,
      boxId: toBoxId,
      fromBoxId,
      toBoxId,
      detail: `从箱「${fromBox.label}」移至箱「${toBox.label}」`
    });
  });
}

export async function toggleCheck(barcode: string, boxId: string, operator: string): Promise<boolean> {
  let nowChecked = false;
  await atomic(['items', 'boxes', 'logs'], 'readwrite', async (s) => {
    const box = (await reqAs<Box | undefined>(s.boxes.get(boxId)))!;
    const item = (await reqAs<Item | undefined>(s.items.get(barcode)))!;
    if (box.status === 'handed') throw new Error('箱已交接锁定');
    if (!item || item.location.kind !== 'box' || item.location.boxId !== boxId) {
      throw new Error('物品不在该箱中');
    }
    if (box.checks[barcode]) {
      delete box.checks[barcode];
      nowChecked = false;
    } else {
      box.checks[barcode] = { at: nowId(), by: operator };
      nowChecked = true;
    }
    s.boxes.put(box);
    await appendLog(s, {
      type: 'CHECK',
      operator,
      barcode,
      boxId,
      detail: nowChecked ? '逐件检查：已核' : '逐件检查：取消勾选'
    });
  });
  return nowChecked;
}

/** 整箱交接：逐件检查 + 全部适配后才锁定；锁定后清单不可再编辑 */
export async function handoverBox(
  boxId: string,
  receiver: string,
  operator: string
): Promise<{ readiness: Awaited<ReturnType<typeof dryRunHandover>> }> {
  const readiness = await dryRunHandover(boxId);
  if (!readiness.ok) {
    throw new Error(`不能交接：还有 ${readiness.blockingCount} 件未通过逐件检查或不适配`);
  }
  await atomic(['items', 'boxes', 'logs'], 'readwrite', async (s) => {
    const box = (await reqAs<Box | undefined>(s.boxes.get(boxId)))!;
    const allItems = await reqAs<Item[]>(s.items.getAll());
    const items = allItems.filter((i) => i.location.kind === 'box' && i.location.boxId === boxId);
    box.status = 'handed';
    box.handedAt = nowId();
    box.receiver = receiver.trim() || '未登记接收人';
    s.boxes.put(box);
    for (const item of items) {
      if (item) {
        item.location = { kind: 'handed', boxId };
        s.items.put(item);
      }
    }
    await appendLog(s, {
      type: 'HANDOVER',
      operator,
      boxId,
      detail: `整箱交接给 ${box.receiver}，共 ${items.length} 件`
    });
  });
  return { readiness };
}

/** 交接预检（UI 逐件渲染，不是只禁用按钮） */
async function dryRunHandover(boxId: string) {
  const [box, items, orgs] = await Promise.all([
    get<Box>('boxes', boxId),
    getAll<Item>('items'),
    getAll<Organization>('organizations')
  ]);
  if (!box) throw new Error('箱不存在');
  const inBox = items.filter((i) => i.location.kind === 'box' && i.location.boxId === boxId);
  return evaluateHandover(box, inBox, orgs.find((o) => o.id === box.orgId));
}

export async function getHandoverReadiness(boxId: string) {
  return dryRunHandover(boxId);
}

/** 已交接清单的错误处理：退回解锁，历史日志与交接记录保留 */
export async function returnBox(boxId: string, reason: string, operator: string): Promise<void> {
  await atomic(['items', 'boxes', 'logs'], 'readwrite', async (s) => {
    const box = (await reqAs<Box | undefined>(s.boxes.get(boxId)))!;
    const guard = canReturnBox(box);
    if (!guard.ok) throw new Error(guard.reason);
    box.status = 'open';
    box.returnedAt = nowId();
    box.returnReason = reason.trim() || '未填写退回原因';
    s.boxes.put(box);
    const items = await reqAs<Item[]>(s.items.getAll());
    for (const item of items) {
      if (item.location.kind === 'handed' && item.location.boxId === boxId) {
        item.location = { kind: 'box', boxId };
        s.items.put(item);
      }
    }
    await appendLog(s, {
      type: 'RETURN',
      operator,
      boxId,
      detail: `交接退回：${box.returnReason}`
    });
  });
}

/**
 * 撤销尚未交接的连续扫码：
 * - 仅允许仍在队列、且其后没有复核记录的 SCAN/IMPORT；
 * - 追加 REVERT 日志，不删除任何日志行；后续复核因此绝不会被误删。
 */
export async function revertScan(logId: number, operator: string): Promise<void> {
  const creation = await get<OperationLog>('logs', logId);
  if (!creation) throw new Error('日志不存在');
  const item = creation.barcode ? await get<Item>('items', creation.barcode) : undefined;
  const allLogs = await getAll<OperationLog>('logs');
  // 已经被撤销过的扫码不能重复撤销
  if (allLogs.some((l) => l.type === 'REVERT' && l.revertsId === logId)) {
    throw new Error('该扫码已撤销过');
  }
  const guard = canRevertScan(creation, item, allLogs);
  if (!guard.ok) throw new Error(guard.reason);

  await atomic(['items', 'logs'], 'readwrite', async (s) => {
    s.items.delete(creation.barcode!);
    await appendLog(s, {
      type: 'REVERT',
      operator,
      barcode: creation.barcode,
      revertsId: logId,
      detail: `撤销扫码 ${creation.barcode}（物品仍在队列且其后无复核）`
    });
  });
}

export async function createBox(
  box: Omit<Box, 'createdAt' | 'status' | 'checks'>,
  operator: string
): Promise<void> {
  await atomic(['boxes', 'logs'], 'readwrite', async (s) => {
    const full: Box = { ...box, status: 'open', checks: {}, createdAt: nowId() };
    s.boxes.put(full);
    await appendLog(s, { type: 'IMPORT', operator, boxId: box.id, detail: `建档箱「${box.label}」` });
  });
}

export async function listAll(): Promise<{
  orgs: Organization[];
  items: Item[];
  boxes: Box[];
  logs: OperationLog[];
}> {
  const [orgs, items, boxes, logs] = await Promise.all([
    getAll<Organization>('organizations'),
    getAll<Item>('items'),
    getAll<Box>('boxes'),
    getAll<OperationLog>('logs')
  ]);
  logs.sort((a, b) => a.id - b.id);
  return { orgs, items, boxes, logs };
}

export const logTypeLabel: Record<OperationType, string> = {
  SCAN: '扫码入库',
  RESCAN: '重复扫码',
  IMPORT: '导入/建档',
  REVIEW: '高价值复核',
  PACK: '装箱',
  UNPACK: '取出',
  MOVE: '移箱',
  CHECK: '逐件检查',
  HANDOVER: '整箱交接',
  RETURN: '交接退回',
  REVERT: '撤销扫码'
};
