/* ============================================================
   나이트 드롭 (크래시) — 라이브 게임
   지시서 §4-1. 비주얼·모션·사운드만 바꿨다.
   라운드 타이밍·배수·터지는 지점·provably-fair 값은 전부 서버 것을 그대로 쓴다.

   서버 계약 (건드리지 않음):
     SSE  /api/crash/stream        event: round | phase | update
     POST /api/crash/bet           {amount}
     POST /api/crash/cashout
     GET  /api/crash/my-bets?limit
     GET  /api/crash/round/{id}/verify
     GET  /api/wallet              {balance}

   스냅샷: phase(betting|flight|crashed|paused) · round_id · multiplier ·
           crash_point · bets[] · history[] · seconds_remaining ·
           min_bet · max_bet · bet_unit · bet_tiers[]

   ⚠️ 베팅 티어는 서버가 내려주는 bet_tiers를 쓴다. 프론트에 박지 말 것 —
      예전 코드가 [10,50,100,200,500]을 하드코딩해서 10·50은 서버가
      CRASH_MIN_BET(100)·BET_UNIT(100)으로 거부했다.
   ============================================================ */

const me = requireAuth();

/* ============================================================ 상태 */

let snap = null;            // 마지막 서버 스냅샷
let stream = null;
let reconnectTimer = null;

let balance = null;         // /api/wallet
let pickedBet = null;       // 선택한 티어 (없으면 첫 티어)
let betBusy = false;
let cashBusy = false;

// 표시용 보간 — 서버 값이 진실이고, 그 값으로 부드럽게 다가갈 뿐이다.
let shownMult = 1;
let shownLeft = 0;          // 남은 초
let leftStamp = 0;          // seconds_remaining을 받은 시각
let lastTickSfx = 0;
let flying = false;         // 라이저 on/off 판정용

const $ = (id) => document.getElementById(id);

// 캔버스 — 부팅 블록이 fitCanvas()를 부르므로 반드시 그 위에서 초기화한다.
// (let/const는 선언 위치까지 TDZ라 아래에 두면 부팅이 통째로 죽는다.)
const cv = document.getElementById("cv");
const ctx = cv ? cv.getContext("2d") : null;
let W = 0;
let H = 0;
let city = [];
let stars = [];
const particles = [];
const MAX_PARTICLES = 60;   // §6 상한

/** 운영 시간. 서버 _utils.hours_label()이 정본이지만 스냅샷에 없어서
 *  여기 적어둔다(지시서 §10). 서버가 내려주게 되면 그 값으로 바꿀 것. */
const HOURS_LABEL = "18:00~03:00 KST";

/* ============================================================ 부팅 */

if (me) {
  initSound();
  wire();
  fitCanvas();
  loadBalance();
  loadLimits();
  loadMyBets();
  connect();
  requestAnimationFrame(loop);
  setInterval(paintClock, 1000);
  paintClock();
}

function wire() {
  addEventListener("resize", fitCanvas);
  $("go").addEventListener("click", onAction);

  $("verify-link").addEventListener("click", () => openVerify(true));
  $("verify-close").addEventListener("click", () => openVerify(false));
  $("verify-bg").addEventListener("click", () => openVerify(false));
  $("verify-run").addEventListener("click", runVerify);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") openVerify(false);
  });

  // 탭이 안 보이면 캔버스를 멈춘다(§6). 돌아오면 rAF가 다시 돈다.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) riserOff();
    else requestAnimationFrame(loop);
  });
}

/* ============================================================ 잔액 */

async function loadBalance() {
  try {
    const w = await api("/api/wallet");
    balance = Number(w.balance) || 0;
  } catch (e) {
    balance = null;
  }
  paintPurse();
}

/* ============================================================ 주간 한도 */

/**
 * GET /api/me/limits — 이번주 두 상한.
 *
 * ⚠️ earning(인증으로 **버는** 쪽)과 betting(카지노에 **거는** 쪽)은
 *    완전히 다른 값이다. 기본값이 둘 다 1,800이라 눈으로는 구분이 안 되므로
 *    라벨과 색으로 갈라 보여준다. 서로 섞어 쓰지 말 것.
 *
 * 실패해도 조용히 접는다 — 게임 자체는 이 값 없이도 돌아간다.
 */
