/**
 * 工程合并动作：
 * - parseSnapshot 读取 v2 工程包（机构/箱/物品/操作日志/台账）；
 * - previewMerge 只计算不写库 —— 可反复预览，用户可暂停；
 * - resolveConflict 追加裁决（带证据指纹），同一包重复导入不会再出现已处理冲突；
 * - commitMerge 幂等提交：操作按 projectId#uid 去重，完全相同的操作只导入一次。
 */
import { newUid } from './db';
import { listAll, replaceWorld, ensureMeta } from './actions';
import { analyzeWorld, buildMergePreview, type MergePreview, type WorldData } from './merge';
import {
  opKey,
  type Adjudication,
  type DamageGrade,
  type ItemLocation,
  type MergeLedger,
  type OperationLog,
  type SnapshotV2
} from './types';

export class SnapshotError extends Error {}

export function parseSnapshot(text: string): SnapshotV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new SnapshotError(`不是有效的 JSON：${(e as Error).message}`);
  }
  const s = parsed as Partial<SnapshotV2>;
  if (!s || s.format !== 'charity-warehouse/v2' || !s.payload?.meta || !Array.isArray(s.payload.logs)) {
    throw new SnapshotError('不是本系统 v2 工程快照（请用新版本导出）');
  }
  return s as SnapshotV2;
}

export async function localWorld(): Promise<WorldData> {
  await ensureMeta();
  const d = await listAll();
  return { meta: d.meta, ledger: d.ledger, organizations: d.orgs, boxes: d.boxes, items: d.items, logs: d.logs };
}

export async function previewFromText(text: string): Promise<{ preview: MergePreview; incoming: WorldData }> {
  const snap = parseSnapshot(text);
  const local = await localWorld();
  const incoming: WorldData = {
    meta: snap.payload.meta,
    ledger: snap.payload.ledger ?? { key: 'ledger', ingested: {}, adjudications: {}, packages: {} },
    organizations: snap.payload.organizations,
    boxes: snap.payload.boxes,
    items: snap.payload.items,
    logs: snap.payload.logs
  };
  if (incoming.meta.projectId === local.meta.projectId) {
    throw new SnapshotError('该工程包来自本工程自己（projectId 相同），无需合并');
  }
  return { preview: buildMergePreview(local, incoming), incoming };
}

/** 重新分析当前库（刷新冲突视图） */
export async function currentConflicts() {
  const d = await localWorld();
  return analyzeWorld([d.meta], d.ledger, d.organizations, d.logs);
}

export interface SaveAdjudicationInput {
  key: string;
  kind: Adjudication['kind'];
  signature: string;
  by: string;
  note?: string;
  decision?: DamageGrade | ItemLocation | string;
  winner?: string;
  loser?: string;
  relabelItemId?: string;
  newBarcode?: string;
}

/**
 * 追加/更新一条裁决。裁决写入台账后立即重放：
 * - ITEM_COLLISION/same_item：loser 身份并入 winner；
 * - ITEM_COLLISION/separate：给其中一件改派新条码（不新增库存）；
 * - DAMAGE / LOCATION / DUAL_HANDOVER：采用人工决定，并解除对应冻结。
 */
