import { sha256Hex } from '$lib/randomness/sha';
import type { ApplicantRaw } from '$lib/types';

export async function anonIdOf(fileHash: string, row: ApplicantRaw): Promise<string> {
  const member = (row.회원ID ?? '').trim();
  const name = (row.이름 ?? '').trim();
  const birth = (row.생년월일 ?? '').trim();
  return sha256Hex(`${fileHash}::${member}::${name}::${birth}`);
}
