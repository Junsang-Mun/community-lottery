import * as XLSX from 'xlsx';
import type { ApplicantRaw } from '$lib/types';

const EXPECTED_HEADERS = [
  'no',
  '이름',
  '성별',
  '생년월일',
  '나이',
  '만나이',
  '할인대상',
  '수강료',
  '회원ID',
  '전화번호',
  '휴대전화',
  '이메일',
  '우편번호',
  '주소',
  '직업',
  '직장명',
  '메모',
  '접수방법',
  '접수상태',
  '접수유형',
  '등록일'
] as const;

function toText(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

export function parseExcelApplicants(bytes: ArrayBuffer): { rows: ApplicantRaw[]; fileHashHex: string } {
  const workbook = XLSX.read(bytes, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows2d = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' });
  if (rows2d.length === 0) return { rows: [], fileHashHex: '' };

  const headerRow = (rows2d[0] ?? []).map((cell) => toText(cell));
  const headerMap = new Map<string, number>();

  EXPECTED_HEADERS.forEach((h, idx) => {
    const found = headerRow.findIndex((v) => v === h);
    headerMap.set(h, found >= 0 ? found : idx);
  });

  const rows: ApplicantRaw[] = rows2d.slice(1).map((row, i) => {
    const rec: ApplicantRaw = { rowIndex: i + 2 };
    for (const h of EXPECTED_HEADERS) {
      const idx = headerMap.get(h) ?? -1;
      const cell = idx >= 0 ? row[idx] : '';
      (rec as Record<string, string | number | undefined>)[h] = toText(cell);
    }
    return rec;
  });

  return { rows, fileHashHex: '' };
}

export async function sha256HexOfArrayBuffer(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
