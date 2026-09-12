import { describe, expect, it } from 'vitest';
import { parseImportText } from '../lib/io';
import { buildHandedManifest, buildPendingManifest } from '../lib/manifest';
import type { Box, Item, Organization } from '../lib/types';

const orgs: Organization[] = [
  { id: 'o1', name: '福利院', allowedCategories: ['clothing'], maxDamage: 1 }
];
const openBox: Box = { id: 'b1', label: 'A-01', orgId: 'o1', categories: ['clothing'], maxDamage: 1, status: 'open', createdAt: 1, checks: {} };
const handedBox: Box = { id: 'b2', label: 'C-03', orgId: 'o1', categories: ['clothing'], maxDamage: 1, status: 'handed', createdAt: 1, handedAt: 2, receiver: '王校长', checks: {} };
const qItem: Item = { barcode: 'Q1', name: '队列物', category: 'clothing', damage: 0, highValue: false, scannedAt: 1, scanCount: 1, reviews: [], location: { kind: 'queue' }, createdAt: 1 };
const hItem: Item = { barcode: 'H1', name: '已交物', category: 'clothing', damage: 0, highValue: false, scannedAt: 1, scanCount: 1, reviews: [], location: { kind: 'handed', boxId: 'b2' }, createdAt: 1 };

describe('导入解析', () => {
  it('解析 CSV 并校验枚举', () => {
    const csv = `barcode,name,category,damage,highValue
1,卫衣,clothing,1,false
2,坏物,xx,9,maybe
3,图书,book,0,true`;
    const { rows, errors } = parseImportText(csv);
    expect(rows.map((r) => r.barcode)).toEqual(['1', '3']);
    expect(errors.length).toBe(2);
    expect(rows[1].highValue).toBe(true);
  });

  it('支持 JSON 数组与 BOM', () => {
    const { rows } = parseImportText('﻿[{"barcode":"9","name":"n","category":"toy","damage":2,"highValue":false}]');
    expect(rows[0].barcode).toBe('9');
  });
});

describe('清单明确区分待交接与已交接', () => {
  it('待交接清单不含已交接箱，已交接清单带锁定标识', () => {
    const pending = buildPendingManifest([openBox, handedBox], [qItem, hItem], orgs);
    const handed = buildHandedManifest([openBox, handedBox], [qItem, hItem], orgs);
    expect(pending).toContain('待交接');
    expect(pending).toContain('A-01');
    expect(pending).not.toContain('C-03');
    expect(handed).toContain('已交接');
    expect(handed).toContain('C-03');
    expect(handed).toContain('王校长');
    // 队列物品不出现在任何箱明细中
    expect(pending).not.toContain('队列物');
  });
});
