/**
 * 文件导入 / 清单导出（全部离线完成，无网络请求）。
 *
 * 导入格式（CSV，首行表头，UTF-8，可带 BOM）：
 *   barcode,name,category,damage,highValue
 *   6901001,羽绒服,clothing,1,true
 * category 取值：clothing|book|toy|food|medical；damage 取值 0..3；highValue 为 true/false
 * 也接受 JSON 数组（同字段）。
 */
import { CATEGORY_LABEL, type ItemCategory } from './types';
import type { ImportRow } from './actions';

const CATS: ItemCategory[] = ['clothing', 'book', 'toy', 'food', 'medical'];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

function normalizeCategory(raw: string): ItemCategory | null {
  const v = raw.trim().toLowerCase();
  if ((CATS as string[]).includes(v)) return v as ItemCategory;
  const byLabel = CATS.find((c) => CATEGORY_LABEL[c] === raw.trim());
  return byLabel ?? null;
}

export function parseImportText(text: string): {
  rows: ImportRow[];
  errors: string[];
} {
  const trimmed = text.trim();
  const errors: string[] = [];
  const rows: ImportRow[] = [];

  const pushObj = (obj: Record<string, unknown>, index: number) => {
    const barcode = String(obj.barcode ?? '').trim();
    const problems: string[] = [];
    if (!barcode) problems.push('条码为空');
    const category = normalizeCategory(String(obj.category ?? ''));
    if (!category) problems.push(`品类无效（${String(obj.category ?? '')}）`);
    const damage = Number(obj.damage);
    if (!Number.isInteger(damage) || damage < 0 || damage > 3) {
      problems.push(`污损等级必须是 0..3（得到 ${String(obj.damage ?? '')}）`);
    }
    if (problems.length) {
      problems.forEach((p) => errors.push(`第 ${index} 行（${barcode || '无条码'}）：${p}，已跳过`));
      return;
    }
    rows.push({
      barcode,
      name: String(obj.name ?? '').trim(),
      category: category!,
      damage: damage as ImportRow['damage'],
      highValue: obj.highValue === true || String(obj.highValue).toLowerCase() === 'true'
    });
  };

  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as Record<string, unknown>[];
      arr.forEach((o, i) => pushObj(o, i + 1));
    } catch (e) {
      errors.push(`JSON 解析失败：${(e as Error).message}`);
    }
    return { rows, errors };
  }

  const table = parseCsv(trimmed);
  if (table.length < 2) {
    errors.push('CSV 需要表头且至少一行数据');
    return { rows, errors };
  }
  const header = table[0].map((h) => h.trim());
  for (let i = 1; i < table.length; i++) {
    const obj: Record<string, string> = {};
    header.forEach((h, j) => (obj[h] = table[i][j] ?? ''));
    pushObj(obj, i + 1);
  }
  return { rows, errors };
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 重新打开工程：完整快照 JSON，可在“导入工程快照”中恢复 */
export function buildSnapshot(payload: unknown): string {
  return JSON.stringify({ format: 'charity-warehouse/v1', exportedAt: Date.now(), payload }, null, 2);
}
