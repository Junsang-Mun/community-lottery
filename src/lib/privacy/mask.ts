import type { Applicant } from '$lib/types';

export function maskName(name: string | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw) return '*';
  const chars = [...raw];
  if (chars.length === 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${'*'.repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export function normalizePhone(phone: string | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

export function last4(phone: string | undefined): string {
  const digits = normalizePhone(phone);
  if (digits.length < 4) return '----';
  return digits.slice(-4);
}

export function maskedPublicRow(applicant: Applicant): { anonId: string; maskedName: string; phoneLast4: string } {
  return {
    anonId: applicant.anonId,
    maskedName: maskName(applicant.이름),
    phoneLast4: last4(applicant.휴대전화)
  };
}
