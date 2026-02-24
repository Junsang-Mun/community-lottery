import type { ApplicantRaw, DuplicatePolicy } from '$lib/types';

function registrationEpoch(v: string | undefined): number {
  const t = Date.parse((v ?? '').trim());
  return Number.isFinite(t) ? t : 0;
}

function secondaryKey(a: ApplicantRaw): string {
  return `${(a.이름 ?? '').trim()}::${(a.생년월일 ?? '').trim()}::${(a.휴대전화 ?? '').replace(/\D/g, '')}`;
}

export function detectCollisions(rows: ApplicantRaw[]): Map<string, ApplicantRaw[]> {
  const buckets = new Map<string, ApplicantRaw[]>();
  for (const row of rows) {
    const key = (row.회원ID ?? '').trim() || secondaryKey(row);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }
  for (const [k, v] of [...buckets.entries()]) {
    if (v.length < 2) buckets.delete(k);
  }
  return buckets;
}

export function applyDuplicatePolicy(rows: ApplicantRaw[], policy: DuplicatePolicy): ApplicantRaw[] {
  if (policy === 'keep-all') return rows;

  const byKey = new Map<string, ApplicantRaw[]>();
  for (const row of rows) {
    const key = (row.회원ID ?? '').trim() || secondaryKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(row);
  }

  const selected: ApplicantRaw[] = [];
  for (const list of byKey.values()) {
    if (list.length === 1) {
      selected.push(list[0]);
      continue;
    }
    const sorted = [...list].sort((a, b) => registrationEpoch(a.등록일) - registrationEpoch(b.등록일));
    selected.push(policy === 'earliest' ? sorted[0] : sorted[sorted.length - 1]);
  }

  return selected.sort((a, b) => a.rowIndex - b.rowIndex);
}
