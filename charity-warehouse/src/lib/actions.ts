/**
 * 应用动作层 v2：每个动作在单个 IndexedDB 事务内完成「状态变更 + 追加带稳定 uid 的日志」。
 * 身份一律用 itemId（projectId#创建操作uid），条码仅可变属性（RELABEL）。
 */
import { atomic, emptyLedger, getAll, get, newUid, STORES } from './db';
import { analyzeWorld } from './merge';
import { canReturnBox, validatePack } from './rules';
import {
  opKey,
  refOf,
  type Box,
  type DamageGrade,
  type Item,
  type ItemCategory,
  type MergeLedger,
  type OperationLog,
  type OperationType,
  type Organization,
  type ProjectMeta,
  type Review
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

function reqAs<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

async function readMeta(s: Record<string, IDBObjectStore>): Promise<ProjectMeta> {
  const meta = await reqAs<ProjectMeta | undefined>(s.meta.get('meta'));
  if (!meta) throw new Error('工程元信息缺失');
  return meta;
}

/** 在事务内分配操作 uid + seq，并写入 logs */
async function writeLog(
  s: Record<string, IDBObjectStore>,
  meta: ProjectMeta,
  entry: Omit<OperationLog, 'uid' | 'projectId' | 'seq' | 'at'> & { at?: number }
): Promise<OperationLog> {
  meta.seq += 1;
  s.meta.put(meta);
  const log: OperationLog = {
    uid: newUid(),
    projectId: meta.projectId,
    seq: meta.seq,
    at: entry.at ?? Date.now(),
    ...entry
  };
  s.logs.put(log);
  return log;
}

function assertEditable(item: Item) {
  if (item.frozen) throw new Error(`物品已冻结：${item.frozenReason ?? '待人工核实'}`);
  if (item.awaitingArbitration) {
    throw new Error(`该物品存在未裁决的合并冲突（${(item.arbitrationKinds ?? []).join('、')}），请先在工程合并中处理`);
  }
  if (item.location.kind === 'handed') throw new Error('物品已随箱交接锁定，需先走退回流程');
}

async function findByBarcode(store: IDBObjectStore, barcode: string): Promise<Item[]> {
  const all = await reqAs<Item[]>(store.getAll());
  return all.filter((i) => i.barcode === barcode);
}

export async function scanBarcode(
  barcode: string,
  draft: { name: string; category: ItemCategory; damage: DamageGrade; highValue: boolean },
  operator: string,
  source: 'SCAN' | 'IMPORT' = 'SCAN'
): Promise<ScanResult> {
  barcode = barcode.trim();
  if (!barcode) throw new Error('条码为空');
  let result: ScanResult | null = null;

  await atomic(['items', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const matches = await findByBarcode(s.items, barcode);

    if (matches.length > 0) {
      // 同码冲突待裁决时不允许继续扫码加库存/定位混乱：提示去合并页
      const blocked = matches.find((m) => m.awaitingArbitration || m.frozen);
      if (blocked) {
        throw new Error(`条码 ${barcode} 存在未决合并冲突，请先在「工程合并」中裁决后再扫描`);
      }
      const existing = matches[0]!;
      existing.scanCount += 1;
      existing.scannedAt = Date.now();
      s.items.put(existing);
      await writeLog(s, meta, {
        type: 'RESCAN',
        operator,
        itemId: existing.itemId,
        barcode,
        detail: `重复扫描，定位原物品（${describeLocation(existing)}），库存未增加`
      });
      result = { outcome: 'duplicate', item: existing };
      return;
    }

    const createLog = await writeLog(s, meta, {
      type: source,
      operator,
      barcode,
      payload: { name: draft.name?.trim() || `物品 ${barcode}`, category: draft.category, damage: draft.damage, highValue: draft.highValue },
      detail: `新扫入：${draft.name?.trim() || barcode}`
    });
    const item: Item = {
      itemId: refOf(meta.projectId, createLog.uid),
      originProjectId: meta.projectId,
      barcode,
      aliases: [],
      name: (createLog.payload!.name as string) ?? `物品 ${barcode}`,
      category: draft.category,
      damage: draft.damage,
      highValue: draft.highValue,
      scannedAt: createLog.at,
      scanCount: 1,
      reviews: [],
      location: { kind: 'queue' },
      createdAt: createLog.at
    };
    s.items.put(item);
    // 回填创建日志的 itemId
    s.logs.put({ ...createLog, itemId: item.itemId });
    result = { outcome: 'created', item };
  });

  return result!;
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
  damage: DamageGrade;
  highValue: boolean;
}

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

/** 人工改写条码（身份不变） */
export async function relabelItem(itemId: string, newBarcode: string, operator: string): Promise<void> {
  newBarcode = newBarcode.trim();
  if (!newBarcode) throw new Error('新条码为空');
  await atomic(['items', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!item) throw new Error('物品不存在');
    assertEditable(item);
    const clash = (await reqAs<Item[]>(s.items.getAll())).find((i) => i.itemId !== itemId && i.barcode === newBarcode);
    if (clash) throw new Error(`新条码 ${newBarcode} 已被物品 ${clash.itemId} 占用（必要时请走工程合并裁决）`);
    const old = item.barcode;
    if (old === newBarcode) return;
    item.aliases.push(old);
    item.barcode = newBarcode;
    s.items.put(item);
    await writeLog(s, meta, {
      type: 'RELABEL',
      operator,
      itemId,
      barcode: newBarcode,
      oldBarcode: old,
      detail: `人工改写条码：${old} → ${newBarcode}（身份不变）`
    });
  });
}

