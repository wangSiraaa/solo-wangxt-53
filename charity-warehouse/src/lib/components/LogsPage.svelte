<script lang="ts">
  import { state } from '../store';
  import { logTypeLabel } from '../actions';

  let filter = '';

  $: logs = [...$state.logs]
    .slice()
    .sort((a, b) => b.seq - a.seq || (a.projectId > b.projectId ? -1 : 1))
    .filter((l) => {
      if (!filter.trim()) return true;
      const q = filter.trim().toLowerCase();
      return [l.type, l.itemId, l.barcode, l.boxId, l.fromBoxId, l.detail, l.operator, l.projectId, l.uid]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
</script>

<div class="page">
  <h2>操作日志（IndexedDB，只追加不修改）</h2>
  <p class="muted small">
    每条操作有来源工程 + 稳定 uid + 工程内序号 seq：uid 是合并去重的身份，seq 是该工程内因果顺序，<b>at 只是本机时钟，合并不以它判对错</b>。
    REVERT/裁决都是追加补偿记录，不删除原行。
  </p>
  <input placeholder="按条码/身份/箱号/工程/关键字过滤" bind:value={filter}>
  <table>
    <thead><tr><th>工程</th><th>seq</th><th>时间(本机时钟)</th><th>类型</th><th>操作员</th><th>物品身份/条码</th><th>箱</th><th>说明</th></tr></thead>
    <tbody>
      {#each logs as l (l.projectId + l.uid)}
        <tr class:revert={l.type === 'REVERT'} class:handover={l.type === 'HANDOVER' || l.type === 'RETURN'} class:merge={l.type === 'MERGE_IMPORT' || l.type === 'MERGE_RESOLVE'}>
          <td class="small mono">{l.projectId}</td>
          <td class="mono">{l.seq}</td>
          <td class="small nowrap">{new Date(l.at).toLocaleString('zh-CN', { hour12: false })}</td>
          <td><span class="type t-{l.type}">{logTypeLabel[l.type]}</span>{#if l.revertsUid}<span class="muted small">（撤销 {l.revertsUid.slice(0, 8)}…）</span>{/if}</td>
          <td>{l.operator}</td>
          <td class="small">
            {#if l.itemId}<div class="mono dim">{l.itemId}</div>{/if}
            {l.barcode ?? ''}{#if l.oldBarcode} <span class="dim">({l.oldBarcode}→)</span>{/if}
          </td>
          <td class="mono small">
            {#if l.fromBoxId}{l.fromBoxId} → {l.toBoxId}{:else}{l.boxId ?? ''}{/if}
          </td>
          <td class="small">{l.detail ?? ''}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 10px; }
  input { max-width: 340px; padding: 7px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #d5d8dc; padding: 5px 8px; text-align: left; vertical-align: top; }
  th { background: #f8f9f9; }
  .mono { font-family: ui-monospace, monospace; }
  .dim { color: #999; font-size: 11px; }
  .small { font-size: 12px; }
  .nowrap { white-space: nowrap; }
  .muted { color: #888; }
  tr.revert { background: #f4ecf7; }
  tr.handover { background: #eafaf1; }
  tr.merge { background: #eaf2f8; }
  .type { padding: 1px 7px; border-radius: 8px; background: #ecf0f1; font-size: 12px; white-space: nowrap; }
  .t-HANDOVER { background: #d5f5e3; }
  .t-RETURN { background: #fadbd8; }
  .t-REVERT { background: #e8daef; }
  .t-REVIEW, .t-GRADE, .t-RELABEL { background: #fef9e7; }
  .t-MERGE_IMPORT, .t-MERGE_RESOLVE { background: #d6eaf8; }
</style>