async function loadLimits() {
  let d;
  try {
    d = await api("/api/me/limits");
  } catch (e) {
    $("lim").hidden = true;
    return;
  }
  if (!d || !d.betting || !d.earning) { $("lim").hidden = true; return; }

  // betting.enforced=false면 CASINO_GATE가 꺼져 있다 — 집계는 되지만 막지는
  // 않으므로 "한도"라고 단정하지 않는다.
  $("lim-bet-label").textContent = d.betting.enforced
    ? "이번 주 강하 한도" : "이번 주 강하";
  gauge("lim-bet", d.betting.used, d.betting.cap);
  gauge("lim-earn", d.earning.used, d.earning.cap);
  $("lim").hidden = false;
}

function gauge(id, used, cap) {
  const u = Number(used) || 0;
  const c = Number(cap) || 0;
  $(id + "-used").textContent = fmtCoin(u);
  $(id + "-cap").textContent = fmtCoin(c);
  const ratio = c > 0 ? Math.min(1, Math.max(0, u / c)) : 0;
  $(id + "-bar").style.transform = `scaleX(${ratio})`;
}

function paintPurse() {
  $("bal").innerHTML = (balance === null ? "—" : fmtCoin(balance)) + "<em>G</em>";
}

/* ============================================================ SSE */

function connect() {
  stream = new EventSource(`${API_BASE}/api/crash/stream`);

  stream.addEventListener("update", (e) => {
    let next;
    try { next = JSON.parse(e.data); } catch (err) { return; }
    onSnap(next);
  });

  stream.addEventListener("phase", (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    onPhase(d.phase);
  });

  stream.addEventListener("error", () => {
    if (stream.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    }
  });
}

function onSnap(next) {
  const prev = snap;
  const roundChanged = !prev || prev.round_id !== next.round_id;
  const phaseChanged = !prev || prev.phase !== next.phase;
  snap = next;

  if (roundChanged) {
    shownMult = 1;
    particles.length = 0;
    $("pop").classList.remove("go");
  }

  if (next.seconds_remaining !== null && next.seconds_remaining !== undefined) {
    shownLeft = next.seconds_remaining;
    leftStamp = performance.now();
  }

  paintStage();
  paintBetPanel();
  paintFeed();
  if (roundChanged || phaseChanged) paintHistory();

  // 라운드가 끝나면 결과가 확정된다 — 잔액·이력을 다시 읽는다.
  if (phaseChanged && next.phase === "crashed") {
    loadBalance();
    loadMyBets();
  }
}

function onPhase(phase) {
  const stage = $("stage");

  if (phase === "flight") {
    stage.classList.add("fly");
    flying = true;
    riserOn();
    sfx.board();
  } else {
    stage.classList.remove("fly");
    if (flying) { riserOff(); flying = false; }
  }

  if (phase === "crashed") {
    sfx.bust();
    stage.classList.add("bust");
    setTimeout(() => stage.classList.remove("bust"), 600);
    $("mult").classList.add("flick");
    setTimeout(() => {
      $("mult").classList.remove("flick");
      $("mult").classList.add("dead");
    }, 320);
  } else {
    $("mult").classList.remove("dead");
  }

  if (phase === "betting") sfx.board();
}

/* ============================================================ 무대 */

const PHASE_SUB = {
  betting: "탑승 접수 중",
  flight: "강하 중",
  crashed: "낙하산 미전개",
  paused: "영업 종료",
};

const PHASE_SLUG = {
  betting: "BOARDING",
  flight: "DROPPING",
  crashed: "DOWN",
  paused: "CLOSED",
};