/** 成色复核改级（记录 from/to 因果链） */
export async function gradeItem(itemId: string, to: DamageGrade, operator: string): Promise<void> {
  await atomic(['items', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!item) throw new Error('物品不存在');
    assertEditable(item);
    if (item.damage === to) return;
    const from = item.damage;
    item.damage = to;
    s.items.put(item);
    await writeLog(s, meta, { type: 'GRADE', operator, itemId, barcode: item.barcode, from, to, detail: `成色复核：${from}级 → ${to}级` });
  });
}

export async function addReview(itemId: string, review: Omit<Review, 'uid' | 'projectId' | 'seq' | 'at'>, operator: string): Promise<void> {
  await atomic(['items', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!item) throw new Error('物品不存在');
    if (item.location.kind === 'handed') throw new Error('物品已随箱交接锁定，复核请先走退回流程');
    const log = await writeLog(s, meta, {
      type: 'REVIEW',
      operator,
      itemId,
      barcode: item.barcode,
      payload: { uid: '', by: review.by, verdict: review.verdict, note: review.note },
      detail: `高价值复核：${review.verdict === 'approved' ? '通过' : '不通过'}${review.note ? ' / ' + review.note : ''}`
    });
    // uid 用操作 uid（跨工程稳定）
    const fixedPayload = { ...(log.payload as Record<string, unknown>), uid: log.uid };
    s.logs.put({ ...log, payload: fixedPayload });
    item.reviews.push({ uid: log.uid, projectId: meta.projectId, seq: log.seq, at: log.at, by: review.by, verdict: review.verdict, note: review.note });
    s.items.put(item);
  });
}

export async function packItem(itemId: string, boxId: string, operator: string): Promise<void> {
  await atomic(['items', 'boxes', 'logs', 'organizations', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    const box = await reqAs<Box | undefined>(s.boxes.get(boxId));
    const org = await reqAs<Organization | undefined>(s.organizations.get(box?.orgId ?? ''));
    if (!item) throw new Error('物品不存在');
    if (!box) throw new Error('箱不存在');
    assertEditable(item);
    const violations = validatePack(item, box, org);
    if (violations.length) throw new Error(violations.map((v) => v.message).join('；'));
    item.location = { kind: 'box', boxId };
    s.items.put(item);
    await writeLog(s, meta, { type: 'PACK', operator, itemId, barcode: item.barcode, boxId, detail: `装入箱「${box.label}」` });
  });
}

