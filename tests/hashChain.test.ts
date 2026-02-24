import { describe, expect, it } from 'vitest';
import { appendAuditEntry, verifyHashChain } from '../src/lib/audit/hashChain';

describe('hash chain', () => {
  it('verifies intact chain and fails tampered chain', async () => {
    const chain: any[] = [];
    await appendAuditEntry(chain, 'a', { x: 1 });
    await appendAuditEntry(chain, 'b', { y: 2 });

    const ok = await verifyHashChain(chain);
    expect(ok.ok).toBe(true);

    chain[1].data.y = 999;
    const bad = await verifyHashChain(chain);
    expect(bad.ok).toBe(false);
  });
});
