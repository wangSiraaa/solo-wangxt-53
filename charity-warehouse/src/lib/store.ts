/** 全局内存状态：IndexedDB 为事实来源，动作完成后 refresh() 全量重读 */
import { writable } from 'svelte/store';
import { listAll } from './actions';
import { deleteDb } from './db';
import { seedIfEmpty } from './seed';
import type { Box, Item, OperationLog, Organization } from './types';

export interface AppState {
  orgs: Organization[];
  items: Item[];
  boxes: Box[];
  logs: OperationLog[];
  loaded: boolean;
}

const initial: AppState = { orgs: [], items: [], boxes: [], logs: [], loaded: false };

export const state = writable<AppState>(initial);
export const operator = writable('李仓管');
/** 全局提示（重复扫描定位等） */
export const toast = writable<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(kind: 'ok' | 'warn' | 'err', text: string) {
  toast.set({ kind, text });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.set(null), 5200);
}

export async function refresh(): Promise<void> {
  const data = await listAll();
  state.set({ ...data, loaded: true });
}

export async function initStore(): Promise<void> {
  await seedIfEmpty(false);
  await refresh();
}

export async function reseed(): Promise<void> {
  await seedIfEmpty(true);
  await refresh();
}

export async function wipe(): Promise<void> {
  await deleteDb();
  await refresh();
}
