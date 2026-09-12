<script lang="ts">
  import { state, operator, notify, refresh } from '../store';
  import {
    getHandoverReadiness,
    handoverBox,
    moveItem,
    packItem,
    returnBox,
    toggleCheck,
    unpackItem
  } from '../actions';
  import { validatePack } from '../rules';
  import { buildSingleBoxManifest } from '../manifest';
  import { download } from '../io';
  import type { Box, Item } from '../types';
  import { CATEGORY_LABEL, DAMAGE_LABEL } from '../types';
  import DamageBadge from './DamageBadge.svelte';

  let selectedBoxId = '';
  let targetBoxForMove = '';
  let receiver = '';
  let returnReason = '';
  let showReturn = false;
  let readiness: Awaited<ReturnType<typeof getHandoverReadiness>> | null = null;

  $: boxes = $state.boxes;
  $: selectedBox = boxes.find((b) => b.id === selectedBoxId) ?? boxes.find((b) => b.status === 'open') ?? boxes[0];
  $: org = $state.orgs.find((o) => o.id === selectedBox?.orgId);
  $: itemsInBox = selectedBox
    ? $state.items.filter((i) => (i.location.kind === 'box' || i.location.kind === 'handed') && i.location.boxId === selectedBox.id)
    : [];
  $: queueItems = $state.items.filter((i) => i.location.kind === 'queue');
  $: otherBoxes = boxes.filter((b) => b.id !== selectedBox?.id);
  $: isLocked = selectedBox?.status === 'handed';

  // 候选装箱物品逐条给出适配结论 —— 一箱混入不适配物品在点击前就能看到全部原因
  function packPreview(item: Item, box: Box | undefined) {
    if (!box) return [];
    return validatePack(item, box, $state.orgs.find((o) => o.id === box.orgId));
  }

  async function pack(item: Item) {
    if (!selectedBox) return;
    try {
      await packItem(item.barcode, selectedBox.id, $operator);
      await reload();
      notify('ok', `「${item.name}」已装入 ${selectedBox.label}`);
    } catch (e) {
      notify('err', `装箱被阻止：${(e as Error).message}`);
    }
  }

  async function unpack(item: Item) {
    try {
      await unpackItem(item.barcode, $operator);
      await reload();
      notify('ok', `「${item.name}」已取出回队列`);
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  async function move(item: Item) {
    if (!selectedBox || !targetBoxForMove) {
      notify('err', '请先选择目标箱');
      return;
    }
    try {
      await moveItem(item.barcode, selectedBox.id, targetBoxForMove, $operator);
      await reload();
      notify('ok', '移箱完成（来源箱与目标箱已在同一事务内更新）');
    } catch (e) {
      notify('err', `移箱被阻止：${(e as Error).message}`);
    }
  }

  async function check(item: Item) {
    if (!selectedBox) return;
    try {
      await toggleCheck(item.barcode, selectedBox.id, $operator);
      await reload();
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  async function reload() {
    await refresh();
    if (selectedBox?.status === 'open') {
      readiness = await getHandoverReadiness(selectedBox.id);
    } else {
      readiness = null;
    }
  }

  // 选中箱变化时重算交接就绪度
  $: if (selectedBox && selectedBox.status === 'open') {
    void getHandoverReadiness(selectedBox.id).then((r) => (readiness = r));
  } else {
    readiness = null;
  }

  async function doHandover() {
    if (!selectedBox) return;
    if (!receiver.trim()) {
      notify('err', '请填写接收人');
      return;
    }
    try {
      await handoverBox(selectedBox.id, receiver, $operator);
      notify('ok', `箱 ${selectedBox.label} 已整箱交接，清单锁定`);
      receiver = '';
      await reload();
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  async function doReturn() {
    if (!selectedBox) return;
    try {
      await returnBox(selectedBox.id, returnReason, $operator);
      notify('warn', '已交接清单已退回解锁，修正后可重新交接（交接/退回记录均保留）');
      returnReason = '';
      showReturn = false;
      await reload();
    } catch (e) {
      notify('err', (e as Error).message);
    }
  }

  function exportThisBox() {
    if (!selectedBox) return;
    download(
      `box-${selectedBox.label}-${selectedBox.status === 'handed' ? 'handed' : 'pending'}.html`,
      buildSingleBoxManifest(selectedBox, $state.items, $state.orgs),
      'text/html;charset=utf-8'
    );
  }
</script>

<div class="page">
  <h2>箱内明细与整箱交接</h2>

  <div class="box-tabs">
    {#each boxes as b}
      <button class="boxtab" class:active={selectedBox?.id === b.id} on:click={() => (selectedBoxId = b.id)}>
        {b.label}
        {#if b.status === 'handed'}<span class="lock">🔒已交接</span>{/if}
      </button>
    {/each}
  </div>

  {#if selectedBox && org}
    <div class="box-head">
      <div>
        <strong>{selectedBox.label}</strong> · 机构：{org.name}
        ｜限收：{selectedBox.categories.map((c) => CATEGORY_LABEL[c]).join('、')}
        ｜成色上限：{DAMAGE_LABEL[selectedBox.maxDamage]}
      </div>
      <div class="box-head-actions">
        <button class="mini" on:click={exportThisBox}>导出本箱清单</button>
        {#if isLocked}
          <span class="seal">🔒 已交接锁定 · 接收人：{selectedBox.receiver}</span>
          <button class="mini bad" on:click={() => (showReturn = !showReturn)}>交接有误·退回处理</button>
        {/if}
      </div>
    </div>

    {#if isLocked}
      <div class="locked-note">
        本清单已于 {selectedBox.handedAt ? new Date(selectedBox.handedAt).toLocaleString('zh-CN', { hour12: false }) : ''} 交接锁定：
        不能再装箱、移箱或改勾检。发现错误请点「交接有误·退回处理」，全程留痕。
      </div>
      {#if showReturn}
        <div class="return-row">
          <input placeholder="退回原因（必填，写入操作日志）" bind:value={returnReason}>
          <button class="bad" on:click={doReturn}>确认退回并解锁</button>
        </div>
      {/if}
    {/if}

    <h3>箱内物品（{itemsInBox.length} 件）</h3>
    <table>
      <thead>
        <tr><th>条码</th><th>名称</th><th>品类</th><th>成色</th><th>高价值复核</th>{#if !isLocked}<th>逐件检查</th>{/if}<th>位置操作</th></tr>
      </thead>
      <tbody>
        {#each itemsInBox as item (item.barcode)}
          <tr>
            <td class="mono">{item.barcode}</td>
            <td>{item.name}</td>
            <td>{CATEGORY_LABEL[item.category]}</td>
            <td><DamageBadge grade={item.damage} /></td>
            <td>
              {#if item.highValue}
                {@const last = item.reviews[item.reviews.length - 1]}
                <span class="{last?.verdict === 'approved' ? 'ok-text' : 'bad-text'}">
                  {last ? (last.verdict === 'approved' ? '✔ 复核通过' : '✘ 复核不通过') : '缺复核'}
                </span>
              {:else}—{/if}
            </td>
            {#if !isLocked}
              <td>
                {#if readiness}
                  {@const row = readiness.perItem.find((p) => p.item.barcode === item.barcode)}
                  <button class="mini {selectedBox.checks[item.barcode] ? 'ok' : 'warn'}" on:click={() => check(item)}>
                    {selectedBox.checks[item.barcode] ? `✔ 已核（${selectedBox.checks[item.barcode].by}）` : '☐ 未检查'}
                  </button>
                  {#if row && row.violations.filter((v) => v.code !== 'CHECK_MISSING').length > 0}
                    <div class="bad-text small">
                      {row.violations.filter((v) => v.code !== 'CHECK_MISSING').map((v) => v.message).join('；')}
                    </div>
                  {/if}
                {/if}
              </td>
            {/if}
            <td>
              {#if isLocked}
                <span class="muted">锁定中</span>
              {:else}
                <button class="mini" on:click={() => unpack(item)} title="取出回队列">取出</button>
                <select bind:value={targetBoxForMove}>
                  <option value="">移到…</option>
                  {#each otherBoxes.filter((b) => b.status === 'open') as b}
                    <option value={b.id}>{b.label}</option>
                  {/each}
                </select>
                <button class="mini" on:click={() => move(item)}>移箱</button>
              {/if}
            </td>
          </tr>
        {#if itemsInBox.length === 0}
          <tr><td colspan="7" class="empty">空箱 —— 从下方待装箱队列装入</td></tr>
        {/if}
        {/each}
      </tbody>
    </table>

    {#if !isLocked}
      <h3>交接前逐件检查</h3>
      {#if readiness}
        <div class="readiness">
          {#if itemsInBox.length === 0}
            <p class="muted">空箱不能交接。</p>
          {:else}
            <p>
              共 {itemsInBox.length} 件；
              {#if readiness.blockingCount === 0}
                <span class="ok-text">全部已逐件检查且适配，可交接。</span>
              {:else}
                <span class="bad-text">{readiness.blockingCount} 件存在阻断项，逐件列明如下（不是仅靠一个禁用按钮）：</span>
              {/if}
            </p>
            <ul class="peritem">
              {#each readiness.perItem as p}
                <li class="{p.violations.length ? 'bad-text' : 'ok-text'}">
                  <span class="mono">{p.item.barcode}</span> {p.item.name}：
                  {#if p.violations.length}
                    {p.violations.map((v) => v.message).join('；')}
                  {:else}
                    ✔ 已检查、适配规则通过
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          <div class="handover-row">
            <input placeholder="接收人 / 接收单位" bind:value={receiver}>
            <button class="primary {readiness.ok ? '' : 'disabled-looking'}" disabled={!readiness.ok} on:click={doHandover}>
              整箱交接并锁定
            </button>
            <span class="muted small">按钮仅在全部阻断项清零时可用，具体原因见上方逐件清单</span>
          </div>
        </div>
      {/if}

      <h3>待装箱队列（{queueItems.length} 件）—— 选择装入本箱</h3>
      <table>
        <thead><tr><th>条码</th><th>名称</th><th>品类</th><th>成色</th><th>高价值</th><th>适配预检</th><th></th></tr></thead>
        <tbody>
          {#each queueItems as item (item.barcode)}
            {@const reasons = packPreview(item, selectedBox)}
            <tr class:badrow={reasons.length > 0}>
              <td class="mono">{item.barcode}</td>
              <td>{item.name}</td>
              <td>{CATEGORY_LABEL[item.category]}</td>
              <td><DamageBadge grade={item.damage} /></td>
              <td>{item.highValue ? (item.reviews.length ? (item.reviews[item.reviews.length - 1].verdict === 'approved' ? '✔已复核' : '✘不通过') : '待复核') : '—'}</td>
              <td>
                {#if reasons.length === 0}
                  <span class="ok-text">可装入</span>
                {:else}
                  <span class="bad-text small">{reasons.map((r) => r.message).join('；')}</span>
                {/if}
              </td>
              <td><button class="mini primary" disabled={reasons.length > 0} on:click={() => pack(item)}>装入本箱</button></td>
            </tr>
          {#if queueItems.length === 0}
            <tr><td colspan="7" class="empty">队列已空</td></tr>
          {/if}
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .page { display: flex; flex-direction: column; gap: 8px; }
  .box-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .boxtab { padding: 6px 12px; border: 1px solid #bbb; background: #fff; border-radius: 6px 6px 0 0; cursor: pointer; }
  .boxtab.active { background: #2c3e50; color: #fff; border-color: #2c3e50; }
  .lock { font-size: 11px; margin-left: 4px; }
  .box-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; background: #f4f6f7; border: 1px solid #d5d8dc; }
  .box-head-actions { display: flex; align-items: center; gap: 8px; }
  .seal { color: #c0392b; font-weight: bold; font-size: 13px; }
  .locked-note { background: #fdedec; border: 1px solid #f5b7b1; padding: 8px 10px; border-radius: 6px; font-size: 13px; }
  .return-row { display: flex; gap: 8px; }
  .return-row input { flex: 1; padding: 7px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #d5d8dc; padding: 6px 9px; text-align: left; }
  th { background: #f8f9f9; }
  .mono { font-family: ui-monospace, monospace; }
  .muted { color: #888; }
  .small { font-size: 12px; }
  .empty { text-align: center; color: #888; }
  .mini { font-size: 12px; padding: 3px 9px; cursor: pointer; margin-right: 4px; }
  .mini.ok { background: #d5f5e3; }
  .mini.warn { background: #fdebd0; }
  .mini.bad { background: #fadbd8; }
  .ok-text { color: #1e8449; }
  .bad-text { color: #c0392b; }
  tr.badrow { background: #fdf3f2; }
  .readiness { border: 1px solid #d5d8dc; border-radius: 6px; padding: 10px 12px; background: #fbfcfc; }
  .peritem { margin: 6px 0 10px; padding-left: 18px; display: flex; flex-direction: column; gap: 3px; font-size: 13px; }
  .handover-row { display: flex; align-items: center; gap: 8px; }
  .handover-row input { flex: 1; max-width: 280px; padding: 8px; }
  .disabled-looking { opacity: .45; }
  select { padding: 4px; font-size: 12px; }
  button.primary { padding: 8px 16px; }
  button.bad { background: #c0392b; color: #fff; border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; }
</style>