function paintStage() {
  if (!snap) return;
  const rid = snap.round_id ? String(snap.round_id).padStart(3, "0") : "—";
  $("slug").textContent = `ROUND ${rid} · ${PHASE_SLUG[snap.phase] || "STANDBY"}`;
  $("sub").textContent = PHASE_SUB[snap.phase] || "대기";

  const cd = $("cd");
  const showCd = snap.phase === "betting" || snap.phase === "crashed";
  cd.hidden = !showCd;
  $("cdlabel").textContent = snap.phase === "betting" ? "초 후 이탈" : "초 후 다음 라운드";
}

/** 배수 표시. 서버 값을 향해 부드럽게 다가간다(표시만, 계산은 서버). */
function paintMult() {
  const el = $("mult");
  if (!snap) return;

  if (snap.phase === "crashed") {
    const cp = snap.crash_point ?? snap.multiplier ?? 1;
    shownMult = cp;
    el.innerHTML = cp.toFixed(2) + "<sup>×</sup>";
    el.style.color = "";
    el.style.textShadow = "";
    $("alt").textContent = "고도 0m";
    return;
  }

  if (snap.phase === "paused") {
    el.innerHTML = "—";
    el.style.color = "";
    el.style.textShadow = "";
    $("alt").textContent = `${HOURS_LABEL}에 열려요`;
    return;
  }

  const target = snap.phase === "flight" ? (snap.multiplier || 1) : 1;
  shownMult += (target - shownMult) * .28;
  if (Math.abs(target - shownMult) < .002) shownMult = target;

  el.innerHTML = shownMult.toFixed(2) + "<sup>×</sup>";

  if (snap.phase === "flight") {
    const heat = Math.min(1, (shownMult - 1) / 6);
    el.style.color = `rgb(242,${Math.round(233 - heat * 27)},${Math.round(216 - heat * 110)})`;
    el.style.textShadow = `0 0 ${20 + shownMult * 9}px rgba(243,206,106,${(.45 + heat * .4).toFixed(3)})`;
    riserTune(shownMult);
    const alt = Math.max(0, Math.round(1200 - progress() * 1200));
    $("alt").textContent = `고도 ${alt.toLocaleString("ko-KR")}m`;
  } else {
    el.style.color = "";
    el.style.textShadow = "";
    $("alt").textContent = "대기 고도 1,200m";
  }
}

/** 카운트다운 — 서버 값에서 로컬 경과를 빼서 표시만 매끄럽게 한다. */
function paintCountdown(ts) {
  if (!snap || $("cd").hidden) return;
  const elapsed = (ts - leftStamp) / 1000;
  const left = Math.max(0, shownLeft - elapsed);
  const total = snap.phase === "betting" ? (snap.betting_secs || 15) : 5;

  $("cdn").textContent = left.toFixed(1);
  $("cdb").style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;

  if (snap.phase === "betting" && left <= 5.2 && ts - lastTickSfx > 1000) {
    lastTickSfx = ts;
    sfx.tick();
  }
}

function paintClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  $("clk").textContent = `${hh}:${mm} KST`;
}

/* ============================================================ 베팅 패널 */

function myBet() {
  if (!snap || !me) return null;
  return (snap.bets || []).find((b) => b.discord_id === me.sub) || null;
}

function tiers() {
  return (snap && snap.bet_tiers && snap.bet_tiers.length)
    ? snap.bet_tiers
    : [snap && snap.min_bet].filter(Boolean);
}

function currentBet() {
  const list = tiers();
  if (!list.length) return null;
  return list.includes(pickedBet) ? pickedBet : list[0];
}

function paintChips() {
  const box = $("chips");
  const list = tiers();
  if (!list.length) {
    box.innerHTML = '<div class="skel"></div>';
    return;
  }

  const picked = currentBet();
  const locked = !!myBet() || (snap && snap.phase !== "betting");
  // 잔액도 키에 넣는다 — 빠뜨리면 코인을 쓴 뒤에도 칩이 살아 있는 것처럼 보인다.
  const sig = `${list.join(",")}|${picked}|${locked}|${balance}`;
  if (box.dataset.sig === sig) return;   // 매 틱 다시 그리지 않는다
  box.dataset.sig = sig;

  box.innerHTML = list.map((v) => {
    const poor = balance !== null && balance < v;
    const on = v === picked ? " on" : "";
    const dis = (locked || poor) ? " disabled" : "";
    return `<button type="button" class="chip${on}"${dis} data-v="${v}">`
      + `${fmtCoin(v)}<small>G</small></button>`;
  }).join("");

  box.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      pickedBet = Number(btn.dataset.v);
      sfx.tick();
      paintBetPanel();
    });
  });
}

