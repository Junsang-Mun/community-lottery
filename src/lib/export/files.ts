import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Applicant, AuditSummary } from '$lib/types';
import type { IndividualResult } from '$lib/verify/replay';

const PRETENDARD_GOV_CSS_URL =
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard-gov.min.css';

function sanitizeForWinAnsi(text: string): string {
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code <= 126 ? ch : '?';
    })
    .join('');
}

async function fetchFontBytes(paths: string[]): Promise<Uint8Array | null> {
  for (const path of paths) {
    try {
      const res = await fetch(path);
      if (!res.ok) continue;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      // ignore and try next path
    }
  }
  return null;
}

async function fetchFontBytesFromCss(cssUrl: string): Promise<Uint8Array | null> {
  try {
    const cssRes = await fetch(cssUrl);
    if (!cssRes.ok) return null;
    const cssText = await cssRes.text();

    const urls: string[] = [];
    const re = /url\((['"]?)([^'")]+)\1\)/g;
    for (const m of cssText.matchAll(re)) {
      const raw = m[2]?.trim();
      if (!raw) continue;
      if (!/\.(woff2?|ttf|otf)(\?|#|$)/i.test(raw)) continue;
      urls.push(new URL(raw, cssUrl).toString());
    }

    const prioritized = [
      ...urls.filter((u) => /\.woff(\?|#|$)/i.test(u)),
      ...urls.filter((u) => /\.(ttf|otf)(\?|#|$)/i.test(u)),
      ...urls.filter((u) => /\.woff2(\?|#|$)/i.test(u))
    ];

    for (const url of prioritized) {
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        // try next font file
      }
    }
  } catch {
    return null;
  }
  return null;
}

function toWinnerRows(rows: Applicant[]) {
  return rows.map((a, idx) => ({
    순번: idx + 1,
    회원ID: a.회원ID ?? '',
    이름: a.이름 ?? '',
    휴대전화: a.휴대전화 ?? '',
    우편번호: a.우편번호 ?? '',
    주소: a.주소 ?? '',
    등록일: a.등록일 ?? '',
    anon_id: a.anonId
  }));
}

function toCsv(rows: Record<string, string | number>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = String(row[h] ?? '');
          return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        })
        .join(',')
    );
  }
  return lines.join('\n');
}

export function buildXlsxBytes(rows: Record<string, string | number>[]): Uint8Array {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(buf);
}

export async function buildAuditPdf(summary: AuditSummary): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([842, 595]);
  // Keep audit export lightweight to avoid browser freeze during zip generation.
  const customFontEmbedded = false;
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const legacyRandomValueUsed = summary.randomness.nist?.finalValue ?? summary.randomness.nasdaq?.finalValue ?? '';

  const lines = [
    'Public Fair Lottery Audit Report',
    `Generated: ${summary.generatedAt}`,
    `Run ID: ${summary.runId}`,
    `Seed Hash: ${summary.seedHash}`,
    `Final Hash: ${summary.finalHash}`,
    `Dong: ${summary.config.selectedDong}`,
    `Capacity: ${summary.config.capacity}`,
    `Rounding: ${summary.config.roundingMode}`,
    `Guarantee Quota: ${summary.config.guaranteeQuota}`,
    `Valid Applicants: ${summary.totals.validApplicants}`,
    `Winners: ${summary.totals.winners}`,
    `Waitlist: ${summary.totals.waitlist}`,
    `BTC used: ${summary.randomness.btc.finalValue}`,
    `NIST used: ${legacyRandomValueUsed}`,
    'PII is excluded from audit artifacts by design.',
    'Korean font: fallback mode (audit PDF uses lightweight export mode)'
  ];

  let y = 560;
  for (const line of lines) {
    const text = customFontEmbedded ? line : sanitizeForWinAnsi(line);
    page.drawText(text, { x: 36, y, size: 12, font, color: rgb(0.1, 0.1, 0.14) });
    y -= 24;
  }

  return new Uint8Array(await doc.save());
}

export async function buildAuditPackageZip(params: {
  winners: Applicant[];
  waitlist: Applicant[];
  auditJsonl: string;
  auditSummary: AuditSummary;
  filenameBase?: string;
  integrityManifestJson?: string;
  integritySignatureBase64?: string;
  integrityPublicKeyJson?: string;
}): Promise<Uint8Array> {
  const safeBase = (params.filenameBase ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
  const withBase = (name: string) => (safeBase ? `${safeBase}_${name}` : name);

  const winnerRows = toWinnerRows(params.winners);
  const waitRows = toWinnerRows(params.waitlist).map((r) => ({ ...r, 대기번호: r.순번 }));

  const zip = new JSZip();
  zip.file(withBase('winners.csv'), toCsv(winnerRows));
  zip.file(withBase('waitlist.csv'), toCsv(waitRows));
  zip.file(withBase('winners.xlsx'), buildXlsxBytes(winnerRows));
  zip.file(withBase('waitlist.xlsx'), buildXlsxBytes(waitRows));
  zip.file(withBase('audit.jsonl'), params.auditJsonl);
  zip.file(withBase('audit_summary.json'), JSON.stringify(params.auditSummary, null, 2));
  zip.file(withBase('audit.pdf'), await buildAuditPdf(params.auditSummary));
  if (params.integrityManifestJson) {
    zip.file(withBase('integrity_manifest.json'), params.integrityManifestJson);
  }
  if (params.integritySignatureBase64) {
    zip.file(withBase('integrity_manifest.sig'), params.integritySignatureBase64);
  }
  if (params.integrityPublicKeyJson) {
    zip.file(withBase('integrity_public_key.jwk'), params.integrityPublicKeyJson);
  }

  return zip.generateAsync({ type: 'uint8array' });
}

export async function buildIndividualCertificatePdf(
  applicant: NonNullable<IndividualResult['applicant']>,
  status: { status: 'WINNER' | 'WAITLIST' | 'NOT_SELECTED'; waitlistRank?: number },
  summary: AuditSummary
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4 portrait

  // For PDF stability, prefer local TTF/OTF fonts over webfont css/woff.
  const fontBytes = await fetchFontBytes([
    '/fonts/NotoSansKR-Regular.ttf',
    '/fonts/NotoSansKR-Regular.otf',
    '/fonts/NotoSansCJKkr-Regular.otf',
    '/fonts/AppleGothic.ttf'
  ]);
  if (!fontBytes) {
    throw new Error('개인 인증서용 한글 폰트 파일을 찾을 수 없습니다.');
  }
  doc.registerFontkit(fontkit as never);
  const font = await doc.embedFont(fontBytes, { subset: false });
  const mono = await doc.embedFont(StandardFonts.Courier);

  const legacyRandomValueUsed = summary.randomness.nist?.finalValue ?? summary.randomness.nasdaq?.finalValue ?? '';

  let badgeText = '미당첨';
  let badgeColor = rgb(0.58, 0.11, 0.13);
  let resultLine = '아쉽게도 이번 추첨에 선정되지 않았습니다.';
  if (status.status === 'WINNER') {
    badgeText = '당첨자';
    badgeColor = rgb(0.07, 0.39, 0.2);
    resultLine = '정원 내 당첨자로 선정되었습니다.';
  } else if (status.status === 'WAITLIST') {
    badgeText = `대기자 ${status.waitlistRank ?? '-'}번`;
    badgeColor = rgb(0.63, 0.35, 0.02);
    resultLine = `예비 대기자로 등록되었습니다. (대기 순번: ${status.waitlistRank ?? '-'}번)`;
  }

  page.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(0.97, 0.98, 1) });
  page.drawRectangle({ x: 24, y: 24, width: 547, height: 794, borderColor: rgb(0.78, 0.82, 0.9), borderWidth: 2 });
  page.drawRectangle({ x: 24, y: 736, width: 547, height: 82, color: rgb(0.14, 0.24, 0.43) });
  page.drawText('개인 추첨 결과 인증서', { x: 46, y: 780, size: 28, font, color: rgb(1, 1, 1) });
  page.drawText('Individual Lottery Verification Certificate', {
    x: 46,
    y: 758,
    size: 11,
    font,
    color: rgb(0.83, 0.89, 1)
  });

  page.drawRectangle({ x: 46, y: 680, width: 503, height: 44, color: rgb(0.95, 0.96, 1) });
  page.drawRectangle({ x: 46, y: 680, width: 503, height: 44, borderColor: rgb(0.86, 0.88, 0.94), borderWidth: 1 });
  page.drawText('신청자 익명 ID (anon_id)', { x: 58, y: 708, size: 10, font, color: rgb(0.32, 0.37, 0.47) });
  page.drawText(applicant.anonId, { x: 58, y: 690, size: 11, font: mono, color: rgb(0.1, 0.14, 0.2) });

  page.drawRectangle({ x: 46, y: 620, width: 210, height: 38, color: badgeColor });
  page.drawText(`결과: ${badgeText}`, { x: 60, y: 634, size: 16, font, color: rgb(1, 1, 1) });
  page.drawText(resultLine, { x: 46, y: 592, size: 13, font, color: rgb(0.14, 0.18, 0.25) });

  page.drawText('시스템 감사 정보 (Audit Details)', {
    x: 46,
    y: 544,
    size: 15,
    font,
    color: rgb(0.12, 0.2, 0.35)
  });
  page.drawRectangle({ x: 46, y: 324, width: 503, height: 206, color: rgb(1, 1, 1) });
  page.drawRectangle({ x: 46, y: 324, width: 503, height: 206, borderColor: rgb(0.85, 0.89, 0.96), borderWidth: 1 });

  const detailRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: 'Run ID', value: summary.runId, mono: true },
    { label: '최종 해시', value: summary.finalHash, mono: true },
    { label: 'BTC 난수 시드', value: summary.randomness.btc.finalValue, mono: true },
    { label: 'NIST 난수 시드', value: legacyRandomValueUsed, mono: true },
    { label: '추첨 일시', value: summary.generatedAt, mono: false },
    { label: '검증 대상 동', value: summary.config.selectedDong, mono: false },
    {
      label: '정원/당첨/대기',
      value: `${summary.config.capacity}명 / ${summary.totals.winners}명 / ${summary.totals.waitlist}명`,
      mono: false
    }
  ];

  let y = 500;
  for (const row of detailRows) {
    page.drawText(`${row.label}:`, { x: 58, y, size: 11, font, color: rgb(0.12, 0.16, 0.23) });
    page.drawText(row.value, {
      x: 150,
      y,
      size: 11,
      font: row.mono ? mono : font,
      color: rgb(0.12, 0.16, 0.23)
    });
    y -= 26;
  }

  return new Uint8Array(await doc.save());
}
