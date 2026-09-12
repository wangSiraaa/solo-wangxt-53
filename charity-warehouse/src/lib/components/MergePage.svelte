<script lang="ts">
  import { state, operator, notify, refresh } from '../store';
  import { commitMerge, previewFromText, saveAdjudication } from '../merge-actions';
  import { buildOtherSnapshot } from '../seed';
  import type { MergeConflict, MergePreview, WorldData } from '../merge';
  import type { DamageGrade, HandoverClaim, ItemLocation } from '../types';

  let fileName = '';
  let incoming: WorldData | null = null;
  let preview: MergePreview | null = null;
  let loadError = '';
  let committing = false;

  // 各冲突的表单状态
  let forms: Record<string, {
    mode: 'same' | 'separate';
    relabelWhich: string;
    newBarcode: string;
    damage: DamageGrade;
    locationJson: string;
    boxChoice: string;
  }> = {};

  function initForms(c: MergeConflict) {
    if (forms[c.key]) return;
    const pair = c.kind === 'ITEM_COLLISION' ? c.itemIds : [];
    forms[c.key] = {
      mode: 'same',
      relabelWhich: pair[0] ?? '',
      newBarcode: '',
      damage: 0,
      locationJson: '',
      boxChoice: c.claims?.[0]?.boxId ?? ''
    };
  }

  async function onFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    fileName = file.name;
    loadError = '';
    try {
      const text = await file.text();
      const r = await previewFromText(text);
      incoming = r.incoming;
      preview = r.preview;
      preview.conflicts.forEach(initForms);
      notify('ok', `已生成合并预览：新增操作 ${preview.newOpKeys.length} 条，跳过重复 ${preview.skippedDuplicateKeys.length} 条，待裁决 ${preview.pendingCount} 项`);
    } catch (err) {
      loadError = (err as Error).message;
      incoming = null;
      preview = null;
    }
    (e.target as HTMLInputElement).value = '';
  }

  async function loadDemo() {
    fileName = '城南分拣点（P2 演示工程，时钟相差约一年）.json';
    loadError = '';
    try {
      const r = await previewFromText(buildOtherSnapshot());
      incoming = r.incoming;
      preview = r.preview;
      preview.conflicts.forEach(initForms);
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  async function resolve(c: MergeConflict) {
    if (!incoming) return;
    const f = forms[c.key]!;
    try {
      if (c.kind === 'ITEM_COLLISION') {
        const [a, b] = c.itemIds;
        if (f.mode === 'same') {
          // 同一实物：库存仍为 1，两份证据都保留
          await saveAdjudication({ key: c.key, kind: 'ITEM_COLLISION', signature: c.signature, by: $operator, decision: undefined as never, winner: a, loser: b });
        } else {
          if (!f.newBarcode.trim()) throw new Error('请填写改派的新条码');
          await saveAdjudication({ key: c.key, kind: 'ITEM_COLLISION', signature: c.signature, by: $operator, decision: undefined as never, relabelItemId: f.relabelWhich, newBarcode: f.newBarcode.trim() });
        }
      } else if (c.kind === 'DAMAGE') {
        await saveAdjudication({ key: c.key, kind: 'DAMAGE', signature: c.signature, by: $operator, decision: f.damage });
      } else if (c.kind === 'LOCATION') {
        const candidates = c.candidates as Array<{ pid: string; loc: ItemLocation }>;
        const pick = candidates.find((x) => JSON.stringify(x.loc) === f.locationJson);
        if (!pick) throw new Error('请选择一个去向');
        await saveAdjudication({ key: c.key, kind: 'LOCATION', signature: c.signature, by: $operator, decision: pick.loc });
      } else if (c.kind === 'DUAL_HANDOVER') {
        if (!f.boxChoice) throw new Error('请选择核实后的交接去向');
        await saveAdjudication({ key: c.key, kind: 'DUAL_HANDOVER', signature: c.signature, by: $operator, decision: f.boxChoice, note: '人工核实两份交接证据后选定' });
      }
      await refresh();
      // 用同一包重新生成预览：已处理冲突不再出现（签名命中裁决）
      const r = await previewFromText(JSON.stringify(snapshotOf(incoming)));
      incoming = r.incoming;
      preview = r.preview;
      preview.conflicts.forEach(initForms);
      notify('ok', '裁决已保存（可继续处理其余冲突，也可暂停）');
    } catch (err) {
      notify('err', (err as Error).message);
    }
  }

  function snapshotOf(w: WorldData) {
    return {
      format: 'charity-warehouse/v2',
      exportedAt: Date.now(),
      payload: { meta: w.meta, ledger: w.ledger, organizations: w.organizations, boxes: w.boxes, items: w.items, logs: w.logs }
    };
  }

  async function doCommit() {
    if (!incoming) return;
    committing = true;
    try {
      const p = await commitMerge(incoming, $operator, fileName);
      await refresh();
      notify('ok', `合并已提交：新增操作 ${p.newOpKeys.length} 条${p.pendingCount ? `，仍有 ${p.pendingCount} 项待裁决（已暂停保留，下次导入同一包不会重复）` : ''}`);
      incoming = null;
      preview = null;
      fileName = '';
    } catch (err) {
      notify('err', (err as Error).message);
    } finally {
      committing = false;
    }
  }

  function short(id: string): string {
    const [pid, uid] = id.split('#');
    return `${pid}#${uid?.slice(0, 6)}…`;
  }
  function locText(loc: ItemLocation): string {
    return loc.kind === 'queue' ? '待装箱队列' : loc.kind === 'box' ? `箱 ${loc.boxId}` : `已交接（箱 ${loc.boxId}）`;
  }

  function damageOptions(c: MergeConflict): DamageGrade[] {
    return (c.candidates as DamageGrade[]) ?? [];
  }
  function locOptions(c: MergeConflict): Array<{ pid: string; loc: ItemLocation }> {
    return (c.candidates as Array<{ pid: string; loc: ItemLocation }>) ?? [];
  }
  function claimList(c: MergeConflict): HandoverClaim[] {
    return c.claims ?? [];
  }

  $: blockingConflicts = preview?.conflicts.filter((c) => c.blocking && !c.adjudication) ?? [];
  $: infoConflicts = preview?.conflicts.filter((c) => !c.blocking) ?? [];
</script>

<div class="page">
  <h2>工程合并（离线两个仓库 → 同一台账）</h2>
  <p class="muted small">
    物品身份是「来源工程 + 稳定操作编号」，条码只是可改写的属性。预览阶段不写库；
    完全相同的操作按 <span class="mono">工程#操作uid</span> 去重只导入一次；
    同码独立创建列为待裁决，<b>不会自动加总库存</b>；两边交接给不同机构则冻结并保留双方证据。
    所有判断按各工程内序号（seq）重放，<b>不依赖文件先后，也不凭谁的时钟新</b>。
  </p>

  <div class="row">
    <label class="file">选择工程快照 JSON
      <input type="file" accept=".json" on:change={onFile}>
    </label>
    <button on:click={loadDemo}>载入演示工程（P2 城南分拣点）</button>
    {fileName}<span class="muted">（当前本工程：{$state.meta?.projectName} / {$state.meta?.projectId}）</span>
  </div>
  {#if loadError}<div class="errbox">{loadError}</div>{/if}

  {#if preview}
    <div class="summary">
      <h3>合并预览</h3>
      <table class="sumtab">
        <thead><tr><th>工程</th><th>操作数</th><th>新增</th><th>跳过（完全相同）</th></tr></thead>
        <tbody>
          {#each preview.projects as p}
            <tr>
              <td>{p.meta.projectName} <span class="mono small">{p.meta.projectId}</span>{#if p.isLocal}<b>（本机）</b>{/if}</td>
              <td>{p.ops}</td>
              <td>{#if !p.isLocal}{preview.newOpKeys.length}{/if}</td>
              <td>{#if !p.isLocal}{preview.skippedDuplicateKeys.length}{/if}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h3>待裁决冲突（{blockingConflicts.length} 项，未裁决物品已冻结/禁止装箱）</h3>
      {#if blockingConflicts.length === 0}
        <p class="ok-text">没有阻断型冲突 —— 可以直接提交；即使现在不提交，下次导入同一包也不会重复处理。</p>
      {/if}
      {#each blockingConflicts as c (c.key)}
        <div class="conflict">
          <div class="ctitle"><span class="badge k-{c.kind}">{c.kind}</span> {c.title}</div>
          <div class="cdetail">{c.detail}</div>

          {#if c.adjudication}
            <div class="resolved">✔ 已有有效裁决（{c.adjudication.by}）—— 重复导入同一包不会再出现此项</div>
          {:else if c.kind === 'ITEM_COLLISION'}
            <div class="form">
              <p class="small warn-text">两件物品库存独立（{c.itemIds.length} 个身份），系统绝不自动相加：</p>
              <label><input type="radio" name={'mode-' + c.key} bind:group={forms[c.key].mode} value="same"> 是同一实物 —— 合并为一个身份（库存仍为 1，两份记录都留痕）</label>
              <label><input type="radio" name={'mode-' + c.key} bind:group={forms[c.key].mode} value="separate"> 是不同实物 —— 给其中一件改派新条码：</label>
              {#if forms[c.key].mode === 'separate'}
                <div class="sub">
                  改码物品：
                  <select bind:value={forms[c.key].relabelWhich}>
                    {#each c.itemIds as id}<option value={id}>{short(id)}</option>{/each}
                  </select>
                  新条码：<input placeholder="如 6901001-B" bind:value={forms[c.key].newBarcode}>
                </div>
              {/if}
            </div>
          {:else if c.kind === 'DAMAGE'}
            <div class="form">
              {#each damageOptions(c) as g}
                <label class="inline"><input type="radio" name={'dmg-' + c.key} bind:group={forms[c.key].damage} value={g}> {g} 级</label>
              {/each}
              <p class="small muted">若其中一方已交接，该成色是事实，不会出现在此供选择（见信息项）。</p>
            </div>
          {:else if c.kind === 'LOCATION'}
            <div class="form">
              {#each locOptions(c) as cand}
                <label class="inline">
                  <input type="radio" name={'loc-' + c.key} bind:group={forms[c.key].locationJson} value={JSON.stringify(cand.loc)}>
                  工程 {cand.pid}：{locText(cand.loc)}
                </label>
              {/each}
            </div>
          {:else if c.kind === 'DUAL_HANDOVER'}
            <div class="form">
              <p class="small bad-text">交接证据均保留（含已退回），转移已冻结；请核实实物实际去向并选定一个现存去向：</p>
              {#each claimList(c) as cl}
                <label class="inline">
                  <input type="radio" name={'dual-' + c.key} bind:group={forms[c.key].boxChoice} value={cl.boxId}>
                  工程 {cl.projectId} → 箱 {cl.boxId}（{cl.receiver ?? '接收人未登记'}，成色 {cl.damage}，记录码 {cl.barcode}）
                  {#if cl.active === false}<b class="returned">（该次交接已退回）</b>{/if}
                </label>
              {/each}
            </div>
          {/if}

          {#if !c.adjudication}
            <button class="primary mini" on:click={() => resolve(c)}>保存此项裁决</button>
          {/if}
        </div>
      {/each}

      <h3>信息项（{infoConflicts.length}）</h3>
      {#each infoConflicts as c (c.key)}
        <div class="conflict info">
          <div class="ctitle"><span class="badge k-{c.kind}">{c.kind}</span> {c.title}</div>
          <div class="cdetail small">{c.detail}</div>
        </div>
      {/each}

      <div class="commit-row">
        <button class="primary big" on:click={doCommit} disabled={committing}>
          {committing ? '提交中…' : '提交合并（未裁决项保留为冻结，可稍后继续）'}
        </button>
        <span class="muted small">提交后可暂停；再次导入同一包，已导入操作与已裁决冲突都不会重复出现。</span>
      </div>
    </div>
  {/if}

  <h3>当前台账中的未决项</h3>
  {#if $state.items.filter((i) => i.frozen || i.awaitingArbitration).length === 0}
    <p class="muted small">无。</p>
  {:else}
    <table>
      <thead><tr><th>条码</th><th>名称</th><th>状态</th><th>证据/来源</th></tr></thead>
      <tbody>
        {#each $state.items.filter((i) => i.frozen || i.awaitingArbitration) as it (it.itemId)}
          <tr>
            <td class="mono">{it.barcode}</td>
            <td>{it.name}</td>
            <td>
              {#if it.frozen}<div class="bad-text">⛔ {it.frozenReason}</div>{/if}
              {#if it.awaitingArbitration}<div class="warn-text">待裁决：{(it.arbitrationKinds ?? []).join('、')}</div>{/if}
            </td>
            <td class="small">
              {#each (it.handoverClaims ?? []) as cl}
                <div>工程 {cl.projectId} → {cl.boxId}（{cl.receiver}，{cl.damage}级，{new Date(cl.at).toLocaleDateString('zh-CN')}）</div>
              {/each}
              <div class="muted">身份 {short(it.itemId)}{#if it.mergedFrom?.length}，并入 {it.mergedFrom.length} 条{/if}</div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 10px; }
  .muted { color: #777; }
  .small { font-size: 12px; }
  .mono { font-family: ui-monospace, monospace; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .file { padding: 6px 12px; border: 1px solid #888; border-radius: 4px; cursor: pointer; background: #f4f6f7; }
  .file input { display: none; }
  .errbox { background: #fadbd8; border: 1px solid #e6b0aa; padding: 8px 12px; border-radius: 6px; color: #922b21; font-size: 13px; }
  .summary { border: 1px solid #cfd4d8; border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
  .sumtab { width: 100%; border-collapse: collapse; font-size: 13px; }
  .sumtab th, .sumtab td { border: 1px solid #d5d8dc; padding: 5px 8px; text-align: left; }
  .conflict { border: 1px solid #e6b0aa; border-left-width: 4px; border-radius: 6px; padding: 10px 12px; background: #fdf6f5; display: flex; flex-direction: column; gap: 6px; }
  .conflict.info { border-color: #d5d8dc; background: #f8f9f9; }
  .ctitle { font-weight: 600; font-size: 14px; }
  .cdetail { color: #555; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; color: #fff; background: #c0392b; margin-right: 4px; }
  .k-DAMAGE, .k-LOCATION { background: #b9770e; }
  .k-BLOCKED_STALE_GRADE, .k-ALIAS_COLLISION, .k-LOCATION_FACT { background: #7f8c8d; }
  .form { display: flex; flex-direction: column; gap: 5px; font-size: 13px; }
  .form .inline { display: inline-flex; gap: 5px; align-items: center; margin-right: 14px; }
  .form .sub { margin-left: 20px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .resolved { color: #1e8449; font-size: 13px; }
  .returned { color: #b9770e; font-weight: normal; }
  .ok-text { color: #1e8449; }
  .bad-text { color: #c0392b; }
  .warn-text { color: #b9770e; }
  .mini { font-size: 12px; padding: 4px 12px; align-self: flex-start; }
  .commit-row { display: flex; gap: 12px; align-items: center; margin-top: 8px; }
  .big { padding: 10px 18px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #d5d8dc; padding: 5px 8px; text-align: left; }
</style>
