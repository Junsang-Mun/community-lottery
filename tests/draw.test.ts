import { describe, expect, it } from 'vitest';
import { runLottery } from '../src/lib/lottery/draw';

function app(i: number, target: boolean) {
  return {
    rowIndex: i,
    anonId: `a-${i}`,
    valid: true,
    invalidReasons: [],
    selectedDongMatch: target,
    classificationReason: target ? 'zip:ok' : 'unknown',
    classificationSource: target ? 'zip' : 'unknown'
  };
}

describe('draw determinism and ordering', () => {
  it('is deterministic with same seed material', async () => {
    const valid = [app(1, true), app(2, true), app(3, false), app(4, false), app(5, true)];
    const cfg = { selectedDong: '아라1동', capacity: 3, roundingMode: 'floor' as const };
    const seed = {
      excelHash: 'abc',
      config: cfg,
      finalBTCValueUsed: '100',
      finalNASDAQCompositeValueUsed: '200',
      runId: 'run-1',
      runSaltHex: '11'.repeat(32)
    };
    const r1 = await runLottery(valid as never, cfg, seed);
    const r2 = await runLottery(valid as never, cfg, seed);
    expect(r1.winners.map((x) => x.anonId)).toEqual(r2.winners.map((x) => x.anonId));
    expect(r1.waitlist.map((x) => x.anonId)).toEqual(r2.waitlist.map((x) => x.anonId));
  });

  it('applies guarantee + single waitlist ordering', async () => {
    const target = Array.from({ length: 23 }, (_, i) => app(i + 1, true));
    const other = [app(100, false), app(101, false)];
    const valid = [...target, ...other];
    const cfg = { selectedDong: '아라1동', capacity: 20, roundingMode: 'floor' as const };
    const seed = {
      excelHash: 'excel',
      config: cfg,
      finalBTCValueUsed: '123',
      finalNASDAQCompositeValueUsed: '456',
      runId: 'run-z',
      runSaltHex: '22'.repeat(32)
    };
    const r = await runLottery(valid as never, cfg, seed);
    expect(r.guaranteeQuota).toBe(10);
    expect(r.winners.length).toBe(20);
    expect(r.waitlist.length).toBe(5);
    const orderSet = new Set([...r.winners, ...r.waitlist].map((a) => a.anonId));
    expect(orderSet.size).toBe(25);
    expect(r.waitlist.map((w) => w.anonId)).toEqual(r.ordering.filter((id) => !r.winners.find((w) => w.anonId === id)));
  });
});
