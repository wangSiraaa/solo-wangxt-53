/**
 * 合并验收端到端（node + fake-indexeddb）：
 *   npx vite-node scripts/merge-demo.ts
 * 演示：预览→部分裁决可暂停→重导同一包不重复→导入顺序无关→
 *       同码独立创建不加总→交接事实不被旧成色覆盖→双机构交接冻结双证据。
 */
import 'fake-indexeddb/auto';
import { deleteDb } from '../src/lib/db';
import { ensureMeta, listAll } from '../src/lib/actions';
import { commitMerge, previewFromText, saveAdjudication } from '../src/lib/merge-actions';
import { analyzeWorld, buildMergePreview, type WorldData } from '../src/lib/merge';
import { buildOtherSnapshot, buildSeedWorld, PID_LOCAL } from '../src/lib/seed';
import { installWorld } from '../src/test/helpers';
import type { OperationLog } from '../src/lib/types';

const line = (s = '') => console.log(s);

function summarize(preview: Awaited<ReturnType<typeof previewFromText>>['preview']) {
  line(`  新增操作 ${preview.newOpKeys.length}，完全相同跳过 ${preview.skippedDuplicateKeys.length}`);
  for (const c of preview.conflicts) {
    line(`  [${c.blocking ? '阻断' : '信息'}] ${c.kind} — ${c.title}`);
  }
}

line('========== 工程合并验收演示 ==========\n');

// —— 安装 P1 本机工程 ——
await deleteDb();
const { local, other } = buildSeedWorld();
await ensureMeta('本机仓库（P1）', PID_LOCAL);
await installWorld(local);
line(`① 本机 P1：${local.items.length} 件物品，${local.logs.length} 条操作`);
line(`   另一仓库 P2：${other.items.length} 件物品，${other.logs.length} 条操作（时钟与 P1 相差约一年）\n`);

// —— 第一次导入 P2：预览，不提交 ——
const pkg = buildOtherSnapshot();
line('② 第一次载入 P2 工程包（仅预览）：');
const first = await previewFromText(pkg);
summarize(first.preview);
line();

// —— 提交合并（不裁决，模拟暂停）——
line('③ 直接提交（冲突不裁决，保留为冻结/待裁决，可暂停）：');
await commitMerge(first.incoming, '李仓管', 'P2.json');
let d = await listAll();
line(`  合并后实体物品 ${d.items.length} 件（注意：独立身份未被自动加总/合并）`);
const frozen = d.items.filter((i) => i.frozen);
line(`  冻结物品 ${frozen.length} 件：${frozen.map((i) => `${i.barcode}(${i.frozenReason})`).join('；')}`);
line();

// —— 重复导入同一包：幂等 ——
line('④ 再次导入同一包：');
const second = await previewFromText(pkg);
line(`  新增操作 ${second.preview.newOpKeys.length}（应为 0），跳过 ${second.preview.skippedDuplicateKeys.length}`);
line(`  待裁决 ${second.preview.pendingCount} 项（已提交但未裁决，仍可继续；操作本身不重复）`);
line();

// —— 用户处理部分冲突：先裁决同码 6901001 为“同一实物” ——
line('⑤ 裁决同码 6901001 = 同一实物（两份记录留痕，库存归 1）：');
const collision = second.preview.conflicts.find((c) => c.kind === 'ITEM_COLLISION')!;
await saveAdjudication({
  key: collision.key,
  kind: 'ITEM_COLLISION',
  signature: collision.signature,
  by: '值班主管',
  decision: undefined as never,
  winner: collision.itemIds[0]!,
  loser: collision.itemIds[1]!
});
d = await listAll();
line(`  当前实体 ${d.items.length} 件；该条码裁决后身份合并`);

// 再次预览同一包：已裁决的同码碰撞消失，但该物升级为 DUAL_HANDOVER（含退回证据）
const third = await previewFromText(pkg);
const unresolved = third.preview.conflicts.filter((c) => c.blocking && !c.adjudication);
line(`  重导同一包：未决阻断项 ${unresolved.length}（已处理的同码碰撞不再出现；该物因两份交接证据升级为双机构核实）\n`);

// —— 交接事实不被旧成色覆盖（找信息项；本种子该物已升级为双机构冻结，故可能为 0）——
line('⑥ 交接事实优先级验证：');
{
  d = await listAll();
  const r = analyzeWorld([d.meta], d.ledger, d.orgs, d.logs);
  const stale = r.conflicts.filter((c) => c.kind === 'BLOCKED_STALE_GRADE');
  line(`  BLOCKED_STALE_GRADE 信息项 ${stale.length} 条（单一现存交接时出现；本种子因有退回已升级为双机构核实）`);
  for (const s of stale) line(`   · ${s.title}`);
}
line();

// —— 双重交接：同一实物两个机构（含其一已退回），冻结 + 双证据 ——
line('⑦ 双机构交接核实（同码裁决为同一实物后浮现，含已退回证据）：');
{
  d = await listAll();
  const r = analyzeWorld([d.meta], d.ledger, d.orgs, d.logs);
  const dual = r.conflicts.find((c) => c.kind === 'DUAL_HANDOVER');
  if (dual) {
    line(`  ${dual.title}`);
    for (const cl of dual.claims ?? []) line(`   证据：工程 ${cl.projectId} → ${cl.boxId}（${cl.receiver}，成色 ${cl.damage}）`);
    const it = r.canonical.items.find((i) => i.itemId === dual.itemIds[0]);
    line(`  物品冻结=${it?.frozen}，证据份数=${it?.handoverClaims?.length}`);
  }
}
line();

// —— 导入顺序无关（纯函数重放）——
line('⑧ 导入顺序无关性：');
{
  const ab = buildMergePreview(local as WorldData, other as WorldData);
  const ba = buildMergePreview(other as WorldData, local as WorldData);
  const norm = (items: { itemId: string; barcode: string; location: { kind: string; boxId?: string } }[]) =>
    items.map((i) => `${i.itemId}|${i.barcode}|${i.location.kind}${i.location.boxId ?? ''}`).sort();
  // 两种顺序下规范实体集合（身份数、条码、去向）一致
  const same = JSON.stringify(norm(ab.canonical.items)) === JSON.stringify(norm(ba.canonical.items));
  line(`  先P1后P2 与 先P2后P1 的规范状态一致：${same}`);
  line(`  关键：排序键是 (projectId, seq, uid)，at 时钟与文件顺序都不参与判定`);
}
line();

// —— 操作总数核对：完全相同的操作只生效一次 ——
{
  d = await listAll();
  const keys = d.logs.map((l: OperationLog) => `${l.projectId}#${l.uid}`);
  line(`⑨ 库内操作 ${d.logs.length} 条，去重后键 ${new Set(keys).size} 个（相等说明无重复导入）`);
}
line('\n演示完成。');
