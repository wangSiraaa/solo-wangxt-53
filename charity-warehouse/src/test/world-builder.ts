/**
 * 测试用操作构建器：按工程内 seq 追加操作，再交给 analyzeWorld 物化。
 * 关键：at（本机时钟）可随意设置，合并判定不依赖它。
 */
import { analyzeWorld } from '../lib/merge';
import { emptyLedger } from '../lib/db';
import {
  opKey,
  refOf,
  type Box,
  type DamageGrade,
  type HandoverEvidence,
  type Item,
  type ItemCategory,
  type ItemLocation,
  type OperationLog,
  type Organization,
  type ProjectMeta
} from '../lib/types';
import type { WorldData } from '../lib/merge';

export class WorldBuilder {
  logs: OperationLog[] = [];
  orgs: Organization[] = [];
  meta: ProjectMeta;
  seq = 0;
  /** 显式操作 uid 计数，稳定可复现 */
  private n = 0;
  ledger = emptyLedger();

  constructor(public pid: string, public name: string, public clockBase = Date.UTC(2026, 0, 1), public clockStepMs = 60_000) {
    this.meta = { key: 'meta', projectId: pid, projectName: name, createdAt: clockBase, seq: 0 };
  }

  private nextUid(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }

  private add(log: Omit<OperationLog, 'uid' | 'projectId' | 'seq' | 'at'> & { uid?: string; at?: number }): OperationLog {
    this.seq += 1;
    const full: OperationLog = {
      uid: log.uid ?? this.nextUid(log.type.toLowerCase().slice(0, 2) + '-'),
      projectId: this.pid,
      seq: this.seq,
      at: log.at ?? this.clockBase + this.seq * this.clockStepMs,
      ...log
    } as OperationLog;
    this.logs.push(full);
    return full;
  }

  org(localId: string, name: string, cats: ItemCategory[], maxDamage: DamageGrade): Organization {
    const o: Organization = { id: refOf(this.pid, localId), originProjectId: this.pid, name, allowedCategories: cats, maxDamage };
    this.orgs.push(o);
    return o;
  }

  box(localId: string, label: string, org: Organization, cats: ItemCategory[], maxDamage: DamageGrade) {
    this.add({
      type: 'BOX_CREATE',
      operator: 't',
      boxId: refOf(this.pid, localId),
      detail: `建箱 ${label}`,
      payload: { label, orgId: org.id, categories: cats, maxDamage }
    });
    return refOf(this.pid, localId);
  }

  scan(localUid: string, barcode: string, p: { name: string; category: ItemCategory; damage: DamageGrade; highValue?: boolean }, at?: number): string {
    const itemId = refOf(this.pid, localUid);
    this.add({
      uid: localUid,
      type: 'SCAN',
      operator: 't',
      itemId,
      barcode,
      at,
      payload: { name: p.name, category: p.category, damage: p.damage, highValue: p.highValue ?? false },
      detail: `扫码 ${barcode}`
    });
    return itemId;
  }

  rescan(itemId: string) {
    this.add({ type: 'RESCAN', operator: 't', itemId, detail: '重复扫' });
  }
  review(itemId: string, barcode: string, by: string, verdict: 'approved' | 'rejected', note?: string, uidOverride?: string) {
    const uid = uidOverride ?? `rv-${this.n + 1}`;
    this.add({
      uid,
      type: 'REVIEW',
      operator: by,
      itemId,
      barcode,
      payload: { uid, by, verdict, note },
      detail: '复核'
    });
  }
  grade(itemId: string, barcode: string, from: DamageGrade, to: DamageGrade) {
    this.add({ type: 'GRADE', operator: 't', itemId, barcode, from, to, detail: `${from}→${to}` });
  }
  relabel(itemId: string, oldBarcode: string, newBarcode: string) {
    this.add({ type: 'RELABEL', operator: 't', itemId, barcode: newBarcode, oldBarcode, detail: `${oldBarcode}→${newBarcode}` });
  }
  pack(itemId: string, barcode: string, boxId: string) {
    this.add({ type: 'PACK', operator: 't', itemId, barcode, boxId });
  }
  unpack(itemId: string, barcode: string, boxId: string) {
    this.add({ type: 'UNPACK', operator: 't', itemId, barcode, boxId });
  }
  move(itemId: string, barcode: string, fromBoxId: string, toBoxId: string) {
    this.add({ type: 'MOVE', operator: 't', itemId, barcode, boxId: toBoxId, fromBoxId, toBoxId });
  }
  check(itemId: string, boxId: string, checked = true) {
    this.add({ type: 'CHECK', operator: 't', itemId, boxId, payload: { checked } });
  }
  handover(boxId: string, receiver: string, itemsInBox: Array<{ itemId: string; barcode: string; name: string; category: ItemCategory; damage: DamageGrade }>, at?: number) {
    const evidence: HandoverEvidence[] = itemsInBox;
    // 整箱交接是箱级操作，不设单一 itemId；各物品去向由 evidence/箱内成员决定
    this.add({ type: 'HANDOVER', operator: 't', boxId, receiver, evidence, at, detail: `交接 ${receiver}` });
  }
  returnBox(boxId: string, reason: string) {
    this.add({ type: 'RETURN', operator: 't', boxId, payload: { reason }, detail: `退回 ${reason}` });
  }
  revert(createUid: string, barcode: string) {
    this.add({ type: 'REVERT', operator: 't', itemId: refOf(this.pid, createUid), barcode, revertsUid: createUid });
  }

  /** 物化为 WorldData（items/boxes 由引擎重放产生） */
  build(): WorldData {
    const { canonical } = analyzeWorld([this.meta], this.ledger, this.orgs, this.logs);
    this.meta.seq = this.seq;
    return {
      meta: this.meta,
      ledger: this.ledger,
      organizations: this.orgs,
      boxes: canonical.boxes as Box[],
      items: canonical.items as Item[],
      logs: this.logs
    };
  }

  opKeys(): Set<string> {
    return new Set(this.logs.map((l) => opKey(l.projectId, l.uid)));
  }
}

export function locOf(w: WorldData, itemId: string): ItemLocation {
  const it = w.items.find((i) => i.itemId === itemId)!;
  return it.location;
}
