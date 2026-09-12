/**
 * 端到端演示脚本（node + fake-indexeddb）：
 *   npx vite-node scripts/e2e-demo.ts
 * 顺序演练：摄像头不可用降级分类 → 重复扫描 → 不适配混入拦截 → 逐件交接锁定 → 退回 → 撤销保护。
 */
import 'fake-indexeddb/auto';
import { get } from 'svelte/store';
import { seedIfEmpty } from '../src/lib/seed';
import { refresh, state } from '../src/lib/store';
import {
  handoverBox,
  packItem,
  returnBox,
  revertScan,
  scanBarcode,
  toggleCheck
} from '../src/lib/actions';
import { CameraError, startCameraScan } from '../src/lib/scanner';

const S = () => get(state);
const line = (s: string) => console.log(s);
line('============ 公益仓库端到端演示 ============\n');

await seedIfEmpty(true);
await refresh();
line(`初始：物品 ${S().items.length} 件，箱 ${S().boxes.length} 只，日志 ${S().logs.length} 行\n`);

// 案例1：摄像头不可用（模拟无 mediaDevices 环境）
line('【案例1 摄像头不可用】');
const savedNavigator = globalThis.navigator;
try {
  // @ts-expect-error 模拟无摄像头环境
  globalThis.navigator = { mediaDevices: undefined };
  await startCameraScan({} as HTMLVideoElement, () => {});
} catch (e) {
  line(`  降级错误：kind=${(e as CameraError).kind}，msg=${(e as Error).message}`);
  line('  → UI 出现降级横幅，键盘/文件入口继续工作。\n');
} finally {
  globalThis.navigator = savedNavigator;
}

// 案例2：重复扫描
line('【案例2 重复扫描 6901001（已在 A-01 箱内的羽绒服）】');
for (let i = 0; i < 2; i++) {
  const r = await scanBarcode('6901001', { name: 'x', category: 'clothing', damage: 0, highValue: false }, '李仓管');
  line(`  第 ${i + 1} 次重复扫：outcome=${r.outcome}，位置=${r.item.location.kind}，累计扫描=${r.item.scanCount}`);
}
await refresh();
line(`  库内物品总数仍为 ${S().items.length}（未新增库存）\n`);

// 案例3：不适配物品混入 A-01
line('【案例3 污损玩具 6901003 试图装入 A-01（仅 ≤1 级衣物）】');
try {
  await packItem('6901003', 'box-a01', '李仓管');
} catch (e) {
  line(`  装箱被阻止：${(e as Error).message}\n`);
}

// 逐件检查后交接 A-01
line('【整箱交接 A-01】');
for (const barcode of ['6901001', '6901002']) {
  await toggleCheck(barcode, 'box-a01', '李仓管');
}
await handoverBox('box-a01', '爱华福利院-赵老师', '李仓管');
await refresh();
const a01 = S().boxes.find((b) => b.id === 'box-a01')!;
line(`  A-01 状态=${a01.status}，接收人=${a01.receiver}`);
try {
  await packItem('6901003', 'box-a01', '李仓管');
} catch (e) {
  line(`  锁定后再装箱被阻止：${(e as Error).message}`);
}
await returnBox('box-a01', '接收人电话登记错误，需更正', '李仓管');
await refresh();
line(`  退回后状态=${S().boxes.find((b) => b.id === 'box-a01')!.status}，日志中保留 HANDOVER 与 RETURN\n`);

// 撤销保护
line('【撤销扫码的保护】');
await scanBarcode('7000001', { name: '新扫外套', category: 'clothing', damage: 1, highValue: false }, '李仓管');
await refresh();
const scanId = [...S().logs].reverse().find((l) => l.barcode === '7000001' && l.type === 'SCAN')!.id;
await revertScan(scanId, '李仓管');
line('  队列中无复核的新扫码：已撤销（REVERT 留痕）');
await refresh();
line(`  物品数恢复为 ${S().items.length}，SCAN 原行仍在，新增 REVERT 行`);

// 已复核扫码不允许撤销
line('\n【已追加复核的扫码不能撤销】');
await scanBarcode('7000002', { name: '贵重羊绒衫', category: 'clothing', damage: 0, highValue: true }, '李仓管');
const { addReview } = await import('../src/lib/actions');
await addReview('7000002', { by: '张社工', verdict: 'approved', note: '核价无误' }, '李仓管');
await refresh();
const id2 = [...S().logs].reverse().find((l) => l.barcode === '7000002' && l.type === 'SCAN')!.id;
try {
  await revertScan(id2, '李仓管');
} catch (e) {
  line(`  撤销被阻止：${(e as Error).message}`);
}
line('\n演示完成。');
