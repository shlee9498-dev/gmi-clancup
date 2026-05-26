/* ============================================
   헤즈업 홀덤 라이브 보드 (SSE)
   ============================================ */

const matchId = parseInt(new URLSearchParams(location.search).get("id") || "0");
if (!matchId) {
  document.getElementById("board").innerHTML =
    `<div class="empty">매치 ID가 잘못되었습니다.</div>`;
  throw new Error("no match id");
}

const me = requireAuth();
if (me) {
  renderNav();
  renderFooter();
  document.getElementById("title").textContent =
    `1:1 헤즈업 홀덤 #${matchId}`;
  startStream();
}

let evtSource = null;
let reconnectTimer = null;

function startStream() {
  const url = `${API_BASE}/api/holdem/${matchId}/stream`;
  evtSource = new EventSource(url);

  evtSource.addEventListener("update", (e) => {
    try {
      const state = JSON.parse(e.data);
      renderBoard(state);
    } catch (err) {
      console.error("update parse error", err);
    }
  });

  evtSource.addEventListener("ended", () => {
    console.log("match ended");
    evtSource.close();
  });

  evtSource.addEventListener("error", () => {
    if (evtSource.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(startStream, 3000);
    }
  });

  // 초기 1회 스냅샷
  api(`/api/holdem/${matchId}/snapshot`)
    .then(renderBoard)
    .catch(e => {
      document.getElementById("board").innerHTML =
        `<div class="empty">로드 실패: ${e.message}</div>`;
    });
}

// ===== 카드 렌더링 =====

const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_NAME = { 14: "A", 13: "K", 12: "Q", 11: "J" };

function cardFromId(cid) {
  return { rank: Math.floor(cid / 4), suit: ["S","H","D","C"][cid % 4] };
}

function cardHTML(cid, opts = {}) {
  if (opts.folded) return `<div class="h-card folded"></div>`;
  if (cid == null || cid === undefined) {
    if (opts.empty) return `<div class="h-card empty"></div>`;
    return `<div class="h-card back">?</div>`;
  }
  const { rank, suit } = cardFromId(cid);
  const rg = RANK_NAME[rank] || String(rank);
  const sg = SUIT_GLYPH[suit];
  const color = (suit === "H" || suit === "D") ? "red" : "black";
  return `
    <div class="h-card ${color}">
      <div class="top-rank">${rg}${sg}</div>
      <div class="center-suit">${sg}</div>
      <div class="bot-rank">${sg}${rg}</div>
    </div>
  `;
}

const STREET_LABEL = {
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
  showdown_done: "Showdown",
  ended: "종료",
};

const STREETS = ["preflop", "flop", "turn", "river"];

function streetProgressHTML(currentStreet) {
  const curIdx = STREETS.indexOf(currentStreet);
  return STREETS.map((s, i) => {
    let cls = "street-step";
    if (i === curIdx) cls += " active";
    else if (curIdx > i || ["showdown", "showdown_done", "ended"].includes(currentStreet)) cls += " done";
    return `<div class="${cls}">${STREET_LABEL[s]}</div>`;
  }).join("");
}

// ===== 보드 렌더 =====

