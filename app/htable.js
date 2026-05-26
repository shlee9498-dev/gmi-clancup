/* GmI 멀티 캐시 게임 라이브 보드. */

const id_key = new URLSearchParams(location.search).get("id");
if (!id_key) {
  document.getElementById("board").innerHTML =
    `<div class="empty">테이블 ID 누락</div>`;
  throw new Error("no id");
}

const me = requireAuth();
if (me) {
  renderNav();
  renderFooter();
  connectStream();
  loadHistory();
}

let lastSnap = null;
let evtSource = null;
let reconnectTimer = null;
let actionBusy = false;

function connectStream() {
  const token = getToken();
  const url = `${API_BASE}/api/htable/${id_key}/stream?token=${encodeURIComponent(token)}`;
  evtSource = new EventSource(url);

  evtSource.addEventListener("update", (e) => {
    try {
      const snap = JSON.parse(e.data);
      render(snap);
    } catch (err) {
      console.error("snap parse error", err);
    }
  });

  evtSource.addEventListener("error", () => {
    if (evtSource.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectStream, 3000);
    }
  });
}

// ===== 카드 =====
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

// ===== 렌더 =====

function render(snap) {
  if (!lastSnap) {
    document.getElementById("table-title").textContent =
      `🃏 ${snap.table.name} (${snap.table.stake})`;
  }
  document.getElementById("table-meta").textContent =
    `Buy-in ${snap.table.min_buyin}~${snap.table.max_buyin}코인 · 핸드 #${snap.hand_no}`;

  renderBoard(snap);
  renderActions(snap);

  // 핸드 결과 감지
  if (snap.last_summary && (!lastSnap?.last_summary ||
      lastSnap.last_summary.hand_no !== snap.last_summary.hand_no)) {
    // 새 결과
    loadHistory();
  }

  lastSnap = snap;
}

