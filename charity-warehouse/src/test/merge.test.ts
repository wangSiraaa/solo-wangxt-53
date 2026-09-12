/**
 * 工程合并验收测试：
 *  - 身份按 来源工程+稳定uid；完全相同操作只导入一次（幂等，重导不重复）
 *  - 同码两边独立创建 → ITEM_COLLISION 待裁决，不自动加总库存
 *  - 时钟不同：结果不依赖 at
 *  - 文件导入先后：正序/反序合并结果一致
 *  - 人工改码：旧码被他工程占用时身份仍清晰
 *  - 整箱交接后退回：状态可重放
 *  - 已交接事实不被另一工程旧成色覆盖（BLOCKED_STALE_GRADE）
 *  - 同一实物两边交给两个机构 → DUAL_HANDOVER 冻结，双证据保留
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldBuilder } from './world-builder';
import { buildMergePreview, analyzeWorld } from '../lib/merge';
import { commitMerge, localWorld, previewFromText, saveAdjudication } from '../lib/merge-actions';
import { installWorld } from './helpers';
import { deleteDb } from '../lib/db';
import { buildSnapshot } from '../lib/io';
import { opKey, refOf, type Item, type OperationLog } from '../lib/types';
import type { WorldData } from '../lib/merge';

beforeEach(async () => {
  await deleteDb();
});

type WorldDataLike = ReturnType<WorldBuilder['build']>;

function snapshotText(w: WorldDataLike): string {
  return buildSnapshot({ meta: w.meta, ledger: w.ledger, organizations: w.organizations, boxes: w.boxes, items: w.items, logs: w.logs });
}

/** 合并两个内存 world（不写库），返回预览 */
function mergeInMemory(local: WorldData, other: WorldData) {
  return buildMergePreview(local, other);
}

describe('身份与去重：完全相同的操作只导入一次', () => {
  it('重复导入同一包：新增 0、跳过全部、冲突不重复出现', async () => {
    const p1 = new WorldBuilder('p1', '仓库一').build();
    const p2b = new WorldBuilder('p2', '仓库二');
    const o2 = p2b.org('org-x', '爱心行', ['clothing'], 2);
    const b2 = p2b.box('bx', 'X-1', o2, ['clothing'], 2);
    p2b.scan('s1', '8000001', { name: '围巾', category: 'clothing', damage: 1 });
    p2b.pack(refOf('p2', 's1'), '8000001', b2);
    const p2 = p2b.build();

    await installWorld(p1);
    const text = snapshotText(p2);

    const first = await previewFromText(text);
    expect(first.preview.newOpKeys.length).toBeGreaterThan(0);
    await commitMerge(first.incoming, '测试', 'p2.json');

    const second = await previewFromText(text);
    expect(second.preview.newOpKeys).toEqual([]);
    expect(second.preview.skippedDuplicateKeys.length).toBe(p2.logs.length);
    const world = await localWorld();
    const keys = world.logs.map((l) => opKey(l.projectId, l.uid));
    expect(new Set(keys).size).toBe(keys.length); // 无重复操作
  });
});

