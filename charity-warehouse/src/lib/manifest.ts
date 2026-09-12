/**
 * 交接清单导出：明确区分「待交接」与「已交接」，输出可打印的独立 HTML。
 */
import { CATEGORY_LABEL, DAMAGE_LABEL, type Box, type Item, type Organization } from './types';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function fmtTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function shortId(itemId: string): string {
  const [pid, uid] = itemId.split('#');
  return `${pid?.slice(0, 6)}…#${uid?.slice(-4)}`;
}

function itemRows(items: Item[], box: Box): string {
  if (!items.length) return `<tr><td colspan="8" class="empty">（空箱）</td></tr>`;
  return items
    .map((it, i) => {
      const review = it.highValue
        ? it.reviews.length
          ? esc(it.reviews[it.reviews.length - 1].verdict === 'approved' ? `复核通过(${it.reviews[it.reviews.length - 1].by})` : '复核不通过')
          : '<b>缺复核</b>'
        : '—';
      const checked = box.checks[it.itemId] ? '✔ 已逐件检查' : '☐ 待检查';
      const alias = it.aliases.length ? `<br><span class="dim">曾用码：${it.aliases.map(esc).join('、')}</span>` : '';
      const merged = it.mergedFrom?.length ? `<br><span class="dim">合并身份：${it.mergedFrom.length} 条来源记录</span>` : '';
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(it.barcode)}${alias}${merged}</td>
        <td>${esc(it.name)}</td>
        <td>${esc(CATEGORY_LABEL[it.category])}</td>
        <td>${esc(DAMAGE_LABEL[it.damage])}</td>
        <td>${review}</td>
        <td>${checked}</td>
        <td class="dim">${esc(shortId(it.itemId))}</td>
      </tr>`;
    })
    .join('');
}

function page(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  body{font-family:"Microsoft YaHei",sans-serif;margin:24px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#555;margin-bottom:16px}
  .box{border:1px solid #999;margin-bottom:22px;page-break-inside:avoid}
  .box h2{font-size:15px;margin:0;padding:8px 12px;background:#f0f0f0;border-bottom:1px solid #999}
  .meta{padding:6px 12px;font-size:13px;color:#333}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #bbb;padding:5px 8px;text-align:left}
  th{background:#fafafa}
  .empty{text-align:center;color:#888}
  .dim{color:#888;font-size:11px}
  .sign{margin-top:18px;font-size:13px}
  .seal{display:inline-block;margin-left:16px;padding:2px 10px;border:2px solid #c0392b;color:#c0392b;font-weight:bold}
  .badge-pending{display:inline-block;margin-left:16px;padding:2px 10px;border:2px solid #b7791f;color:#b7791f;font-weight:bold}
  .freeze{color:#c0392b;font-weight:bold}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="sub">${subtitle}</div>
${body}
</body></html>`;
}

function boxSection(box: Box, org: Organization | undefined, items: Item[], handed: boolean): string {
  const itemsHere = items.filter(
    (i) => i.location.kind !== 'queue' && (handed ? i.location.kind === 'handed' : i.location.kind === 'box') && i.location.boxId === box.id
  );
  const seal = handed
    ? `<span class="seal">已交接 · 锁定</span>`
    : `<span class="badge-pending">待交接${box.returnedAt ? '（退回修正中）' : ''}</span>`;
  const meta = handed
    ? `交接时间：${fmtTime(box.handedAt)}　接收人：${esc(box.receiver ?? '—')}`
    : `建档时间：${fmtTime(box.createdAt)}　逐件检查：${Object.keys(box.checks).length}/${itemsHere.length}${
        box.returnedAt ? `　<br><b>该箱曾退回：${esc(box.returnReason ?? '')}（${fmtTime(box.returnedAt)}）</b>` : ''
      }`;
  const frozen = itemsHere.filter((i) => i.frozen);
  return `<section class="box">
    <h2>箱号 ${esc(box.label)}　机构：${esc(org?.name ?? box.orgId)} ${seal}</h2>
    <div class="meta">${meta}<br>
      限收品类：${box.categories.map((c) => esc(CATEGORY_LABEL[c])).join('、')}
      最高污损：${esc(DAMAGE_LABEL[box.maxDamage])}</div>
    ${frozen.length ? `<div class="meta freeze">⚠ 箱内 ${frozen.length} 件处于合并冲突冻结状态，须人工核实后再处置：${frozen.map((f) => esc(f.barcode)).join('、')}</div>` : ''}
    <table><thead><tr><th>#</th><th>条码/曾用码</th><th>名称</th><th>品类</th><th>成色</th><th>高价值复核</th><th>逐件检查</th><th>稳定身份</th></tr></thead>
    <tbody>${itemRows(itemsHere, box)}</tbody></table>
    <div class="sign">移交人签字：__________　${handed ? '接收人签字：__________　' : ''}日期：__________</div>
  </section>`;
}

export function buildPendingManifest(boxes: Box[], items: Item[], orgs: Organization[]): string {
  const pending = boxes.filter((b) => b.status === 'open');
  const body = pending.length
    ? pending.map((b) => boxSection(b, orgs.find((o) => o.id === b.orgId), items, false)).join('')
    : '<p class="empty">当前没有待交接的箱。</p>';
  return page('待交接装箱清单', `导出时间：${fmtTime(Date.now())}　共 ${pending.length} 箱（尚未锁定，可继续编辑）`, body);
}

export function buildHandedManifest(boxes: Box[], items: Item[], orgs: Organization[]): string {
  const handed = boxes.filter((b) => b.status === 'handed');
  const body = handed.length
    ? handed.map((b) => boxSection(b, orgs.find((o) => o.id === b.orgId), items, true)).join('')
    : '<p class="empty">当前没有已交接的箱。</p>';
  return page('已交接清单（锁定存档）', `导出时间：${fmtTime(Date.now())}　共 ${handed.length} 箱（已锁定，错误须走退回流程）`, body);
}

export function buildSingleBoxManifest(box: Box, items: Item[], orgs: Organization[]): string {
  const handed = box.status === 'handed';
  return page(
    `箱 ${box.label} 交接清单`,
    handed ? '本清单已交接锁定' : '本清单待交接',
    boxSection(box, orgs.find((o) => o.id === box.orgId), items, handed)
  );
}
