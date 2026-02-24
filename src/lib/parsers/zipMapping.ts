import type { ZipDongRecord } from '$lib/types';

const ZIP_IDX = 0;
const SIDO_IDX = 1;
const SIGUNGU_IDX = 3;
const ADMIN_DONG_IDX = 19;

function normalizeZip(zip: string): string | null {
  const cleaned = zip.replace(/["'\s]/g, '');
  return /^\d{5}$/.test(cleaned) ? cleaned : null;
}

export function parseZipMappingText(input: string): Map<string, ZipDongRecord> {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const out = new Map<string, ZipDongRecord>();

  for (const line of lines) {
    const cols = line.split('|');
    if (cols.length < 20) continue;
    const zip = normalizeZip(cols[ZIP_IDX] ?? '');
    const 행정동명 = (cols[ADMIN_DONG_IDX] ?? '').trim();
    const 시군구 = (cols[SIGUNGU_IDX] ?? '').trim();
    const 시도 = (cols[SIDO_IDX] ?? '').trim();

    if (!zip || !행정동명) continue;
    out.set(zip, { zip, 행정동명, 시군구, 시도 });
  }

  return out;
}

export function normalizeAddress(address: string | undefined): string {
  return (address ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '')
    .toLowerCase();
}

export function buildDongTokenVariants(dong: string): string[] {
  const base = dong.trim().toLowerCase();
  const noSpace = base.replace(/\s+/g, '');
  const spacedNumber = base.replace(/(\D)(\d)(동)/g, '$1 $2$3');
  const compact = base.replace(/(\D)\s+(\d)(동)/g, '$1$2$3');
  return Array.from(new Set([base, noSpace, spacedNumber, compact]));
}

export function addressMatchesDong(address: string | undefined, dong: string): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  const variants = buildDongTokenVariants(dong);
  return variants.some((token) => normalized.includes(token));
}
