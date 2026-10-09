# 클랜CODE 인수인계 — 2026-10-09 (본컴 세션 → 웹 세션)

> 클랜CODE = GmI 클랜 쪽 저장소 담당(gmi-clancup 화면 · gmi-casino-bot · mri-academy 안의 킬내기 화면 짝 코드).
> 주문은 지휘(Claude 챗)가 `[지휘 → 클랜CODE]` 로, 회신은 `[클랜CODE → 지휘]` 복붙 블록 + 「직원 완료 초인종」(RemoteTrigger run `trig_01J8SncmJJQLtB9t7nK2cZmU` · 글 없이).
> 이 문서에는 이름 · 디스코드 번호 · 계좌 · env 값이 없다. 값은 Railway Variables 에만 있다.

## 1. 저장소 · 브랜치 · 배포

| 저장소 (GitHub shlee9498-dev/…) | 역할 | 배포 | 쓰는 브랜치(10/9) |
|---|---|---|---|
| `gmi-clancup` | 킬내기 화면 전부(신청 · 점수판 · 오버레이 · 개인 기록 · 경매 · +1킬 · **앱 `killrace/`**) · G드컵 공개 화면 · 카지노 PWA `app/` | GitHub Pages — `main` 머지 = 즉시 공개 (`https://shlee9498-dev.github.io/gmi-clancup/`) | `feat/killrace-app-prize`(Draft #105) · `handoff/clancode`(이 문서) |
| `mri-academy` | 킬내기 서버 전부(`killrace*.cjs` · `server.js` 킬내기 블록) — **지금은 경비(MRIacademy 세션)가 대행** | Railway 서비스 `mri-academy` (`https://mri-academy-production.up.railway.app`) · 정적은 Pages | 클랜CODE 가 만든 브랜치는 전부 머지됨. 열린 것 없음 |
| `gmi-casino-bot` | 카지노 봇 + FastAPI(코인 장부 SQLite · Railway 볼륨) | Railway (Procfile `worker` 봇 · `web` API) · **9/8 이후 커밋 없음 · 휴면** | `main` 만. 변경 없음 |

- 역할군(추첨) 봇은 코드가 없다 — 설계 문서만 mri-academy `docs/role-event-bot-design.md`(#425 · Draft). 리더보드 역할 봇도 아직 코드 없음(아래 3).
- 대회 · 행사 시간 머지 금지 · main 직푸시 금지 · env 추가는 이름 · 위치만 보고(값은 오너).

## 2. 열린 PR · 진행 중

| PR | 상태 | 내용 | 다음 |
|---|---|---|---|
| gmi-clancup **#105** | Draft | 킬내기 앱 1화면 — `killrace/` 내 상금 · 지급 요청 + 로그인 · 동의 · 스팀 연결. 계약 = mri-academy `docs/killrace-api.md` §1.20 · `docs/killrace-app-api.md` §1~§4 | **머지 순서**: mri-academy #537 머지 → DDL §70 실행 → #544 머지 → #105 Ready → 검수 → 머지. 그 뒤 운영 실측 3화면(잔액 8만 칩 켜짐 · 21,250 3만 원 안내 · 잔액 0 지급 이력) — 시험 줄을 운영 DB 에 넣지 않는다 |
| gmi-clancup #104 | Draft | 경매 §1.4a 화면(경비 측 작업 · 클랜CODE 것 아님) | — |
| mri-academy #534 #536 #537 #538 #541 #542 #544 #520 | Draft/Open | 경비가 쓴 킬내기 서버 PR 들. 화면 짝은 #534 문서대로 `killrace/` 에 클랜CODE 가 만든다 | #105 가 그 첫 화면 |

경비가 아직 안 준 것(#105 에 들어갈 자리는 있음): 「본인 확인 전」 `reason` 코드 이름(#105 는 `not_verified` · `unverified` 로 받아 둠).

## 3. 다음 할 일 (우선순위)

1. **#105 머지 흐름 완주**(위 표) → 실측 → 지휘 보고.
2. **리더보드 역할 봇**(지휘 10/9 주문 · 오너 OK 뒤 구현). 계약 = mri-academy `docs/killrace-api.md` **§1.18**(`GET /api/killrace/leaderboard` · 1~10위 · `group` 1 / 2-4 / 5-10 · 계정 번호는 진행자 키 호출에만).
   - 드라이런(10/9 02:30 · 읽기만) 결과: 10명 중 클랜 등록계(`clan_registry`)로 디스코드에 이어지는 사람 **4명**, 못 이은 사람 6명. 역할 3개(「킬내기 1위」 금 · 「킬내기 2~4위」 은 · 「킬내기 5~10위」 동 · hoist · 마스터 아래 m 위)는 오너가 만든다.
   - 구현 자리: mri-academy `killrace-leaderboard.cjs`(봇 = `server.js` 디스코드 봇 · GmI 길드 `LESSON_GUILD_ID`). 매주 수 09:00 KST + 회차 마감 직후 → 차이만 붙이고 떼기 → `#킬내기` 고정 메시지 하나 수정.
   - 필요한 env(이름만 · 오너가 만듦): `KILLRACE_LB_ROLE_1` · `KILLRACE_LB_ROLE_2_4` · `KILLRACE_LB_ROLE_5_10` · `KILLRACE_LB_CHANNEL_ID`.
   - 판단 대기: 잇는 표를 등록계만 쓸지 앱 회원(`killrace_members` · §70)도 쓸지 · 못 이은 6명을 어떻게 잇나.
3. 카지노 연동은 1단계 밖(10/7 확정 6). 조사 결과는 10/7 보고에 있다 — 장부 = gmi-casino-bot SQLite(`wallets` · `ledger` · `burn_log` · `db.py:51~85`), 사람 = 디스코드 번호, 밖에서 부르는 지급 API 없음(만들면 라우트 2개 + 서버 키 + idem 표), 코인 → 기프티콘 상점 있음(`cogs/_shop.py`).

## 4. 1회 킬내기(9/26) 개인 기록 건 — **보관 기한 10/10**

- 운영 DB 에 1회 팀 · 판 기록은 **0줄**(event_defs id 1 행만). 되살릴 원본은 PUBG 전적뿐이고 14일 보관 → **10/10 쯤 사라진다**.
- 찾은 것: 6팀 명단(디코 이름)은 오너 아티팩트 「대승배 GmI 킬내기 — 최종 결과」(`claude.ai/artifact/9mX6DsRHfVM82M1erT4245`)에, 스팀 닉은 1회 신청 기록(`gdcup_solos` season 9 · 15명)에서 **9명 확실 · 2명 추정 · 7명 모름**. 10/5 보고에 표가 있다(지휘 대화).
- 끝내는 길: 스팀 닉 18개(팀별) 확보 → (가) 오너 `/킬내기팀등록` ×6 + `/킬내기집계` — 단 「현재 대회」가 최신 회차라 1회 창으로 안 잡힘 → 경비 설정 한 줄 필요 / (나) 경비가 일회용 읽기 길(회차 + 닉 18개 → `event_match_players` 더하기만) PR. **명단이 10/9 안에 와야 한다.** 오너 「저장돼 있다」는 디스코드(집계 DM 카드 · 공지)일 가능성이 가장 높다 — 거기는 못 봤다.

## 5. 로컬에만 있고 깃에 없는 것

| 경로(본컴) | 무엇 | 왜 깃에 없나 |
|---|---|---|
| `C:\Users\User\gmi-clancup-apply` · `C:\Users\User\mri-academy-killrace` · `C:\Users\User\mri-academy-krapply` | git worktree(브랜치별 작업 사본). 내용은 전부 푸시됨 | 작업 사본일 뿐 |
| `%LOCALAPPDATA%\Temp\claude\C--Users-User\4c6f5547-…\scratchpad\` | 가짜 서버 2개(`prize-dev.cjs` · `apply-dev.cjs`) · 캡처 스크립트(`shots*.cjs`) · 패치 스크립트 · PR 본문 초안 · 캡처 PNG | 세션 임시 폴더. 쓸모 있는 둘은 이 PR 의 `scripts/local/` 로 옮겼다(아래) |
| `C:\Users\User\Desktop\10-6 킬내기.txt` · `대승배2회_킬내기_*.png` | 오너 메모 · 캡처 | 오너 파일 |

이 PR 에 같이 넣은 것: `scripts/local/prize-dev.cjs`(앱 「내 상금」 가짜 서버) · `scripts/local/apply-dev.cjs`(신청 폼 가짜 서버) · `scripts/local/shots-prize.cjs`(폰 360 캡처 흐름). 셋 다 가짜 값만 · express · playwright 경로를 자기 환경에 맞게 고쳐야 한다(파일 머리 주석).
mri-academy 쪽 연습 서버는 이미 깃에 있다: `scripts/killrace-auction-dev.cjs`(경매 · 점수판 · 자동 집계 · 잠정 킬 · 개인 기록 — `node scripts/killrace-auction-dev.cjs <gmi-clancup 폴더>` → `localhost:4310`).

## 6. 이 PC 에서만 되던 것 (이름만)

| 무엇 | 어디에 필요 | 웹 세션에서 |
|---|---|---|
| 운영 DB 읽기(Supabase MCP 커넥터) | 드라이런 · 실측 조회(읽기만) | 커넥터를 다시 붙여야 한다. 값은 안 받는다 |
| 운영 API 공개 길 `curl`(`/api/killrace/board` · `leaderboard` 등) | 배포 확인 | 된다(열린 주소) |
| 로컬 브라우저 캡처(playwright-core · `C:/Users/User/mri-student-app/.ds-sync/node_modules`) | 화면 PR 캡처 | 웹 세션은 자기 환경에 playwright 를 깔거나 Chrome 도구로 |
| `gh`(GitHub CLI · 로그인됨) | PR 만들기 · 머지 | 웹 세션은 GitHub 앱 권한으로 |
| PUBG 전적 조회 | 1회 기록 되살리기 · 닉 확인 | **본컴에도 없었다**(`PUBG_API_KEY` 는 Railway 만). 운영 서버의 명령 · 길로만 |
| 디스코드 봇 조작 | 역할 드라이런 실부여 | 없었다(`DISCORD_TOKEN` 은 Railway 만) |

## 7. 규칙 요약(이 저장소 `CLAUDE.md` 와 같다)

- 킬내기 화면은 **라이트 토큰**(`killnaegi.html` `:root`) · 루트 G드컵 다크+골드 · `app/` 카지노 브랜드와 섞지 않는다 · `impeccable detect` 무출력(외부 CSS 는 못 보니 본문 글꼴 한 줄은 페이지 안에).
- 문구: 「~요」체 · 한 줄 마침표 없음 · 이모지 · 느낌표 화면당 0~1 · 금지어(확실하게 · 완벽하게 · 체계적으로 · 특별한 · 최고의 · 함께 성장 · 여러분의).
- 계좌 · 디스코드 번호 · PUBG 계정 번호는 화면 · 응답 · 문서 어디에도 싣지 않는다.
- 이 환경 메모: Bash heredoc 이 `\\` 를 `\` 로 줄였다 — 백슬래시가 든 패치는 파일로 써서 돌렸다.
