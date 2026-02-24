const LS_PUB_JWK = 'lottery.audit.signing.publicJwk.v1';
const LS_PRIV_JWK = 'lottery.audit.signing.privateJwk.v1';

export type AuditIntegrityManifest = {
  version: 1;
  type: 'AUDIT_JSON_INTEGRITY';
  generatedAt: string;
  hashAlgorithm: 'SHA-256';
  targets: {
    audit_jsonl_sha256: string;
    audit_summary_json_sha256: string;
  };
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function sha256HexUtf8(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(digest));
}

async function getOrCreateSigningKeys(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  if (typeof window === 'undefined') {
    throw new Error('브라우저 환경에서만 키를 생성/저장할 수 있습니다.');
  }

  const cachedPub = localStorage.getItem(LS_PUB_JWK);
  const cachedPriv = localStorage.getItem(LS_PRIV_JWK);
  if (cachedPub && cachedPriv) {
    return {
      publicJwk: JSON.parse(cachedPub) as JsonWebKey,
      privateJwk: JSON.parse(cachedPriv) as JsonWebKey
    };
  }

  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );

  const publicJwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  localStorage.setItem(LS_PUB_JWK, JSON.stringify(publicJwk));
  localStorage.setItem(LS_PRIV_JWK, JSON.stringify(privateJwk));
  return { publicJwk, privateJwk };
}

export async function buildAuditIntegrityManifest(
  auditJsonlText: string,
  auditSummaryText: string
): Promise<AuditIntegrityManifest> {
  return {
    version: 1,
    type: 'AUDIT_JSON_INTEGRITY',
    generatedAt: new Date().toISOString(),
    hashAlgorithm: 'SHA-256',
    targets: {
      audit_jsonl_sha256: await sha256HexUtf8(auditJsonlText),
      audit_summary_json_sha256: await sha256HexUtf8(auditSummaryText)
    }
  };
}

function canonicalManifestText(manifest: AuditIntegrityManifest): string {
  return JSON.stringify(manifest);
}

export async function signAuditIntegrityManifest(manifest: AuditIntegrityManifest): Promise<{
  signatureBase64: string;
  publicJwk: JsonWebKey;
}> {
  const { publicJwk, privateJwk } = await getOrCreateSigningKeys();
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(canonicalManifestText(manifest))
  );
  return {
    signatureBase64: bytesToBase64(new Uint8Array(sig)),
    publicJwk
  };
}

export async function verifyAuditIntegrityBundle(params: {
  manifestText: string;
  signatureBase64: string;
  publicKeyText: string;
  auditJsonlText: string;
  auditSummaryText: string;
}): Promise<{ hashOk: boolean; signatureOk: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  let manifest: AuditIntegrityManifest;
  let publicJwk: JsonWebKey;

  try {
    manifest = JSON.parse(params.manifestText) as AuditIntegrityManifest;
  } catch {
    return { hashOk: false, signatureOk: false, reasons: ['integrity_manifest.json 파싱 실패'] };
  }

  try {
    publicJwk = JSON.parse(params.publicKeyText) as JsonWebKey;
  } catch {
    return { hashOk: false, signatureOk: false, reasons: ['integrity_public_key.jwk 파싱 실패'] };
  }

  const actualJsonl = await sha256HexUtf8(params.auditJsonlText);
  const actualSummary = await sha256HexUtf8(params.auditSummaryText);
  const hashOk =
    actualJsonl === manifest.targets.audit_jsonl_sha256 &&
    actualSummary === manifest.targets.audit_summary_json_sha256;
  if (!hashOk) reasons.push('manifest 해시와 업로드한 audit.jsonl / audit_summary.json 내용이 불일치합니다.');

  let signatureOk = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    signatureOk = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      base64ToBytes(params.signatureBase64.trim()),
      new TextEncoder().encode(canonicalManifestText(manifest))
    );
    if (!signatureOk) reasons.push('manifest 전자서명 검증 실패');
  } catch {
    signatureOk = false;
    reasons.push('전자서명 검증 중 오류');
  }

  return { hashOk, signatureOk, reasons };
}

