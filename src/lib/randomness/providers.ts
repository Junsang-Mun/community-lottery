import type { ProviderSample, RandomnessMetric } from '$lib/types';
import { sha256Hex } from '$lib/randomness/sha';

type ProviderDef = {
  name: string;
  url: string;
  parse: (raw: string) => number;
};

const BTC_PROVIDERS: ProviderDef[] = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
    parse: (raw) => JSON.parse(raw).bitcoin.usd
  },
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/spot?currency=USD',
    parse: (raw) => Number(JSON.parse(raw).data.amount)
  },
  {
    name: 'binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    parse: (raw) => Number(JSON.parse(raw).price)
  }
];

const NIST_PROVIDERS: ProviderDef[] = [
  {
    name: 'nist_beacon',
    url: 'https://beacon.nist.gov/beacon/2.0/pulse/last',
    parse: (raw) => {
      const json = JSON.parse(raw);
      const hex = json.pulse?.outputValue;
      if (!hex) return Number.NaN;
      return parseInt(hex.slice(-13), 16);
    }
  },
  {
    name: 'drand_cloudflare',
    url: 'https://drand.cloudflare.com/public/latest',
    parse: (raw) => {
      const json = JSON.parse(raw);
      const hex = json.randomness;
      if (!hex) return Number.NaN;
      return parseInt(hex.slice(-13), 16);
    }
  }
];

function medianOrMiddleAverage(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcSpreadPercent(values: number[]): number {
  if (!values.length || values.length === 1) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const baseline = (min + max) / 2 || 1;
  return ((max - min) / baseline) * 100;
}

function requestCandidates(targetUrl: string, proxyBase?: string): string[] {
  if (proxyBase) {
    return [`${proxyBase}?url=${encodeURIComponent(targetUrl)}`];
  }
  return [
    targetUrl,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`,
    `https://r.jina.ai/http://${targetUrl.replace(/^https?:\/\//, '')}`
  ];
}

async function fetchSamples(providers: ProviderDef[], proxyBase?: string): Promise<ProviderSample[]> {
  const now = new Date().toISOString();
  const samples = await Promise.all(
    providers.map(async (p): Promise<ProviderSample> => {
      const tried: string[] = [];
      for (const candidate of requestCandidates(p.url, proxyBase)) {
        tried.push(candidate);
        try {
          const res = await fetch(candidate);
          const text = await res.text();
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const value = p.parse(text);
          if (!Number.isFinite(value)) throw new Error('NaN value');
          return {
            provider: p.name,
            url: p.url,
            requestedUrl: candidate,
            retrievedAt: now,
            value,
            rawSha256: await sha256Hex(text),
            ok: true
          };
        } catch {
          // continue next candidate
        }
      }
      return {
        provider: p.name,
        url: p.url,
        requestedUrl: tried[tried.length - 1],
        retrievedAt: now,
        value: Number.NaN,
        rawSha256: '',
        ok: false,
        error: `all attempts failed (${tried.length}): ${tried.join(' | ')}`
      };
    })
  );

  return samples;
}

export async function fetchPublicRandomness(
  tolerancePercent: number,
  proxyBase?: string
): Promise<{ btc: RandomnessMetric; nist: RandomnessMetric }> {
  const btcSamples = await fetchSamples(BTC_PROVIDERS, proxyBase);
  const nistSamples = await fetchSamples(NIST_PROVIDERS, proxyBase);

  const btcValues = btcSamples.filter((s) => s.ok).map((s) => s.value);
  const nistValues = nistSamples.filter((s) => s.ok).map((s) => s.value);

  const btcFinal = btcValues.length >= 2 ? medianOrMiddleAverage(btcValues) : Number.NaN;
  // For NIST/Drand, we just pick the first successful one since they are independent beacons, not prices to be averaged
  const nistFinal = nistValues.length >= 1 ? nistValues[0] : Number.NaN;

  const btcSpread = calcSpreadPercent(btcValues);

  return {
    btc: {
      metric: 'BTC',
      finalValue: Number.isFinite(btcFinal) ? btcFinal.toFixed(2) : '',
      samples: btcSamples,
      warning: btcSpread > tolerancePercent ? `BTC 편차 ${btcSpread.toFixed(3)}%` : undefined
    },
    nist: {
      metric: 'NIST',
      finalValue: Number.isFinite(nistFinal) ? nistFinal.toString() : '',
      samples: nistSamples,
      warning: undefined
    }
  };
}
