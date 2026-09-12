<script lang="ts">
  import { state, refresh, wipe, notify } from '../store';
  import { ensureMeta } from '../actions';
  import { buildHandedManifest, buildPendingManifest } from '../manifest';
  import { openDb } from '../db';
  import { buildSnapshot, download } from '../io';
  import { buildOtherSnapshot } from '../seed';
  import { previewFromText, commitMerge } from '../merge-actions';
  import type { Box } from '../types';

  $: pendingBoxes = $state.boxes.filter((b) => b.status === 'open');
  $: handedBoxes = $state.boxes.filter((b) => b.status === 'handed');
  $: returnedBoxes = $state.boxes.filter((b) => b.returnedAt);
  $: frozenItems = $state.items.filter((i) => i.frozen);

  function stamp(): string {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  }

  function exportPending() {
    download(`清单-待交接-${stamp()}.html`, buildPendingManifest($state.boxes, $state.items, $state.orgs), 'text/html;charset=utf-8');
  }
  function exportHanded() {
    download(`清单-已交接-${stamp()}.html`, buildHandedManifest($state.boxes, $state.items, $state.orgs), 'text/html;charset=utf-8');
  }
  function exportSnapshot() {
    download(
      `工程快照-${$state.meta?.projectId ?? 'x'}-${stamp()}.json`,
      buildSnapshot({ meta: $state.meta, ledger: $state.ledger, organizations: $state.orgs, items: $state.items, boxes: $state.boxes, logs: $state.logs }),
      'application/json'
    );
  }

  function exportDemoOther() {
    download('工程快照-城南分拣点P2-演示.json', buildOtherSnapshot(), 'application/json');
  }

  async function restoreSnapshot(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      // 恢复 = 把快照当作“另一个工程”原样装库（projectId 相同则直接整体替换）
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.format !== 'charity-warehouse/v2' || !parsed.payload?.meta) throw new Error('不是 v2 工程快照');
      const p = parsed.payload;
      await openDb();
      const { replaceWorld } = await import('../actions');
      await replaceWorld(
        { organizations: p.organizations ?? [], boxes: p.boxes ?? [], items: p.items ?? [], logs: p.logs ?? [] },
        p.ledger ?? { key: 'ledger', ingested: {}, adjudications: {}, packages: {} }
      );
      // 恢复的 meta 单独写入
      const { atomic } = await import('../db');
      await atomic(['meta'], 'readwrite', (s) => {
        s.meta.put(p.meta);
      });
      await refresh();
      notify('ok', '工程快照已恢复（整个工程可在本机重新打开）');
    } catch (err) {
      notify('err', `快照恢复失败：${(err as Error).message}`);
    }
    (e.target as HTMLInputElement).value = '';
  }

  /** 一键演示：先清空再用 P1 播种，然后把 P2 合并进来（保留全部冲突供观察） */
  async function quickDemoMerge() {
    try {
      const text = buildOtherSnapshot();
      const { incoming } = await previewFromText(text);
      await commitMerge(incoming, '演示员', '城南分拣点P2-演示.json');
      await refresh();
      notify('ok', '已把 P2 城南分拣点并入本工程：可到「工程合并」页查看并裁决冲突');
    } catch (err) {
      notify('err', (err as Error).message);
    }
  }

  async function doWipe() {
    if (!confirm('确定清空全部本地数据并重建空工程？')) return;
    await wipe();
    await ensureMeta('本机仓库');
    await refresh();
    notify('warn', '本地数据已清空，已创建新工程');
  }

  function boxIds(boxes: Box[]): string {
    return boxes.map((b) => b.label).join('、') || '无';
  }
</script>

<div class="page">
  <h2>交接清单与工程导出</h2>

  <div class="cols">
    <section class="card pending">
      <h3>待交接（可编辑）</h3>
      <p class="big">{pendingBoxes.length} 箱</p>
      <p class="muted small">{boxIds(pendingBoxes)}</p>
      <button class="primary" on:click={exportPending}>导出待交接清单 HTML</button>
    </section>
    <section class="card handed">
      <h3>已交接（锁定存档）</h3>
      <p class="big">{handedBoxes.length} 箱</p>
      <p class="muted small">{boxIds(handedBoxes)}</p>
      <button class="primary" on:click={exportHanded}>导出已交接清单 HTML</button>
    </section>
  </div>

  {#if frozenItems.length}
    <p class="warn small">⛔ {frozenItems.length} 件因合并冲突冻结：{frozenItems.map((i) => i.barcode).join('、')}（见工程合并页）</p>
  {/if}
  {#if returnedBoxes.length}
    <p class="warn small">曾退回修正的箱：{returnedBoxes.map((b) => `${b.label}（${b.returnReason}）`).join('；')}</p>
  {/if}

  <section class="card">
    <h3>工程快照 v2（可在另一台离线电脑重新打开 / 参与合并）</h3>
    <p class="muted small">
      包含工程元信息（projectId）、合并台账（已导入操作/裁决）、机构、物品、箱、全部操作日志（稳定 uid + seq）。
      本工程：{$state.meta?.projectName} <span class="mono">{$state.meta?.projectId}</span>
    </p>
    <div class="row">
      <button on:click={exportSnapshot}>导出本工程快照 JSON</button>
      <label class="file">恢复工程快照（整体替换）
        <input type="file" accept=".json" on:change={restoreSnapshot}>
      </label>
    </div>
  </section>

  <section class="card">
    <h3>合并验收演示</h3>
    <div class="row">
      <button on:click={exportDemoOther}>下载“另一个仓库 P2”快照</button>
      <button class="primary" on:click={quickDemoMerge}>一键并入 P2（含时钟不同/改码/交接后退回/双重交接）</button>
    </div>
    <p class="muted small">P2 与本工程时钟相差约一年；并入后到「工程合并」页预览、逐项裁决、暂停、重复导入验证幂等。</p>
  </section>

  <section class="card danger">
    <h3>本地数据</h3>
    <div class="row">
      <button class="danger-btn" on:click={doWipe}>清空全部本地数据并重建空工程</button>
    </div>
  </section>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 14px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  .card { border: 1px solid #cfd4d8; border-radius: 8px; padding: 14px 16px; background: #fff; }
  .card.pending { border-top: 4px solid #b7791f; }
  .card.handed { border-top: 4px solid #1e8449; }
  .card.danger { border-color: #e6b0aa; }
  h3 { margin: 0 0 8px; font-size: 15px; }
  .big { font-size: 26px; font-weight: bold; margin: 4px 0; }
  .muted { color: #777; }
  .small { font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; }
  .warn { color: #b7791f; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .file { padding: 6px 12px; border: 1px solid #888; border-radius: 4px; cursor: pointer; background: #f4f6f7; }
  .file input { display: none; }
  .danger-btn { background: #c0392b; color: #fff; border: none; padding: 7px 14px; border-radius: 4px; cursor: pointer; }
</style>
