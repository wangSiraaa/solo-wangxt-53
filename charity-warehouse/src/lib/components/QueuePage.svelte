<script lang="ts">
  import { state, operator, notify, refresh } from '../store';
  import { gradeItem, relabelItem, addReview, revertScan, scanBarcode } from '../actions';
  import type { Item, ItemCategory, DamageGrade } from '../types';
  import { CATEGORY_LABEL } from '../types';
  import ScanPanel from './ScanPanel.svelte';
  import DamageBadge from './DamageBadge.svelte';

  let busy = false;
  let locatedItemId = '';

  async function onScan(e: CustomEvent<{ barcode: string; draft: { name: string; category: ItemCategory; damage: DamageGrade; highValue: boolean } }>) {
    if (busy) return;
    busy = true;
    try {
      const r = await scanBarcode(e.detail.barcode, e.detail.draft, $operator);
      await refresh();
      if (r.outcome === 'duplicate') {
        const where =
          r.item.location.kind === 'queue' ? '正在【待装箱队列】中'
            : r.item.location.kind === 'box' ? `已在【箱 ${boxLabel(r.item.location.boxId)}】内`
              : `已随【箱 ${boxLabel(r.item.location.boxId)}】交接锁定`;
        notify('warn', `重复条码 ${e.detail.barcode}：定位原物品「${r.item.name}」，${where}（第 ${r.item.scanCount} 次扫描），未新增库存`);
        locatedItemId = r.item.itemId;
      } else {
        notify('ok', `已扫入新物品「${r.item.name}」(${e.detail.barcode})，进入待装箱队列`);
      }
    } catch (err) {
      notify('err', (err as Error).message);
    } finally {
      busy = false;
    }
  }

  function boxLabel(boxId: string): string {
    return $state.boxes.find((b) => b.id === boxId)?.label ?? boxId;
  }

  // 复核弹窗
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
      await addReview(reviewTarget.itemId, { by: reviewBy || $operator, verdict: reviewVerdict, note: reviewNote }, $operator);
      await refresh();
      reviewTarget = null;
      notify('ok', '复核记录已追加（历史复核保留，以最后一条为准）');
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  // 改码 / 改成色 行内操作
  let relabelTarget: Item | null = null;
  let newBarcode = '';
  let gradeTarget: Item | null = null;
  let newGrade: DamageGrade = 1;

  function startRelabel(item: Item) {
    relabelTarget = item;
    newBarcode = item.barcode;
  }
  async function submitRelabel() {
    if (!relabelTarget) return;
    try {
      await relabelItem(relabelTarget.itemId, newBarcode, $operator);
      await refresh();
      relabelTarget = null;
      notify('ok', '条码已人工改写，物品身份不变（旧码进入曾用码）');
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }
  function startGrade(item: Item) {
    gradeTarget = item;
    newGrade = item.damage;
  }
  async function submitGrade() {
    if (!gradeTarget) return;
    try {
      await gradeItem(gradeTarget.itemId, newGrade, $operator);
      await refresh();
      gradeTarget = null;
      notify('ok', `成色已改为 ${newGrade} 级（GRADE 留痕）`);
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  async function undoScan(item: Item) {
    // 创建操作 uid = itemId 的 # 后半段
    const uid = item.itemId.split('#')[1]!;
    try {
      await revertScan(uid, $operator);
      await refresh();
      notify('ok', `已撤销扫码 ${item.barcode}（追加 REVERT，日志行保留）`);
    } catch (e) {
      notify('err', `撤销被阻止：${(e as Error).message}`);
    }
  }

  $: queueItems = $state.items.filter((i) => i.location.kind === 'queue');
</script>

<div class="page">
  <h2>扫码队列（边评估成色边装箱）</h2>
  <ScanPanel on:scan={onScan} />

  {#if $state.items.some((i) => i.frozen || i.awaitingArbitration)}
    <div class="merge-banner">
      有物品处于合并冻结/待裁决状态，裁决前不能装箱或转移，请到「工程合并」页处理。
    </div>
  {/if}

  <h3>待装箱队列（{queueItems.length} 件）</h3>
  <table>
    <thead>
      <tr><th>条码（曾用码）</th><th>名称</th><th>品类</th><th>成色</th><th>高价值/复核</th><th>来源/状态</th><th>操作</th></tr>
    </thead>
    <tbody>
      {#each queueItems as item (item.itemId)}
        <tr class:located={locatedItemId === item.itemId} class:frozen={item.frozen} class:pending={item.awaitingArbitration}>
          <td>
            <div class="mono">{item.barcode}</div>
            {#if item.aliases.length}<div class="muted small">曾用：{item.aliases.join('、')}</div>{/if}
          </td>
          <td>{item.name}</td>
          <td>{CATEGORY_LABEL[item.category]}</td>
          <td>
            <DamageBadge grade={item.damage} />
            <button class="mini link" on:click={() => startGrade(item)} title="成色复核改级">改</button>
          </td>
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
            {:else}<span class="muted">—</span>{/if}
          </td>
          <td class="small">
            <span class="src">{item.originProjectId}</span>
            {#if item.mergedFrom?.length}<div class="muted">已合并 {item.mergedFrom.length} 条身份</div>{/if}
            {#if item.frozen}<div class="bad-text">⛔ {item.frozenReason}</div>{/if}
            {#if item.awaitingArbitration}<div class="warn-text">待裁决：{(item.arbitrationKinds ?? []).join('、')}</div>{/if}
          </td>
          <td class="nowrap">
            <button class="mini" on:click={() => startRelabel(item)}>改码</button>
            <button class="mini" title="仅可撤销仍在队列、其后无复核的扫码" on:click={() => undoScan(item)}>撤销扫码</button>
          </td>
        </tr>
      {#if queueItems.length === 0}
        <tr><td colspan="7" class="empty">队列为空</td></tr>
      {/if}
      {/each}
    </tbody>
  </table>
</div>

{#if reviewTarget}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal-mask" on:click={() => (reviewTarget = null)} role="presentation">
    <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="高价值复核">
      <h3>高价值复核：{reviewTarget.name}（{reviewTarget.barcode}）</h3>
      {#if reviewTarget.reviews.length > 0}
        <div class="history">
          <div class="muted small">历史复核（全部保留）：</div>
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

{#if relabelTarget}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal-mask" role="presentation" on:click={() => (relabelTarget = null)}>
    <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="人工改写条码">
      <h3>人工改写条码（身份不变）</h3>
      <p class="small muted">物品 {relabelTarget.name}，稳定身份 {relabelTarget.itemId}</p>
      <label>旧条码 <input value={relabelTarget.barcode} disabled></label>
      <label>新条码 <input bind:value={newBarcode}></label>
      <div class="modal-actions">
        <button on:click={() => (relabelTarget = null)}>取消</button>
        <button class="primary" on:click={submitRelabel}>确认改码（RELABEL 留痕）</button>
      </div>
    </div>
  </div>
{/if}

{#if gradeTarget}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal-mask" role="presentation" on:click={() => (gradeTarget = null)}>
    <div class="modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="成色复核改级">
      <h3>成色复核改级</h3>
      <p class="small muted">{gradeTarget.name}（当前 {gradeTarget.damage} 级）。改级写 GRADE（from→to），交接锁定后不可改。</p>
      <select bind:value={newGrade}>
        <option value={0}>0 全新/吊牌</option>
        <option value={1}>1 九成新</option>
        <option value={2}>2 可用/明显磨损</option>
        <option value={3}>3 污损</option>
      </select>
      <div class="modal-actions">
        <button on:click={() => (gradeTarget = null)}>取消</button>
        <button class="primary" on:click={submitGrade}>确认改级</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { display: flex; flex-direction: column; gap: 10px; }
  .merge-banner { background: #fdedec; border: 1px solid #f5b7b1; padding: 8px 12px; border-radius: 6px; font-size: 13px; color: #922b21; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #d5d8dc; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #f8f9f9; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #888; }
  .small { font-size: 12px; }
  .empty { text-align: center; color: #888; padding: 14px; }
  tr.located { background: #fef9e7; }
  tr.frozen { background: #fdedec; }
  tr.pending { background: #fef5e7; }
  .src { font-family: ui-monospace, monospace; font-size: 11px; color: #555; }
  .bad-text { color: #c0392b; font-size: 12px; }
  .warn-text { color: #b9770e; font-size: 12px; }
  .nowrap { white-space: nowrap; }
  .mini { font-size: 12px; padding: 3px 9px; cursor: pointer; margin: 1px 2px; }
  .mini.link { padding: 1px 6px; }
  .mini.ok { background: #d5f5e3; border-color: #27ae60; }
  .mini.bad { background: #fadbd8; border-color: #c0392b; }
  .mini.warn { background: #fdebd0; border-color: #e67e22; }
  .modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 30; }
  .modal { background: #fff; padding: 20px; border-radius: 10px; min-width: 440px; max-width: 580px; display: flex; flex-direction: column; gap: 10px; }
  .modal label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .modal label.full { grid-column: 1 / -1; }
  .modal input, .modal select { padding: 7px; }
  .history { background: #f8f9f9; border: 1px solid #e5e7e9; border-radius: 6px; padding: 8px; display: flex; flex-direction: column; gap: 3px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
