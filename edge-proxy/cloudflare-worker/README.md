# Optional Cloudflare Worker Proxy

## 목적
외부 금융 API CORS 제한 시 브라우저가 직접 접근하지 못하는 URL을 `?url=` 파라미터로 중계합니다.

## 배포
```bash
npm i -g wrangler
cd edge-proxy/cloudflare-worker
wrangler deploy
```

배포 후 발급 URL을 앱의 "선택 Edge Proxy URL"에 넣으면 됩니다.
예: `https://lottery-randomness-proxy.<subdomain>.workers.dev`
