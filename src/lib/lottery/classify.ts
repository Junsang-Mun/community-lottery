import type { Applicant, ApplicantRaw, ZipDongRecord } from '$lib/types';
import { addressMatchesDong } from '$lib/parsers/zipMapping';

function normalizeZip(zip: string | undefined): string | null {
  const cleaned = (zip ?? '').replace(/["'\s]/g, '');
  return /^\d{5}$/.test(cleaned) ? cleaned : null;
}

export function validateApplicant(row: ApplicantRaw): { valid: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!(row.이름 ?? '').trim()) reasons.push('이름 누락');
  if (!(row.회원ID ?? '').trim()) reasons.push('회원ID 누락');
  if (!(row.휴대전화 ?? '').trim()) reasons.push('휴대전화 누락');
  if (!(row.우편번호 ?? '').trim()) reasons.push('우편번호 누락');
  if (!(row.주소 ?? '').trim()) reasons.push('주소 누락');
  return { valid: reasons.length === 0, reasons };
}

export function classifyApplicant(
  row: ApplicantRaw,
  selectedDong: string,
  zipMap: Map<string, ZipDongRecord> | null
): {
  selectedDongMatch: boolean;
  classificationReason: string;
  source: 'zip' | 'address' | 'unknown';
} {
  const zip = normalizeZip(row.우편번호);
  if (zip && zipMap?.has(zip)) {
    const record = zipMap.get(zip)!;
    const match = record.행정동명.trim() === selectedDong.trim();
    return {
      selectedDongMatch: match,
      classificationReason: `zip:${zip} -> ${record.시도} ${record.시군구} ${record.행정동명}`,
      source: 'zip'
    };
  }

  if (addressMatchesDong(row.주소, selectedDong)) {
    return {
      selectedDongMatch: true,
      classificationReason: `address_fallback_matched:${selectedDong}`,
      source: 'address'
    };
  }

  return {
    selectedDongMatch: false,
    classificationReason: zip ? `zip_not_found:${zip}` : 'zip_missing_or_invalid_and_address_no_confident_match',
    source: 'unknown'
  };
}

export function buildApplicant(
  row: ApplicantRaw,
  anonId: string,
  selectedDong: string,
  zipMap: Map<string, ZipDongRecord> | null
): Applicant {
  const validation = validateApplicant(row);
  const cls = classifyApplicant(row, selectedDong, zipMap);
  return {
    ...row,
    anonId,
    valid: validation.valid,
    invalidReasons: validation.reasons,
    selectedDongMatch: validation.valid ? cls.selectedDongMatch : false,
    classificationReason: cls.classificationReason,
    classificationSource: cls.source
  };
}
