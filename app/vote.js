/* GmI 투표소 — 1회용 입장권(#t=) → 세션 → 투표용지 → 꾸욱 도장 → 투표함
   서버: gmi-casino-bot api/routes/poll.py. 이 화면은 디코 번호를 받지도 보내지도 않는다.
   입장권은 들어오자마자 주소창에서 지운다(뒤로 가기 · 공유로 새지 않게). 세션은 이 탭에만(sessionStorage). */
(() => {
  "use strict";
  const API = (document.querySelector('meta[name="gmi-api-base"]') || {}).content || "";
  const HOLD_MS = 800;
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let session = null, vote = null, choice = null, stamped = false;

  /* ---------- 유비서 자리(그림 · 영상이 오면 여기만 채운다) ---------- */
  const HOST = {      // 예: greet: "assets/vote/host-greet.webm"
    greet: null, hand: null, wait: null, cheer: null, announce: null,
  };
  function paintHost(el) {
    const src = HOST[el.dataset.pose];
    el.textContent = "";
    if (src && /\.webm$|\.mp4$/.test(src) && !reduce) {
      const v = document.createElement("video");
      Object.assign(v, { src, autoplay: true, muted: true, playsInline: true, loop: el.dataset.pose === "wait" });
      v.onerror = () => { el.textContent = ""; el.appendChild(ph()); };
      el.appendChild(v);
    } else if (src) {
      const i = new Image(); i.src = src.replace(/\.(webm|mp4)$/, ".png"); i.alt = ""; el.appendChild(i);
    } else el.appendChild(ph());
  }
  function ph() { const d = document.createElement("div"); d.className = "ph"; d.innerHTML = "<b>유</b>선관위원"; return d; }

  /* ---------- 소리(Web Audio 합성 · 기본 꺼짐 · 켜면 기억) ---------- */
  const SKEY = "gmi_vote_sound";
  const Snd = {
    on: false, ctx: null,
    init() {
      try { this.on = localStorage.getItem(SKEY) === "1"; } catch (_) {}
      this.paint();
      $("snd").addEventListener("click", () => { this.on = !this.on; try { localStorage.setItem(SKEY, this.on ? "1" : "0"); } catch (_) {} this.paint(); this.bgm(); if (this.on) this.click(); });
    },
    paint() { const b = $("snd"); b.setAttribute("aria-pressed", String(this.on)); b.textContent = this.on ? "소리 켜짐" : "소리 꺼짐"; b.setAttribute("aria-label", this.on ? "소리 끄기" : "소리 켜기"); },
    ac() { if (!this.on) return null; this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === "suspended") this.ctx.resume(); return this.ctx; },
    tone(freq, dur, type = "sine", gain = .25, slide = 0) {
      const c = this.ac(); if (!c) return; const t = c.currentTime, o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
      g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(.001, t + dur); o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur);
    },
    noise(dur, gain = .2, hp = 800) {
      const c = this.ac(); if (!c) return; const n = c.sampleRate * dur, buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(); s.buffer = buf; f.type = "highpass"; f.frequency.value = hp; g.gain.value = gain;
      s.connect(f).connect(g).connect(c.destination); s.start();
    },
    click() { this.tone(1400, .05, "square", .06); },
    charge() { this.tone(180, HOLD_MS / 1000, "sine", .08, 420); },
    thump() { this.tone(110, .22, "sine", .5, 45); this.noise(.06, .25, 1500); },
    fold() { this.noise(.18, .12, 2500); setTimeout(() => this.noise(.12, .1, 3000), 160); },
    drop() { this.tone(240, .12, "triangle", .3, 120); setTimeout(() => this.tone(90, .25, "sine", .4, 50), 90); },
    cheer() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.tone(f, .18, "triangle", .15), i * 90)); },
    bgm() { const a = $("bgm"); if (!a) return; if (this.on) { a.volume = .22; a.play().catch(() => {}); } else a.pause(); },
  };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (_) {} };

  /* ---------- 서버 ---------- */
  async function call(path, body) {
    const r = await fetch(API + "/api/poll" + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error((data && data.detail) || "잠깐 연결이 안 돼요. 다시 해 주세요"); e.status = r.status; throw e; }
    return data;
  }

  /* ---------- 화면 ---------- */
  function show(id) { ["stLoad", "stErr", "stGreet", "stBallot", "stDone"].forEach((s) => { $(s).hidden = s !== id; }); window.scrollTo(0, 0); }
  function fail(msg) { $("errMsg").textContent = msg; show("stErr"); }
  const kst = (iso) => { const d = new Date(iso); const w = "일월화수목금토"[new Date(d.getTime() + 9 * 36e5).getUTCDay()]; const k = new Date(d.getTime() + 9 * 36e5);
    return `${k.getUTCMonth() + 1}/${k.getUTCDate()}(${w}) ${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`; };
  function turnout(v) { const n = v.members || 0; return { text: n ? `${v.turnout}명 / ${n}명` : `${v.turnout}명`, pct: n ? Math.min(100, Math.round(100 * v.turnout / n)) : 0 }; }

  function fillGreet(v) {
    $("agTitle").textContent = v.title; $("agDesc").textContent = v.description || ""; $("agDesc").hidden = !v.description;
    $("agClose").textContent = kst(v.closes_at); const t = turnout(v); $("agTurn").textContent = t.text;
    requestAnimationFrame(() => { $("agBar").style.width = t.pct + "%"; });
    paintHost($("hostGreet"));
  }
  function fillDone(v, fresh) {
    const t = turnout(v); $("dnTurn").textContent = t.text; $("dnClose").textContent = kst(v.closes_at);
    $("doneLine").textContent = fresh ? "한 표 잘 받았어요. 마감 때 같이 열어 봐요" : "이미 투표함에 넣으셨어요";
    if (v.my_opinion) { $("opText").value = v.my_opinion; count(); }
    if (v.opinion_hidden) { $("opText").disabled = true; $("opSend").disabled = true; $("opMsg").textContent = "운영진이 숨긴 의견이라 고칠 수 없어요"; }
    if (!v.open) { $("opText").disabled = true; $("opSend").disabled = true; }
    paintHost($("hostDone"));
    show("stDone");
    requestAnimationFrame(() => { $("dnBar").style.width = t.pct + "%"; });
  }

  function buildBallot(v) {
    $("ppTitle").textContent = v.title;
    const fs = $("opts"); fs.querySelectorAll(".opt").forEach((x) => x.remove());
    v.options.forEach((o, i) => {
      const lb = document.createElement("label"); lb.className = "opt";
      lb.innerHTML = `<span class="no">${i + 1}</span><input type="radio" name="c" value="${i}"><span></span><b class="mark" aria-hidden="true"><i class="ink">GmI</i></b>`;
      lb.querySelector("span:not(.no)").textContent = o;
      lb.querySelector("input").addEventListener("change", () => { if (stamped) return; choice = i; Snd.click(); $("hint").textContent = `「${o}」에 도장을 꾸욱 눌러 주세요`; $("ballotErr").textContent = ""; });
      fs.appendChild(lb);
    });
  }

  /* ---------- 꾸욱 도장(0.8초 · 눌림 · 진동 · 소리) ---------- */
  function holdStamp() {
    const btn = $("stamp"), ring = btn.querySelector("circle"), LEN = 340;
    let t0 = 0, raf = 0, holding = false;
    const reset = () => { holding = false; cancelAnimationFrame(raf); btn.classList.remove("press"); ring.style.transition = "stroke-dashoffset .2s"; ring.style.strokeDashoffset = LEN; };
    const tick = (now) => {
      if (!holding) return; const p = Math.min(1, (now - t0) / HOLD_MS); ring.style.strokeDashoffset = LEN * (1 - p);
      if (p >= 1) { holding = false; done(); } else raf = requestAnimationFrame(tick);
    };
    const start = (e) => {
      if (stamped || btn.disabled) return; if (e) e.preventDefault();
      if (choice === null) { btn.classList.remove("shake"); void btn.offsetWidth; btn.classList.add("shake"); $("ballotErr").textContent = "먼저 한 칸을 골라 주세요"; buzz(40); return; }
      holding = true; t0 = performance.now(); ring.style.transition = "none"; btn.classList.add("press"); buzz(15); Snd.charge(); raf = requestAnimationFrame(tick);
    };
    const done = () => {
      stamped = true; btn.classList.remove("press"); btn.disabled = true; ring.style.strokeDashoffset = 0;
      Snd.thump(); buzz([30, 40, 70]);
      const ink = document.querySelectorAll(".opt .ink")[choice]; ink.classList.add("on");
      document.querySelectorAll('.opt input').forEach((x) => { x.disabled = true; });
      $("hint").textContent = "도장을 찍었어요. 이제 투표함에 넣어 주세요";
      $("drop").hidden = false; $("drop").focus();
    };
    btn.addEventListener("pointerdown", start);
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, () => { if (holding) reset(); }));
    btn.addEventListener("contextmenu", (e) => e.preventDefault());
    btn.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) start(e); });
    btn.addEventListener("keyup", (e) => { if ((e.key === " " || e.key === "Enter") && holding) reset(); });
  }

  async function dropIn() {
    const b = $("drop"); b.disabled = true; $("ballotErr").textContent = "";
    let res;
    try { res = await call("/cast", { s: session, choice }); }
    catch (e) {
      if (e.status === 409) { const v = await call("/booth?s=" + encodeURIComponent(session)).then((d) => d.vote).catch(() => vote); return fillDone(v, false); }
      if (e.status === 410) return fail(e.message);
      b.disabled = false; $("ballotErr").textContent = e.message; return;
    }
    Snd.fold(); $("paper").classList.add("fold");
    setTimeout(() => {
      fillDone(res.vote, true);
      const slip = $("slip"), box = document.querySelector(".box"); slip.classList.add("go"); box.classList.add("thud");
      setTimeout(() => { Snd.drop(); buzz(25); }, reduce ? 0 : 850);
      setTimeout(() => Snd.cheer(), reduce ? 0 : 1250);
    }, reduce ? 0 : 650);
  }

  /* ---------- 의견 ---------- */
  function count() { $("opCount").textContent = `${$("opText").value.length} / 300`; }
  async function sendOpinion() {
    const text = $("opText").value.trim(); const m = $("opMsg");
    if (text.length < 2) { m.textContent = "두 글자 이상 적어 주세요"; return; }
    $("opSend").disabled = true;
    try { const r = await call("/opinion", { s: session, text }); m.style.color = "var(--ok)"; m.textContent = r.result === "same" ? "같은 의견이 이미 들어가 있어요" : "의견이 이름 없이 들어갔어요"; }
    catch (e) { m.style.color = ""; m.textContent = e.message; }
    finally { $("opSend").disabled = false; }
  }

  /* ---------- 시작 ---------- */
  async function boot() {
    Snd.init(); holdStamp();
    $("toBallot").addEventListener("click", () => { Snd.click(); buildBallot(vote); show("stBallot"); });
    $("drop").addEventListener("click", dropIn);
    $("opText").addEventListener("input", count);
    $("opin").addEventListener("submit", sendOpinion);

    const m = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash || "");
    if (m) history.replaceState(null, "", location.pathname);       // 입장권은 주소창에 남기지 않는다
    try {
      if (m) { const d = await call("/enter", { t: m[1] }); session = d.session; vote = d.vote; sessionStorage.setItem("gmi_vote_s", session); }
      else {
        session = sessionStorage.getItem("gmi_vote_s");
        if (!session) return fail("입장권이 없어요");
        vote = (await call("/booth?s=" + encodeURIComponent(session))).vote;
      }
    } catch (e) { sessionStorage.removeItem("gmi_vote_s"); return fail(e.message); }
    if (vote.voted) return fillDone(vote, false);
    if (!vote.open) return fail("이미 마감된 투표예요");
    fillGreet(vote); show("stGreet");
  }
  boot();
})();
