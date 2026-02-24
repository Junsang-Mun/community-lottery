import { describe, expect, it } from 'vitest';
import { canonicalSeedParts, deriveSeedHash, calcGuaranteeQuota } from '../src/lib/lottery/seed';

describe('seed derivation', () => {
  it('canonicalization is stable', async () => {
    const material = {
      excelHash: 'abc',
      config: { selectedDong: '아라1동', capacity: 20, roundingMode: 'floor' as const },
      finalBTCValueUsed: '100000.00',
      finalNASDAQCompositeValueUsed: '18000.00',
      runId: 'run-1',
      runSaltHex: 'ff'.repeat(32)
    };
    expect(canonicalSeedParts(material)).toEqual([
      'excel_hash=abc',
      'selected_dong=아라1동',
      'capacity=20',
      'rounding_mode=floor',
      'btc=100000.00',
      'nasdaq=18000.00',
      'run_id=run-1',
      `run_salt=${'ff'.repeat(32)}`
    ]);
    const h1 = await deriveSeedHash(material);
    const h2 = await deriveSeedHash(material);
    expect(h1).toBe(h2);
  });

  it('handles rounding modes', () => {
    expect(calcGuaranteeQuota(20, 'floor')).toBe(10);
    expect(calcGuaranteeQuota(21, 'floor')).toBe(10);
    expect(calcGuaranteeQuota(21, 'ceil')).toBe(11);
    expect(calcGuaranteeQuota(21, 'round')).toBe(11);
  });
});
