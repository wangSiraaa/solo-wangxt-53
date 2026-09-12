<script lang="ts">
  import { operator, notify, refresh, state } from '../store';
  import { importRows } from '../actions';
  import { parseImportText } from '../io';

  let text = '';
  let fileName = '';
  let result: { created: number; duplicates: string[]; rejected: { barcode: string; reason: string }[]; parseErrors: string[] } | null = null;

  const sample = `barcode,name,category,damage,highValue
6903001,儿童棉袜,clothing,0,false
6903002,绘本套装,book,1,false
6901001,重复的羽绒服,clothing,0,true
6903003,破损玩具,toy,3,false`;

  function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    fileName = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      text = String(reader.result ?? '');
      result = null;
    };
    reader.readAsText(file, 'utf-8');
  }

  async function runImport() {
    const { rows, errors } = parseImportText(text);
    const r = await importRows(rows, $operator);
    result = {
      created: r.created.length,
      duplicates: r.duplicates,
      rejected: r.rejected,
      parseErrors: errors
    };
    await refresh();
    if (r.created.length) notify('ok', `导入新增 ${r.created.length} 件；重复 ${r.duplicates.length} 件（未新增库存）`);
    else notify('warn', `没有新增：重复 ${r.duplicates.length} 件，错误 ${r.rejected.length + errors.length} 条`);
  }

  function loadSample() {
    text = sample;
    fileName = '示例.csv';
    result = null;
  }
</script>

<div class="page">
  <h2>文件导入（离线，CSV / JSON）</h2>
  <p class="muted">
    与摄像头、键盘走同一个入口：重复条码（含库内已存在、文件内重复）一律只定位原物品，不产生第二份库存。
  </p>
  <div class="row">
    <label class="file">选择文件
      <input type="file" accept=".csv,.json,.txt" on:change={onFile}>
    </label>
    {fileName}<span class="muted">（UTF-8）</span>
    <button class="mini" on:click={loadSample}>载入示例（含一条重复条码）</button>
  </div>
  <textarea rows="12" bind:value={text} placeholder="barcode,name,category,damage,highValue"></textarea>
  <div>
    <button class="primary" on:click={runImport}>解析并导入</button>
  </div>

  {#if result}
    <div class="result">
      <h3>导入结果</h3>
      <p>新增 {result.created} 件；重复（已定位原物品，未入库）{result.duplicates.length} 件
        {#if result.duplicates.length}<span class="mono">：{result.duplicates.join(', ')}</span>{/if}
      </p>
      {#if result.parseErrors.length}
        <p class="bad">解析错误：</p>
        <ul>{#each result.parseErrors as e}<li class="bad">{e}</li>{/each}</ul>
      {/if}
      {#if result.rejected.length}
        <p class="bad">被拒绝行：</p>
        <ul>{#each result.rejected as r}<li class="bad">{r.barcode} —— {r.reason}</li>{/each}</ul>
      {/if}
    </div>
  {/if}

  <h3>当前库内物品（{$state.items.length} 件，条码唯一）</h3>
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 10px; }
  .muted { color: #666; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .file { padding: 6px 12px; border: 1px solid #888; border-radius: 4px; cursor: pointer; background: #f4f6f7; }
  .file input { display: none; }
  textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 13px; padding: 8px; }
  .result { border: 1px solid #bbb; border-radius: 6px; padding: 10px 14px; background: #fbfcfc; }
  .bad { color: #c0392b; }
  .mono { font-family: ui-monospace, monospace; }
  .mini { font-size: 12px; padding: 4px 10px; }
</style>
