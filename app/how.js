/* ============================================================
   게임 방법 — 데모 엔진
   각 게임을 **움직여서** 보여준다. 글로 설명하지 않는다.

   로그인이 필요 없다 — requireAuth()를 부르지 않는다.
   아직 가입 안 한 사람도 읽을 수 있어야 하는 페이지다.

   숫자는 전부 서버 정본에서 가져온 실제 값이다:
     크래시 베팅 100/200/500 (CRASH_MIN_BET·BET_UNIT)
     매치베팅 레이크 10% (MBET_RAKE)
     인디언 포커 1 vs 10 (cogs/duel.py)
     흑과백 0~8 · 5점 선취 (cogs/blackwhite.py)
   숫자를 바꿀 일이 생기면 서버부터 보고 여기를 맞출 것.
   ============================================================ */

const $$ = (name, root) => (root || document).querySelector(`[data-el="${name}"]`);
const reduced = window.matchMedia
  && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 데모용 지연. reduced-motion이면 확 줄여서 결과만 빨리 보여준다. */
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 120) : ms));

const won = (n) => Number(n).toLocaleString("ko-KR");

/** 각 데모의 취소 토큰. «다시»를 누르면 이전 회차를 여기서 끊는다. */
const runs = {};
function fresh(key) { return (runs[key] = (runs[key] || 0) + 1); }
function alive(key, token) { return runs[key] === token; }

/* ============================================================ 크래시 */

const crash = {
  el: {}, raf: 0, state: "idle", mult: 1, bust: 0, t0: 0, amount: 100,
};

function crashInit() {
  crash.el = {
    cv: document.querySelector('[data-cv="crash"]'),
    mult: $$("crash-mult"),
    say: $$("crash-say"),
    go: $$("crash-go"),
    sub: $$("crash-gosub"),
  };
  if (!crash.el.cv) return;
  crash.ctx = crash.el.cv.getContext("2d");
  crashFit();
  addEventListener("resize", crashFit);
  crash.el.go.addEventListener("click", crashTap);
  crashReset();
  requestAnimationFrame(crashDraw);
}

function crashFit() {
  const cv = crash.el.cv;
  const r = cv.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * d));
  cv.height = Math.max(1, Math.round(r.height * d));
  crash.ctx.setTransform(d, 0, 0, d, 0, 0);
  crash.W = r.width;
  crash.H = r.height;
}

function crashReset() {
  crash.state = "idle";
  crash.mult = 1;
  // 터지는 지점은 매번 다르다 — 그게 이 게임의 전부다.
  crash.bust = 1.25 + Math.random() * Math.random() * 7;
  crash.el.mult.textContent = "1.00×";
  crash.el.mult.classList.remove("dead");
  crash.el.mult.style.color = "";
  crash.el.mult.style.textShadow = "";
  crash.el.go.classList.remove("cash");
  crash.el.go.disabled = false;
  crash.el.go.firstChild.textContent = "100코인 걸기";
  crash.el.sub.textContent = "눌러서 시작";
  crash.el.say.innerHTML = "먼저 <b>100코인 걸기</b>를 눌러보세요.";
}

function crashTap() {
  if (crash.state === "idle") {
    crash.state = "fly";
    crash.t0 = performance.now();
    crash.el.go.classList.add("cash");
    crash.el.say.innerHTML = "숫자가 올라가는 중! <b>지금 «회수»를 누르세요.</b>"
      + "<small>늦게 누를수록 많이 받지만, 터지면 다 잃어요.</small>";
    return;
  }
  if (crash.state === "fly") {
    crash.state = "cashed";
    const got = Math.round(crash.amount * crash.mult);
    crash.el.go.classList.remove("cash");
    crash.el.go.disabled = true;
    crash.el.go.firstChild.textContent = `${crash.mult.toFixed(2)}× 회수 완료`;
    crash.el.sub.textContent = `+${won(got - crash.amount)} G 벌었어요`;
    crash.el.say.innerHTML =
      `<b>${crash.mult.toFixed(2)}×</b>에 회수했어요! `
      + `100 G → <b>${won(got)} G</b>`
      + `<small>이번 판은 ${crash.bust.toFixed(2)}×에서 터질 예정이었어요. 잘 피했네요.</small>`;
  }
}

