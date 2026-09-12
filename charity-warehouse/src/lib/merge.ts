/**
 * 工程合并引擎（纯函数，无 IO，可单测）。
 *
 * 关键原则：
 * 1. 身份 = 来源工程 + 稳定操作编号（itemId / 操作 uid / 全局箱引用），条码只是可变属性；
 * 2. 操作按 (projectId, seq, uid) 确定性排序 —— 同一工程 seq 给出因果顺序，
 *    跨工程不假设时钟，所以合并不依赖文件导入先后，也不凭 at 判谁对；
 * 3. 已交接是“事实”：交接证据快照（HANDOVER.evidence / claims）中的成色与去向，
 *    不允许被另一工程的旧 GRADE/位置覆盖；
 * 4. 同一实物被两边交给两个机构 → DUAL_HANDOVER，冻结后续转移，双方证据保留；
 * 5. 同一条码被两个独立身份占用 → ITEM_COLLISION 待裁决，绝不自动加总库存；
 * 6. 裁决带证据指纹（signature），证据变了裁决失效、冲突重新出现；
 * 7. 操作按 projectId#uid 去重：同一包反复导入，完全相同的操作只生效一次。
 */
import {
  opKey,
  type Adjudication,
  type Box,
  type DamageGrade,
  type HandoverClaim,
  type HandoverEvidence,
  type Item,
  type ItemCategory,
  type ItemLocation,
  type MergeLedger,
  type OperationLog,
  type Organization,
  type ProjectMeta,
  type Review
} from './types';

export interface WorldData {
  meta: ProjectMeta;
  ledger: MergeLedger;
  organizations: Organization[];
  boxes: Box[];
  items: Item[];
  logs: OperationLog[];
}

export type ConflictKind =
  | 'ITEM_COLLISION' // 同一条码、两个独立身份：同一实物需合并，或不同实物需改码
  | 'DAMAGE' // 同一身份两边记录了不同成色
  | 'LOCATION' // 同一身份两边去向不一致（都未交接）
  | 'DUAL_HANDOVER' // 两边都声称交接，且机构不同 —— 冻结
  | 'BLOCKED_STALE_GRADE' // 信息项：另一工程旧成色被交接事实挡住
  | 'ALIAS_COLLISION'; // 信息项：当前码撞上别人的曾用码

export interface MergeConflict {
  key: string;
  kind: ConflictKind;
  /** 阻断型：未裁决前相关物品不能装箱/转移 */
  blocking: boolean;
  signature: string;
  title: string;
  detail: string;
  itemIds: string[];
  /** 已有有效裁决（指纹匹配） */
  adjudication?: Adjudication;
  candidates?: unknown;
  claims?: HandoverClaim[];
}

export interface MergePreview {
  projects: { meta: ProjectMeta; ops: number; isLocal: boolean }[];
  newOpKeys: string[];
  skippedDuplicateKeys: string[];
  conflicts: MergeConflict[];
  pendingCount: number;
  /** 提交后应落库的规范状态 */
  canonical: {
    organizations: Organization[];
    boxes: Box[];
    items: Item[];
    logs: OperationLog[];
  };
}

/* ------------------------------------------------------------------ */
/* 内部重放状态                                                         */
/* ------------------------------------------------------------------ */

interface ProjState {
  exists: boolean;
  removed: boolean;
  barcode: string;
  aliases: string[];
  damage: DamageGrade;
  location: ItemLocation;
  name: string;
  category: ItemCategory;
  highValue: boolean;
}

interface ItemAcc {
  effectiveId: string;
  /** projectId -> 该工程视角的最终状态（用于发现跨工程分歧，且不依赖时钟） */
  perProject: Map<string, ProjState>;
  reviews: Map<string, Review>;
  claims: HandoverClaim[];
  scanCount: number;
  createdAt: number;
  scannedAt: number;
}

interface BoxAcc {
  id: string;
  originProjectId: string;
  label: string;
  orgId: string;
  categories: ItemCategory[];
  maxDamage: DamageGrade;
  status: Box['status'];
  createdAt: number;
  handedAt?: number;
  receiver?: string;
  checks: Record<string, { at: number; by: string }>;
  returnedAt?: number;
  returnReason?: string;
}

