/** 全局内存状态：IndexedDB 为事实来源，动作完成后 refresh() 全量重读 */
import { writable } from 'svelte/store';
import { ensureMeta, listAll } from './actions';
import { deleteDb } from './db';
import { seedIfEmpty } from './seed';
import type { Box, Item, OperationLog, Organization, ProjectMeta, MergeLedger } from './types';

export interface AppState {
  meta: ProjectMeta | null;
  ledger: MergeLedger | null;
  orgs: Organization[];
  items: Item[];
  boxes: Box[];
  logs: OperationLog[];
  loaded: boolean;
}

const initial: AppState = { meta: null, ledger: null, orgs: [], items: [], boxes: [], logs: [], loaded: false };

export const state = writable<AppState>(initial);
export const operator = writable('李仓管');
export const toast = writable<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(kind: 'ok' | 'warn' | 'err', text: string) {
  toast.set({ kind, text });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.set(null), 6000);
}

export async function refresh(): Promise<void> {
  const d = await listAll();
  state.set({ meta: d.meta, ledger: d.ledger, orgs: d.orgs, items: d.items, boxes: d.boxes, logs: d.logs, loaded: true });
}

export async function initStore(): Promise<void> {
  await ensureMeta('本机仓库');
  await seedIfEmpty(false);
  await refresh();
}

export async function wipe(): Promise<void> {
  try {
    globalThis.localStorage?.setItem('cw-noseed', '1');
  } catch {
    /* ignore */
  }
  await deleteDb();
  state.set(initial);
}