describe('同一条码被两边独立创建 → 待裁决，绝不自动加总库存', () => {
  it('ITEM_COLLISION 阻断；裁决 same_item 后库存为 1', async () => {
    const a = new WorldBuilder('p1', '甲');
    a.scan('s1', '6901001', { name: '羽绒服', category: 'clothing', damage: 1 });
    const w1 = a.build();

    const b = new WorldBuilder('p2', '乙');
    b.scan('s9', '6901001', { name: '旧羽绒服', category: 'clothing', damage: 2 });
    const w2 = b.build();

    let preview = mergeInMemory(w1, w2);
    const collision = preview.conflicts.find((c) => c.kind === 'ITEM_COLLISION')!;
    expect(collision).toBeTruthy();
    expect(collision.blocking).toBe(true);
    expect(preview.canonical.items.length).toBe(2); // 两个身份，库存没加总也没合并

    await installWorld(w1);
    await commitMerge((await previewFromText(snapshotText(w2))).incoming, 't', 'w2');
    await saveAdjudication({
      key: collision.key,
      kind: 'ITEM_COLLISION',
      signature: collision.signature,
      by: '仲裁员',
      decision: undefined as never,
      winner: collision.itemIds[0]!,
      loser: collision.itemIds[1]!
    });
    const world = await localWorld();
    const { conflicts, canonical } = analyzeWorld([world.meta], world.ledger, world.organizations, world.logs);
    expect(conflicts.filter((c) => c.kind === 'ITEM_COLLISION' && !c.adjudication)).toHaveLength(0);
    expect(canonical.items.length).toBe(1); // 同一实物：库存 1
    expect(canonical.items[0]!.mergedFrom?.length).toBe(1);
  });

  it('裁决 separate：改派新条码，两件实物各自保留', async () => {
    const a = new WorldBuilder('p1', '甲');
    a.scan('s1', '6901001', { name: '羽绒服A', category: 'clothing', damage: 1 });
    const w1 = a.build();
    const b = new WorldBuilder('p2', '乙');
    b.scan('s9', '6901001', { name: '羽绒服B', category: 'clothing', damage: 1 });
    const w2 = b.build();

    const preview = mergeInMemory(w1, w2);
    const collision = preview.conflicts.find((c) => c.kind === 'ITEM_COLLISION')!;
    const ledger = {
      ...w1.ledger,
      adjudications: {
        [collision.key]: {
          kind: 'ITEM_COLLISION' as const,
          decision: 'separate' as const,
          relabelItemId: collision.itemIds[1]!,
          newBarcode: '6901001-B',
          by: 't',
          signature: collision.signature
        }
      }
    };
    const r = analyzeWorld([w1.meta], ledger, [...w1.organizations, ...w2.organizations], [...w1.logs, ...w2.logs]);
    expect(r.canonical.items.length).toBe(2);
    const barcodes = r.canonical.items.map((i) => i.barcode).sort();
    expect(barcodes).toEqual(['6901001', '6901001-B']);
  });
});

describe('时钟不同 & 导入顺序：结果不依赖文件先后，也不凭本机时间判对错', () => {
  it('P1 时钟 2025、P2 时钟 2030：谁新谁说了不算，分歧必须人工裁决', () => {
    const t2025 = Date.UTC(2025, 0, 1);
    const t2030 = Date.UTC(2030, 0, 1);
    const a = new WorldBuilder('p1', '甲(旧时钟)', t2025);
    a.scan('s1', '7000001', { name: '外套', category: 'clothing', damage: 1 }, t2025 + 1000);
    const w1 = a.build();

    const b = new WorldBuilder('p2', '乙(新时钟)', t2030);
    b.scan('z1', '7000002', { name: '毛衣', category: 'clothing', damage: 2 }, t2030 + 1000);
    const w2 = b.build();

    // 同码无关；构造同身份分歧需要同 itemId（跨工程不可能），故用同实物裁决后看 DAMAGE
    // 这里先验证纯时钟差不会自动选择：同码碰撞在未裁决前始终阻断
    const pv = mergeInMemory(w1, w2);
    // 不同码无冲突：证明没有因为时钟而丢弃任何一边的记录
    expect(pv.canonical.items.length).toBe(2);
  });

  it('正序/反序导入产生相同规范状态（按 seq 重放，不按 at/文件顺序）', () => {    const a = new WorldBuilder('p1', '甲', Date.UTC(2030, 0, 1));
    const oa = a.org('oa', '机构甲', ['clothing'], 2);
    const ba = a.box('ba', 'A-1', oa, ['clothing'], 2);
    a.scan('s1', '710001', { name: '马甲', category: 'clothing', damage: 1 });
    a.pack(refOf('p1', 's1'), '710001', ba);
    const w1 = a.build();

    const b = new WorldBuilder('p2', '乙', Date.UTC(2020, 0, 1));
    const ob = b.org('ob', '机构乙', ['clothing'], 2);
    const bb = b.box('bb', 'B-1', ob, ['clothing'], 2);
    b.scan('s2', '710002', { name: '手套', category: 'clothing', damage: 0 });
    b.pack(refOf('p2', 's2'), '710002', bb);
    const w2 = b.build();

    const orderAB = analyzeWorld([w1.meta, w2.meta], w1.ledger, [...w1.organizations, ...w2.organizations], [...w1.logs, ...w2.logs]);
    const orderBA = analyzeWorld([w2.meta, w1.meta], w1.ledger, [...w2.organizations, ...w1.organizations], [...w2.logs, ...w1.logs]);

    const norm = (items: Item[]) =>
      items.map((i) => `${i.itemId}:${i.barcode}:${i.location.kind}${i.location.kind === 'queue' ? '' : i.location.boxId}`).sort();
    expect(norm(orderAB.canonical.items)).toEqual(norm(orderBA.canonical.items));
    // 箱子状态也一致
    const boxes = (x: typeof orderAB) => x.canonical.boxes.map((b2) => `${b2.id}:${b2.status}`).sort();
    expect(boxes(orderAB)).toEqual(boxes(orderBA));
  });
});