interface AnalyzeResult {
  conflicts: MergeConflict[];
  canonical: MergePreview['canonical'];
}

/* ------------------------------------------------------------------ */
/* 身份映射（同一实物裁决）                                              */
/* ------------------------------------------------------------------ */

function buildIdentityMap(ledger: MergeLedger): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of Object.values(ledger.adjudications)) {
    if (a.kind === 'ITEM_COLLISION' && a.decision === 'same_item') {
      map.set(a.loser, a.winner);
    }
  }
  // 解析传递性（A->B, B->C）
  const resolve = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (map.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = map.get(cur)!;
    }
    return cur;
  };
  return new Map([...map.keys()].map((k) => [k, resolve(k)]));
}

/* ------------------------------------------------------------------ */
/* 主分析：给定合并后的操作全集，重放规范状态 + 找冲突                    */
/* ------------------------------------------------------------------ */

export function analyzeWorld(
  _metas: ProjectMeta[],
  ledger: MergeLedger,
  organizationsIn: Organization[],
  logsIn: OperationLog[]
): AnalyzeResult {
  void _metas;
  const identity = buildIdentityMap(ledger);
  const eff = (id: string) => identity.get(id) ?? id;

  const ops = [...logsIn].sort((a, b) =>
    a.projectId < b.projectId ? -1
      : a.projectId > b.projectId ? 1
        : a.seq - b.seq || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
  );

  // 重放阶段各工程完全独立：itemId 用“原始身份”建账，identity 只在折叠阶段生效，
  // 否则 same_item 裁决会让 A 工程的交接/退回错误作用到 B 工程的状态与主张。
  const items = new Map<string, ItemAcc>();
  const boxes = new Map<string, BoxAcc>();

  const accOfRaw = (id: string): ItemAcc => {
    let acc = items.get(id);
    if (!acc) {
      acc = { effectiveId: id, perProject: new Map(), reviews: new Map(), claims: [], scanCount: 0, createdAt: Infinity, scannedAt: 0 };
      items.set(id, acc);
    }
    return acc;
  };

  for (const op of ops) {
    const pid = op.projectId;

    if (op.type === 'BOX_CREATE' && op.boxId) {
      const p = op.payload ?? {};
      boxes.set(op.boxId, {
        id: op.boxId,
        originProjectId: pid,
        label: String(p.label ?? op.boxId),
        orgId: String(p.orgId ?? ''),
        categories: (p.categories as ItemCategory[]) ?? [],
        maxDamage: (p.maxDamage as DamageGrade) ?? 3,
        status: 'open',
        createdAt: op.at,
        checks: {}
      });
      continue;
    }

    // 箱级 HANDOVER/RETURN：没有单一 itemId，要作用到该工程视角下箱内全部成员
    if ((op.type === 'HANDOVER' || op.type === 'RETURN') && op.boxId) {
      const box = boxes.get(op.boxId);
      const evidenceMap = new Map((op.evidence ?? []).map((e) => [e.itemId, e]));
      for (const [eid, acc] of items) {
        const st = acc.perProject.get(pid);
        if (!st || !st.exists || st.removed) continue;
        const inBox =
          (st.location.kind === 'box' || st.location.kind === 'handed') && st.location.boxId === op.boxId;
        const evidenced = evidenceMap.has(eid);
        if (!inBox && !evidenced) continue;
        if (op.type === 'HANDOVER') {
          if (box) {
            box.status = 'handed';
            box.handedAt = op.at;
            box.receiver = op.receiver;
            delete box.returnedAt;
            delete box.returnReason;
          }
          st.location = { kind: 'handed', boxId: op.boxId };
          const ev = evidenceMap.get(eid);
          acc.claims.push({
            projectId: pid,
            boxId: op.boxId,
            receiver: op.receiver,
            at: op.at,
            damage: ev ? ev.damage : st.damage,
            barcode: ev ? ev.barcode : st.barcode,
            active: true
          });
        } else {
          if (box) {
            box.status = 'open';
            box.returnedAt = op.at;
            box.returnReason = String(op.payload?.reason ?? '');
          }
          st.location = { kind: 'box', boxId: op.boxId };
          // 退回不删除交接证据：标记失效即可。同一实物曾交给两个机构时，
          // 即使其中一份后来退回，仍需保留双份证据交人工核实。
          for (const c of acc.claims) {
            if (c.projectId === pid && c.boxId === op.boxId) c.active = false;
          }
        }
      }
      continue;
    }

    if (!op.itemId) continue;
    const acc = accOfRaw(op.itemId);
    let st = acc.perProject.get(pid);
    if (!st) {
      st = { exists: false, removed: false, barcode: '', aliases: [], damage: 0, location: { kind: 'queue' }, name: '', category: 'clothing', highValue: false };
      acc.perProject.set(pid, st);
    }

    switch (op.type) {
      case 'SCAN':
      case 'IMPORT': {
        if (st.removed) break; // 已撤销后不可能同 id 复活（新扫会生成新 uid）
        if (!st.exists) {
          const p = op.payload ?? {};
          st.exists = true;
          st.barcode = op.barcode ?? '';
          st.name = String(p.name ?? op.barcode ?? '');
          st.category = (p.category as ItemCategory) ?? 'clothing';
          st.damage = (p.damage as DamageGrade) ?? 0;
          st.highValue = Boolean(p.highValue);
          acc.createdAt = Math.min(acc.createdAt, op.at);
        }
        acc.scanCount += 1;
        acc.scannedAt = Math.max(acc.scannedAt, op.at);
        break;
      }
      case 'RESCAN':
        acc.scanCount += 1;
        acc.scannedAt = Math.max(acc.scannedAt, op.at);
        break;
      case 'REVERT':
        st.removed = true;
        st.exists = false;
        break;
      case 'RELABEL': {
        const next = String(op.payload?.barcode ?? op.barcode ?? '');
        if (st.barcode && next !== st.barcode) st.aliases.push(st.barcode);
        st.barcode = next;
        break;
      }
      case 'GRADE':
        if (op.to !== undefined) st.damage = op.to;
        break;
      case 'REVIEW': {
        const p = op.payload ?? {};
        const uid = String(p.uid ?? op.uid);
        acc.reviews.set(uid, {
          uid,
          projectId: pid,
          seq: op.seq,
          at: op.at,
          by: String(p.by ?? op.operator),
          verdict: (p.verdict as Review['verdict']) ?? 'approved',
          note: p.note ? String(p.note) : undefined
        });
        break;
      }
      case 'PACK':
        if (op.boxId) st.location = { kind: 'box', boxId: op.boxId };
        break;
      case 'UNPACK':
        st.location = { kind: 'queue' };
        break;
      case 'MOVE':
        if (op.toBoxId) st.location = { kind: 'box', boxId: op.toBoxId };
        break;
      case 'CHECK': {
        const box = op.boxId ? boxes.get(op.boxId) : undefined;
        if (box) {
          if (op.payload?.checked === false) delete box.checks[op.itemId!];
          else box.checks[op.itemId!] = { at: op.at, by: op.operator };
        }
        break;
      }
      default:
        // HANDOVER/RETURN 为箱级操作，已在主循环统一处理
        break;
    }
  }

  /* ---- 组织：按全局 id 合并，内容取确定性较大者（JSON 字典序），不看时钟 ---- */
  const orgs = new Map<string, Organization>();
  for (const o of organizationsIn) {
    const prev = orgs.get(o.id);
    if (!prev || JSON.stringify(o) > JSON.stringify(prev)) orgs.set(o.id, o);
  }

  /* ---- 折叠为规范物品，并检测跨工程分歧 ---- */
  const conflicts: MergeConflict[] = [];
  const canonicalItems: Item[] = [];

  // 折叠阶段：把 same_item 裁决映射到同一 effectiveId 的各工程原始账合并
  const merged = new Map<string, ItemAcc>();
  for (const [rawId, acc] of items) {
    const eid = eff(rawId);
    let m = merged.get(eid);
    if (!m) {
      m = { effectiveId: eid, perProject: new Map(), reviews: new Map(), claims: [], scanCount: 0, createdAt: Infinity, scannedAt: 0 };
      merged.set(eid, m);
    }
    for (const [pid, st] of acc.perProject) m.perProject.set(pid, st);
    for (const [uid, rv] of acc.reviews) m.reviews.set(uid, rv);
    m.claims.push(...acc.claims);
    m.scanCount += acc.scanCount;
    m.createdAt = Math.min(m.createdAt, acc.createdAt);
    m.scannedAt = Math.max(m.scannedAt, acc.scannedAt);
  }

  for (const [eid, acc] of merged) {
    const liveProjects = [...acc.perProject.entries()].filter(([, s]) => s.exists && !s.removed);
    if (liveProjects.length === 0) continue; // 各工程都已撤销：墓碑，不进库存

    const winnerPid = eid.split('#')[0]!;
    const winnerState = liveProjects.find(([pid]) => pid === winnerPid)?.[1] ?? liveProjects[0]![1];

    // 条码：以 winner 工程视角为准，其他工程码进 aliases
    const aliases = new Set<string>();
    for (const [, s] of liveProjects) {
      for (const a of s.aliases) aliases.add(a);
      if (s.barcode !== winnerState.barcode) aliases.add(s.barcode);
    }
    aliases.delete(winnerState.barcode);

    const damages = new Set(liveProjects.map(([, s]) => s.damage));
    const locEntries = liveProjects.map(([pid, s]) => ({ pid, loc: s.location }));

    let damage: DamageGrade = winnerState.damage;
    let location: ItemLocation = winnerState.location;
    let frozen = false;
    let frozenReason: string | undefined;
    let awaiting = false;
    const kinds: string[] = [];
    const itemConflicts: MergeConflict[] = [];

    // —— 交接冲突：历史上交给不同机构（含其一已退回）都算 ——
    const liveClaims = acc.claims.filter((c) =>
      liveProjects.some(([pid]) => pid === c.projectId)
    );
    const claimBoxes = new Set(liveClaims.map((c) => c.boxId));
    if (claimBoxes.size > 1) {
      // —— DUAL_HANDOVER：历史上有两个不同交接去向，冻结并保留双方证据 ——
      const sig = JSON.stringify([
        eid,
        [...claimBoxes].sort(),
        liveClaims.map((c) => `${c.projectId}:${c.boxId}:${c.active !== false ? 1 : 0}:${c.damage}:${c.barcode}`).sort()
      ]);
      const key = `DUAL_HANDOVER:${eid}`;
      const adjudication = validAdjudication(ledger, key, sig);
      itemConflicts.push({
        key,
        kind: 'DUAL_HANDOVER',
        blocking: true,
        signature: sig,
        title: `物品 ${winnerState.barcode} 被记录为交给过不同机构（含已退回）`,
        detail: liveClaims
          .map((c2) => `工程 ${c2.projectId} → 箱 ${c2.boxId}（${c2.receiver ?? '接收人未登记'}，成色 ${c2.damage} 级，码 ${c2.barcode}${c2.active === false ? '，该次交接已退回' : ''}）`)
          .join('；'),
        itemIds: [eid],
        claims: liveClaims,
        adjudication
      });
      if (!adjudication) {
        frozen = true;
        frozenReason = '存在两个不同机构的交接记录，冻结转移，待人工核实';
        awaiting = true;
        kinds.push('DUAL_HANDOVER');
      } else if (adjudication.kind === 'DUAL_HANDOVER') {
        location = { kind: 'handed', boxId: adjudication.decision };
      }
    } else if (claimBoxes.size === 1) {
      const onlyBox = [...claimBoxes][0]!;
      const activeClaims = liveClaims.filter((c) => c.boxId === onlyBox && c.active !== false);
      const returned = activeClaims.length === 0; // 唯一一次交接已退回
      if (!returned) {
        // —— 单一现存交接主张即为“事实”：其成色/去向不被另一工程旧记录覆盖 ——
        const activeClaim = activeClaims[activeClaims.length - 1]!;
        const factPid = activeClaim.projectId;
        location = { kind: 'handed', boxId: activeClaim.boxId };
        damage = activeClaim.damage;
        for (const [pid, s] of liveProjects) {
          if (pid === factPid) continue;
          // 该工程对同一箱的交接已退回：它回箱内是正常业务，不报冲突
          const hisClaim = liveClaims.find((c) => c.projectId === pid);
          if (hisClaim && hisClaim.active === false) continue;
          if (s.damage !== damage) {
            itemConflicts.push({
              key: `BLOCKED_STALE_GRADE:${eid}:${pid}`,
              kind: 'BLOCKED_STALE_GRADE',
              blocking: false,
              signature: `${eid}:${pid}:${s.damage}:${damage}`,
              title: `工程 ${pid} 的成色 ${s.damage} 级未覆盖交接事实`,
              detail: `现存交接事实在工程 ${factPid}（箱 ${activeClaim.boxId}，交接时成色 ${damage} 级，不可变）；工程 ${pid} 记录的 ${s.damage} 级仅保留为证据，不覆盖事实。`,
              itemIds: [eid]
            });
          }
          if (s.location.kind === 'handed' && s.location.boxId !== activeClaim.boxId) {
            itemConflicts.push({
              key: `LOCATION_FACT:${eid}:${pid}`,
              kind: 'LOCATION',
              blocking: false,
              signature: `fact:${eid}:${pid}:${JSON.stringify(s.location)}`,
              title: `工程 ${pid} 的交接去向与现存事实不一致`,
              detail: `该工程显示交给 ${s.location.boxId}，现存交接事实为 ${activeClaim.boxId}；以事实为准，原记录留痕。`,
              itemIds: [eid]
            });
          }
        }
      }
      // returned === true：交接已退回，落入下方“未交接分歧”逻辑
    }

    const noActiveHandoverFact = claimBoxes.size === 0 ||
      (claimBoxes.size === 1 && liveClaims.every((c) => c.active === false));
    if (claimBoxes.size <= 1 && noActiveHandoverFact) {
      // —— 无现存交接事实：成色/去向分歧必须人工裁决，不凭时钟取舍 ——
      if (damages.size > 1) {
        const sig = JSON.stringify([eid, [...damages].sort()]);
        const key = `DAMAGE:${eid}`;
        const adjudication = validAdjudication(ledger, key, sig);
        itemConflicts.push({
          key,
          kind: 'DAMAGE',
          blocking: true,
          signature: sig,
          title: `物品 ${winnerState.barcode} 成色记录不一致：${[...damages].sort().join(' / ')} 级`,
          detail: liveProjects.map(([pid, s]) => `工程 ${pid}：${s.damage} 级`).join('；'),
          itemIds: [eid],
          candidates: [...damages].sort(),
          adjudication
        });
        if (!adjudication) {
          awaiting = true;
          kinds.push('DAMAGE');
        } else if (adjudication.kind === 'DAMAGE') {
          damage = adjudication.decision;
        }
      }
      const distinctLocs = new Set(locEntries.map((e) => JSON.stringify(e.loc)));
      if (distinctLocs.size > 1) {
        const sig = JSON.stringify([eid, [...distinctLocs].sort()]);
        const key = `LOCATION:${eid}`;
        const adjudication = validAdjudication(ledger, key, sig);
        itemConflicts.push({
          key,
          kind: 'LOCATION',
          blocking: true,
          signature: sig,
          title: `物品 ${winnerState.barcode} 去向记录不一致`,
          detail: locEntries.map((e) => `工程 ${e.pid}：${describeLoc(e.loc)}`).join('；'),
          itemIds: [eid],
          candidates: locEntries,
          adjudication
        });
        if (!adjudication) {
          awaiting = true;
          kinds.push('LOCATION');
        } else if (adjudication.kind === 'LOCATION') {
          location = adjudication.decision;
        }
      }
    }

    const reviews = [...acc.reviews.values()].sort((a, b) => a.seq - b.seq || (a.uid < b.uid ? -1 : 1));
    const mergedFrom = [...identity.entries()].filter(([, w]) => w === eid).map(([l]) => l);

    canonicalItems.push({
      itemId: eid,
      originProjectId: winnerPid,
      barcode: winnerState.barcode,
      aliases: [...aliases],
      name: winnerState.name,
      category: winnerState.category,
      damage,
      highValue: winnerState.highValue,
      scannedAt: acc.scannedAt,
      scanCount: acc.scanCount,
      reviews,
      location,
      createdAt: acc.createdAt === Infinity ? 0 : acc.createdAt,
      mergedFrom: mergedFrom.length ? mergedFrom : undefined,
      handoverClaims: liveClaims.length ? liveClaims : undefined,
      frozen: frozen || undefined,
      frozenReason,
      awaitingArbitration: awaiting || undefined,
      arbitrationKinds: kinds.length ? kinds : undefined
    });
    conflicts.push(...itemConflicts);
  }

  /* ---- ITEM_COLLISION：不同独立身份占用同一当前条码：绝不自动加总库存 ---- */
  const byBarcode = new Map<string, Item[]>();
  for (const it of canonicalItems) {
    const list = byBarcode.get(it.barcode) ?? [];
    list.push(it);
    byBarcode.set(it.barcode, list);
  }
  for (const [barcode, list] of byBarcode) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const idPair = [a.itemId, b.itemId].sort();
        const sig = JSON.stringify({ pair: idPair, barcodes: [a.barcode, b.barcode], damages: [a.damage, b.damage].sort() });
        const key = `ITEM_COLLISION:${idPair.join('|')}`;
        const adjudication = validAdjudication(ledger, key, sig);
        conflicts.push({
          key,
          kind: 'ITEM_COLLISION',
          blocking: true,
          signature: sig,
          title: `条码 ${barcode} 被两个独立工程创建为不同物品`,
          detail: `① ${a.itemId}「${a.name}」成色 ${a.damage}；② ${b.itemId}「${b.name}」成色 ${b.damage}。请裁决：同一实物（合并身份、库存仍为 1）还是不同实物（给其中一件改码）。`,
          itemIds: [a.itemId, b.itemId],
          candidates: { barcode, a: a.itemId, b: b.itemId },
          adjudication
        });
        if (!adjudication) {
          for (const it of [a, b]) {
            it.awaitingArbitration = true;
            it.arbitrationKinds = [...(it.arbitrationKinds ?? []), 'ITEM_COLLISION'];
          }
        } else if (adjudication.kind === 'ITEM_COLLISION' && adjudication.decision === 'separate') {
          const target = canonicalItems.find((it) => it.itemId === adjudication.relabelItemId);
          if (target && target.barcode !== adjudication.newBarcode) {
            target.aliases.push(target.barcode);
            target.barcode = adjudication.newBarcode;
          }
        }
      }
    }
  }

  /* ---- ALIAS_COLLISION（信息项）：当前码撞上别人的曾用码 ---- */
  for (const it of canonicalItems) {
    for (const other of canonicalItems) {
      if (other.itemId === it.itemId) continue;
      if (other.aliases.includes(it.barcode)) {
        conflicts.push({
          key: `ALIAS_COLLISION:${[it.itemId, other.itemId].sort().join('|')}`,
          kind: 'ALIAS_COLLISION',
          blocking: false,
          signature: `${it.itemId}:${it.barcode}`,
          title: `条码 ${it.barcode} 是物品 ${other.itemId} 的曾用码`,
          detail: '改码痕迹保留：人工核对此码当前归属，避免凭条码误判身份。',
          itemIds: [it.itemId, other.itemId]
        });
      }
    }
  }

  // 排序稳定输出
  conflicts.sort((a, b) => (a.key < b.key ? -1 : 1));
  // 箱内勾检键从原始 itemId 重映射到裁决后的有效身份
  const canonicalBoxes = [...boxes.values()]
    .map((b0) => {
      const checks: Box['checks'] = {};
      for (const [rawItemId, v] of Object.entries(b0.checks)) checks[eff(rawItemId)] = v;
      return { ...b0, checks };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  return { conflicts, canonical: { organizations: [...orgs.values()], boxes: canonicalBoxes, items: canonicalItems, logs: dedupOps(logsIn) } };
}

function validAdjudication(ledger: MergeLedger, key: string, signature: string): Adjudication | undefined {
  const a = ledger.adjudications[key];
  return a && a.signature === signature ? a : undefined;
}

function describeLoc(loc: ItemLocation): string {
  return loc.kind === 'queue' ? '待装箱队列' : loc.kind === 'box' ? `箱 ${loc.boxId}` : `已交接（箱 ${loc.boxId}）`;
}

function dedupOps(logs: OperationLog[]): OperationLog[] {
  const map = new Map<string, OperationLog>();
  for (const l of logs) map.set(opKey(l.projectId, l.uid), l);
  return [...map.values()].sort((a, b) => a.seq - b.seq || (a.projectId < b.projectId ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* 合并预览：本地 world + 传入工程快照                                    */
/* ------------------------------------------------------------------ */

export function buildMergePreview(local: WorldData, incoming: WorldData): MergePreview {
  const localKeys = new Set(local.logs.map((l) => opKey(l.projectId, l.uid)));
  const incomingKeys = new Set(incoming.logs.map((l) => opKey(l.projectId, l.uid)));
  const newOpKeys = [...incomingKeys].filter((k) => !localKeys.has(k)).sort();
  const skippedDuplicateKeys = [...incomingKeys].filter((k) => localKeys.has(k)).sort();

  // 台账合并（裁决取并集；同 key 指纹不同时保留较新的写入 —— 由 UI 在保存时保证）
  const ledger: MergeLedger = {
    key: 'ledger',
    ingested: { ...local.ledger.ingested, ...incoming.ledger.ingested },
    adjudications: { ...local.ledger.adjudications, ...incoming.ledger.adjudications },
    packages: { ...local.ledger.packages, ...incoming.ledger.packages }
  };
  const metas = [local.meta, ...incomingItemsToMetas(incoming)];
  const mergedOrgs = mergeOrgs(local.organizations, incoming.organizations);
  const mergedLogs = dedupOps([...local.logs, ...incoming.logs]);

  const { conflicts, canonical } = analyzeWorld(metas, ledger, mergedOrgs, mergedLogs);
  canonical.logs = mergedLogs;

  const pendingCount = conflicts.filter(
    (c) => c.blocking && !c.adjudication && c.kind !== 'BLOCKED_STALE_GRADE'
  ).length;

  return {
    projects: [
      { meta: local.meta, ops: local.logs.length, isLocal: true },
      ...incomingProjectList(incoming)
    ],
    newOpKeys,
    skippedDuplicateKeys,
    conflicts,
    pendingCount,
    canonical
  };
}

function incomingItemsToMetas(incoming: WorldData): ProjectMeta[] {
  return [incoming.meta];
}
function incomingProjectList(incoming: WorldData) {
  return [{ meta: incoming.meta, ops: incoming.logs.length, isLocal: false }];
}

function mergeOrgs(a: Organization[], b: Organization[]): Organization[] {
  const map = new Map<string, Organization>();
  for (const o of [...a, ...b]) {
    const prev = map.get(o.id);
    if (!prev || JSON.stringify(o) > JSON.stringify(prev)) map.set(o.id, o);
  }
  return [...map.values()];
}

export function previewFromLocal(local: WorldData): MergePreview {
  return buildMergePreview(local, {
    meta: { ...local.meta, projectId: '__none__', projectName: '（无）' },
    ledger: { key: 'ledger', ingested: {}, adjudications: {}, packages: {} },
    organizations: [],
    boxes: [],
    items: [],
    logs: []
  });
}

export function itemFingerprint(it: Item): string {
  return JSON.stringify({ id: it.itemId, barcode: it.barcode, damage: it.damage });
}

export type { HandoverEvidence };