export async function unpackItem(itemId: string, operator: string, reason = ''): Promise<void> {
  await atomic(['items', 'boxes', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!item || item.location.kind === 'queue') throw new Error('物品不在箱内');
    if (item.location.kind === 'handed') throw new Error('已交接物品请走退回流程');
    if (item.frozen) throw new Error(`物品已冻结：${item.frozenReason ?? ''}`);
    const boxId = item.location.boxId;
    const box = await reqAs<Box | undefined>(s.boxes.get(boxId));
    if (box?.status === 'handed') throw new Error('箱已交接锁定');
    if (box) delete box.checks[itemId];
    if (box) s.boxes.put(box);
    item.location = { kind: 'queue' };
    s.items.put(item);
    await writeLog(s, meta, { type: 'UNPACK', operator, itemId, barcode: item.barcode, boxId, detail: reason || '取出回队列' });
  });
}

export async function moveItem(itemId: string, fromBoxId: string, toBoxId: string, operator: string): Promise<void> {
  if (fromBoxId === toBoxId) throw new Error('来源箱与目标箱相同');
  await atomic(['items', 'boxes', 'logs', 'organizations', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    const fromBox = await reqAs<Box | undefined>(s.boxes.get(fromBoxId));
    const toBox = await reqAs<Box | undefined>(s.boxes.get(toBoxId));
    if (!item || !fromBox || !toBox) throw new Error('物品或箱不存在');
    if (item.frozen) throw new Error(`物品已冻结：${item.frozenReason ?? ''}`);
    if (item.awaitingArbitration) throw new Error('存在未裁决合并冲突，不能移箱');
    if (item.location.kind === 'handed' || fromBox.status === 'handed' || toBox.status === 'handed') {
      throw new Error('涉及已交接锁定的箱或物品，移箱被阻止（请走退回流程）');
    }
    if (item.location.kind !== 'box' || item.location.boxId !== fromBoxId) throw new Error('物品不在来源箱中');
    const org = await reqAs<Organization | undefined>(s.organizations.get(toBox.orgId));
    const violations = validatePack(item, toBox, org);
    if (violations.length) throw new Error(violations.map((v) => v.message).join('；'));

    delete fromBox.checks[itemId];
    s.boxes.put(fromBox);
    item.location = { kind: 'box', boxId: toBoxId };
    s.items.put(item);
    await writeLog(s, meta, {
      type: 'MOVE',
      operator,
      itemId,
      barcode: item.barcode,
      boxId: toBoxId,
      fromBoxId,
      toBoxId,
      detail: `从箱「${fromBox.label}」移至箱「${toBox.label}」`
    });
  });
}

export async function toggleCheck(itemId: string, boxId: string, operator: string): Promise<boolean> {
  let nowChecked = false;
  await atomic(['items', 'boxes', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const box = await reqAs<Box | undefined>(s.boxes.get(boxId));
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!box) throw new Error('箱不存在');
    if (box.status === 'handed') throw new Error('箱已交接锁定');
    if (!item || item.location.kind !== 'box' || item.location.boxId !== boxId) throw new Error('物品不在该箱中');
    if (box.checks[itemId]) {
      delete box.checks[itemId];
      nowChecked = false;
    } else {
      box.checks[itemId] = { at: Date.now(), by: operator };
      nowChecked = true;
    }
    s.boxes.put(box);
    await writeLog(s, meta, {
      type: 'CHECK',
      operator,
      itemId,
      barcode: item.barcode,
      boxId,
      payload: { checked: nowChecked },
      detail: nowChecked ? '逐件检查：已核' : '逐件检查：取消勾选'
    });
  });
  return nowChecked;
}

export async function getHandoverReadiness(boxId: string) {
  const [box, items, orgs] = await Promise.all([
    get<Box>('boxes', boxId),
    getAll<Item>('items'),
    getAll<Organization>('organizations')
  ]);
  if (!box) throw new Error('箱不存在');
  const { evaluateHandover } = await import('./rules');
  const inBox = items.filter((i) => i.location.kind === 'box' && i.location.boxId === boxId);
  return evaluateHandover(box, inBox, orgs.find((o) => o.id === box.orgId));
}

