import type { LotteryConfig } from '$lib/types';
import { concatAndHashHex } from '$lib/randomness/sha';

export type SeedMaterial = {
  excelHash: string;
  config: LotteryConfig;
  finalBTCValueUsed: string;
  finalNISTValueUsed: string;
  runId: string;
  runSaltHex: string;
};

export function canonicalSeedParts(m: SeedMaterial): string[] {
  return [
    `excel_hash=${m.excelHash}`,
    `selected_dong=${m.config.selectedDong.trim()}`,
    `capacity=${m.config.capacity}`,
    `rounding_mode=${m.config.roundingMode}`,
    `btc=${m.finalBTCValueUsed}`,
    `nist=${m.finalNISTValueUsed}`,
    `run_id=${m.runId}`,
    `run_salt=${m.runSaltHex}`
  ];
}

export async function deriveSeedHash(material: SeedMaterial): Promise<string> {
  return concatAndHashHex(canonicalSeedParts(material));
}

export function calcGuaranteeQuota(capacity: number, mode: 'floor' | 'ceil' | 'round'): number {
  const half = capacity / 2;
  if (mode === 'floor') return Math.floor(half);
  if (mode === 'ceil') return Math.ceil(half);
  return Math.round(half);
}
