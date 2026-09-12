<script lang="ts">
  import { onMount } from 'svelte';
  import { initStore, operator, state, toast } from './lib/store';
  import QueuePage from './lib/components/QueuePage.svelte';
  import BoxesPage from './lib/components/BoxesPage.svelte';
  import MergePage from './lib/components/MergePage.svelte';
  import ImportPage from './lib/components/ImportPage.svelte';
  import LogsPage from './lib/components/LogsPage.svelte';
  import ExportPage from './lib/components/ExportPage.svelte';

  type Tab = 'scan' | 'boxes' | 'merge' | 'import' | 'logs' | 'export';
  let tab: Tab = 'scan';

  const tabs: { id: Tab; label: string }[] = [
    { id: 'scan', label: '扫码队列' },
    { id: 'boxes', label: '箱内明细/交接' },
    { id: 'merge', label: '工程合并' },
    { id: 'import', label: '文件导入' },
    { id: 'logs', label: '操作日志' },
    { id: 'export', label: '清单/工程导出' }
  ];

  onMount(initStore);
</script>

<header>
  <div class="brand">
    <span class="logo">❤</span>
    <div>
      <h1>公益仓库离线扫码装箱系统</h1>
      <div class="sub">摄像头(ZXing) · 键盘/扫码枪 · 文件导入 · IndexedDB 本地存储 · 无后台</div>
    </div>
  </div>
  <div class="who">
    操作员 <input bind:value={$operator} aria-label="操作员">
  </div>
</header>

<nav>
  {#each tabs as t}
    <button class:active={tab === t.id} on:click={() => (tab = t.id)}>{t.label}</button>
  {/each}
  <span class="counts">
    待装箱 {$state.items.filter((i) => i.location.kind === 'queue').length}
    ｜待交接箱 {$state.boxes.filter((b) => b.status === 'open').length}
    ｜已交接箱 {$state.boxes.filter((b) => b.status === 'handed').length}
  </span>
</nav>

<main>
  {#if !$state.loaded}
    <p class="loading">正在打开本地数据库…</p>
  {:else if tab === 'scan'}
    <QueuePage />
  {:else if tab === 'boxes'}
    <BoxesPage />
  {:else if tab === 'merge'}
    <MergePage />
  {:else if tab === 'import'}
    <ImportPage />
  {:else if tab === 'logs'}
    <LogsPage />
  {:else}
    <ExportPage />
  {/if}
</main>

{#if $toast}
  <div class="toast {$toast.kind}" role="status">
    {$toast.text}
    <button class="close" on:click={() => ($toast = null)} aria-label="关闭提示">×</button>
  </div>
{/if}

<footer>
  数据仅保存在本机浏览器 IndexedDB（库名 charity-warehouse）。已交接清单锁定，错误须退回；撤销只追加 REVERT 记录。
</footer>

<style>
  :global(:root) { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: #222; }
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; background: #f4f5f7; }
  :global(button) { font-family: inherit; cursor: pointer; border-radius: 4px; border: 1px solid #999; background: #fff; padding: 6px 12px; }
  :global(button:hover:not(:disabled)) { filter: brightness(0.96); }
  :global(button:disabled) { cursor: not-allowed; opacity: .55; }
  :global(button.primary) { background: #2c3e50; color: #fff; border-color: #2c3e50; }
  :global(input), :global(select), :global(textarea) { font-family: inherit; border: 1px solid #aab; border-radius: 4px; }

  header { display: flex; justify-content: space-between; align-items: center; padding: 10px 20px; background: #2c3e50; color: #fff; gap: 12px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .logo { font-size: 30px; color: #e74c3c; }
  h1 { font-size: 18px; margin: 0; }
  .sub { font-size: 12px; opacity: .85; }
  .who { font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .who input { width: 110px; padding: 4px 8px; color: #222; }
  nav { display: flex; gap: 4px; padding: 0 16px; background: #34495e; align-items: center; flex-wrap: wrap; }
  nav button { background: transparent; color: #dfe6e9; border: none; border-radius: 0; padding: 11px 16px; font-size: 14px; border-bottom: 3px solid transparent; }
  nav button.active { background: #f4f5f7; color: #2c3e50; border-bottom-color: #e74c3c; }
  .counts { margin-left: auto; color: #dfe6e9; font-size: 12px; }
  main { max-width: 1080px; margin: 18px auto; padding: 0 18px; width: 100%; }
  main > :global(.page) { background: #fff; border: 1px solid #dde1e4; border-radius: 8px; padding: 18px; }
  :global(.page h2) { margin: 0 0 6px; font-size: 18px; }
  :global(.page h3) { margin: 14px 0 6px; font-size: 15px; }
  .loading { text-align: center; color: #777; padding: 40px; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); padding: 11px 18px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.2); font-size: 14px; z-index: 50; max-width: 80%; display: flex; align-items: center; gap: 12px; }
  .toast.ok { background: #d5f5e3; color: #145a32; }
  .toast.warn { background: #fdebd0; color: #7e5109; }
  .toast.err { background: #fadbd8; color: #922b21; }
  .close { cursor: pointer; font-size: 18px; line-height: 1; }
  footer { text-align: center; color: #999; font-size: 12px; padding: 22px; }
</style>
