/* ============================================
   GmI 크래시 — 라이브 게임 로직
   - SSE로 라운드 상태 수신
   - Canvas 실시간 차트
   - 베팅/캐시아웃 버튼 핸들러
   ============================================ */

const me = requireAuth();
if (me) {
  renderNav();
  renderFooter();
  initChart();
  connectStream();
  loadMyBets();
}

// ===== 상태 =====
let lastSnap = null;
let evtSource = null;
let reconnectTimer = null;
let cashoutBusy = false;
let betBusy = false;

// 차트 데이터: 0.1초 단위로 (t, multiplier) 누적
let chartPoints = [];
let lastTickTime = 0;

// ===== SSE 연결 =====
function connectStream() {
  const url = `${API_BASE}/api/crash/stream`;
  evtSource = new EventSource(url);

  evtSource.addEventListener("update", (e) => {
    try {
      const snap = JSON.parse(e.data);
      handleUpdate(snap);
    } catch (err) {
      console.error("snap parse error", err);
    }
  });

  evtSource.addEventListener("round", (e) => {
    // 새 라운드 시작
    chartPoints = [{ t: 0, m: 1.00 }];
  });

  evtSource.addEventListener("phase", (e) => {
    try {
      const data = JSON.parse(e.data);
      handlePhaseChange(data.phase, data.crash_point);
    } catch (err) {}
  });

  evtSource.addEventListener("error", () => {
    if (evtSource.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectStream, 3000);
    }
  });
}

// ===== 라운드 상태 핸들링 =====

function handleUpdate(snap) {
  const phaseChanged = !lastSnap || lastSnap.phase !== snap.phase;
  const roundChanged = !lastSnap || lastSnap.round_id !== snap.round_id;

  // 차트 데이터 누적 (비행 중에만)
  if (snap.phase === "flight") {
    const now = performance.now();
    if (now - lastTickTime > 50) {  // 50ms 최소 간격
      const t = chartPoints.length > 0
        ? (chartPoints.length * 0.1)  // 대략적인 t
        : 0;
      chartPoints.push({ t, m: snap.multiplier });
      // 최대 600개 (60초까지)
      if (chartPoints.length > 600) chartPoints.shift();
      lastTickTime = now;
    }
  } else if (phaseChanged && snap.phase === "betting") {
    // 베팅 단계로 전환 → 차트 리셋
    chartPoints = [{ t: 0, m: 1.00 }];
  } else if (phaseChanged && snap.phase === "crashed") {
    // 폭발 시 마지막 점 (실제 crash_point)
    if (snap.crash_point) {
      chartPoints.push({
        t: chartPoints.length * 0.1,
        m: snap.crash_point
      });
    }
  }

  // UI 갱신
  updateHeader(snap);
  updateBigMult(snap);
  drawChart(snap);
  updateAction(snap);
  updateParticipants(snap);

  if (phaseChanged || roundChanged) {
    updateHistory(snap.history);
    if (snap.phase === "crashed") {
      loadMyBets();  // 베팅 결과 갱신
    }
  }

  lastSnap = snap;
}

function handlePhaseChange(phase, crashPoint) {
  if (phase === "crashed") {
    if (crashPoint && crashPoint >= 10) {
      showToast(`💥 ${crashPoint}x 폭발!`, "success");
    }
  }
}

