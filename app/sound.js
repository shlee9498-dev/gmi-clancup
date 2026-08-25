/* ============================================================
   GmI NIGHT OPERATION — 사운드 모듈
   지시서 §3. 전부 Web Audio 합성이라 외부 음원 파일이 없다(용량 0).

   규칙:
     - 기본 OFF. 사용자가 ♪ 토글로 켜야 소리가 난다.
       (브라우저 자동재생 정책 + 예의)
     - 토글 상태는 localStorage에 저장 — 페이지를 옮겨도 유지된다.
     - AudioContext는 첫 사용자 제스처에서 resume() 한다.
     - prefers-reduced-motion: reduce 면 지속음(룸톤·라이저)을 끈다.
       단발 SFX는 남긴다 — 상태 변화를 알리는 정보이지 장식이 아니다.

   BGM은 별건이다. 합성으로는 라운지 재즈가 안 나온다.
   재생 로직만 두고 URL은 비워둔다 — 오너가 라이선스 음원을 넣으면 붙는다.
   저작권 음원을 여기 하드코딩하지 말 것.
   ============================================================ */

const SOUND_KEY = "gmi_sound";

/** 지속음(룸톤·라이저)을 재생해도 되는가. 단발 SFX와 판정이 다르다. */
function prefersReducedMotion() {
  return window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const Sound = {
  ctx: null,
  on: false,
  bed: null,
  riser: null,
  /** 오너가 라이선스 음원 URL을 넣으면 BGM이 붙는다. 비워둘 것. */
  bgmUrl: "",
  bgmEl: null,
};

function audioCtx() {
  if (!Sound.ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    Sound.ctx = new Ctor();
  }
  return Sound.ctx;
}

/** 어택-디케이 엔벨로프를 붙여 destination까지 연결한다. */
function envelope(node, gain, attack, decay, when) {
  const c = audioCtx();
  const g = c.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + attack);
  g.gain.exponentialRampToValueAtTime(.0001, when + attack + decay);
  node.connect(g);
  g.connect(c.destination);
  return g;
}

function ping(freq, gain, decay, type) {
  if (!Sound.on) return;
  const c = audioCtx();
  if (!c) return;
  const o = c.createOscillator();
  o.type = type || "sine";
  o.frequency.value = freq;
  envelope(o, gain, .008, decay, c.currentTime);
  o.start();
  o.stop(c.currentTime + decay + .05);
}

function noise(dur, gain, freq, q) {
  if (!Sound.on) return;
  const c = audioCtx();
  if (!c) return;
  const src = c.createBufferSource();
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q || 1;
  src.connect(filter);
  envelope(filter, gain, .004, dur, c.currentTime);
  src.start();
}

/* ============================================================ 단발 SFX */

const sfx = {
  /** 칩 놓는 소리 — 베팅 확정 */
  chip() {
    noise(.09, .4, 2600, 3);
    setTimeout(() => noise(.07, .25, 1700, 3), 42);
  },
  /** 동전 상승 4음 — 코인 획득 (회수·구매·인증 승인) */
  coin() {
    [1046, 1318, 1568, 2093].forEach((f, i) => {
      setTimeout(() => ping(f, .16, .5), i * 72);
    });
    setTimeout(() => noise(.6, .14, 4200, .8), 90);
  },
  /** 저역 쿵 + 노이즈 — 실패·터짐 */
  bust() {
    ping(70, .4, .9, "sawtooth");
    noise(.5, .34, 300, .7);
    setTimeout(() => ping(45, .3, 1.2, "sine"), 60);
  },
  /** 짧은 틱 — 선택, 카운트다운 5초 이하 */
  tick() { noise(.03, .09, 3400, 6); },
  /** 2음 시그널 — 라운드/화면 전환 */
  board() {
    ping(392, .12, .3);
    setTimeout(() => ping(523, .12, .4), 110);
  },
};

/* ============================================================ 지속음 */

/** 룸톤 — 저역 드론 + 아주 옅은 잡담 노이즈. 카지노 홀 공기. */
function bedOn() {
  const c = audioCtx();
  if (!c || prefersReducedMotion()) return;
  Sound.bed = c.createGain();
  Sound.bed.gain.value = 0;
  Sound.bed.connect(c.destination);

  [55, 82.5, 110].forEach((f, i) => {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = f;
    const g = c.createGain();
    g.gain.value = [.05, .03, .018][i];
    o.connect(g);
    g.connect(Sound.bed);
    o.start();
    // 아주 느린 LFO로 숨을 넣는다 — 고정음은 금방 귀에 걸린다.
    const lfo = c.createOscillator();
    lfo.frequency.value = .06 + i * .02;
    const lfoGain = c.createGain();
    lfoGain.gain.value = .012;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    lfo.start();
  });

  const src = c.createBufferSource();
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 3), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * .35;
  src.buffer = buf;
  src.loop = true;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 560;
  filter.Q.value = .6;
  const g = c.createGain();
  g.gain.value = .028;
  src.connect(filter);
  filter.connect(g);
  g.connect(Sound.bed);
  src.start();

  Sound.bed.gain.linearRampToValueAtTime(.5, c.currentTime + 1.6);
}

