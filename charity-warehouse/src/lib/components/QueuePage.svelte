<script lang="ts">
  import { state, operator, notify, refresh } from '../store';
  import { addReview, revertScan, scanBarcode } from '../actions';
  import type { Item, ItemCategory, DamageGrade } from '../types';
  import { CATEGORY_LABEL } from '../types';
  import ScanPanel from './ScanPanel.svelte';
  import DamageBadge from './DamageBadge.svelte';

  let busy = false;

  async function onScan(e: CustomEvent<{ barcode: string; draft: { name: string; category: ItemCategory; damage: DamageGrade; highValue: boolean } }>) {
    if (busy) return;
    busy = true;
    try {
      const r = await scanBarcode(e.detail.barcode, e.detail.draft, $operator);
      await refresh();
      if (r.outcome === 'duplicate') {
        const where =
          r.item.location.kind === 'queue'
            ? '正在【待装箱队列】中'
            : r.item.location.kind === 'box'
              ? `已在【箱 ${r.item.location.boxId}】内`
              : `已随【箱 ${r.item.location.boxId}】交接锁定`;
        notify('warn', `重复条码 ${e.detail.barcode}：已定位原物品「${r.item.name}」，${where}（第 ${r.item.scanCount} 次扫描），未新增库存`);
        locatedBarcode = r.item.barcode;
      } else {
        notify('ok', `已扫入新物品「${r.item.name}」(${e.detail.barcode})，进入待装箱队列`);
      }
    } catch (err) {
      notify('err', (err as Error).message);
    } finally {
      busy = false;
    }
  }

  let locatedBarcode = '';

  // —— 高价值复核 ——
  let reviewTarget: Item | null = null;
  let reviewVerdict: 'approved' | 'rejected' = 'approved';
  let reviewBy = '';
  let reviewNote = '';

  export function selectReview(item: Item) {
    reviewTarget = item;
    reviewVerdict = 'approved';
    reviewBy = $operator;
    reviewNote = '';
  }

  async function submitReview() {
    if (!reviewTarget) return;
    try {
      await addReview(reviewTarget.barcode, { by: reviewBy || $operator, verdict: reviewVerdict, note: reviewNote }, $operator);
      await refresh();
      reviewTarget = null;
      notify('ok', '复核记录已追加（历史复核保留，以最后一条结论为准）');
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  // —— 撤销尚未交接的连续扫码 ——
  async function undoScan(item: Item) {
    const creation = [...$state.logs].reverse().find((l) => (l.type === 'SCAN' || l.type === 'IMPORT') && l.barcode === item.barcode);
    if (!creation) {
      notify('err', '找不到对应的扫码日志');
      return;
    }
    try {
      await revertScan(creation.id, $operator);
      await refresh();
      notify('ok', `已撤销扫码 ${item.barcode}（追加 REVERT 记录，日志行保留）`);
    } catch (e) {
      notify('err', `撤销被阻止：${(e as Error).message}`);
    }
  }

  $: queueItems = $state.items.filter((i) => i.location.kind === 'queue');
  $: revertedBarcodes = new Set($state.logs.filter((l) => l.type === 'REVERT').map((l) => l.barcode));
</script>

<div class="page">
  <h2>扫码队列（边评估成色边装箱）</h2>
  <ScanPanel on:scan={onScan} />

  <h3>待装箱队列（{queueItems.length} 件）</h3>
  <table>
    <thead>
      <tr><th>条码</th><th>名称</th><th>品类</th><th>成色</th><th>高价值/复核</th><th>扫入时间</th><th>操作</th></tr>
    </thead>
    <tbody>
      {#each queueItems as item (item.barcode)}
        <tr class:located={locatedBarcode === item.barcode}>
          <td class="mono">{item.barcode}</td>
          <td>{item.name}</td>
          <td>{CATEGORY_LABEL[item.category]}</td>
          <td><DamageBadge grade={item.damage} /></td>
          <td>
            {#if item.highValue}
              {#if item.reviews.length === 0}
                <button class="mini warn" on:click={() => selectReview(item)}>待复核…</button>
              {:else}
                {@const last = item.reviews[item.reviews.length - 1]}
                <button class="mini {last.verdict === 'approved' ? 'ok' : 'bad'}" on:click={() => selectReview(item)}>
                  {last.verdict === 'approved' ? `✔ ${last.by}` : `✘ ${last.by}`}（{item.reviews.length}）
                </button>
              {/if}
            {:else}
              <span class="muted">—</span>
            {/if}
          </td>
          <td class="muted small">{new Date(item.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })}</td>
          <td>
            <button
              class="mini"
              title="仅可撤销仍在队列、且其后没有复核记录的扫码；复核记录绝不被误删"
              on:click={() => undoScan(item)}
              disabled={revertedBarcodes.has(item.barcode)}
            >撤销扫码</button>
          </td>
        </tr>
      {#if queueItems.length === 0}
        <tr><td colspan="7" class="empty">队列为空 —— 扫码、键盘录入或文件导入后在此评估成色与复核</td></tr>
      {/if}
      {/each}
    </tbody>
  </table>
</div>

{#if reviewTarget}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions a11y-no-static-element-interactions -->
  <div class="modal-mask" on:click={() => (reviewTarget = null)} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="高价值复核">
      <h3>高价值复核：{reviewTarget.name}（{reviewTarget.barcode}）</h3>
      {#if reviewTarget.reviews.length > 0}
        <div class="history">
          <div class="muted small">历史复核（全部保留，撤销扫码也不会删除这些记录）：</div>
          {#each reviewTarget.reviews as r}
            <div class="small">{new Date(r.at).toLocaleString('zh-CN', { hour12: false })} · {r.by} · {r.verdict === 'approved' ? '通过' : '不通过'}{r.note ? ' · ' + r.note : ''}</div>
          {/each}
        </div>
      {/if}
      <label>复核人 <input bind:value={reviewBy}></label>
      <label>结论
        <select bind:value={reviewVerdict}>
          <option value="approved">通过 —— 可装箱</option>
          <option value="rejected">不通过 —— 禁止装箱</option>
        </select>
      </label>
      <label class="full">备注 <input bind:value={reviewNote} placeholder="成色/估值/瑕疵说明"></label>
      <div class="modal-actions">
        <button on:click={() => (reviewTarget = null)}>取消</button>
        <button class="primary" on:click={submitReview}>追加复核记录</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { display: flex; flex-direction: column; gap: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #d5d8dc; padding: 6px 9px; text-align: left; }
  th { background: #f8f9f9; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #888; }
  .small { font-size: 12px; }
  .empty { text-align: center; color: #888; padding: 14px; }
  tr.located { background: #fef9e7; }
  tr.located td:first-child { box-shadow: inset 3px 0 0 #d4ac0d; }
  .mini { font-size: 12px; padding: 3px 9px; cursor: pointer; }
  .mini.ok { background: #d5f5e3; border-color: #27ae60; }
  .mini.bad { background: #fadbd8; border-color: #c0392b; }
  .mini.warn { background: #fdebd0; border-color: #e67e22; }
  .modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 30; }
  .modal { background: #fff; padding: 20px; border-radius: 10px; min-width: 440px; max-width: 560px; display: flex; flex-direction: column; gap: 10px; }
  .modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .modal label.full { grid-column: 1 / -1; }
  .modal input, .modal select { padding: 7px; }
  .history { background: #f8f9f9; border: 1px solid #e5e7e9; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 3px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