function paintBetPanel() {
  if (!snap) return;
  paintChips();

  const go = $("go");
  const sub = $("gosub");
  const why = $("why");
  const mine = myBet();
  const amt = currentBet();

  why.hidden = true;
  go.classList.remove("cash");

  // ── 영업 종료 ──
  if (snap.phase === "paused") {
    go.disabled = true;
    go.firstChild.textContent = "지금은 닫혀 있어요";
    sub.textContent = `${HOURS_LABEL}에 열려요`;
    return;
  }

  // ── 비행 중: 내 베팅이 살아 있으면 회수 ──
  if (snap.phase === "flight") {
    if (mine && mine.status === "placed") {
      const now = Math.round(mine.amount * (snap.multiplier || 1));
      go.disabled = cashBusy;
      go.classList.add("cash");
      go.firstChild.textContent = `${fmtCoin(now)} G 회수`;
      sub.textContent = "지금 낙하산 전개";
      return;
    }
    if (mine && mine.status === "cashed") {
      go.disabled = true;
      go.firstChild.textContent = `${mine.cashout_at.toFixed(2)}× 착지`;
      sub.textContent = `+${fmtCoin(mine.payout - mine.amount)} G 획득`;
      return;
    }
    go.disabled = true;
    go.firstChild.textContent = "다음 라운드 대기";
    sub.textContent = "이번 판은 못 타요";
    return;
  }

  // ── 터짐 ──
  if (snap.phase === "crashed") {
    go.disabled = true;
    if (mine && mine.status === "cashed") {
      go.firstChild.textContent = `${mine.cashout_at.toFixed(2)}× 착지`;
      sub.textContent = `+${fmtCoin(mine.payout - mine.amount)} G 획득`;
    } else if (mine) {
      go.firstChild.textContent = "낙사";
      sub.textContent = `-${fmtCoin(mine.amount)} G`;
    } else {
      go.firstChild.textContent = "다음 라운드 대기";
      sub.textContent = "곧 새 판이 열려요";
    }
    return;
  }

  // ── 베팅 접수 중 ──
  if (mine) {
    go.disabled = true;
    go.firstChild.textContent = "탑승 완료";
    sub.textContent = `${fmtCoin(mine.amount)} G · 이탈 대기 중`;
    return;
  }

  if (!amt) {
    go.disabled = true;
    go.firstChild.textContent = "연결 중";
    sub.textContent = "라운드 정보를 받는 중이에요";
    return;
  }

  // 왜 못 거는지 명시한다 — 버튼만 죽여두지 않는다(§4-1, §5).
  if (balance !== null && balance < amt) {
    const need = amt - balance;
    const cheapest = Math.min(...tiers());
    go.disabled = true;
    go.firstChild.textContent = `${fmtCoin(amt)}코인 걸기`;
    sub.textContent = "코인이 모자라요";
    why.hidden = false;
    why.textContent = balance < cheapest
      ? `코인이 ${fmtCoin(cheapest - balance)} G 부족해요. 배그 인증으로 적립할 수 있어요.`
      : `코인이 ${fmtCoin(need)} G 부족해요. ${fmtCoin(cheapest)} G부터 탑승할 수 있어요.`;
    return;
  }

  go.disabled = betBusy;
  go.firstChild.textContent = `${fmtCoin(amt)}코인 걸기`;
  sub.textContent = "터지기 전에 회수하면 배수만큼 받아요";
}

/* ============================================================ 피드 */

