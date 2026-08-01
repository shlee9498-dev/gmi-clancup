# GmI 클랜컵 작업 규칙
- 브랜드: 다크+골드(#f5c518), index 스타일 통일.
- **디자인 계약: mri-academy의 DESIGN.md v2·PRODUCT.md 준수** (2026-07 리디자인 확정).
  AI 티 5대 패턴 금지, 페이지 작업 후 impeccable detect 무출력까지 수정
  (`node <mri-academy>/.claude/skills/impeccable/scripts/detect.mjs <파일>` — v4, 인라인 예외 지원).
- 시즌3 점수: (순위점+킬+연속보너스) × BPI 가중치.
- **가중치표·BPI 스케일·팀 상한의 정본은 server.js(mri-academy)의 `GDCUP_WEIGHT_S3` 하나뿐이다.**
  gdcup-s3.html은 `GET /api/gdcup-meta`로 받아 쓴다 — **프론트에 표를 복제하지 말 것.**
  (과거 양쪽 하드코딩이 어긋나 신청자에게 구 표 ×1.0 구간 22~23이 표시된 사고가 있었다.
   S급 13점 도입으로 합산 총량이 올라 현재 정본은 29~32=×1.00, 상한 38·S급 팀당 1명.
   상한은 2026-08-01에 36→38로 상향됐다 — 이 숫자를 프론트 본문에 적지 말고 meta.cap.team으로 렌더할 것.)
- 연속보너스는 서버 자동계산 — 폼/입력페이지에 입력칸 추가 금지.
  시즌3부터: 연속 Top4 +2 · 연속 치킨 +4(+2 대체), **BPI 곱하기 전** 라운드 점수에 합산.
  수치 정본은 server.js `GDCUP_SEASONS[3].streak` (시즌2 기록은 구 규칙 +2/+5로 동결).
- 점수 리셋(truncate)은 자동화 금지, 사용자가 Supabase 콘솔에서 직접.
- 커밋 전 변경 요약을 먼저 보고하고 승인받는다.

## G드컵 관리 화면 역할 경계 (2026-07 확정)
두 화면이 공존한다. **계좌·실명은 staff-panel에만 있다.**
- **gdcup-admin.html** (gmi-clancup, GitHub Pages) — 운영 조작: 팀 확정·수정·보드·솔로 관리.
  `x-admin-key` 헤더 게이트. 서버가 `sanitizeMembers()`로 계좌·실명을 벗겨 내려주므로
  **이 화면에서는 계좌·실명에 접근할 수 없다.** 새 기능을 붙일 때 이 경계를 넘지 말 것.
- **staff-panel.html** (mri-academy, Vercel) — 계좌·실명 열람 + 정산 CSV. JWT owner 인증
  (`/api/gdcup-payouts*`는 owner 전용, staff가 직접 호출해도 403).

## 시즌 파라미터 규칙
- 서버 `gdSeason()`은 season 미지정 시 **현재 시즌**(`GDCUP_CURRENT_SEASON`)으로 폴백한다.
- 따라서 **아카이브 페이지는 season을 반드시 명시**해야 한다 (`gdcup-s2.html` = `season=2`).
  생략하면 현재 시즌 데이터가 뜬다. 과거에 폴백이 `2`로 하드코딩돼 있어
  `gdcup-admin.html`이 시즌3 운영 중 시즌2를 보고 있던 사고가 있었다.
- 운영·방송용 페이지(results·overlay·kill-mvp·team-brand·gdcup-add·gdcup-score)는
  **현재 시즌**이 기본이므로 season을 생략해도 된다.
- 시즌 목록·현재 시즌은 `GET /api/gdcup-meta`의 `seasons`·`currentSeason`에서 받는다.
  **프론트에 시즌 목록을 하드코딩하지 말 것** — 시즌이 늘 때 프론트 수정이 필요해진다.
