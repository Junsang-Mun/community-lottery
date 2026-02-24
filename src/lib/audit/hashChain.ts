import type { AuditEvent } from '$lib/types';
import { sha256Hex } from '$lib/randomness/sha';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export async function appendAuditEntry<T extends Record<string, unknown>>(
  chain: AuditEvent[],
  eventType: string,
  data: T
): Promise<AuditEvent<T>> {
  const prevHash = chain.length ? chain[chain.length - 1].entry_hash : 'GENESIS';
  const base = {
    timestamp: new Date().toISOString(),
    event_type: eventType,
    data,
    prev_hash: prevHash
  };
  const canonical = stableStringify(base);
  const entryHash = await sha256Hex(`${prevHash}\n${canonical}`);
  const entry = { ...base, entry_hash: entryHash };
  chain.push(entry);
  return entry;
}

export function toJsonLines(entries: AuditEvent[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n');
}

export async function verifyHashChain(entries: AuditEvent[]): Promise<{ ok: boolean; reason?: string; finalHash?: string }> {
  let prev = 'GENESIS';
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.prev_hash !== prev) {
      return { ok: false, reason: `prev_hash mismatch at index ${i}` };
    }
    const base = {
      timestamp: e.timestamp,
      event_type: e.event_type,
      data: e.data,
      prev_hash: e.prev_hash
    };
    const h = await sha256Hex(`${prev}\n${stableStringify(base)}`);
    if (h !== e.entry_hash) {
      return { ok: false, reason: `entry_hash mismatch at index ${i}` };
    }
    prev = e.entry_hash;
  }
  return { ok: true, finalHash: prev };
}
