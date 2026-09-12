<script lang="ts">
  import { state } from '../store';
  import { logTypeLabel } from '../actions';

  let filter = '';

  $: logs = [...$state.logs]
    .reverse()
    .filter((l) => {
      if (!filter.trim()) return true;
      const q = filter.trim().toLowerCase();
      return [l.type, l.barcode, l.boxId, l.fromBoxId, l.detail, l.operator]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
</script>

<div class="page">
  <h2>操作日志（IndexedDB，只追加不修改）</h2>
  <p class="muted small">
    撤销也是追加一条 <b>REVERT</b> 补偿记录，原始 SCAN 行保留；REVIEW 复核记录永远不会被“撤销扫码”级联删除。
  </p>
  <input placeholder="按条码/箱号/关键字过滤" bind:value={filter}>
  <table>
    <thead><tr><th>#</th><th>时间</th><th>类型</th><th>操作员</th><th>条码</th><th>箱</th><th>说明</th></tr></thead>
    <tbody>
      {#each logs as l (l.id)}
        <tr class:revert={l.type === 'REVERT'} class:handover={l.type === 'HANDOVER' || l.type === 'RETURN'}>
          <td class="mono">{l.id}</td>
          <td class="small nowrap">{new Date(l.at).toLocaleString('zh-CN', { hour12: false })}</td>
          <td><span class="type t-{l.type}">{logTypeLabel[l.type]}</span>{#if l.revertsId !== undefined}<span class="muted small">（撤销 #{l.revertsId}）</span>{/if}</td>
          <td>{l.operator}</td>
          <td class="mono">{l.barcode ?? ''}</td>
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
  input { max-width: 320px; padding: 7px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #d5d8dc; padding: 5px 8px; text-align: left; }
  th { background: #f8f9f9; }
  .mono { font-family: ui-monospace, monospace; }
  .small { font-size: 12px; }
  .nowrap { white-space: nowrap; }
  .muted { color: #888; }
  tr.revert { background: #f4ecf7; }
  tr.handover { background: #eafaf1; }
  .type { padding: 1px 7px; border-radius: 8px; background: #ecf0f1; font-size: 12px; white-space: nowrap; }
  .t-HANDOVER { background: #d5f5e3; }
  .t-RETURN { background: #fadbd8; }
  .t-REVERT { background: #e8daef; }
  .t-REVIEW { background: #fef9e7; }
</style>
