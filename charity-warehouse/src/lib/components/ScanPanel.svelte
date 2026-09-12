<script context="module" lang="ts">
  import type { ItemCategory, DamageGrade } from '../types';

  export interface Draft {
    name: string;
    category: ItemCategory;
    damage: DamageGrade;
    highValue: boolean;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { CameraError, detectCameras, startCameraScan, type CameraErrorKind, type ScanHandle } from '../scanner';
  import { CATEGORY_LABEL } from '../types';

  const dispatch = createEventDispatcher<{
    scan: { barcode: string; draft: Draft };
  }>();

  let video: HTMLVideoElement;
  let handle: ScanHandle | null = null;
  let cameraOn = false;
  let cameraStatus = '未启动';
  let camError: { kind: CameraErrorKind; message: string } | null = null;
  let cameraCount = -1;

  let barcode = '';
  let name = '';
  let category: ItemCategory = 'clothing';
  let damage: DamageGrade = 1;
  let highValue = false;

  // 演示开关：在无摄像头的离线电脑上也能稳定复现“摄像头不可用”案例
  let simulateUnavailable = false;

  const draft = (): Draft => ({ name, category, damage, highValue });

  async function probe() {
    cameraCount = simulateUnavailable ? 0 : (await detectCameras()).length;
  }
  probe();

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
      return;
    }
    camError = null;
    if (simulateUnavailable) {
      camError = { kind: 'NO_DEVICE', message: '【模拟】未检测到摄像头设备，可继续使用键盘录入或文件导入' };
      cameraStatus = '摄像头不可用';
      return;
    }
    try {
      handle = await startCameraScan(
        video,
        (code) => {
          barcode = code;
          submit(code);
        },
        (s) => (cameraStatus = s)
      );
      cameraOn = true;
    } catch (e) {
      const ce = e instanceof CameraError ? e : new CameraError('UNKNOWN', String(e));
      camError = { kind: ce.kind, message: ce.message };
      cameraStatus = '摄像头不可用';
      cameraOn = false;
    }
  }

  function stopCamera() {
    handle?.stop();
    handle = null;
    cameraOn = false;
    cameraStatus = '已停止';
  }

  function submit(forcedCode?: string) {
    const code = (forcedCode ?? barcode).trim();
    if (!code) return;
    dispatch('scan', { barcode: code, draft: draft() });
    barcode = '';
  }

  const categories = Object.entries(CATEGORY_LABEL) as [ItemCategory, string][];
</script>

<div class="scanner">
  <div class="cam-area">
    <video bind:this={video} class:on={cameraOn} muted playsinline></video>
    {#if !cameraOn}
      <div class="cam-placeholder">
        <div class="big">📷</div>
        <div>{camError ? camError.message : '摄像头未启动'}</div>
      </div>
    {/if}
  </div>

  <div class="cam-controls">
    <button class="primary" on:click={toggleCamera}>{cameraOn ? '停止摄像头' : '启动摄像头扫码'}</button>
    <label class="sim"><input type="checkbox" bind:checked={simulateUnavailable} on:change={probe} disabled={cameraOn}> 模拟摄像头不可用（离线演练）</label>
    <div class="status" class:err={!!camError}>状态：{cameraStatus}{cameraCount === 0 && !cameraOn ? '（检测到 0 个视频设备）' : ''}</div>
  </div>

  {#if camError}
    <div class="fallback-banner">
      <strong>摄像头不可用，不影响业务：</strong>
      请使用下方<b>键盘录入条码</b>（回车提交），或到「文件导入」页批量导入；队列、装箱、交接、导出全部照常工作。
    </div>
  {/if}

  <div class="keyrow">
    <input
      type="text"
      placeholder="键盘录入/扫码枪条码，回车提交（重复条码会自动定位原物品）"
      bind:value={barcode}
      on:keydown={(e) => e.key === 'Enter' && submit()}
    >
    <button class="primary" on:click={() => submit()}>扫入队列</button>
  </div>

  <div class="draft">
    <label>默认名称（新条码用）
      <input type="text" bind:value={name} placeholder="如：儿童羽绒服">
    </label>
    <label>品类
      <select bind:value={category}>
        {#each categories as [value, text]}
          <option value={value}>{text}</option>
        {/each}
      </select>
    </label>
    <label>成色
      <select bind:value={damage}>
        <option value={0}>0 全新/吊牌</option>
        <option value={1}>1 九成新</option>
        <option value={2}>2 可用/明显磨损</option>
        <option value={3}>3 污损</option>
      </select>
    </label>
    <label class="hv"><input type="checkbox" bind:checked={highValue}> 高价值（须复核）</label>
  </div>
</div>

<style>
  .scanner { display: flex; flex-direction: column; gap: 10px; }
  .cam-area { position: relative; width: 100%; max-width: 460px; aspect-ratio: 4 / 3; background: #111; border-radius: 8px; overflow: hidden; }
  video { width: 100%; height: 100%; object-fit: cover; display: none; }
  video.on { display: block; }
  .cam-placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #aaa; gap: 8px; }
  .big { font-size: 42px; }
  .cam-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .status { font-size: 13px; color: #555; }
  .status.err { color: #c0392b; }
  .sim { font-size: 13px; color: #444; display: flex; align-items: center; gap: 4px; }
  .fallback-banner { background: #fef9e7; border: 1px solid #f1c40f; padding: 8px 12px; border-radius: 6px; font-size: 13px; }
  .keyrow { display: flex; gap: 8px; }
  .keyrow input { flex: 1; padding: 9px 10px; font-size: 15px; }
  .draft { display: flex; gap: 12px; flex-wrap: wrap; }
  .draft label { font-size: 13px; color: #555; display: flex; flex-direction: column; gap: 3px; }
  .draft input, .draft select { padding: 6px 8px; }
  .hv { flex-direction: row !important; align-items: center; align-self: flex-end; padding-bottom: 8px; }
  button.primary { padding: 9px 16px; }
</style>
