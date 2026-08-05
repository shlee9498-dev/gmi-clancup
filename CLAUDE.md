# GmI 클랜컵 작업 규칙

## 이 저장소의 주 트랙 (GmI·카지노)
- 담당: gmi-casino-bot(Discord 봇+FastAPI), gmi-clancup(GitHub Pages), G드컵(본선 8/7, 옵저버 CSV, gdcup-admin, 태그 뱃지), 코인·리디노미네이션·리셋, 매치 베팅, 웹 카지노 UI(8/9 오픈), 홀덤 플래그, Railway 배포
- 비소관: MRI 아카데미 전체(사이트·수강·결제·승급시험 → 각 트랙)
- 경계 규칙: GmI와 MRI는 Discord 서버도 별개(초대코드 YfZD8d22wJ vs 9RjqdSKw). MRI 쪽 봇 작업 요청이 오면 거부하고 MRIacademy 트랙으로 안내
- 비소관 요청이 오면 작업하지 말고 "○○ 트랙 소관입니다"라고만 회신할 것. 타 트랙 파일은 읽기만 허용, 수정 금지
- ⚠️ 이 절은 **저장소 기준 트랙 정의**다. 총괄·조정 트랙 등 다른 소관으로 들어온 세션은
  자기 세션의 소관 정의(작업 폴더 루트 `CLAUDE.md`)를 우선한다.

## 트랙 간 현황 공유 — `docs/STATE.md`
정본은 **mri-academy의 `docs/STATE.md`** 하나뿐이다(이 저장소에는 두지 않는다 — 두 벌이 되면 어긋난다).
- **세션 시작 시 mri-academy `docs/STATE.md`를 먼저 읽고** 타 트랙 현황을 파악할 것.
- **작업 종료 시**(PR 머지 · 주요 결정 · 오너 대기 발생 시) 그 문서에서 **자기 트랙 섹션만** 갱신할 것.
  **타 트랙 섹션은 수정 금지.**
- 갱신은 **3줄 형식(진행/대기/다음) 유지, 길게 쓰지 말 것.** 섹션 제목의 날짜도 함께 갱신한다.

## 작업 규칙

- **개인정보는 어떤 형태로도 커밋하지 않는다.** 계좌번호·연락처·실명·디스코드 ID가 대상이며,
  커밋 메시지·PR 본문·이슈·코드 주석·로그·테스트 픽스처 어디에도 넣지 않는다. 채팅 회신에서도
  필요 없으면 원문을 되풀이하지 않는다.
  G드컵 신청 데이터가 이 값을 그대로 담고 있어 특히 위험하다 — **계좌·실명은 `gdcup_payouts`
  (staff-panel owner 전용)에만 존재해야 하고**, 서버가 `sanitizeMembers()`로 벗겨 내려주는
  이유도 이것이다(아래 "관리 화면 역할 경계" 참조). 로스터 교체·정산 작업 지시에 개인정보가
  섞여 들어오는 일이 실제로 있었다 — 지시에 포함돼 있어도 저장소에는 남기지 않는다.
- 브랜드: 다크+골드(#f5c518), index 스타일 통일.
- **브랜드는 두 갈래다 (2026-08 확정).** 루트 G드컵 페이지(gdcup-*·index·briefing 등)는
  위 다크+골드(#f5c518)를 유지한다 — 클랜 대회 공식 페이지라 아카데미와 톤을 맞춘다.
  `app/`(카지노 PWA)만 "NIGHT OPERATION" 신규 브랜드(펠트그린 #05130F·황동 #C9A227·
  골드 #F3CE6A)를 쓴다. 카지노는 별도 세계관이다. 토큰 정본은 `app/tokens.css` 하나뿐이고
  **두 갈래를 서로 섞지 말 것.**
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