// ===== 헤더 =====
function updateHeader(snap) {
  document.getElementById("round-no").textContent =
    `라운드 #${snap.round_id || "—"}`;

  const tag = document.getElementById("phase-tag");
  const phaseLabel = {
    betting: "베팅 받는 중",
    flight: "비행 중",
    crashed: "폭발",
    paused: "휴식 (도박 시간 22:00~02:00)",
  }[snap.phase] || snap.phase;
  tag.textContent = phaseLabel;
  tag.className = "phase-tag " + snap.phase;

  const metaLabel = document.getElementById("phase-label");
  const metaTime = document.getElementById("phase-time");
  if (snap.phase === "betting") {
    metaLabel.textContent = "베팅 종료까지";
    metaTime.textContent = snap.seconds_remaining != null
      ? `${snap.seconds_remaining.toFixed(1)}초` : "—";
  } else if (snap.phase === "flight") {
    metaLabel.textContent = "비행 중";
    metaTime.textContent = `${snap.multiplier.toFixed(2)}x`;
  } else if (snap.phase === "crashed") {
    metaLabel.textContent = "다음 라운드까지";
    metaTime.textContent = snap.seconds_remaining != null
      ? `${snap.seconds_remaining.toFixed(1)}초` : "—";
  } else {
    metaLabel.textContent = "—";
    metaTime.textContent = "—";
  }
}

// ===== 큰 멀티 텍스트 =====
function updateBigMult(snap) {
  const el = document.getElementById("big-mult");
  const lbl = document.getElementById("big-mult-label");

  if (snap.phase === "flight") {
    el.textContent = `${snap.multiplier.toFixed(2)}x`;
    el.classList.remove("crashed");
    lbl.textContent = "현재 멀티플라이어";
  } else if (snap.phase === "crashed") {
    const cp = snap.crash_point ?? snap.multiplier;
    el.textContent = `${cp.toFixed(2)}x`;
    el.classList.add("crashed");
    lbl.textContent = "💥 폭발!";
  } else if (snap.phase === "betting") {
    el.textContent = "1.00x";
    el.classList.remove("crashed");
    lbl.textContent = "베팅 받는 중";
  } else {
    el.textContent = "—";
    el.classList.remove("crashed");
    lbl.textContent = "휴식 시간";
  }
}

// ===== Canvas 차트 =====
let chartCtx = null;

function initChart() {
  const canvas = document.getElementById("chart");
  // 고해상도 대응
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = (rect.width || 800) * dpr;
  canvas.height = (rect.height || 480) * dpr;
  chartCtx = canvas.getContext("2d");
  chartCtx.scale(dpr, dpr);
}

