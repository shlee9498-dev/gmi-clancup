/* 킬내기 앱 공통 — 로그인 · 토큰 · 서버 호출 (계약 mri-academy docs/killrace-app-api.md §1 ~ §4 · 상금은 docs/killrace-api.md §1.20)
 * 토큰은 localStorage kr_token 하나. 주소의 #token= 은 읽자마자 지운다. 401 이면 지우고 다시 로그인.
 * 디스코드 번호 · PUBG 계정 번호 · 계좌는 서버가 주지 않고 화면도 보여 주지 않는다. 숫자는 전부 서버 값이다. */
(function () {
  "use strict";
  var LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  var API = LOCAL ? location.origin : "https://mri-academy-production.up.railway.app";
  var APP_BASE = LOCAL ? location.origin + "/killrace/" : "https://shlee9498-dev.github.io/gmi-clancup/killrace/";
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  var session = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { sessionStorage.removeItem(k); } catch (e) {} }
  };

  // 돌아온 토큰 받기 — nonce 가 같을 때만. 주소에서 바로 지운다
  (function takeToken() {
    var h = location.hash || "";
    if (h.indexOf("token=") < 0) return;
    var q = new URLSearchParams(h.replace(/^#/, ""));
    var token = q.get("token"), nonce = q.get("nonce");
    history.replaceState(null, "", location.pathname + location.search);
    if (token && nonce && nonce === session.get("kr_nonce")) { store.set("kr_token", token); session.del("kr_nonce"); }
  })();

  function token() { return store.get("kr_token") || ""; }
  function logout() { store.del("kr_token"); }
  function login() {
    var nonce = "";
    var abc = "abcdefghijklmnopqrstuvwxyz0123456789";
    var buf = new Uint8Array(24);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf); else for (var i = 0; i < 24; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < 24; j++) nonce += abc[buf[j] % abc.length];
    session.set("kr_nonce", nonce);
    var back = APP_BASE + location.pathname.replace(/^.*\//, "");
    location.href = API + "/api/auth/login?intent=killrace&nonce=" + nonce + "&return=" + encodeURIComponent(back);
  }
  // 서버 호출 — { ok, status, body }. 401 이면 토큰을 지운다(화면이 로그인 안내로 바꾼다)
  // 8초 안에 답이 없으면 끊는다(폰 · 느린 망에서 끝없이 기다리면 빈 화면이 남는다 · #113 과 같은 방식).
  // 읽기(GET)만 연결 실패 · 시간 초과 · 5xx 일 때 1.5초 뒤 한 번 다시 받는다. 쓰기(POST)는 돈 · 교환이 걸려 있어 다시 보내지 않는다
  var WAIT_MS = 8000;
  function once(path, opt) {
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctl) opt.signal = ctl.signal;
    var t = null;
    var late = new Promise(function (ok) { t = setTimeout(function () { if (ctl) ctl.abort(); ok({ ok: false, status: 0, body: {}, code: "timeout" }); }, WAIT_MS); });
    var req = fetch(API + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) logout();
        return { ok: r.ok, status: r.status, body: j, code: j && j.error && j.error.code ? j.error.code : null };
      });
    }, function () { return { ok: false, status: 0, body: {}, code: "network" }; });
    return Promise.race([req, late]).then(function (v) { clearTimeout(t); return v; });
  }
  function api(path, body, method) {
    var h = { "Content-Type": "application/json" };
    if (token()) h.Authorization = "Bearer " + token();
    var m = method || (body ? "POST" : "GET");
    var make = function () { var o = { method: m, headers: h, cache: "no-store" }; if (body) o.body = JSON.stringify(body); return o; };
    return once(path, make()).then(function (r) {
      if (m !== "GET" || !(r.status === 0 || r.status >= 500)) return r;
      return new Promise(function (ok) { setTimeout(ok, 1500); }).then(function () { return once(path, make()); });
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString("ko-KR") + "원"; }
  function when(iso) {
    if (!iso) return "";
    var t = Date.parse(iso); if (!isFinite(t)) return "";
    var d = new Date(t + 9 * 3600000);
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
  }
  function header(who) {
    var el = document.getElementById("who"); if (!el) return;
    if (!token()) { el.innerHTML = '<button type="button" class="btn" data-act="login">디스코드로 로그인</button>'; return; }
    el.innerHTML = (who ? "<b>" + esc(who) + "</b>" : "") + '<button type="button" class="btn" data-act="logout">로그아웃</button>';
  }
  document.addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    if (b.getAttribute("data-act") === "login") login();
    if (b.getAttribute("data-act") === "logout") { logout(); location.reload(); }
    if (b.getAttribute("data-act") === "retry" && typeof window.KR.retry === "function") window.KR.retry();
  });
  // 스위치(앱 계약 §18.1 · GET /api/killrace/switches · 누구나) — 못 읽으면 전부 꺼진 것으로 본다(안전한 쪽)
  var OFF = { coin_shop: false, casino_link: false, deposit: false, monthly_budget_krw: 0, budget: null };
  var swP = null;
  function switches() {
    if (!swP) swP = once("/api/killrace/switches", { method: "GET", cache: "no-store" }).then(function (r) { return r.ok ? r.body : null; }).then(function (j) {
      var s = j && (j.switches || j);                      // { switches: {...}, budget } 또는 평평한 모양 둘 다 읽는다
      if (!s || typeof s !== "object") return OFF;
      return { coin_shop: s.coin_shop === true, shop_vote: s.shop_vote === true, clan_room: s.clan_room === true, casino_link: s.casino_link === true, deposit: s.deposit === true,
        monthly_budget_krw: Number(s.monthly_budget_krw) || 0, budget: (j && j.budget) || s.budget || null };
    }).catch(function () { return OFF; });
    return swP;
  }
  function num(n) { return Number(n || 0).toLocaleString("ko-KR"); }
  function day(iso) {
    var t = Date.parse(iso || ""); if (!isFinite(t)) return "";
    var d = new Date(t + 9 * 3600000);
    return d.getUTCFullYear() + "." + (d.getUTCMonth() + 1) + "." + d.getUTCDate();
  }
  // 처음 모습 · 실패 모습 — 화면이 빈칸으로 남지 않게(10/12 지휘 검수 · #113 과 같은 기준)
  var LOADING = ["불러오는 중이에요", "잠깐만 기다려 주세요"];
  var RETRY = '잠시 뒤 다시 시도해 주세요<br><button type="button" class="btn" data-act="retry" style="margin-top:10px;">다시 시도</button>';
  // 판 표시 — 맨 아래 「v월/일 시:분 · 커밋 7자리」(../version.json · 배포 때 채워짐 · killnaegi-app.html 과 같은 모양). 틀 그대로(로컬)거나 못 읽으면 「개발 판」
  (function loadVer() {
    var el = document.getElementById("ver"); if (!el || !window.fetch) return;
    function two(n) { return (n < 10 ? "0" : "") + n; }
    fetch("../version.json", { cache: "no-store" }).then(function (r) { return r.text(); }).then(function (t) {
      var j = JSON.parse(t.replace(/^---[\s\S]*?---\s*/, "")), at = Date.parse(j.at || ""), rev = j.rev || "";
      if (!/^[0-9a-f]{7,40}$/.test(rev)) { el.textContent = "개발 판"; return; }
      var d = isFinite(at) ? new Date(at + 9 * 3600000) : null;
      el.textContent = "v" + (d ? (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + " · " : "") + rev.slice(0, 7);
    }).catch(function () { el.textContent = "개발 판"; });
  })();
  window.KR = { LOADING: LOADING, RETRY: RETRY, API: API, api: api, token: token, login: login, logout: logout, esc: esc, won: won, when: when, header: header, switches: switches, num: num, day: day };
})();
