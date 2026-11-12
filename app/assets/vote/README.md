# GmI 투표소 그림 · 소리 자리 (총무가 만들어 넘김 · 2026-11-13)

파일을 이 폴더에 넣고 `app/vote.js` 맨 위 `HOST` 표에 이름만 적으면 붙는다. BGM은 이름만 맞추면 바로 붙는다.

| 파일 | 형식 · 크기 | 쓰는 곳 |
|---|---|---|
| host-greet.webm · host-hand.webm · host-wait.webm · host-cheer.webm · host-announce.webm | WebM(VP9 알파) 720×720 · 2~5초 · 각 1.5MB 이하. MP4만 있으면 단색 #00FF00 배경 1080×1080 으로 주면 변환한다 | 유비서 선관위원: 맞이 · 용지 건넴 · 도장 기다림(반복) · 투표함 뒤 반응 · 개표 발표 |
| host-greet.png … (같은 이름 .png) | 512×512 투명 PNG | 움직임 줄이기 설정 · 느린 폰 |
| stamp.png · stamp-ink.png | 512×512 투명 PNG | 도장 손잡이 · 찍힌 자국 |
| ballot.webp | 1080×1500 | 투표용지 바탕(선택지 칸은 비워 둠 · 글자는 코드로) |
| box-front.png · box-back.png | 1024 투명 PNG | 투표함 앞판 · 뒤판(용지가 사이로 들어감) |
| bgm.ogg · bgm.mp3 | 60~90초 끊김 없는 반복 · −16 LUFS · 1.5MB 이하 | 소리 켜짐일 때만 · 볼륨 0.22 |
| sfx-stamp · sfx-fold · sfx-drop · sfx-fanfare · sfx-click (.ogg) | 0.3~1초 · 100KB 이하 | 지금은 Web Audio 합성 소리로 대신함 |

지킬 것: 방송 프로그램 · 실제 선관위 로고 · 정당색 금지(브레인 챌린지 지킬 선과 같음). 우리가 만든 것만.
