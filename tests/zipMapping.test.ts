import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseZipMappingText, normalizeAddress, addressMatchesDong } from '../src/lib/parsers/zipMapping';

describe('zip mapping parser', () => {
  it('parses pipe-delimited rows into zip lookup', () => {
    const fixture = readFileSync(join(process.cwd(), 'tests/fixtures/zip-sample.txt'), 'utf-8');
    const map = parseZipMappingText(fixture);
    expect(map.size).toBe(2);
    expect(map.get('22879')?.행정동명).toBe('아라1동');
    expect(map.get('22710')?.행정동명).toBe('청라1동');
  });

  it('normalizes address and matches dong token variants', () => {
    expect(normalizeAddress(' 인천 서구 아라 1동 123  ')).toBe('인천 서구 아라 1동 123');
    expect(addressMatchesDong('인천광역시 서구 아라 1동 12-3', '아라1동')).toBe(true);
    expect(addressMatchesDong('인천광역시 서구 당하동 12-3', '아라1동')).toBe(false);
  });
});