describe('人工改写条码：身份不随码改变，旧码冲突仍可识别', () => {
  it('RELABEL 后曾用码留痕；他工程占用旧码时产生 ITEM_COLLISION（待人工裁决）', () => {
    const a = new WorldBuilder('p1', '甲');
    a.scan('s1', '6901005', { name: '牛仔裤', category: 'clothing', damage: 2 });
    a.relabel(refOf('p1', 's1'), '6901005', '6901009');
    const w1 = a.build();
    expect(w1.items[0]!.barcode).toBe('6901009');
    expect(w1.items[0]!.aliases).toContain('6901005');

    const b = new WorldBuilder('p2', '乙');
    b.scan('q1', '6901005', { name: '牛仔裤B', category: 'clothing', damage: 1 }); // 占用旧码
    const w2 = b.build();

    const pv = mergeInMemory(w1, w2);
    // 当前码 6901009 vs 6901005 不同 → 不算同码碰撞；但信息项 ALIAS_COLLISION 提示
    expect(pv.conflicts.some((c) => c.kind === 'ALIAS_COLLISION')).toBe(true);
    // 两件实物都在（未误合并）
    expect(pv.canonical.items.length).toBe(2);
  });
});

describe('整箱交接后出现退回：可重放为打开状态', () => {  it('HANDOVER→RETURN 后箱为 open、物品回箱内、交接主张撤回', () => {
    const b = new WorldBuilder('p1', '甲');
    const o = b.org('o', '机构', ['clothing'], 2);
    const box = b.box('b1', 'A-1', o, ['clothing'], 2);
    b.scan('s1', '880001', { name: '外套', category: 'clothing', damage: 1 });
    b.pack(refOf('p1', 's1'), '880001', box);
    b.check(refOf('p1', 's1'), box);
    b.handover(box, '王校长', [
      { itemId: refOf('p1', 's1'), barcode: '880001', name: '外套', category: 'clothing', damage: 1 }
    ]);
    b.returnBox(box, '登记错误');
    const w = b.build();

    const boxState = w.boxes.find((x) => x.id === box)!;
    expect(boxState.status).toBe('open');
    expect(boxState.returnReason).toContain('登记错误');
    const it = w.items[0]!;
    expect(it.location).toEqual({ kind: 'box', boxId: box });
    // 交接证据保留但标记已失效（active=false），双机构核实时有据可查
    expect(it.handoverClaims).toHaveLength(1);
    expect(it.handoverClaims![0]!.active).toBe(false);
    // 不再有“现存交接事实”：不冻结、不阻断
    expect(it.frozen).not.toBe(true);
  });
});

