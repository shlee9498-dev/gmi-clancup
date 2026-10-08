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
  function api(path, body, method) {
    var h = { "Content-Type": "application/json" };
    if (token()) h.Authorization = "Bearer " + token();
    var opt = { method: method || (body ? "POST" : "GET"), headers: h, cache: "no-store" };
    if (body) opt.body = JSON.stringify(body);
    return fetch(API + path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) logout();
        return { ok: r.ok, status: r.status, body: j, code: j && j.error && j.error.code ? j.error.code : null };
      });
    }, function () { return { ok: false, status: 0, body: {}, code: "network" }; });
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
  });
  window.KR = { API: API, api: api, token: token, login: login, logout: logout, esc: esc, won: won, when: when, header: header };
})();