export async function handoverBox(boxId: string, receiver: string, operator: string): Promise<void> {
  await atomic(['items', 'boxes', 'logs', 'organizations', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const box = await reqAs<Box | undefined>(s.boxes.get(boxId));
    if (!box) throw new Error('箱不存在');
    if (box.status === 'handed') throw new Error('箱已交接');
    const allItems = await reqAs<Item[]>(s.items.getAll());
    const inBox = allItems.filter((i) => i.location.kind === 'box' && i.location.boxId === boxId);
    const orgs = await reqAs<Organization[]>(s.organizations.getAll());
    const { evaluateHandover } = await import('./rules');
    const readiness = evaluateHandover(box, inBox, orgs.find((o) => o.id === box.orgId));
    if (!readiness.ok) throw new Error(`不能交接：还有 ${readiness.blockingCount} 件未通过逐件检查或不适配`);

    const evidence = inBox.map((i) => ({
      itemId: i.itemId,
      barcode: i.barcode,
      name: i.name,
      category: i.category,
      damage: i.damage
    }));
    box.status = 'handed';
    box.handedAt = Date.now();
    box.receiver = receiver.trim() || '未登记接收人';
    s.boxes.put(box);
    for (const item of inBox) {
      item.location = { kind: 'handed', boxId };
      s.items.put(item);
    }
    await writeLog(s, meta, {
      type: 'HANDOVER',
      operator,
      boxId,
      receiver: box.receiver,
      evidence,
      itemId: undefined,
      detail: `整箱交接给 ${box.receiver}，共 ${inBox.length} 件`
    });
  });
}

export async function returnBox(boxId: string, reason: string, operator: string): Promise<void> {
  await atomic(['items', 'boxes', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const box = await reqAs<Box | undefined>(s.boxes.get(boxId));
    if (!box) throw new Error('箱不存在');
    const guard = canReturnBox(box);
    if (!guard.ok) throw new Error(guard.reason);
    box.status = 'open';
    box.returnedAt = Date.now();
    box.returnReason = reason.trim() || '未填写退回原因';
    s.boxes.put(box);
    const items = await reqAs<Item[]>(s.items.getAll());
    for (const item of items) {
      if (item.location.kind === 'handed' && item.location.boxId === boxId) {
        item.location = { kind: 'box', boxId };
        s.items.put(item);
      }
    }
    await writeLog(s, meta, {
      type: 'RETURN',
      operator,
      boxId,
      payload: { reason: box.returnReason },
      detail: `交接退回：${box.returnReason}`
    });
  });
}

/** 撤销扫码：仅仍在队列、其后无复核的创建操作；追加 REVERT，不删日志 */
export async function revertScan(createUid: string, operator: string): Promise<void> {
  await atomic(['items', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const creation = await reqAs<OperationLog | undefined>(s.logs.get(createUid));
    if (!creation) throw new Error('日志不存在');
    if (creation.projectId !== meta.projectId) throw new Error('只能撤销本工程的扫码（外来记录请在合并中处理）');
    const all = await reqAs<OperationLog[]>(s.logs.getAll());
    if (all.some((l) => l.type === 'REVERT' && l.revertsUid === createUid)) throw new Error('该扫码已撤销过');
    if (creation.type !== 'SCAN' && creation.type !== 'IMPORT') throw new Error('只能撤销扫码/导入产生的新增记录');
    const itemId = creation.itemId ?? refOf(meta.projectId, creation.uid);
    const item = await reqAs<Item | undefined>(s.items.get(itemId));
    if (!item) throw new Error('物品不存在，可能已被撤销');
    if (item.location.kind !== 'queue') throw new Error('物品已装箱或已交接，不能撤销扫码（请先移回队列/走退回流程）');
    const protectedLater = all.filter((l) => l.itemId === itemId && l.seq > creation.seq && l.type === 'REVIEW');
    if (protectedLater.length) throw new Error('该物品扫码后已追加高价值复核记录，撤销会破坏复核痕迹，已阻止');

    s.items.delete(itemId);
    await writeLog(s, meta, {
      type: 'REVERT',
      operator,
      itemId,
      barcode: creation.barcode,
      revertsUid: createUid,
      detail: `撤销扫码 ${creation.barcode}（物品仍在队列且其后无复核）`
    });
  });
}

