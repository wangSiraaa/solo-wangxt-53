import { describe, expect, it } from 'vitest';
import { parseImportText } from '../lib/io';
import { buildHandedManifest, buildPendingManifest } from '../lib/manifest';
import { refOf, type Box, type Item, type Organization } from '../lib/types';

const pid = 'p1';
const orgs: Organization[] = [{ id: refOf(pid, 'o1'), originProjectId: pid, name: '福利院', allowedCategories: ['clothing'], maxDamage: 1 }];
const openBox: Box = { id: refOf(pid, 'b1'), originProjectId: pid, label: 'A-01', orgId: refOf(pid, 'o1'), categories: ['clothing'], maxDamage: 1, status: 'open', createdAt: 1, checks: {} };
const handedBox: Box = { id: refOf(pid, 'b2'), originProjectId: pid, label: 'C-03', orgId: refOf(pid, 'o1'), categories: ['clothing'], maxDamage: 1, status: 'handed', createdAt: 1, handedAt: 2, receiver: '王校长', checks: {} };
const qItem: Item = { itemId: refOf(pid, 'q1'), originProjectId: pid, barcode: 'Q1', aliases: [], name: '队列物', category: 'clothing', damage: 0, highValue: false, scannedAt: 1, scanCount: 1, reviews: [], location: { kind: 'queue' }, createdAt: 1 };
const hItem: Item = { itemId: refOf(pid, 'h1'), originProjectId: pid, barcode: 'H1', aliases: [], name: '已交物', category: 'clothing', damage: 0, highValue: false, scannedAt: 1, scanCount: 1, reviews: [], location: { kind: 'handed', boxId: handedBox.id }, createdAt: 1 };

describe('导入解析', () => {
  it('CSV 枚举校验：无效行逐条报错', () => {
    const csv = `barcode,name,category,damage,highValue
1,卫衣,clothing,1,false
2,坏物,xx,9,maybe
3,图书,book,0,true`;
    const { rows, errors } = parseImportText(csv);
    expect(rows.map((r) => r.barcode)).toEqual(['1', '3']);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(rows[1]!.highValue).toBe(true);
  });
  it('JSON 数组与 BOM', () => {
    const { rows } = parseImportText('﻿[{"barcode":"9","name":"n","category":"toy","damage":2,"highValue":false}]');
    expect(rows[0]!.barcode).toBe('9');
  });
});

describe('清单区分待交接/已交接', () => {
  it('两类清单互不混入；队列物品不出现；已交接带锁定标识与接收人', () => {
    const pending = buildPendingManifest([openBox, handedBox], [qItem, hItem], orgs);
    const handed = buildHandedManifest([openBox, handedBox], [qItem, hItem], orgs);
    expect(pending).toContain('待交接');
    expect(pending).toContain('A-01');
    expect(pending).not.toContain('C-03');
    expect(handed).toContain('已交接');
    expect(handed).toContain('C-03');
    expect(handed).toContain('王校长');
    expect(pending).not.toContain('队列物');
  });
});