function renderBoard(snap) {
  const seats = snap.seats || [];
  const hseats = {};
  (snap.hand_seats || []).forEach(h => hseats[h.seat_no] = h);

  // 본인 seat 찾기 (있을 수도, 없을 수도)
  const meIdx = seats.findIndex(s => s.discord_id === me.sub);
  // 좌석 회전: 본인이 위치 0(아래)에 오도록
  // viewPosition = (seatNo - meIdx + 6) % 6, 본인 없으면 그대로
  const rotate = (raw) => {
    if (meIdx < 0) return raw;
    return (raw - meIdx + 6) % 6;
  };

  // 좌석 렌더
  const seatHTML = seats.map(s => {
    const pos = rotate(s.seat_no);
    const h = hseats[s.seat_no];
    const isMe = s.discord_id === me.sub;
    const isEmpty = !s.discord_id;
    const isTurn = snap.turn_seat === s.seat_no &&
                   ["preflop","flop","turn","river"].includes(snap.phase);
    const isFolded = h && h.status === "folded";
    const isAllin = h && h.status === "allin";

    let cls = `ht-seat pos-${pos}`;
    if (isMe) cls += " me";
    if (isEmpty) cls += " empty";
    if (isTurn) cls += " turn";
    if (isFolded) cls += " folded";
    if (s.sit_out) cls += " sitout";

    if (isEmpty) {
      return `
        <div class="${cls}" onclick="openSitModal(${s.seat_no})">
          <div class="seat-info-box">
            <div>+ 앉기</div>
            <div style="font-size:10px; margin-top:2px;">좌석 ${s.seat_no + 1}</div>
          </div>
        </div>
      `;
    }

    // hole cards (showdown 시 또는 본인)
    let holeHTML = '';
    if (h && h.status !== "folded") {
      if (snap.phase === "showdown" && h.hole) {
        holeHTML = `
          <div class="seat-hole-mini">
            ${cardHTML(h.hole[0])}${cardHTML(h.hole[1])}
          </div>`;
      } else if (h.status === "allin" || h.status === "active" || h.status === "pending") {
        // 진행 중 — 본인은 큰 카드 별도, 다른 사람은 뒷면
        if (!isMe) {
          holeHTML = `
            <div class="seat-hole-mini">
              ${cardHTML(null)}${cardHTML(null)}
            </div>`;
        }
      }
    } else if (h && h.status === "folded") {
      holeHTML = `<div class="seat-hole-mini">${cardHTML(null,{folded:true})}${cardHTML(null,{folded:true})}</div>`;
    }

    const isDealer = snap.dealer_seat === s.seat_no;
    const betChip = (h && h.bet_this_street > 0)
      ? `<div class="seat-bet-chip">${h.bet_this_street}</div>` : '';

    const statusLine = s.sit_out ? '💤 sit out'
                     : (h ? ({
                         pending: '⏳',
                         active: '✓',
                         folded: '✕',
                         allin: '🔥 ALL-IN',
                       })[h.status] || '' : '대기');

    return `
      <div class="${cls}">
        <div class="seat-info-box">
          <div class="seat-name-line ${isMe ? 'me' : ''}">
            ${s.name || '?'}${isMe ? ' (나)' : ''}
            ${isDealer ? '<span class="dealer-button-mini">D</span>' : ''}
          </div>
          <div class="seat-chips-line">${fmtCoin(s.chips)} 칩</div>
          <div style="font-size:10px; color:var(--text-sub); margin-top:2px;">${statusLine}</div>
        </div>
        ${holeHTML}
        ${betChip}
      </div>
    `;
  }).join("");

  // 커뮤니티 카드 (5장 슬롯)
  const community = snap.community || [];
  let communityHTML = '<div class="ht-community">';
  for (let i = 0; i < 5; i++) {
    const revealedCount = community.length;
    if (i < revealedCount) {
      communityHTML += cardHTML(community[i]);
    } else {
      communityHTML += cardHTML(null, { empty: true });
    }
  }
  communityHTML += '</div>';

  // 본인 hole (큰 표시)
  let myHoleHTML = '';
  if (snap.my_hole && meIdx >= 0) {
    const isMyFolded = hseats[meIdx]?.status === 'folded';
    if (!isMyFolded) {
      myHoleHTML = `
        <div class="my-hole-display">
          ${cardHTML(snap.my_hole[0])}${cardHTML(snap.my_hole[1])}
        </div>
      `;
    }
  }

  // 본인 좌석에 있을 때 sitout 토글
  let sitoutBtn = '';
  if (meIdx >= 0) {
    const mySeat = seats[meIdx];
    sitoutBtn = `
      <button class="sitout-toggle ${mySeat.sit_out ? 'active' : ''}"
              onclick="toggleSitout()">
        ${mySeat.sit_out ? '🪑 자리 돌아오기' : '💤 잠시 쉬기'}
      </button>
    `;
  }

  // 결과 표시
  let resultHTML = '';
  if (snap.last_summary && snap.phase === "between_hands") {
    const s = snap.last_summary;
    let winLines = (s.winners || []).map(w => `
      <div style="font-size:13px; margin:2px 0;">
        ${w.name}  <span style="color:var(--gold); font-weight:800;">+${w.payout}</span>
        ${w.hand ? `<span style="color:var(--text-sub); font-size:11px;"> · ${w.hand}</span>` : ''}
      </div>
    `).join("");
    resultHTML = `
      <div class="hand-result">
        <div class="hand-result-head">핸드 #${s.hand_no} ${s.type === 'showdown' ? 'Showdown' : '폴드 종료'}</div>
        ${winLines}
        ${s.rake ? `<div style="font-size:11px; color:var(--text-dim); margin-top:4px;">Rake -${s.rake}</div>` : ''}
      </div>
    `;
  }

  document.getElementById("board").innerHTML = `
    ${resultHTML}
    <div class="ht-table">
      ${sitoutBtn}
      ${seatHTML}
      <div class="ht-pot-display">
        <div class="lbl">POT</div>
        <div class="amt">${snap.pot}</div>
      </div>
      ${communityHTML}
      ${myHoleHTML}
    </div>
  `;
}

