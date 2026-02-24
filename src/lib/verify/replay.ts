import type { AuditEvent, AuditSummary, LotteryConfig } from '$lib/types';
import { runLottery } from '$lib/lottery/draw';
import { verifyHashChain } from '$lib/audit/hashChain';

export type ReplayedResult = {
  applicants: AuditSummary['applicantsForReplay'];
  winners: string[];
  waitlist: string[];
};

export type VerifyAuditReplayResult = {
  chainOk: boolean;
  replayOk: boolean;
  reasons: string[];
  replayResult: ReplayedResult;
};

export async function verifyAuditAndReplay(summary: AuditSummary, events: AuditEvent[]): Promise<VerifyAuditReplayResult> {
  const reasons: string[] = [];
  const chain = await verifyHashChain(events);
  if (!chain.ok) reasons.push(chain.reason ?? 'hash chain failed');
  if (chain.finalHash && chain.finalHash !== summary.finalHash) {
    reasons.push('final hash mismatch with summary');
  }

  const validApplicants = summary.applicantsForReplay
    .filter((a) => a.valid)
    .map((a) => ({
      rowIndex: 0,
      anonId: a.anonId,
      valid: true,
      invalidReasons: [],
      selectedDongMatch: a.selectedDongMatch,
      classificationReason: a.classificationReason,
      classificationSource: 'unknown' as const
    }));

  const cfg: LotteryConfig = {
    selectedDong: summary.config.selectedDong,
    capacity: summary.config.capacity,
    roundingMode: summary.config.roundingMode
  };

  // Add backward compatibility for older JSON runs
  const legacyRandomValueUsed = summary.randomness.nist?.finalValue ?? summary.randomness.nasdaq?.finalValue ?? '';

  const replay = await runLottery(validApplicants as never, cfg, {
    excelHash: summary.excelHash,
    config: cfg,
    finalBTCValueUsed: summary.randomness.btc.finalValue,
    finalNISTValueUsed: legacyRandomValueUsed,
    runId: summary.runId,
    runSaltHex: summary.runSaltHex
  });

  if (replay.seedHash !== summary.seedHash) reasons.push('seed hash mismatch');
  if (JSON.stringify(replay.winners.map((w) => w.anonId)) !== JSON.stringify(summary.drawOutput.winners)) {
    reasons.push('winner ordering mismatch');
  }
  if (JSON.stringify(replay.waitlist.map((w) => w.anonId)) !== JSON.stringify(summary.drawOutput.waitlist)) {
    reasons.push('waitlist ordering mismatch');
  }

  const replayResult: ReplayedResult = {
    applicants: summary.applicantsForReplay,
    winners: replay.winners.map((w) => w.anonId),
    waitlist: replay.waitlist.map((w) => w.anonId)
  };

  return {
    chainOk: chain.ok,
    replayOk: reasons.length === 0,
    reasons,
    replayResult
  };
}

export function parseAuditJsonl(text: string): AuditEvent[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export type IndividualResult = {
  status: 'WINNER' | 'WAITLIST' | 'NOT_SELECTED' | 'NOT_FOUND';
  waitlistRank?: number;
  applicant?: {
    anonId: string;
    memberId: string;
    valid: boolean;
    invalidReasons: string[];
    selectedDongMatch: boolean;
    classificationReason: string;
  };
};

export function verifyIndividualResult(lookupRaw: string, replayResult: ReplayedResult): IndividualResult {
  const lookup = lookupRaw.trim();
  let applicant = lookup
    ? replayResult.applicants.find((a) => a.anonId === lookup || a.memberId === lookup)
    : undefined;

  if (!applicant) {
    return { status: 'NOT_FOUND' };
  }

  const anonId = applicant.anonId;

  // Check Winners
  const isWinner = replayResult.winners.includes(anonId);
  if (isWinner) {
    return { status: 'WINNER', applicant };
  }

  // Check Waitlist
  const waitlistIndex = replayResult.waitlist.indexOf(anonId);
  if (waitlistIndex >= 0) {
    return { status: 'WAITLIST', waitlistRank: waitlistIndex + 1, applicant };
  }

  return { status: 'NOT_SELECTED', applicant };
}
