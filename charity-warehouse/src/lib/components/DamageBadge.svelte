<script lang="ts">
  import { DAMAGE_LABEL } from '../types';

  export let grade: number;
  const cls = ['g0', 'g1', 'g2', 'g3'];
  $: label = DAMAGE_LABEL[grade as keyof typeof DAMAGE_LABEL] ?? String(grade);
  $: extra = cls[grade] ?? '';
</script>

<span class="grade {extra}">{label}</span>

<style>
  .grade {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 12px;
    white-space: nowrap;
  }
  .g0 { background: #d5f5e3; color: #1e8449; }
  .g1 { background: #d6eaf8; color: #21618c; }
  .g2 { background: #fdebd0; color: #b9770e; }
  .g3 { background: #fadbd8; color: #c0392b; }
</style>
