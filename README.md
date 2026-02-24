# Public Fair Lottery Drawer (SvelteKit 5 / Svelte 5)

정적 호스팅용 공정 추첨 웹앱입니다. 핵심 추첨은 100% 브라우저 클라이언트에서 실행됩니다.

## 1) Run locally
```bash
cd /Users/moon/dev/딸깍/lottery
npm install
npm run dev
```

## 2) Test
```bash
npm run test
```

## 3) Build for static hosting
```bash
npm run build
```
`build/` 폴더를 배포합니다.

## 4) Public deploy examples
- Cloudflare Pages: 프로젝트 생성 후 `build/` 업로드
- Netlify: `build/` 드래그 업로드 또는 Git 연동
- Vercel: static output 배포

## 5) Optional edge proxy (CORS)
- 기본은 브라우저 직접 fetch
- CORS 실패 시 수동 난수 입력으로도 완전 동작
- 그래도 자동 조회를 원하면 `edge-proxy/cloudflare-worker` 배포 후 Proxy URL 입력

## 6) Verification Guide (3rd party)
1. `audit_package.zip` 압축 해제
2. `audit.jsonl` 해시체인 검증
   - 각 줄의 `entry_hash`가 `SHA-256(prev_hash + "\n" + canonical_json(entry_without_entry_hash))`인지 확인
3. `audit_summary.json`에서 seed material 확인
   - runId/runSalt/config/randomness final values
4. 동일 seed로 Fisher-Yates 재실행
5. `drawOutput.winners`, `drawOutput.waitlist`, `seedHash`, `finalHash` 일치 확인
6. 앱 Verify Audit 탭에서도 자동 PASS/FAIL 검증 가능

## Privacy / Audit rules
- 감사로그에는 PII(이름/전화/주소/이메일) 저장 금지
- 익명 식별자만 저장: `anon_id = SHA-256(file_hash::회원ID::이름::생년월일)`
- 결과 파일(winners/waitlist)에는 요청사항대로 휴대전화 원문 포함

## Korean PDF font embedding (optional but recommended)
기본 상태에서는 PDF가 fallback 폰트(ASCII-safe)로 생성됩니다.  
아래를 실행하면 `audit.pdf`에서 한글이 정상 임베드됩니다.

```bash
cd /Users/moon/dev/딸깍/lottery
npm install @pdf-lib/fontkit
cp /path/to/NotoSansKR-Regular.otf /Users/moon/dev/딸깍/lottery/static/fonts/NotoSansKR-Regular.otf
```