function renderActions(snap) {
  const el = document.getElementById("action-bar");
  const myHandSeat = (snap.hand_seats || []).find(
    h => h.discord_id === me.sub
  );
  const isMyTurn = snap.turn_seat != null &&
    (snap.seats[snap.turn_seat]?.discord_id === me.sub);
  const inPhase = ["preflop", "flop", "turn", "river"].includes(snap.phase);

  if (!isMyTurn || !inPhase || !myHandSeat ||
      myHandSeat.status === "folded" || myHandSeat.status === "allin") {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");

  const diff = snap.current_bet - myHandSeat.bet_this_street;
  const mySeat = snap.seats.find(s => s.discord_id === me.sub);
  const chips = mySeat ? mySeat.chips : 0;
  const canCheck = diff === 0;
  const canCall = diff > 0 && diff <= chips;
  const canRaise = chips > diff;

  let actionsHTML = `<div class="action-row">`;
  actionsHTML += `<button class="btn-act fold" onclick="doAction('fold')">폴드</button>`;
  if (canCheck) {
    actionsHTML += `<button class="btn-act check" onclick="doAction('check')">체크</button>`;
  } else if (canCall) {
    actionsHTML += `<button class="btn-act call" onclick="doAction('call')">콜 ${diff}</button>`;
  } else {
    actionsHTML += `<button class="btn-act check" disabled>—</button>`;
  }
  if (canRaise) {
    actionsHTML += `<button class="btn-act raise" onclick="openRaise()">레이즈</button>`;
  }
  actionsHTML += `<button class="btn-act allin" onclick="doAction('allin')">올인 ${chips}</button>`;
  actionsHTML += `</div>`;

  actionsHTML += `<div id="raise-row" style="display:none;">
    <div class="raise-input-row">
      <input type="number" id="raise-amount" placeholder="레이즈 추가" inputmode="numeric">
      <button class="btn-act raise" onclick="doRaise()" style="flex:0;">확인</button>
    </div>
    <div class="raise-quick" style="margin-top:6px;">
      <button onclick="setRaise(${snap.table.bb})">+BB</button>
      <button onclick="setRaise(snap.pot)">+POT</button>
      <button onclick="setRaise(Math.floor(${snap.pot}/2))">½POT</button>
      <button onclick="setRaise(${chips - diff})">All-in</button>
    </div>
  </div>`;

  el.innerHTML = actionsHTML;
}

function openRaise() {
  document.getElementById("raise-row").style.display = "block";
}

function setRaise(v) {
  document.getElementById("raise-amount").value = v;
}

async function doAction(action) {
  if (actionBusy) return;
  actionBusy = true;
  try {
    await api(`/api/htable/${id_key}/action`, {
      method: "POST",
      body: { action, amount: 0 },
    });
  } catch (e) {
    alert(e.message || "액션 실패");
  } finally {
    actionBusy = false;
  }
}

async function doRaise() {
  if (actionBusy) return;
  const amt = parseInt(document.getElementById("raise-amount").value);
  if (!amt || amt <= 0) {
    alert("레이즈 금액 입력");
    return;
  }
  actionBusy = true;
  try {
    await api(`/api/htable/${id_key}/action`, {
      method: "POST",
      body: { action: "raise", amount: amt },
    });
  } catch (e) {
    alert(e.message || "레이즈 실패");
  } finally {
    actionBusy = false;
  }
}

// ===== Sit / Leave / Sitout =====

let selectedSeatNo = null;

function openSitModal(seatNo) {
  selectedSeatNo = seatNo;
  const tbl = lastSnap?.table;
  if (!tbl) return;
  document.getElementById("buyin-range").textContent =
    `${tbl.min_buyin}~${tbl.max_buyin} 코인 (가상 칩 1:10)`;
  document.getElementById("buyin-amount").value = tbl.min_buyin;
  document.getElementById("sit-error").textContent = "";
  document.getElementById("sit-modal").classList.remove("hidden");
}

function closeSitModal() {
  document.getElementById("sit-modal").classList.add("hidden");
}

async function doSit() {
  const buyin = parseInt(document.getElementById("buyin-amount").value);
  if (!buyin) {
    document.getElementById("sit-error").textContent = "Buy-in 입력";
    return;
  }
  try {
    await api(`/api/htable/${id_key}/sit`, {
      method: "POST",
      body: { seat_no: selectedSeatNo, buyin },
    });
    closeSitModal();
  } catch (e) {
    document.getElementById("sit-error").textContent = e.message;
  }
}

async function toggleSitout() {
  if (!lastSnap) return;
  const mySeat = lastSnap.seats.find(s => s.discord_id === me.sub);
  if (!mySeat) return;
  try {
    await api(`/api/htable/${id_key}/sitout`, {
      method: "POST",
      body: { sit_out: !mySeat.sit_out },
    });
  } catch (e) {
    alert(e.message);
  }
}

// ===== History =====
async function loadHistory() {
  try {
    const rows = await api(`/api/htable/${id_key}/history?limit=15`);
    const tbody = document.querySelector("#hand-history tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">아직 핸드 없음</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>#${r.hand_no}</td>
        <td class="amount">${fmtCoin(r.pot)}</td>
        <td class="amount" style="color: var(--text-dim);">${fmtCoin(r.rake || 0)}</td>
        <td>${timeAgo(r.ended_at)}</td>
      </tr>
    `).join("");
  } catch (e) {
    console.warn(e);
  }
}

// ===== Verify =====
document.getElementById("verify-link").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("verify-modal").classList.remove("hidden");
});

function closeVerify() {
  document.getElementById("verify-modal").classList.add("hidden");
}

async function doVerify() {
  const hid = parseInt(document.getElementById("verify-hid").value);
  if (!hid) return;
  const result = document.getElementById("verify-result");
  result.textContent = "검증 중...";
  try {
    const data = await api(`/api/htable/hand/${hid}/verify`);
    result.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    result.textContent = "❌ " + e.message;
  }
}

window.openSitModal = openSitModal;
window.closeSitModal = closeSitModal;
window.doSit = doSit;
window.doAction = doAction;
window.doRaise = doRaise;
window.openRaise = openRaise;
window.setRaise = setRaise;
window.toggleSitout = toggleSitout;
window.closeVerify = closeVerify;
window.doVerify = doVerify;