export async function saveAdjudication(input: SaveAdjudicationInput): Promise<void> {
  const d = await localWorld();
  let adjudication: Adjudication;
  if (input.kind === 'ITEM_COLLISION') {
    if (input.winner && input.loser) {
      adjudication = { kind: 'ITEM_COLLISION', decision: 'same_item', winner: input.winner, loser: input.loser, by: input.by, note: input.note, signature: input.signature };
    } else if (input.relabelItemId && input.newBarcode) {
      adjudication = { kind: 'ITEM_COLLISION', decision: 'separate', relabelItemId: input.relabelItemId, newBarcode: input.newBarcode.trim(), by: input.by, note: input.note, signature: input.signature };
    } else throw new Error('裁决参数不完整');
  } else if (input.kind === 'DAMAGE') {
    adjudication = { kind: 'DAMAGE', decision: input.decision as DamageGrade, by: input.by, note: input.note, signature: input.signature };
  } else if (input.kind === 'LOCATION') {
    adjudication = { kind: 'LOCATION', decision: input.decision as ItemLocation, by: input.by, note: input.note, signature: input.signature };
  } else {
    adjudication = { kind: 'DUAL_HANDOVER', decision: String(input.decision), by: input.by, note: input.note ?? '', signature: input.signature };
  }

  const ledger: MergeLedger = {
    ...d.ledger,
    adjudications: { ...d.ledger.adjudications, [input.key]: adjudication }
  };

  const auditSeq = d.meta.seq + 1;
  const auditLog: OperationLog = {
    uid: newUid(),
    projectId: d.meta.projectId,
    seq: auditSeq,
    at: Date.now(),
    type: 'MERGE_RESOLVE',
    operator: input.by,
    detail: `冲突裁决 ${input.kind}（${input.key}）`
  };

  const result = analyzeWorld([d.meta], ledger, d.organizations, [...d.logs, auditLog]);
  await replaceWorld(
    {
      organizations: result.canonical.organizations,
      boxes: result.canonical.boxes,
      items: result.canonical.items,
      logs: result.canonical.logs
    },
    ledger
  );
}

/**
 * 提交合并：把 incoming 的新操作并入（projectId#uid 去重），
 * 标记 ingested，审计一条 MERGE_IMPORT。未裁决冲突保留为阻断态 —— 用户可以暂停。
 * 重复导入同一包：newOpKeys 为空、已裁决冲突不再出现。
 */
export async function commitMerge(incoming: WorldData, operator: string, packageName = ''): Promise<MergePreview> {
  const local = await localWorld();
  const preview = buildMergePreview(local, incoming);

  const knownKeys = new Set(local.logs.map((l) => opKey(l.projectId, l.uid)));
  const incomingUnique: OperationLog[] = [];
  for (const l of incoming.logs) {
    const k = opKey(l.projectId, l.uid);
    if (!knownKeys.has(k)) {
      incomingUnique.push(l);
      knownKeys.add(k);
    }
  }

  const mergedLedger: MergeLedger = {
    key: 'ledger',
    ingested: { ...local.ledger.ingested, ...incoming.ledger.ingested },
    adjudications: { ...incoming.ledger.adjudications, ...local.ledger.adjudications }, // 本机裁决优先
    packages: { ...local.ledger.packages, ...incoming.ledger.packages }
  };
  if (incomingUnique.length || packageName) {
    mergedLedger.packages[`${incoming.meta.projectId}@${incoming.meta.createdAt}`] = { name: packageName };
    for (const k of preview.newOpKeys) mergedLedger.ingested[k] = { packageId: `${incoming.meta.projectId}@${incoming.meta.createdAt}` };
  }

  // 先写审计日志，再整体重放
  const auditSeq = local.meta.seq + 1;
  const auditLog: OperationLog = {
    uid: newUid(),
    projectId: local.meta.projectId,
    seq: auditSeq,
    at: Date.now(),
    type: 'MERGE_IMPORT',
    operator,
    detail: `合并工程「${incoming.meta.projectName}」：新增操作 ${incomingUnique.length} 条，跳过重复 ${preview.skippedDuplicateKeys.length} 条，待裁决 ${preview.pendingCount} 项`
  };

  const metas = [local.meta, incoming.meta];
  const orgs = [...local.organizations, ...incoming.organizations];
  const allOps = [...local.logs, ...incomingUnique, auditLog];
  const result = analyzeWorld(metas, mergedLedger, orgs, allOps);

  await replaceWorld(
    {
      organizations: result.canonical.organizations,
      boxes: result.canonical.boxes,
      items: result.canonical.items,
      logs: result.canonical.logs
    },
    mergedLedger
  );
  return preview;
}