function drawChart(snap) {
  if (!chartCtx) return;
  const canvas = document.getElementById("chart");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width / dpr;
  const H = canvas.height / dpr;

  const ctx = chartCtx;
  ctx.clearRect(0, 0, W, H);

  // 데이터 없으면 그냥 끝
  if (chartPoints.length === 0) return;

  // 스케일: max multiplier에 맞춰 y축
  const maxM = Math.max(2.0, ...chartPoints.map(p => p.m), snap.multiplier || 1);
  const maxT = Math.max(2.0, chartPoints.length * 0.1);

  // 패딩
  const padL = 36, padR = 16, padT = 16, padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  // 보조선 (y축)
  const ticks = niceTicks(1.0, maxM, 5);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#5a5a6a";
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "right";
  for (const tk of ticks) {
    const ratio = (tk - 1.0) / (maxM - 1.0);
    const y = padT + plotH - ratio * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(`${tk.toFixed(2)}x`, padL - 6, y + 3);
  }

  // 곡선
  const isFlightOrCrashed = snap.phase === "flight" || snap.phase === "crashed";
  if (chartPoints.length >= 2 && isFlightOrCrashed) {
    const xy = chartPoints.map(p => {
      const x = padL + (p.t / maxT) * plotW;
      const ratio = (p.m - 1.0) / (maxM - 1.0);
      const y = padT + plotH - ratio * plotH;
      return [x, y];
    });

    // 영역 채우기 (글로우 효과)
    ctx.beginPath();
    ctx.moveTo(xy[0][0], padT + plotH);
    for (const [x, y] of xy) ctx.lineTo(x, y);
    ctx.lineTo(xy[xy.length - 1][0], padT + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    const isCrashed = snap.phase === "crashed";
    grad.addColorStop(0,
      isCrashed ? "rgba(220, 60, 70, 0.25)" : "rgba(212, 175, 55, 0.18)");
    grad.addColorStop(1,
      isCrashed ? "rgba(220, 60, 70, 0.02)" : "rgba(212, 175, 55, 0.02)");
    ctx.fillStyle = grad;
    ctx.fill();

    // 라인
    ctx.beginPath();
    ctx.moveTo(xy[0][0], xy[0][1]);
    for (const [x, y] of xy) ctx.lineTo(x, y);
    ctx.strokeStyle = isCrashed ? "#dc3c46" : "#d4af37";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    // 끝점 (현재 위치)
    const last = xy[xy.length - 1];
    ctx.beginPath();
    ctx.arc(last[0], last[1], 6, 0, Math.PI * 2);
    ctx.fillStyle = isCrashed ? "#dc3c46" : "#f4cc4d";
    ctx.fill();
    ctx.strokeStyle = "#f0f0f5";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function niceTicks(min, max, n) {
  const step = (max - min) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(min + step * i);
  }
  return out;
}

// ===== 액션 영역 (베팅 입력 / 캐시아웃 버튼) =====

function updateAction(snap) {
  const el = document.getElementById("action-area");
  const myBet = (snap.bets || []).find(b => b.discord_id === me.sub);

  if (snap.phase === "paused") {
    el.innerHTML = `
      <div class="action-info">
        <div>
          <div class="label">상태</div>
          <div class="value" style="color: var(--text-sub);">도박 시간 (22:00~02:00 KST)에 진행</div>
        </div>
      </div>`;
    return;
  }

  if (snap.phase === "betting") {
    if (myBet) {
      // 베팅 완료 — 대기
      el.innerHTML = `
        <div class="action-info">
          <div>
            <div class="label">내 베팅 (잠금됨)</div>
            <div class="value gold">${fmtCoin(myBet.amount)} 코인</div>
          </div>
          <div style="text-align:right;">
            <div class="label">잠재 수익</div>
            <div class="value pos">곧 비행 시작</div>
          </div>
        </div>`;
    } else {
      // 베팅 입력
      el.innerHTML = `
        <div class="bet-form">
          <input type="number" class="bet-input" id="bet-amount"
                 inputmode="numeric" min="${snap.min_bet}" max="${snap.max_bet}"
                 placeholder="베팅액 (${snap.min_bet}~${snap.max_bet})">
          <button class="btn-action" id="bet-btn" onclick="doBet()">베팅</button>
        </div>
        <div class="quick-bets">
          ${[10, 50, 100, 200, 500].map(v =>
            `<button class="quick-chip" onclick="setBet(${v})">${v}</button>`
          ).join("")}
        </div>`;
    }
    return;
  }

  if (snap.phase === "flight") {
    if (myBet && myBet.status === "placed") {
      const curPayout = Math.round(myBet.amount * snap.multiplier);
      const profit = curPayout - myBet.amount;
      el.innerHTML = `
        <button class="btn-action cashout" id="cashout-btn" onclick="doCashout()">
          ✋ 캐시아웃<br>
          <span style="font-size:18px;">+${fmtCoin(profit)} 코인 (${snap.multiplier.toFixed(2)}x)</span>
        </button>`;
    } else if (myBet && myBet.status === "cashed") {
      el.innerHTML = `
        <div class="action-info">
          <div>
            <div class="label">캐시아웃 완료 @ ${myBet.cashout_at.toFixed(2)}x</div>
            <div class="value pos">+${fmtCoin(myBet.payout - myBet.amount)} 코인</div>
          </div>
          <div style="text-align:right;">
            <div class="label">받은 금액</div>
            <div class="value gold">${fmtCoin(myBet.payout)}</div>
          </div>
        </div>`;
    } else {
      el.innerHTML = `
        <div class="action-info">
          <div>
            <div class="label">관전 중</div>
            <div class="value" style="color: var(--text-sub);">다음 라운드 베팅</div>
          </div>
        </div>`;
    }
    return;
  }

  if (snap.phase === "crashed") {
    if (myBet) {
      if (myBet.status === "cashed") {
        el.innerHTML = `
          <div class="action-info">
            <div>
              <div class="label">결과: 캐시아웃 성공</div>
              <div class="value pos">+${fmtCoin(myBet.payout - myBet.amount)} 코인 @ ${myBet.cashout_at.toFixed(2)}x</div>
            </div>
          </div>`;
      } else {
        el.innerHTML = `
          <div class="action-info">
            <div>
              <div class="label">결과: 캐시아웃 실패</div>
              <div class="value" style="color: var(--red);">-${fmtCoin(myBet.amount)} 코인</div>
            </div>
          </div>`;
      }
    } else {
      el.innerHTML = `
        <div class="action-info">
          <div>
            <div class="label">라운드 종료</div>
            <div class="value" style="color: var(--text-sub);">다음 라운드 곧 시작</div>
          </div>
        </div>`;
    }
  }
}

// ===== 참여자 리스트 =====
function updateParticipants(snap) {
  const el = document.getElementById("participants");
  const countEl = document.getElementById("participant-count");
  const bets = snap.bets || [];
  countEl.textContent = bets.length > 0 ? `(${bets.length}명)` : "";

  if (!bets.length) {
    el.innerHTML = `<div class="empty" style="text-align:center; padding:16px; color:var(--text-dim);">${snap.phase === "betting" ? "베팅 받는 중" : "참여자 없음"}</div>`;
    return;
  }

  // 캐시아웃 한 사람 위로
  const sorted = bets.slice().sort((a, b) => {
    const order = { cashed: 0, placed: 1, lost: 2, refunded: 3 };
    return (order[a.status] || 9) - (order[b.status] || 9);
  });

  el.innerHTML = sorted.map(b => {
    const isMe = b.discord_id === me.sub;
    const icon = ({
      cashed: "✅",
      placed: "🎯",
      lost: "💥",
      refunded: "↩️",
    })[b.status] || "•";
    let amtHTML, subHTML;
    if (b.status === "cashed") {
      const profit = b.payout - b.amount;
      amtHTML = `<div class="amount cashed">+${fmtCoin(profit)}</div>`;
      subHTML = `<div class="sub">@ ${b.cashout_at.toFixed(2)}x</div>`;
    } else if (b.status === "lost") {
      amtHTML = `<div class="amount lost">${fmtCoin(b.amount)}</div>`;
      subHTML = `<div class="sub">패</div>`;
    } else if (b.status === "placed") {
      amtHTML = `<div class="amount placed">${fmtCoin(b.amount)}</div>`;
      subHTML = `<div class="sub">${snap.phase === "flight" ? "비행 중" : "대기"}</div>`;
    } else {
      amtHTML = `<div class="amount">${fmtCoin(b.amount)}</div>`;
      subHTML = `<div class="sub">${b.status}</div>`;
    }
    return `
      <div class="participant-row ${isMe ? 'me' : ''}">
        <div class="icon">${icon}</div>
        <div class="name ${isMe ? 'me' : ''}">${b.name || '?'}${isMe ? ' (나)' : ''}</div>
        ${amtHTML}
        ${subHTML}
      </div>`;
  }).join("");
}

// ===== 히스토리 =====
function updateHistory(history) {
  const el = document.getElementById("history-strip");
  if (!history || !history.length) {
    el.innerHTML = `<div style="color: var(--text-dim); font-size: 13px; padding: 8px;">아직 라운드 없음</div>`;
    return;
  }
  el.innerHTML = history.slice().reverse().map(h => {
    let cls = "history-chip ";
    if (h.crash_point < 2.0) cls += "crash-red";
    else if (h.crash_point < 10.0) cls += "crash-gold";
    else cls += "crash-green";
    return `<div class="${cls}">${h.crash_point.toFixed(2)}x</div>`;
  }).join("");
}

// ===== 베팅 / 캐시아웃 =====

async function doBet() {
  if (betBusy) return;
  const input = document.getElementById("bet-amount");
  const amt = parseInt(input.value);
  if (!amt || amt <= 0) {
    showToast("베팅액을 입력하세요", "error");
    return;
  }
  betBusy = true;
  const btn = document.getElementById("bet-btn");
  if (btn) btn.disabled = true;
  try {
    const res = await api("/api/crash/bet", {
      method: "POST",
      body: { amount: amt }
    });
    showToast(`✅ ${amt} 코인 베팅 완료`, "success");
  } catch (e) {
    showToast(e.message || "베팅 실패", "error");
  } finally {
    betBusy = false;
    if (btn) btn.disabled = false;
  }
}

function setBet(v) {
  const input = document.getElementById("bet-amount");
  if (input) input.value = v;
}

async function doCashout() {
  if (cashoutBusy) return;
  cashoutBusy = true;
  const btn = document.getElementById("cashout-btn");
  if (btn) btn.disabled = true;
  try {
    const res = await api("/api/crash/cashout", { method: "POST" });
    showToast(
      `✋ ${res.multiplier.toFixed(2)}x 캐시아웃 (+${res.profit})`,
      "success"
    );
  } catch (e) {
    showToast(e.message || "캐시아웃 실패", "error");
  } finally {
    cashoutBusy = false;
    if (btn) btn.disabled = false;
  }
}

// ===== 내 베팅 이력 =====
async function loadMyBets() {
  try {
    const rows = await api("/api/crash/my-bets?limit=15");
    const tbody = document.querySelector("#my-bets-table tbody");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">아직 베팅 없음</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(r => {
      let resultText, deltaHTML;
      if (r.status === "cashed") {
        const profit = r.payout - r.amount;
        resultText = `<span style="color:var(--green)">✅ ${r.cashout_at.toFixed(2)}x</span>`;
        deltaHTML = `<span class="pos">+${fmtCoin(profit)}</span>`;
      } else if (r.status === "lost") {
        resultText = `<span style="color:var(--red)">💥 ${r.crash_point ? r.crash_point.toFixed(2) + "x" : ""}</span>`;
        deltaHTML = `<span class="neg">-${fmtCoin(r.amount)}</span>`;
      } else if (r.status === "refunded") {
        resultText = `<span style="color:var(--text-sub)">↩️ 환불</span>`;
        deltaHTML = `<span style="color:var(--text-sub)">0</span>`;
      } else {
        resultText = r.status;
        deltaHTML = "—";
      }
      return `
        <tr>
          <td>${r.round_id}</td>
          <td class="amount">${fmtCoin(r.amount)}</td>
          <td>${resultText}</td>
          <td class="amount">${deltaHTML}</td>
        </tr>
      `;
    }).join("");
  } catch (e) {
    console.warn("my-bets load:", e);
  }
}

// ===== 토스트 알림 =====
let toastTimer = null;
function showToast(msg, type = "") {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "toast show " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2400);
}

// ===== Provably-Fair 모달 =====
document.getElementById("verify-link").addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("verify-modal").classList.remove("hidden");
});

function closeVerify() {
  document.getElementById("verify-modal").classList.add("hidden");
}

async function doVerify() {
  const rid = parseInt(document.getElementById("verify-rid").value);
  if (!rid) return;
  const result = document.getElementById("verify-result");
  result.textContent = "검증 중...";
  try {
    const data = await api(`/api/crash/round/${rid}/verify`);
    if (data.phase && data.phase !== "crashed") {
      result.textContent = "⚠️ 라운드 종료 후에 검증 가능";
      return;
    }
    result.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    result.textContent = "❌ " + e.message;
  }
}

window.doBet = doBet;
window.doCashout = doCashout;
window.setBet = setBet;
window.closeVerify = closeVerify;
window.doVerify = doVerify;
