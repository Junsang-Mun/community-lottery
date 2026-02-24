export type RoundingMode = 'floor' | 'ceil' | 'round';

export type ApplicantRaw = {
  rowIndex: number;
  no?: string;
  이름?: string;
  성별?: string;
  생년월일?: string;
  나이?: string;
  만나이?: string;
  할인대상?: string;
  수강료?: string;
  회원ID?: string;
  전화번호?: string;
  휴대전화?: string;
  이메일?: string;
  우편번호?: string;
  주소?: string;
  직업?: string;
  직장명?: string;
  메모?: string;
  접수방법?: string;
  접수상태?: string;
  접수유형?: string;
  등록일?: string;
};

export type Applicant = ApplicantRaw & {
  anonId: string;
  valid: boolean;
  invalidReasons: string[];
  selectedDongMatch: boolean;
  classificationReason: string;
  classificationSource: 'zip' | 'address' | 'unknown';
};

export type DuplicatePolicy = 'latest' | 'earliest' | 'keep-all';

export type ZipDongRecord = {
  zip: string;
  행정동명: string;
  시군구: string;
  시도: string;
};

export type ProviderSample = {
  provider: string;
  url: string;
  requestedUrl?: string;
  retrievedAt: string;
  value: number;
  rawSha256: string;
  ok: boolean;
  error?: string;
};

export type RandomnessMetric = {
  metric: 'BTC' | 'NIST';
  finalValue: string;
  samples: ProviderSample[];
  warning?: string;
  manualOverride?: boolean;
};

export type LotteryConfig = {
  selectedDong: string;
  capacity: number;
  roundingMode: RoundingMode;
};

export type DrawResult = {
  runId: string;
  runSaltHex: string;
  seedHash: string;
  guaranteeQuota: number;
  winners: Applicant[];
  waitlist: Applicant[];
  ordering: string[];
  step1WinnerAnonIds: string[];
  step2WinnerAnonIds: string[];
};

export type AuditEvent<T = Record<string, unknown>> = {
  timestamp: string;
  event_type: string;
  data: T;
  prev_hash: string;
  entry_hash: string;
};

export type AuditSummary = {
  appVersion: string;
  excelHash: string;
  runId: string;
  runSaltHex: string;
  seedHash: string;
  finalHash: string;
  generatedAt: string;
  config: {
    selectedDong: string;
    capacity: number;
    roundingMode: RoundingMode;
    guaranteeQuota: number;
  };
  randomness: {
    btc: RandomnessMetric;
    nist?: RandomnessMetric;
    nasdaq?: RandomnessMetric; // Legacy compatibility
  };
  totals: {
    uploadedRows: number;
    validApplicants: number;
    invalidApplicants: number;
    winners: number;
    waitlist: number;
  };
  applicantsForReplay: {
    anonId: string;
    memberId: string;
    valid: boolean;
    selectedDongMatch: boolean;
    invalidReasons: string[];
    classificationReason: string;
  }[];
  drawOutput: {
    winners: string[];
    waitlist: string[];
    step1: string[];
    step2: string[];
    ordering: string[];
  };
};