function bedFade(to) {
  if (!Sound.bed) return;
  const c = audioCtx();
  Sound.bed.gain.linearRampToValueAtTime(to, c.currentTime + .5);
}

/** 라이저 — 크래시 비행 중 상승 필터. riserTune()으로 음정을 올린다. */
function riserOn() {
  if (!Sound.on || Sound.riser || prefersReducedMotion()) return;
  const c = audioCtx();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  const f = c.createBiquadFilter();
  o.type = "sawtooth";
  o.frequency.value = 110;
  g.gain.value = 0;
  f.type = "lowpass";
  f.frequency.value = 700;
  o.connect(f);
  f.connect(g);
  g.connect(c.destination);
  o.start();
  g.gain.linearRampToValueAtTime(.05, c.currentTime + .4);
  Sound.riser = { o, g, f };
}

/** 배수가 오를수록 필터를 연다. 10배 넘어가면 긴장이 최대가 된다. */
function riserTune(mult) {
  if (!Sound.riser) return;
  Sound.riser.f.frequency.value = 700 + mult * 260;
}

function riserOff() {
  if (!Sound.riser) return;
  const c = audioCtx();
  const r = Sound.riser;
  Sound.riser = null;
  r.g.gain.linearRampToValueAtTime(0, c.currentTime + .15);
  setTimeout(() => { try { r.o.stop(); } catch (e) { /* 이미 정지 */ } }, 220);
}

/* ============================================================ BGM 슬롯 */

/** Sound.bgmUrl이 채워져 있을 때만 동작한다. 기본은 아무 일도 안 한다. */
function bgmSync() {
  if (!Sound.bgmUrl) return;
  if (!Sound.bgmEl) {
    Sound.bgmEl = new Audio(Sound.bgmUrl);
    Sound.bgmEl.loop = true;
    Sound.bgmEl.volume = .18;
  }
  if (Sound.on) Sound.bgmEl.play().catch(() => { /* 제스처 대기 */ });
  else Sound.bgmEl.pause();
}

/* ============================================================ 토글 */

function soundEnabled() { return Sound.on; }

/**
 * 사운드 on/off. 인자를 주면 그 값으로, 없으면 뒤집는다.
 * 첫 켜기에서 AudioContext.resume() — 반드시 사용자 제스처 안에서 호출할 것.
 */
function setSound(next) {
  Sound.on = (next === undefined) ? !Sound.on : !!next;
  try { localStorage.setItem(SOUND_KEY, Sound.on ? "1" : "0"); } catch (e) { /* 사파리 프라이빗 */ }

  if (Sound.on) {
    const c = audioCtx();
    if (c && c.state === "suspended") c.resume();
    if (!Sound.bed) bedOn();
    else bedFade(.5);
    sfx.board();
  } else {
    bedFade(0);
    riserOff();
  }
  bgmSync();
  document.querySelectorAll(".sound").forEach((btn) => {
    btn.classList.toggle("off", !Sound.on);
    btn.setAttribute("aria-pressed", Sound.on ? "true" : "false");
  });
  return Sound.on;
}

/**
 * .sound 버튼을 배선한다.
 * 저장된 값이 ON이어도 여기서 소리를 내지는 않는다 — AudioContext는
 * 사용자 제스처 전엔 suspended라서, 버튼 표시만 맞춰두고 첫 클릭에 살린다.
 */
function initSound() {
  let saved = "0";
  try { saved = localStorage.getItem(SOUND_KEY) || "0"; } catch (e) { /* 무시 */ }
  Sound.on = saved === "1";

  document.querySelectorAll(".sound").forEach((btn) => {
    btn.classList.toggle("off", !Sound.on);
    btn.setAttribute("aria-pressed", Sound.on ? "true" : "false");
    btn.addEventListener("click", () => setSound());
  });
}

window.sfx = sfx;
window.Sound = Sound;
window.initSound = initSound;
window.setSound = setSound;
window.soundEnabled = soundEnabled;
window.riserOn = riserOn;
window.riserOff = riserOff;
window.riserTune = riserTune;