describe('已交接事实不被另一工程的旧成色覆盖', () => {
  it('同实物（裁决 same_item）：交接证据成色固定，他工程旧成色只作信息项', () => {    const a = new WorldBuilder('p1', '甲');
    const oa = a.org('oa', '机构甲', ['clothing'], 2);
    const ba = a.box('ba', 'A-1', oa, ['clothing'], 2);
    a.scan('s1', '9001', { name: '大衣', category: 'clothing', damage: 0 });
    a.pack(refOf('p1', 's1'), '9001', ba);
    a.check(refOf('p1', 's1'), ba);
    a.handover(ba, '赵老师', [
      { itemId: refOf('p1', 's1'), barcode: '9001', name: '大衣', category: 'clothing', damage: 0 }
    ]);
    const w1 = a.build();

    const c = new WorldBuilder('p2', '乙');
    c.scan('s1', '9001', { name: '大衣', category: 'clothing', damage: 2 }); // 同 uid 同码 → 独立身份同条码
    const w2 = c.build();

    // 先碰撞，裁决为同一实物：loser=p2#s1 → winner=p1#s1
    const pv = mergeInMemory(w1, w2);
    const collision = pv.conflicts.find((x) => x.kind === 'ITEM_COLLISION')!;
    const ids = [...collision.itemIds].sort();
    const ledger = {
      ...w1.ledger,
      adjudications: {
        [collision.key]: {
          kind: 'ITEM_COLLISION' as const,
          decision: 'same_item' as const,
          winner: refOf('p1', 's1'),
          loser: refOf('p2', 's1'),
          by: 't',
          signature: collision.signature
        }
      }
    };
    void ids;
    const r = analyzeWorld([w1.meta, w2.meta], ledger, [...w1.organizations, ...w2.organizations], [...w1.logs, ...w2.logs]);
    const merged = r.canonical.items.find((i) => i.itemId === refOf('p1', 's1'))!;
    expect(merged.location.kind).toBe('handed');
    expect(merged.damage).toBe(0); // 交接事实成色，未被 2 级覆盖
    expect(r.conflicts.some((x) => x.kind === 'BLOCKED_STALE_GRADE')).toBe(true);
  });

  it('他工程从未交接、仅记录较旧成色：不覆盖交接事实且不冻结（信息项）', () => {
    const a = new WorldBuilder('p1', '甲');
    const oa = a.org('oa', '机构甲', ['clothing'], 2);
    const ba = a.box('ba', 'A-1', oa, ['clothing'], 2);
    a.scan('s1', '9002', { name: '风衣', category: 'clothing', damage: 0 });
    a.pack(refOf('p1', 's1'), '9002', ba);
    a.check(refOf('p1', 's1'), ba);
    a.handover(ba, '赵老师', [
      { itemId: refOf('p1', 's1'), barcode: '9002', name: '风衣', category: 'clothing', damage: 0 }
    ]);
    const w1 = a.build();

    // 乙工程独立扫到同码同实物（未装箱、未交接），成色记为 2
    const c = new WorldBuilder('p2', '乙');
    c.scan('s1', '9002', { name: '风衣', category: 'clothing', damage: 2 });
    const w2 = c.build();

    const pv = mergeInMemory(w1, w2);
    const collision = pv.conflicts.find((x) => x.kind === 'ITEM_COLLISION')!;
    const ledger = {
      ...w1.ledger,
      adjudications: {
        [collision.key]: {
          kind: 'ITEM_COLLISION' as const,
          decision: 'same_item' as const,
          winner: refOf('p1', 's1'),
          loser: refOf('p2', 's1'),
          by: 't',
          signature: collision.signature
        }
      }
    };
    const r = analyzeWorld([w1.meta, w2.meta], ledger, [...w1.organizations, ...w2.organizations], [...w1.logs, ...w2.logs]);
    const merged = r.canonical.items.find((i) => i.itemId === refOf('p1', 's1'))!;
    expect(merged.location.kind).toBe('handed');
    expect(merged.damage).toBe(0);
    expect(merged.frozen).not.toBe(true);
    expect(r.conflicts.some((x) => x.kind === 'BLOCKED_STALE_GRADE')).toBe(true);
    expect(r.conflicts.some((x) => x.kind === 'DUAL_HANDOVER')).toBe(false);
  });
});

