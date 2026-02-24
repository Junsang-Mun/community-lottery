import type { Applicant, DrawResult, LotteryConfig } from '$lib/types';
import { DeterministicPrng, deterministicShuffle } from '$lib/randomness/prng';
import { calcGuaranteeQuota, deriveSeedHash, type SeedMaterial } from '$lib/lottery/seed';

export async function runLottery(
  validApplicants: Applicant[],
  config: LotteryConfig,
  seedMaterial: SeedMaterial
): Promise<DrawResult> {
  const seedHash = await deriveSeedHash(seedMaterial);
  const prng = new DeterministicPrng(seedHash);

  const shuffled = await deterministicShuffle(validApplicants, prng);
  const ordering = shuffled.map((a) => a.anonId);

  const N = config.capacity;
  if (validApplicants.length <= N) {
    return {
      runId: seedMaterial.runId,
      runSaltHex: seedMaterial.runSaltHex,
      seedHash,
      guaranteeQuota: calcGuaranteeQuota(N, config.roundingMode),
      winners: shuffled,
      waitlist: [],
      ordering,
      step1WinnerAnonIds: shuffled.filter((a) => a.selectedDongMatch).map((a) => a.anonId),
      step2WinnerAnonIds: shuffled.filter((a) => !a.selectedDongMatch).map((a) => a.anonId)
    };
  }

  const quota = calcGuaranteeQuota(N, config.roundingMode);
  const step1WinnerSet = new Set<string>();

  for (const a of shuffled) {
    if (a.selectedDongMatch && step1WinnerSet.size < quota) {
      step1WinnerSet.add(a.anonId);
    }
  }

  const winners: Applicant[] = [];
  for (const a of shuffled) {
    if (step1WinnerSet.has(a.anonId)) winners.push(a);
  }

  const winnerSet = new Set(winners.map((a) => a.anonId));
  for (const a of shuffled) {
    if (winners.length >= N) break;
    if (winnerSet.has(a.anonId)) continue;
    winners.push(a);
    winnerSet.add(a.anonId);
  }

  const waitlist = shuffled.filter((a) => !winnerSet.has(a.anonId));

  return {
    runId: seedMaterial.runId,
    runSaltHex: seedMaterial.runSaltHex,
    seedHash,
    guaranteeQuota: quota,
    winners,
    waitlist,
    ordering,
    step1WinnerAnonIds: winners.filter((a) => step1WinnerSet.has(a.anonId)).map((a) => a.anonId),
    step2WinnerAnonIds: winners.filter((a) => !step1WinnerSet.has(a.anonId)).map((a) => a.anonId)
  };
}