function paintFeed() {
  const box = $("feed");
  const cnt = $("cnt");
  const bets = (snap && snap.bets) || [];

  cnt.textContent = bets.length ? `${bets.length}명 탑승` : "0명 탑승";

  if (!bets.length) {
    box.innerHTML = '<div class="none"><b>아직 아무도 안 걸었어요.</b>'
      + `${fmtCoin((tiers()[0]) || 100)} G부터 탑승할 수 있어요.</div>`;
    return;
  }

  const order = { cashed: 0, placed: 1, lost: 2, refunded: 3 };
  const rows = bets.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));

  box.innerHTML = rows.map((b) => {
    const isMe = me && b.discord_id === me.sub;
    let cls = "";
    let right;
    if (b.status === "cashed") {
      cls = " ok";
      right = `<span class="r">${b.cashout_at.toFixed(2)}×</span>`;
    } else if (b.status === "lost") {
      cls = " no";
      right = '<span class="r">낙사</span>';
    } else if (b.status === "refunded") {
      cls = " no";
      right = '<span class="r">환불</span>';
    } else {
      right = `<span class="a">${snap.phase === "flight" ? "강하 중" : "대기"}</span>`;
    }
    return `<div class="ln${cls}"><span class="d"></span>`
      + `<span class="w">${esc(b.name || "?")}${isMe ? " (나)" : ""}</span>`
      + `<span class="a">${fmtCoin(b.amount)} G</span>${right}</div>`;
  }).join("");
}

/* ============================================================ 히스토리 */

function paintHistory() {
  const box = $("hist");
  const hist = (snap && snap.history) || [];
  if (!hist.length) {
    box.innerHTML = '<div class="none">아직 기록이 없어요. 첫 라운드를 기다리는 중이에요.</div>';
    return;
  }
  box.innerHTML = hist.slice(-10).reverse().map((h) => {
    const v = h.crash_point;
    const cls = v >= 5 ? " g" : (v >= 2 ? " m" : "");
    return `<span class="h${cls}">${v.toFixed(2)}×</span>`;
  }).join("");
}

/* ============================================================ 내 베팅 이력 */

async function loadMyBets() {
  const box = $("my-bets");
  let rows;
  try {
    rows = await api("/api/crash/my-bets?limit=15");
  } catch (e) {
    box.innerHTML = '<div class="none">이력을 불러오지 못했어요. 잠시 뒤 새로고침해 주세요.</div>';
    return;
  }

  if (!rows.length) {
    box.innerHTML = '<div class="none"><b>아직 베팅한 판이 없어요.</b>'
      + '위에서 한 판 타보면 여기 쌓여요.</div>';
    return;
  }

  box.innerHTML = rows.map((r) => {
    let res = '<span class="res back">—</span>';
    let delta = '<span class="delta flat">0</span>';
    if (r.status === "cashed") {
      res = `<span class="res win">${r.cashout_at.toFixed(2)}× 착지</span>`;
      delta = `<span class="delta win">+${fmtCoin(r.payout - r.amount)}</span>`;
    } else if (r.status === "lost") {
      const cp = r.crash_point ? `${r.crash_point.toFixed(2)}×` : "";
      res = `<span class="res lose">낙사 ${cp}</span>`;
      delta = `<span class="delta lose">-${fmtCoin(r.amount)}</span>`;
    } else if (r.status === "refunded") {
      res = '<span class="res back">환불</span>';
    }
    return `<div class="row"><span class="rid">#${r.round_id}</span>`
      + `${res}<span class="stake">${fmtCoin(r.amount)} G</span>${delta}</div>`;
  }).join("");
}

/* ============================================================ 액션 */

function onAction() {
  if (!snap) return;
  if (snap.phase === "flight") doCashout();
  else if (snap.phase === "betting") doBet();
}

async function doBet() {
  if (betBusy || myBet()) return;
  const amt = currentBet();
  if (!amt) return;

  betBusy = true;
  paintBetPanel();
  try {
    await api("/api/crash/bet", { method: "POST", body: { amount: amt } });
    sfx.chip();
    if (balance !== null) balance -= amt;
    paintPurse();
    loadLimits();          // 강하 사용액이 방금 늘었다
    toast(`${fmtCoin(amt)} G 탑승 완료`, "success");
  } catch (e) {
    toast(e.message || "베팅하지 못했어요", "error");
    loadBalance();
  } finally {
    betBusy = false;
    paintBetPanel();
  }
}

