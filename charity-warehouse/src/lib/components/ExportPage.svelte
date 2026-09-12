<script lang="ts">
  import { state, refresh, reseed, wipe, notify } from '../store';
  import { buildHandedManifest, buildPendingManifest } from '../manifest';
  import { atomic, openDb } from '../db';
  import { buildSnapshot, download } from '../io';
  import type { StoreName } from '../db';
  import type { Box } from '../types';

  const STORE_NAMES: StoreName[] = ['organizations', 'items', 'boxes', 'logs'];

  $: pendingBoxes = $state.boxes.filter((b) => b.status === 'open');
  $: handedBoxes = $state.boxes.filter((b) => b.status === 'handed');
  $: returnedBoxes = $state.boxes.filter((b) => b.returnedAt);

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
    download(`工程快照-${stamp()}.json`, buildSnapshot({ orgs: $state.orgs, items: $state.items, boxes: $state.boxes, logs: $state.logs }), 'application/json');
  }

  async function importSnapshot(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'charity-warehouse/v1' || !parsed.payload) {
        throw new Error('不是本系统导出的工程快照');
      }
      const p = parsed.payload;
      await openDb();
      await atomic(STORE_NAMES, 'readwrite', (s) => {
        for (const name of STORE_NAMES) s[name].clear();
        for (const o of p.orgs ?? []) s.organizations.put(o);
        for (const b of p.boxes ?? []) s.boxes.put(b);
        for (const it of p.items ?? []) s.items.put(it);
        for (const l of p.logs ?? []) s.logs.put(l);
      });
      await refresh();
      notify('ok', '工程快照已恢复');
    } catch (err) {
      notify('err', `快照恢复失败：${(err as Error).message}`);
    }
    (e.target as HTMLInputElement).value = '';
  }

  async function doReseed() {
    await reseed();
    notify('ok', '已重置为演示数据');
  }
  async function doWipe() {
    if (!confirm('确定清空全部本地数据（机构/物品/箱/日志）？此操作不可恢复。')) return;
    await wipe();
    notify('warn', '本地数据已清空');
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

  {#if returnedBoxes.length}
    <p class="warn small">曾退回修正的箱：{returnedBoxes.map((b) => `${b.label}（${b.returnReason}）`).join('；')}</p>
  {/if}

  <section class="card">
    <h3>工程快照（可在另一台离线电脑重新打开整个工程）</h3>
    <p class="muted small">包含机构、物品、箱与完整操作日志（含已交接锁定记录与 REVERT 补偿记录）。</p>
    <div class="row">
      <button on:click={exportSnapshot}>导出工程快照 JSON</button>
      <label class="file">恢复工程快照
        <input type="file" accept=".json" on:change={importSnapshot}>
      </label>
    </div>
  </section>

  <section class="card danger">
    <h3>演示数据</h3>
    <div class="row">
      <button on:click={doReseed}>重置为演示数据</button>
      <button class="danger-btn" on:click={doWipe}>清空全部本地数据</button>
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
  .warn { color: #b7791f; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .file { padding: 6px 12px; border: 1px solid #888; border-radius: 4px; cursor: pointer; background: #f4f6f7; }
  .file input { display: none; }
  .danger-btn { background: #c0392b; color: #fff; border: none; padding: 7px 14px; border-radius: 4px; cursor: pointer; }
</style>