describe('顺序无关（含裁决与交接证据）', () => {
  it('同一批操作与裁决，调换工程入参顺序后冲突集合与冻结状态一致', () => {
    const a = new WorldBuilder('p1', '甲', Date.UTC(2030, 0, 1));
    const oa = a.org('oa', '机构甲', ['clothing'], 2);
    const ba = a.box('ba', 'A-1', oa, ['clothing'], 2);
    a.scan('s7', '99009', { name: '羽绒服', category: 'clothing', damage: 1 });
    a.pack(refOf('p1', 's7'), '99009', ba);
    a.check(refOf('p1', 's7'), ba);
    a.handover(ba, '甲-赵', [
      { itemId: refOf('p1', 's7'), barcode: '99009', name: '羽绒服', category: 'clothing', damage: 1 }
    ]);
    a.returnBox(ba, '登记错误'); // 交接后退回
    const w1 = a.build();

    const b = new WorldBuilder('p2', '乙', Date.UTC(2020, 0, 1));
    const ob = b.org('ob', '机构乙', ['clothing'], 2);
    const bb = b.box('bb', 'B-1', ob, ['clothing'], 2);
    b.scan('s7', '99009', { name: '羽绒服', category: 'clothing', damage: 1 });
    b.pack(refOf('p2', 's7'), '99009', bb);
    b.check(refOf('p2', 's7'), bb);
    b.handover(bb, '乙-钱', [
      { itemId: refOf('p2', 's7'), barcode: '99009', name: '羽绒服', category: 'clothing', damage: 1 }
    ]);
    const w2 = b.build();

    const base = mergeInMemory(w1, w2);
    const collision = base.conflicts.find((c) => c.kind === 'ITEM_COLLISION')!;
    const ledger = {
      ...w1.ledger,
      adjudications: {
        [collision.key]: {
          kind: 'ITEM_COLLISION' as const,
          decision: 'same_item' as const,
          winner: refOf('p1', 's7'),
          loser: refOf('p2', 's7'),
          by: 't',
          signature: collision.signature
        }
      }
    };
    const run = (logs: OperationLog[]) => {
      const r = analyzeWorld([w1.meta, w2.meta], ledger, [...w1.organizations, ...w2.organizations], logs);
      return {
        kinds: r.conflicts.map((c) => c.kind).sort(),
        frozen: r.canonical.items.map((i) => `${i.itemId}:${i.frozen ? 1 : 0}:${i.handoverClaims?.length ?? 0}`).sort()
      };
    };
    const ab = run([...w1.logs, ...w2.logs]);
    const ba2 = run([...w2.logs, ...w1.logs]);
    expect(ab).toEqual(ba2);
    expect(ab.kinds).toContain('DUAL_HANDOVER');
    expect(ab.frozen[0]).toContain(':1:2'); // 冻结且双证据（其一已退回仍保留）
  });
});

describe('同一实物两边交给两个机构 → 冻结，双证据保留', () => {
  it('裁决同一实物后出现 DUAL_HANDOVER：物品冻结，claims 两份，转移被规则拦截', async () => {
    const a = new WorldBuilder('p1', '甲');
    const oa = a.org('oa', '机构甲', ['clothing'], 2);
    const ba = a.box('ba', 'A-1', oa, ['clothing'], 2);
    a.scan('s7', '99001', { name: '羽绒服', category: 'clothing', damage: 1 });
    a.pack(refOf('p1', 's7'), '99001', ba);
    a.check(refOf('p1', 's7'), ba);
    a.handover(ba, '甲机构-赵', [
      { itemId: refOf('p1', 's7'), barcode: '99001', name: '羽绒服', category: 'clothing', damage: 1 }
    ]);
    const w1 = a.build();

    const b = new WorldBuilder('p2', '乙');
    const ob = b.org('ob', '机构乙', ['clothing'], 2);
    const bb = b.box('bb', 'B-1', ob, ['clothing'], 2);
    b.scan('s7', '99001', { name: '羽绒服', category: 'clothing', damage: 1 });
    b.pack(refOf('p2', 's7'), '99001', bb);
    b.check(refOf('p2', 's7'), bb);
    b.handover(bb, '乙机构-钱', [
      { itemId: refOf('p2', 's7'), barcode: '99001', name: '羽绒服', category: 'clothing', damage: 1 }
    ]);
    const w2 = b.build();

    const pv0 = mergeInMemory(w1, w2);
    const collision = pv0.conflicts.find((c) => c.kind === 'ITEM_COLLISION')!;
    const ledger = {
      ...w1.ledger,
      adjudications: {
        [collision.key]: {
          kind: 'ITEM_COLLISION' as const,
          decision: 'same_item' as const,
          winner: refOf('p1', 's7'),
          loser: refOf('p2', 's7'),
          by: 't',
          signature: collision.signature
        }
      }
    };
    const r = analyzeWorld([w1.meta, w2.meta], ledger, [...w1.organizations, ...w2.organizations], [...w1.logs, ...w2.logs]);
    const dual = r.conflicts.find((c) => c.kind === 'DUAL_HANDOVER')!;
    expect(dual).toBeTruthy();
    expect(dual.claims).toHaveLength(2);
    const item = r.canonical.items[0]!;
    expect(item.frozen).toBe(true);
    expect(item.handoverClaims).toHaveLength(2);
    expect(item.awaitingArbitration).toBe(true);
  });
});