async function doCashout() {
  if (cashBusy) return;
  const mine = myBet();
  if (!mine || mine.status !== "placed") return;

  cashBusy = true;
  paintBetPanel();
  try {
    const res = await api("/api/crash/cashout", { method: "POST" });
    const profit = Number(res.profit) || 0;
    sfx.coin();
    rain(46);
    const pop = $("pop");
    pop.querySelector("b").textContent = "+" + fmtCoin(profit);
    pop.classList.remove("go");
    void pop.offsetWidth;                 // 애니메이션 재시작
    pop.classList.add("go");
    toast(`${res.multiplier.toFixed(2)}× 착지 · +${fmtCoin(profit)} G`, "success");
    loadBalance();
  } catch (e) {
    toast(e.message || "회수하지 못했어요", "error");
  } finally {
    cashBusy = false;
    paintBetPanel();
  }
}

/* ============================================================ 검증 모달 */

function openVerify(open) {
  $("verify-modal").classList.toggle("hidden", !open);
  if (open) $("verify-rid").focus();
}

async function runVerify() {
  const rid = parseInt($("verify-rid").value, 10);
  const out = $("verify-result");
  if (!rid) {
    out.textContent = "라운드 ID를 넣어주세요.";
    return;
  }
  out.textContent = "확인하는 중…";
  try {
    const data = await api(`/api/crash/round/${rid}/verify`);
    if (data.phase && data.phase !== "crashed") {
      out.textContent = "아직 안 끝난 라운드예요. 끝나면 검증할 수 있어요.";
      return;
    }
    out.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    out.textContent = e.message || "검증하지 못했어요.";
  }
}

/* ============================================================ 캔버스 */

function fitCanvas() {
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * d));
  cv.height = Math.max(1, Math.round(r.height * d));
  ctx.setTransform(d, 0, 0, d, 0, 0);
  W = r.width;
  H = r.height;

  city = [];
  for (let i = 0; i < 190; i++) {
    city.push({
      x: Math.random(), y: Math.random(), s: Math.random(),
      h: .4 + Math.random() * .6, t: Math.random() * 6.28,
    });
  }
  stars = [];
  for (let i = 0; i < 70; i++) {
    stars.push({ x: Math.random(), y: Math.random() * .6, a: Math.random() });
  }
}

/** 하강 진행도 0~1. 배수가 오를수록 도시가 가까워진다. */
function progress() {
  return Math.min(1, Math.max(0, (shownMult - 1) / 9));
}

function rain(n) {
  for (let i = 0; i < n && particles.length < MAX_PARTICLES; i++) {
    particles.push({
      x: Math.random() * W, y: -20 - Math.random() * 180,
      v: 1.4 + Math.random() * 3, s: 5 + Math.random() * 8,
      r: Math.random() * 6, vr: (Math.random() - .5) * .16,
    });
  }
}