function crashOver() {
  crash.state = "over";
  crash.mult = crash.bust;
  crash.el.mult.textContent = crash.bust.toFixed(2) + "×";
  crash.el.mult.classList.add("dead");
  crash.el.mult.style.textShadow = "none";
  crash.el.go.classList.remove("cash");
  crash.el.go.disabled = true;
  crash.el.go.firstChild.textContent = "터졌어요";
  crash.el.sub.textContent = "100 G를 잃었어요";
  crash.el.say.innerHTML =
    `<span class="bad">${crash.bust.toFixed(2)}×에서 터졌어요.</span> 건 돈 100 G가 사라졌어요.`
    + "<small>건 돈보다 더 잃지는 않아요. «다시»로 한 번 더 해보세요.</small>";
}

function crashDraw(ts) {
  if (!crash.ctx) return;
  if (crash.state === "fly") {
    crash.mult = Math.exp(0.00028 * (ts - crash.t0));
    if (crash.mult >= crash.bust) {
      crashOver();
    } else {
      crash.el.mult.textContent = crash.mult.toFixed(2) + "×";
      const heat = Math.min(1, (crash.mult - 1) / 5);
      crash.el.mult.style.color =
        `rgb(242,${Math.round(233 - heat * 27)},${Math.round(216 - heat * 110)})`;
      crash.el.mult.style.textShadow =
        `0 0 ${16 + crash.mult * 7}px rgba(243,206,106,${(.4 + heat * .4).toFixed(3)})`;
      crash.el.go.firstChild.textContent =
        `${won(Math.round(crash.amount * crash.mult))} G 회수`;
      crash.el.sub.textContent = "지금 눌러요!";
    }
  }

  // 배경 야경 — 배수가 오를수록 가까워진다 (실제 크래시 화면과 같은 표현)
  const ctx = crash.ctx;
  const W = crash.W;
  const H = crash.H;
  const p = Math.min(1, Math.max(0, (crash.mult - 1) / 8));
  ctx.clearRect(0, 0, W, H);
  const horizon = H * (.62 + p * .26);
  const g = ctx.createLinearGradient(0, horizon - H * .3, 0, H);
  g.addColorStop(0, "rgba(201,162,39,0)");
  g.addColorStop(1, `rgba(255,158,61,${.10 + p * .24})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, horizon - H * .3, W, H - horizon + H * .3);
  for (let i = 0; i < 60; i++) {
    const x = ((i * 97) % 100) / 100;
    const y = ((i * 53) % 100) / 100;
    const sz = (.8 + (i % 4) * .5) * (.6 + p * 1.3);
    ctx.fillStyle = `rgba(243,206,106,${(.2 + p * .45) * (.5 + .5 * Math.sin(ts / 700 + i))})`;
    ctx.fillRect(x * W, horizon + (H - horizon) * y * y, sz, sz * 1.5);
  }
  ctx.strokeStyle = `rgba(201,162,39,${.14 + p * .2})`;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(W, horizon);
  ctx.stroke();

  requestAnimationFrame(crashDraw);
}

/* ============================================================ 매치 베팅 */

async function demoMbet() {
  const k = "mbet";
  const t = fresh(k);
  const say = $$("mbet-say");
  const set = (side, n, ratio) => {
    $$(`mbet-${side}-n`).textContent = won(n) + " G";
    $$(`mbet-${side}-bar`).style.transform = `scaleX(${ratio})`;
  };
  const cls = (side, c) => {
    const el = $$(`mbet-${side}`);
    el.classList.remove("win", "lose");
    if (c) el.classList.add(c);
  };

  cls("a"); cls("b");
  set("a", 0, 0); set("b", 0, 0);
  say.innerHTML = "A팀 vs B팀 매치에 베팅이 열렸어요.";
  if (!alive(k, t)) return;
  await wait(900);

  if (!alive(k, t)) return;
  set("a", 900, 1);
  set("b", 300, 300 / 900);
  say.innerHTML = "다들 <b>A팀</b>이 이길 거라고 봤어요. A에 900 G, B에 300 G.";
  await wait(1700);

  if (!alive(k, t)) return;
  set("b", 400, 400 / 900);
  say.innerHTML = "나는 <b>인기 없는 B팀</b>에 100 G를 걸었어요."
    + "<small>이제 B팀 총 400 G 중 내 몫은 100 G — 지분 25%</small>";
  await wait(2100);

  if (!alive(k, t)) return;
  cls("a", "lose"); cls("b", "win");
  say.innerHTML = "결과는 <b>B팀 승리!</b>";
  await wait(1300);

  if (!alive(k, t)) return;
  say.innerHTML = "진 A팀의 900 G에서 수수료 10%(90 G)를 떼고 <b>810 G</b>를 B팀이 나눠 가져요.";
  await wait(2100);

  if (!alive(k, t)) return;
  // 마지막 문장에도 수수료를 남긴다 — 애니메이션이 끝난 뒤 들어온 사람도
  // 이 한 줄만 보고 전부 알 수 있어야 한다.
  say.innerHTML = "내 지분이 25%니까 810 × 25% = <b>202 G</b>."
    + "<small>진 쪽 900 G − 수수료 10% = 810 G를 나눠 가진 결과예요. "
    + "원금 100 G까지 <b>302 G</b>가 들어와요 — 100 걸어서 +202. "
    + "인기 없는 쪽을 맞히면 이렇게 커요.</small>";
}

/* ============================================================ 인디언 포커 */

async function demoIndian() {
  const k = "indian";
  const t = fresh(k);
  const me = $$("in-me");
  const you = $$("in-you");
  const say = $$("in-say");

  me.className = "card back";
  me.textContent = "?";
  you.className = "card";
  you.textContent = "?";
  say.innerHTML = "카드를 한 장씩 받았어요.";
  if (!alive(k, t)) return;
  await wait(900);

  if (!alive(k, t)) return;
  you.textContent = "3";
  say.innerHTML = "<b>상대 카드는 보여요 — 3이네요.</b> 낮은 카드예요."
    + "<small>그런데 내 카드는 나만 못 봐요. 이게 이 게임의 전부예요.</small>";
  await wait(2400);

  if (!alive(k, t)) return;
  say.innerHTML = "상대가 <b>크게 걸었어요.</b> 자기 카드가 3인 걸 아는데도요."
    + "<small>= 내 카드가 3보다 낮아 보인다는 뜻일까? 아니면 허풍일까?</small>";
  await wait(2600);

  if (!alive(k, t)) return;
  say.innerHTML = "나는 <b>콜</b>했어요. 공개합니다…";
  await wait(1200);

  if (!alive(k, t)) return;
  me.className = "card win";
  me.textContent = "8";
  you.className = "card lose";
  say.innerHTML = "내 카드는 <b>8</b>이었어요. 8 &gt; 3 — <b>내가 이겼어요!</b>"
    + "<small>상대는 허풍이었어요. 상대의 베팅이 유일한 힌트예요.</small>";
  await wait(2800);

  if (!alive(k, t)) return;
  me.className = "card win";
  me.textContent = "1";
  you.className = "card lose";
  you.textContent = "10";
  say.innerHTML = "딱 하나 예외가 있어요 — <b>1은 10을 이깁니다.</b>"
    + "<small>제일 약해 보이는 1이 제일 센 10을 잡아요. 그 외에는 높은 쪽이 이겨요.</small>";
}

/* ============================================================ 흑과백 */

const BW = [0, 1, 2, 3, 4, 5, 6, 7, 8];

function bwRender(el, used, pick) {
  el.innerHTML = BW.map((n) => {
    const cls = used.includes(n) ? " used" : (n === pick ? " pick" : "");
    return `<span class="pip${cls}">${n}</span>`;
  }).join("");
}

async function demoBw() {
  const k = "bw";
  const t = fresh(k);
  const me = $$("bw-me");
  const you = $$("bw-you");
  const say = $$("bw-say");
  const mine = [];
  const theirs = [];

  bwRender(me, mine); bwRender(you, theirs);
  say.innerHTML = "둘 다 <b>0부터 8까지 아홉 장</b>으로 똑같이 시작해요."
    + "<small>운이 하나도 안 들어가요. 뽑는 카드가 없어요.</small>";
  if (!alive(k, t)) return;
  await wait(2200);

  const rounds = [
    { m: 8, y: 2, txt: "1라운드 — 나는 <b>8</b>, 상대는 2. 내가 1점!",
      sub: "그런데 내 8은 <b>이제 없어요.</b> 다시는 못 써요." },
    { m: 1, y: 7, txt: "2라운드 — 상대가 <b>7</b>을 냈어요. 나는 1을 버렸어요. 상대 1점.",
      sub: "질 판은 제일 약한 카드로 버리는 게 요령이에요." },
    { m: 6, y: 5, txt: "3라운드 — 나 6, 상대 5. 내가 1점!",
      sub: "남은 카드를 서로 셀 수 있어요. 상대에게 뭐가 남았는지 다 보여요." },
  ];

  for (const r of rounds) {
    if (!alive(k, t)) return;
    bwRender(me, mine, r.m);
    bwRender(you, theirs, r.y);
    say.innerHTML = r.txt;
    await wait(1500);
    if (!alive(k, t)) return;
    mine.push(r.m);
    theirs.push(r.y);
    bwRender(me, mine);
    bwRender(you, theirs);
    say.innerHTML = r.txt + `<small>${r.sub}</small>`;
    await wait(2200);
  }

  if (!alive(k, t)) return;
  say.innerHTML = "이제 내게 <b>8도 6도 없어요.</b> 상대에겐 8이 남아 있고요."
    + "<small>큰 카드를 <b>언제</b> 쓸지가 이 게임의 전부예요. 먼저 5점이면 이겨요.</small>";
}

/* ============================================================ 홀덤 테이블 */

function seatRow(el, list) {
  el.innerHTML = list.map((s) =>
    `<div class="seat${s.on ? " on" : ""}${s.turn ? " turn" : ""}">${s.name}`
    + `${s.chip ? `<small>${s.chip}</small>` : ""}</div>`).join("");
}

function boardCards(el, cards) {
  el.innerHTML = cards.map((c) =>
    `<div class="card${c.win ? " win" : ""}">${c.v}</div>`).join("");
}

async function demoHtable() {
  const k = "htable";
  const t = fresh(k);
  const seats = $$("ht-seats");
  const board = $$("ht-board");
  const say = $$("ht-say");

  const base = [
    { name: "나", on: true }, { name: "빵다", on: true }, { name: "현태", on: true },
    { name: "준구", on: true }, { name: "빈자리" }, { name: "빈자리" },
  ];

  seatRow(seats, base);
  boardCards(board, []);
  say.innerHTML = "네 명이 앉아 있어요. <b>아무 때나 앉고 아무 때나 일어날 수 있어요.</b>";
  if (!alive(k, t)) return;
  await wait(2000);

  if (!alive(k, t)) return;
  boardCards(board, [{ v: "?" }, { v: "?" }]);
  say.innerHTML = "각자 <b>카드 2장</b>을 받아요. 내 것만 나한테 보여요.";
  await wait(2000);

  const streets = [
    { n: 3, txt: "바닥에 <b>3장</b>이 깔려요. 여기서 한 번 걸지 말지 정해요.", cards: ["K", "9", "4"] },
    { n: 4, txt: "<b>4장째.</b> 또 한 번 정해요.", cards: ["K", "9", "4", "K"] },
    { n: 5, txt: "<b>5장째, 마지막.</b> 마지막으로 정해요.", cards: ["K", "9", "4", "K", "2"] },
  ];

  for (const s of streets) {
    if (!alive(k, t)) return;
    seatRow(seats, base.map((x, i) => ({ ...x, turn: i === 0 })));
    boardCards(board, s.cards.map((v) => ({ v })));
    say.innerHTML = s.txt + "<small>내 차례엔 자리가 <b>주황색</b>으로 깜빡여요. 30초 안에 안 누르면 자동으로 빠져요.</small>";
    await wait(2400);
  }

  if (!alive(k, t)) return;
  seatRow(seats, base);
  boardCards(board, [
    { v: "K", win: true }, { v: "9" }, { v: "4" }, { v: "K", win: true }, { v: "2" },
  ]);
  say.innerHTML = "내 카드 2장 + 바닥 5장 중 <b>제일 좋은 5장</b>으로 겨뤄요. K 두 장이면 원페어."
    + "<small>중간에 «폴드»하면 그때까지 건 것만 잃고 빠져요.</small>";
}

/* ============================================================ 1:1 홀덤 */

async function demoHeads() {
  const k = "heads";
  const t = fresh(k);
  const seats = $$("hd-seats");
  const say = $$("hd-say");

  const steps = [
    { txt: "<code>/홀덤도전 @상대</code> 로 신청해요.", a: 0, b: 0 },
    { txt: "상대가 <code>/홀덤수락</code> 하면 시작돼요.", a: 1, b: 1 },
    { txt: "내 차례 — <code>/홀덤콜</code> · <code>/홀덤레이즈</code> · <code>/홀덤폴드</code> 중 하나.", a: 2, b: 1 },
    { txt: "상대 차례가 돼요. 기다려요.", a: 1, b: 2 },
    { txt: "지금 뭐가 어떤지는 <code>/홀덤현황</code>으로 봐요.", a: 1, b: 1 },
  ];

  for (const s of steps) {
    if (!alive(k, t)) return;
    seatRow(seats, [
      { name: "나", on: s.a > 0, turn: s.a === 2, chip: s.a > 0 ? "100 BB" : "" },
      { name: "상대", on: s.b > 0, turn: s.b === 2, chip: s.b > 0 ? "100 BB" : "" },
    ]);
    say.innerHTML = s.txt;
    await wait(2200);
  }

  if (!alive(k, t)) return;
  seatRow(seats, [
    { name: "나", on: true, chip: "200 BB" },
    { name: "상대", on: true, chip: "0" },
  ]);
  say.innerHTML = "상대 칩을 다 가져오면 끝나요. <b>남은 칩만큼 진짜 코인으로 돌려받아요.</b>"
    + "<small>50판이 지나도 끝나요. 중간에 그만두면 5%를 더 뗍니다.</small>";
}

/* ============================================================ 배선 */

const DEMOS = {
  mbet: demoMbet,
  indian: demoIndian,
  bw: demoBw,
  htable: demoHtable,
  heads: demoHeads,
};

function boot() {
  crashInit();

  document.querySelectorAll("[data-replay]").forEach((btn) => {
    const key = btn.dataset.replay;
    btn.addEventListener("click", () => {
      if (key === "crash") { crashReset(); return; }
      if (DEMOS[key]) DEMOS[key]();
    });
  });

  // 화면에 들어올 때 한 번 재생한다 — 스크롤만 해도 알아서 움직인다.
  const seen = new Set();
  if (!("IntersectionObserver" in window)) {
    Object.keys(DEMOS).forEach((k) => DEMOS[k]());
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      const key = e.target.id === "indian" ? "indian" : e.target.id;
      if (!DEMOS[key] || seen.has(key)) return;
      seen.add(key);
      DEMOS[key]();
    });
  }, { threshold: .35 });
  document.querySelectorAll(".game").forEach((s) => io.observe(s));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