export async function createBox(input: {
  label: string;
  orgId: string;
  categories: ItemCategory[];
  maxDamage: DamageGrade;
}, operator: string): Promise<Box> {
  let created!: Box;
  await atomic(['boxes', 'logs', 'meta'], 'readwrite', async (s) => {
    const meta = await readMeta(s);
    const localId = `box-${newUid().slice(0, 8)}`;
    const box: Box = {
      id: refOf(meta.projectId, localId),
      originProjectId: meta.projectId,
      label: input.label.trim() || localId,
      orgId: input.orgId,
      categories: input.categories,
      maxDamage: input.maxDamage,
      status: 'open',
      createdAt: Date.now(),
      checks: {}
    };
    s.boxes.put(box);
    await writeLog(s, meta, {
      type: 'BOX_CREATE',
      operator,
      boxId: box.id,
      payload: { label: box.label, orgId: box.orgId, categories: box.categories, maxDamage: box.maxDamage },
      detail: `建档箱「${box.label}」`
    });
    created = box;
  });
  return created;
}

export async function listAll(): Promise<{
  meta: ProjectMeta;
  ledger: MergeLedger;
  orgs: Organization[];
  items: Item[];
  boxes: Box[];
  logs: OperationLog[];
}> {
  await ensureMeta();
  const [meta, ledger, orgs, items, boxes, logs] = await Promise.all([
    get<ProjectMeta>('meta', 'meta'),
    get<MergeLedger>('ledger', 'ledger'),
    getAll<Organization>('organizations'),
    getAll<Item>('items'),
    getAll<Box>('boxes'),
    getAll<OperationLog>('logs')
  ]);
  logs.sort((a, b) => a.seq - b.seq || (a.projectId < b.projectId ? -1 : 1));
  return {
    meta: meta!,
    ledger: ledger ?? emptyLedger(),
    orgs,
    items,
    boxes,
    logs
  };
}

/** 首次使用：创建工程元信息与空台账 */
export async function ensureMeta(projectName = '本机仓库', projectId?: string): Promise<void> {
  await atomic(['meta', 'ledger'], 'readwrite', async (s) => {
    const existing = await reqAs<ProjectMeta | undefined>(s.meta.get('meta'));
    if (!existing) {
      s.meta.put({ key: 'meta', projectId: projectId ?? newUid(), projectName, createdAt: Date.now(), seq: 0 } satisfies ProjectMeta);
    }
    const ledger = await reqAs<MergeLedger | undefined>(s.ledger.get('ledger'));
    if (!ledger) s.ledger.put(emptyLedger());
  });
}

/** 合并提交：由 merge-actions 调用 —— 用规范结果整体替换实体，并标记已导入操作 */
export async function replaceWorld(canonical: {
  organizations: Organization[];
  boxes: Box[];
  items: Item[];
  logs: OperationLog[];
}, ledger: MergeLedger): Promise<void> {
  await atomic([...STORES], 'readwrite', async (s) => {
    for (const name of ['organizations', 'boxes', 'items', 'logs'] as const) {
      s[name].clear();
    }
    for (const o of canonical.organizations) s.organizations.put(o);
    for (const b of canonical.boxes) s.boxes.put(b);
    for (const it of canonical.items) s.items.put(it);
    for (const l of canonical.logs) s.logs.put(l);
    s.ledger.put(ledger);
    // 合并/裁决写入的审计日志要推进本工程 seq，外来 seq 不占号段
    const meta = await readMeta(s);
    const maxLocalSeq = canonical.logs
      .filter((l) => l.projectId === meta.projectId)
      .reduce((m, l) => Math.max(m, l.seq), meta.seq);
    s.meta.put({ ...meta, seq: maxLocalSeq });
  });
}

/** 合并后用规范状态自检（返回冲突，供 UI 即时刷新） */
export async function reanalyze() {
  const data = await listAll();
  return analyzeWorld(
    [data.meta],
    data.ledger,
    data.orgs,
    data.logs
  );
}

export const logTypeLabel: Record<OperationType, string> = {
  SCAN: '扫码入库',
  RESCAN: '重复扫码',
  IMPORT: '文件导入',
  RELABEL: '改写条码',
  GRADE: '成色改级',
  BOX_CREATE: '建箱',
  REVIEW: '高价值复核',
  PACK: '装箱',
  UNPACK: '取出',
  MOVE: '移箱',
  CHECK: '逐件检查',
  HANDOVER: '整箱交接',
  RETURN: '交接退回',
  REVERT: '撤销扫码',
  MERGE_IMPORT: '合并导入',
  MERGE_RESOLVE: '冲突裁决'
};

export { opKey };
