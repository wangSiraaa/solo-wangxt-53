import { atomic, emptyLedger, newUid } from '../lib/db';
import type { WorldData } from '../lib/merge';
import { refOf, type DamageGrade, type ItemCategory, type Organization, type ProjectMeta } from '../lib/types';

export async function installWorld(world: WorldData): Promise<void> {
  await atomic(['meta', 'ledger', 'organizations', 'boxes', 'items', 'logs'], 'readwrite', (s) => {
    for (const name of ['meta', 'ledger', 'organizations', 'boxes', 'items', 'logs'] as const) s[name].clear();
    s.meta.put(world.meta);
    s.ledger.put(world.ledger ?? emptyLedger());
    for (const o of world.organizations) s.organizations.put(o);
    for (const b of world.boxes) s.boxes.put(b);
    for (const it of world.items) s.items.put(it);
    for (const l of world.logs) s.logs.put(l);
  });
}

export function emptyWorld(projectId: string, name: string, orgs: Organization[] = []): WorldData {
  const meta: ProjectMeta = { key: 'meta', projectId, projectName: name, createdAt: 1_700_000_000_000, seq: 0 };
  return { meta, ledger: emptyLedger(), organizations: orgs, boxes: [], items: [], logs: [] };
}

export function makeOrg(pid: string, localId: string, name: string, cats: ItemCategory[], maxDamage: DamageGrade): Organization {
  return { id: refOf(pid, localId), originProjectId: pid, name, allowedCategories: cats, maxDamage };
}

export { newUid };
