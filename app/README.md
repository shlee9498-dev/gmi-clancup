# GmI 클랜 — 웹 클라이언트 (PWA)

GitHub Pages용 정적 사이트. 봇 백엔드 (Railway)와 연동.

## 파일 구조

```
app/
├── index.html       대시보드 (지갑/순위/매치)
├── duel.html        1:1 라이브 매치 보드 (SSE)
├── matches.html     매치 히스토리 + 1:1 승수 순위
├── login.html       Discord OAuth 시작
├── auth/done.html   OAuth 콜백 (JWT 추출 → localStorage)
├── style.css        공통 스타일 (G드컵 페이지 톤)
├── app.js           공통 JS (auth, fetch, 헬퍼)
├── manifest.json    PWA 매니페스트
├── sw.js            서비스 워커 (오프라인 캐시)
└── icons/           PWA 아이콘
    ├── icon-192.png
    ├── icon-512.png
    ├── icon-maskable-512.png
    └── favicon.png
```

## 배포 절차

이 `app/` 폴더를 기존 `gmi-clancup` 저장소(GitHub Pages)에 통째로 업로드:

```
gmi-clancup/                    ← 기존 저장소
├── index.html                  ← G드컵 모집 페이지 (그대로)
├── gdcup-s2.html
├── roster.html
├── ...
└── app/                        ← ⭐ 이 폴더를 새로 추가
    ├── index.html              ← 웹 앱 대시보드 (별개)
    └── ...
```

URL:
- 대시보드: `https://shlee9498-dev.github.io/gmi-clancup/app/`
- 매치 보드: `https://shlee9498-dev.github.io/gmi-clancup/app/duel.html?id=42`

## API 베이스 URL 설정 (배포 후 필수)

각 HTML 파일에 `<meta name="gmi-api-base" content="">` 있음. Railway 배포 후 받은 도메인으로 교체:

```html
<meta name="gmi-api-base" content="https://gmi-bot-xxxx.up.railway.app">
```

5개 HTML 파일 모두 수정 (index, duel, matches, login). 또는 `app.js`의 `API_BASE` 기본값 수정.

## Discord OAuth 등록 (배포 후 필수)

1. https://discord.com/developers/applications → 봇 Application 선택
2. **OAuth2** → **General**:
   - **Redirects** 추가:
     ```
     https://gmi-bot-xxxx.up.railway.app/auth/callback
     ```
3. **OAuth2** → **Client Secret** → "Reset Secret" → 시크릿 복사

4. Railway Variables에 등록:
   ```
   DISCORD_CLIENT_ID=Application ID (Application 페이지에 표시)
   DISCORD_CLIENT_SECRET=위에서 복사한 시크릿
   DISCORD_REDIRECT_URI=https://gmi-bot-xxxx.up.railway.app/auth/callback
   SESSION_SECRET=$(openssl rand -hex 32)  # 또는 임의 긴 문자열
   CORS_ORIGIN=https://shlee9498-dev.github.io
   WEB_RETURN_PATH=/gmi-clancup/app/auth/done.html
   ```

## 동작 흐름

```
[클랜원] login.html에서 "디스코드 로그인" 클릭
    ↓
[Railway 봇] /auth/start → 디스코드 OAuth 페이지로 리다이렉트
    ↓
[Discord] 사용자 승인 → /auth/callback?code=... 로 콜백
    ↓
[Railway 봇] 토큰 교환 + 사용자 조회 + JWT 발급
    ↓
[브라우저] /app/auth/done.html#token=... 으로 리다이렉트
    ↓
[done.html] fragment에서 JWT 추출 → localStorage 저장 → index.html로
    ↓
[index.html] localStorage의 JWT로 /api/me 호출 → 잔액/이력 표시
```

## 로컬 테스트 (선택)

봇 로컬 실행 (port 8000) 후:

```bash
# app/ 폴더에서
python3 -m http.server 5500
# 브라우저: http://localhost:5500/login.html
```

이때 `Redirects`에 `http://localhost:8000/auth/callback` 추가 필요.
`WEB_RETURN_PATH`도 `/app/auth/done.html`로 조정.

## PWA 설치

iOS Safari: 공유 → 홈 화면에 추가  
Android Chrome: 메뉴 → 앱 설치  
데스크탑 Chrome: 주소창 우측 설치 아이콘

홈 화면에서 일반 앱처럼 실행 (전체화면, 푸시 알림 가능).