function draw(ts) {
  if (!ctx || !W) return;
  ctx.clearRect(0, 0, W, H);

  const p = progress();
  const horizon = H * (.58 + p * .3);
  const phase = snap ? snap.phase : "paused";

  // 별
  stars.forEach((s) => {
    const a = s.a * (1 - p * .8) * (.4 + .6 * Math.abs(Math.sin(ts / 900 + s.a * 9)));
    ctx.fillStyle = `rgba(242,233,216,${a * .5})`;
    ctx.fillRect(s.x * W, s.y * horizon, 1.2, 1.2);
  });

  // 도시 글로우
  const g = ctx.createLinearGradient(0, horizon - H * .22, 0, H);
  g.addColorStop(0, "rgba(201,162,39,0)");
  g.addColorStop(.55, `rgba(201,162,39,${.06 + p * .14})`);
  g.addColorStop(1, `rgba(255,158,61,${.10 + p * .22})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon - H * .22, W, H - horizon + H * .22);

  // 도시 불빛
  city.forEach((c) => {
    const y = horizon + (H - horizon) * c.y * c.y;
    const sz = (.7 + c.s * 2.2) * (.5 + p * 1.4);
    const tw = .55 + .45 * Math.sin(ts / 620 + c.t);
    ctx.fillStyle = c.h > .72
      ? `rgba(255,235,190,${(.3 + p * .5) * tw})`
      : `rgba(243,206,106,${(.22 + p * .45) * tw})`;
    ctx.fillRect(c.x * W, y, sz, sz * 1.5);
  });

  // 지평선
  ctx.strokeStyle = `rgba(201,162,39,${.12 + p * .2})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(W, horizon);
  ctx.stroke();

  // 고도 눈금
  ctx.font = '600 8.5px "Pretendard Variable", Pretendard, system-ui, sans-serif';
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const y = H * .18 + (horizon - H * .22) * i / 4;
    ctx.fillStyle = "rgba(139,154,146,.4)";
    ctx.fillText(`${1200 - i * 300}m`, W - 16, y + 3);
    ctx.fillStyle = "rgba(139,154,146,.18)";
    ctx.fillRect(W - 13, y, 7, 1);
  }

  if (phase === "flight" || phase === "crashed") {
    // 강하 궤적 + 인영
    const mine = myBet();
    const out = !!(mine && mine.status === "cashed");
    const dy = H * .16 + (horizon - H * .2) * p;
    const dx = W * .5;
    ctx.strokeStyle = "rgba(243,206,106,.22)";
    ctx.setLineDash([3, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx, H * .16);
    ctx.lineTo(dx, dy);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.translate(dx, dy);
    ctx.fillStyle = out ? "#F3CE6A" : "#F2E9D8";
    if (out) {
      ctx.beginPath();
      ctx.arc(0, -13, 13, Math.PI, 0);
      ctx.fill();
      ctx.strokeStyle = "rgba(243,206,106,.6)";
      ctx.beginPath();
      ctx.moveTo(-11, -12); ctx.lineTo(0, 0);
      ctx.moveTo(11, -12); ctx.lineTo(0, 0);
      ctx.stroke();
    }
    ctx.fillRect(-2, -2, 4, 8);
    ctx.restore();
  } else {
    // 수송기 — 탑승 접수 중
    const fx = (ts / 26) % (W + 120) - 60;
    ctx.strokeStyle = "rgba(242,233,216,.16)";
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(fx - 70, H * .15);
    ctx.lineTo(fx + 260, H * .15);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(242,233,216,.85)";
    ctx.save();
    ctx.translate(fx, H * .15);
    ctx.beginPath();
    ctx.moveTo(-13, 0); ctx.lineTo(9, -3); ctx.lineTo(15, 0); ctx.lineTo(9, 3);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2, 0); ctx.lineTo(-9, -9); ctx.lineTo(-4, -9);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // 지폐비 — 화면 밖은 즉시 버린다(§6)
  for (let i = particles.length - 1; i >= 0; i--) {
    const m = particles[i];
    m.y += m.v;
    m.r += m.vr;
    m.x += Math.sin(m.y / 38) * .7;
    if (m.y > H + 30) { particles.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.r);
    const w = m.s * 2.1;
    const h = m.s;
    const grd = ctx.createLinearGradient(-w, 0, w, 0);
    grd.addColorStop(0, "#8A6C12");
    grd.addColorStop(.45, "#F7DE94");
    grd.addColorStop(1, "#C9A227");
    ctx.fillStyle = grd;
    ctx.globalAlpha = Math.abs(Math.cos(m.r)) * .6 + .4;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** 단일 rAF 루프(§6). 탭이 숨으면 멈추고, 돌아오면 다시 붙는다. */
function loop(ts) {
  if (document.hidden) return;
  paintMult();
  paintCountdown(ts);
  draw(ts);
  requestAnimationFrame(loop);
}

/* ============================================================ 유틸 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let toastTimer = null;
function toast(msg, type) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type || ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}