function renderBoard(state) {
  const m = state.match;
  const h = state.current_hand;

  const isC = me.sub === m.challenger_id;
  const isO = me.sub === m.opponent_id;
  const isViewer = !isC && !isO;

  // 본인 시점: 본인이 도전자/상대 어느 쪽인지에 따라 위/아래 배치
  // 위(top) = 상대, 아래(bottom) = 본인
  // 관전자: 도전자 위, 상대 아래
  let topRole, bottomRole;
  if (isC) { topRole = "O"; bottomRole = "C"; }
  else if (isO) { topRole = "C"; bottomRole = "O"; }
  else { topRole = "C"; bottomRole = "O"; }

  const cName = m.challenger_name || "도전자";
  const oName = m.opponent_name || "상대";

  const isLive = m.status === "in_progress";
  const hand_no = h ? h.hand_no : 0;
  const street = h ? h.street : "preflop";

  let community = h ? (h.community || []) : [];
  // 5장 슬롯 채우기 (아직 안 나온 카드는 빈/뒷면)
  while (community.length < 5) community.push(null);

  // 양쪽 정보
  const C = {
    name: cName,
    chips: m.c_chips,
    bet: h ? h.c_bet : 0,
    status: h ? h.c_status : "pending",
    isMe: isC,
    isDealer: h && h.dealer === "C",
    hole: h ? h.c_hole : null,
  };
  const O = {
    name: oName,
    chips: m.o_chips,
    bet: h ? h.o_bet : 0,
    status: h ? h.o_status : "pending",
    isMe: isO,
    isDealer: h && h.dealer === "O",
    hole: h ? h.o_hole : null,
  };

  const topSide = topRole === "C" ? C : O;
  const bottomSide = topRole === "C" ? O : C;

  // 상태 텍스트
  let statusHTML = "";
  let statusClass = "";
  if (m.status === "ended") {
    statusClass = "ended";
    if (m.winner_id) {
      const winName = m.winner_id === m.challenger_id ? cName : oName;
      const reasonLabel = ({
        hand_cap: "50핸드 완료",
        chips_zero: "한쪽 칩 소진",
        forfeit: "자유 종료",
      })[m.end_reason] || m.end_reason;
      statusHTML = `🏆 매치 승자: ${winName} · ${reasonLabel} · 정산 완료`;
    } else {
      statusHTML = "매치 종료";
    }
  } else if (m.status === "expired") {
    statusClass = "ended";
    statusHTML = "도전 만료";
  } else if (m.status === "declined") {
    statusClass = "ended";
    statusHTML = "도전 거절";
  } else if (m.status === "pending") {
    statusClass = "ended";
    statusHTML = "도전 대기 중";
  } else if (!h) {
    statusHTML = "핸드 시작 대기";
  } else if (h.street === "showdown_done") {
    statusClass = "ended";
    const winName = h.winner_role === "C" ? cName
                  : h.winner_role === "O" ? oName : "동률";
    statusHTML = `핸드 #${h.hand_no} ${winName === "동률" ? "동률" : winName + " 승"}`;
  } else if (h.turn) {
    const isMyTurn = (isC && h.turn === "C") || (isO && h.turn === "O");
    if (isMyTurn) {
      statusClass = "my-turn";
      statusHTML = `▶ 내 차례 — 디스코드 채널에서 /홀덤콜 · /홀덤레이즈 · /홀덤폴드 · /홀덤체크 · /홀덤올인`;
    } else {
      const turnName = h.turn === "C" ? cName : oName;
      statusHTML = `▶ ${turnName} 차례 (30초)`;
    }
  } else {
    statusHTML = `${STREET_LABEL[street]} 진행 중`;
  }

  const showdownPhase = h && (h.street === "showdown_done" || h.street === "ended");

  document.getElementById("board").innerHTML = `
    <div class="holdem-stage">
      <div class="holdem-head">
        <div class="title">
          <span class="status ${isLive ? 'live' : 'ended'}">
            ${isLive ? 'LIVE' : '종료'}
          </span>&nbsp;
          매치 #${m.id} · 핸드 #${hand_no}
        </div>
        <div class="meta">
          블라인드 5 / 10 · Buy-in ${m.buyin_real}코인
        </div>
      </div>

      <div class="street-progress">${streetProgressHTML(street)}</div>

      <div class="holdem-table">

        <!-- 위쪽 좌석 -->
        <div class="seat top ${topSide.isMe ? 'me' : ''} ${topSide.status === 'folded' ? 'folded' : ''}">
          <div class="seat-info">
            <div class="seat-name">
              ${topSide.name}${topSide.isMe ? " (나)" : ""}
              ${topSide.isDealer ? '<span class="dealer-btn">D</span>' : ''}
            </div>
            <div class="seat-chips">칩: ${topSide.chips}</div>
          </div>
          ${topSide.bet > 0 ? `<div class="seat-bet">${topSide.bet}</div>` : ''}
          <div class="seat-hole">
            ${holeHTML(topSide, showdownPhase)}
          </div>
        </div>

        <!-- POT -->
        <div class="pot-display">
          <div class="lbl">POT</div>
          <div class="pot-chip">${h ? h.pot : 0}</div>
        </div>

        <!-- 커뮤니티 -->
        <div class="community">
          ${community.map((c, i) => {
            if (c == null) {
              // 보드 진행 단계에 따라 뒷면 vs 빈 슬롯
              const idxRevealed = ({preflop:0, flop:3, turn:4, river:5, showdown:5, showdown_done:5, ended:5})[street] || 0;
              return cardHTML(null, i < idxRevealed ? {} : { empty: true });
            }
            return cardHTML(c);
          }).join("")}
        </div>

        <!-- 아래쪽 좌석 -->
        <div class="seat bottom ${bottomSide.isMe ? 'me' : ''} ${bottomSide.status === 'folded' ? 'folded' : ''}">
          <div class="seat-hole">
            ${holeHTML(bottomSide, showdownPhase)}
          </div>
          ${bottomSide.bet > 0 ? `<div class="seat-bet">${bottomSide.bet}</div>` : ''}
          <div class="seat-info">
            <div class="seat-name">
              ${bottomSide.name}${bottomSide.isMe ? " (나)" : ""}
              ${bottomSide.isDealer ? '<span class="dealer-btn">D</span>' : ''}
            </div>
            <div class="seat-chips">칩: ${bottomSide.chips}</div>
          </div>
        </div>

      </div>

      <div class="holdem-status ${statusClass}">${statusHTML}</div>
    </div>
  `;

  // 핸드 히스토리 별도 로드
  loadHands();
}

function holeHTML(side, showdownPhase) {
  if (side.status === "folded") {
    return cardHTML(null, { folded: true }) + cardHTML(null, { folded: true });
  }
  if (showdownPhase && side.hole) {
    return cardHTML(side.hole[0]) + cardHTML(side.hole[1]);
  }
  // 진행 중 — 양쪽 다 뒷면 (본인 카드는 DM으로)
  return cardHTML(null) + cardHTML(null);
}

async function loadHands() {
  try {
    const data = await api(`/api/holdem/${matchId}`);
    const hands = data.hands || [];
    const m = data.match;
    const tbody = document.querySelector("#hands-table tbody");
    if (!hands.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">아직 핸드 없음</td></tr>`;
      return;
    }
    const cName = m.challenger_name || "도전자";
    const oName = m.opponent_name || "상대";
    tbody.innerHTML = hands.slice().reverse().map(h => {
      let result = "";
      if (h.street === "showdown_done" || h.street === "ended") {
        if (h.winner_role === "C") result = `${cName} 승`;
        else if (h.winner_role === "O") result = `${oName} 승`;
        else result = "동률";
      } else {
        result = `<span style="color:var(--warn)">진행 중 (${STREET_LABEL[h.street]})</span>`;
      }
      const dealerName = h.dealer === "C" ? cName : oName;
      return `
        <tr>
          <td><b>#${h.hand_no}</b></td>
          <td>${dealerName} (SB)</td>
          <td class="amount">${h.pot}</td>
          <td>${result}</td>
        </tr>
      `;
    }).join("");
  } catch (e) {
    console.warn("hands load:", e);
  }
}
