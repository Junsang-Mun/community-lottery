import { hexToBytes } from '$lib/randomness/sha';

export class DeterministicPrng {
  private seed: Uint8Array;
  private counter = 0;

  constructor(seedHex: string) {
    this.seed = hexToBytes(seedHex);
  }

  private async block(): Promise<Uint8Array> {
    const c = new Uint8Array(8);
    new DataView(c.buffer).setBigUint64(0, BigInt(this.counter++), false);
    const input = new Uint8Array(this.seed.length + c.length);
    input.set(this.seed, 0);
    input.set(c, this.seed.length);
    const digest = await crypto.subtle.digest('SHA-256', input);
    return new Uint8Array(digest);
  }

  async nextUInt32(): Promise<number> {
    const b = await this.block();
    return new DataView(b.buffer).getUint32(0, false);
  }

  async randomIndex(maxExclusive: number): Promise<number> {
    if (maxExclusive <= 0) return 0;
    const maxUint = 0xffffffff;
    const limit = maxUint - (maxUint % maxExclusive);
    while (true) {
      const r = await this.nextUInt32();
      if (r < limit) return r % maxExclusive;
    }
  }
}

export async function deterministicShuffle<T>(arr: T[], prng: DeterministicPrng): Promise<T[]> {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = await prng.randomIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
