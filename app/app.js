/* ============================================
   GmI 클랜 웹 앱 공통 JS
   - API base URL 설정
   - JWT 토큰 관리
   - 인증 fetch wrapper
   - 라우팅 헬퍼
   ============================================ */

/**
 * API 베이스 URL 설정.
 * 배포 후 Railway가 부여한 도메인으로 교체:
 *   https://gmi-bot-xxxx.up.railway.app
 */
const API_BASE = (() => {
  // 로컬 개발 환경 자동 감지
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return "http://localhost:8000";
  }
  // 프로덕션: meta 태그 또는 기본값
  const meta = document.querySelector('meta[name="gmi-api-base"]');
  if (meta) return meta.content;
  // ⚠️ Railway 배포 후 이 값을 수정하세요:
  return "https://worker-production-06b8.up.railway.app";
})();

const TOKEN_KEY = "gmi_token";

/** localStorage에서 JWT 토큰 가져오기. */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** JWT payload 디코드 (검증 안 함 — 표시용). */
function decodeJWT(token) {
  try {
    const payload = token.split(".")[1];
    const padded = payload + "==".slice(0, (4 - payload.length % 4) % 4);
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch (e) {
    return null;
  }
}

/** 토큰이 유효한지 (만료 시각 체크). */
function isTokenValid(token) {
  if (!token) return false;
  const payload = decodeJWT(token);
  if (!payload || !payload.exp) return false;
  return payload.exp * 1000 > Date.now();
}

/** 로그아웃 + 로그인 페이지로. */
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  location.href = "login.html";
}

/* ============================================
   오너 전용 잠금 (2026-10-12 오너 결정 · 변호사 검토)
   카지노 · 카드 게임은 오너 한 명만 들어간다 — 서버(gmi-casino-bot)가 /api 를 오너 토큰만 받고
   그 밖은 403 "closed" 를 준다. 화면은 그 판정을 따라 「지금은 쉬고 있어요」만 보인다(데이터는 서버가 안 준다).
   지우지 않고 잠근다 — 오너가 로그인하면 그대로 동작한다.
   ============================================ */
const CLAN_DISCORD = "https://discord.gg/YfZD8d22wJ";

function showClosed(opts) {
  opts = opts || {};
  if (document.getElementById("gmiClosed")) return;
  const css = document.createElement("style");
  css.textContent =
    "body.gmi-closed>*:not(#gmiClosed){display:none !important}" +
    "#gmiClosed{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px 16px;" +
    "background:var(--deep,#05130F);color:var(--ivory,#F2E9D8);font-family:var(--f-ui,system-ui,-apple-system,sans-serif)}" +
    "#gmiClosed .box{max-width:360px;width:100%;text-align:center;background:var(--felt,#0C2A22);border:1px solid var(--line,rgba(201,162,39,.18));border-radius:6px;padding:28px 20px}" +
    "#gmiClosed h1{font-size:22px;font-weight:800;margin:0 0 8px}" +
    "#gmiClosed p{font-size:14px;line-height:1.6;color:var(--smoke,#8B9A92);margin:0 0 20px}" +
    "#gmiClosed a.go{display:flex;align-items:center;justify-content:center;min-height:44px;border-radius:6px;background:var(--brass,#C9A227);color:#05130F;font-weight:700;text-decoration:none}" +
    "#gmiClosed button{margin-top:14px;min-height:44px;padding:0 12px;background:none;border:0;color:var(--smoke,#8B9A92);font-size:13px;text-decoration:underline;cursor:pointer}";
  document.head.appendChild(css);
  const box = document.createElement("div");
  box.id = "gmiClosed";
  box.setAttribute("role", "status");
  box.innerHTML =
    '<div class="box"><h1>지금은 쉬고 있어요</h1>' +
    "<p>" + (opts.sub || "소식은 클랜 디스코드에서 알려 드려요") + "</p>" +
    '<a class="go" href="' + CLAN_DISCORD + '" target="_blank" rel="noopener">클랜 디스코드</a>' +
    '<button type="button" id="gmiOwnerLogin">운영자 로그인</button></div>';
  document.body.appendChild(box);
  document.body.classList.add("gmi-closed");
  document.documentElement.style.visibility = "";
  document.getElementById("gmiOwnerLogin").addEventListener("click", startLogin);
}

// 처음 열 때 — 오너 토큰이면 그대로, 아니면 잠금 화면. 확인 전엔 화면을 가려 둔다(서버가 데이터를 안 주니 비어 보이는 것만 막는다)
(function casinoGate() {
  const page = location.pathname.split("/").pop() || "index.html";
  if (page === "login.html") {
    document.addEventListener("DOMContentLoaded", function () { showClosed({ sub: "소식은 클랜 디스코드에서 알려 드려요" }); });
    if (document.readyState !== "loading") showClosed();
    return;
  }
  const t = getToken();
  if (!isTokenValid(t)) {                        // 로그인 전 — 안내 화면(게임 설명 how.html 포함)도 잠금 화면만
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { showClosed(); }); else showClosed();
    return;
  }
  document.documentElement.style.visibility = "hidden";
  fetch(`${API_BASE}/api/me`, { headers: { Authorization: `Bearer ${t}` } }).then(function (r) {
    if (r.status === 403 || r.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      const go = function () { showClosed(); };
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
      return;
    }
    document.documentElement.style.visibility = "";
  }).catch(function () {
    const go = function () { showClosed({ sub: "지금은 연결되지 않아요. 잠시 뒤 다시 열어 주세요" }); };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  });
})();

/** EventSource 주소에 토큰 붙이기(EventSource 는 헤더를 못 보낸다 · 서버가 ?token= 으로 오너인지 본다). */
function withToken(url) {
  const t = getToken();
  if (!t) return url;
  return url + (url.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/** API 호출 wrapper. 401이면 자동 로그아웃. */
async function api(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  if (res.status === 401) {
    logout();
    throw new Error("로그인 필요");
  }
  if (res.status === 403) {
    localStorage.removeItem(TOKEN_KEY);
    showClosed();
    throw new Error("closed");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail || JSON.stringify(data);
    } catch (e) {}
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json();
}

/** 인증 필요 페이지 — 토큰 없으면 로그인으로. */
function requireAuth() {
  const t = getToken();
  if (!isTokenValid(t)) {
    location.href = "login.html";
    return null;
  }
  return decodeJWT(t);
}

/** Discord OAuth 시작 URL로 이동. */
function startLogin() {
  location.href = `${API_BASE}/auth/start`;
}

/** 코인 포맷팅 1234 → '1,234'. */
function fmtCoin(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString("ko-KR");
}

/** 디스코드 아바타 URL. */
function avatarUrl(userId, hash) {
  if (hash) {
    const ext = hash.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${userId}/${hash}.${ext}?size=64`;
  }
  // 기본 아바타 (디스코드 색상별 분류)
  const idx = (BigInt(userId) >> 22n) % 6n;
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

/** ledger reason → 한글 라벨. */
const REASON_LABEL = {
  duel_win: "1:1 승리",
  duel_loss: "1:1 패배",
  duel_forfeit_penalty: "자유 종료 페널티",
  duel_rake: "Rake",
  duel_forfeit: "자유 종료 소각",
  manual_grant: "지급",
  manual_deduct: "차감",
  g_drop: "G드랍",
  shop_purchase: "G샵 구매",
  shop_refund: "G샵 환불",
};

function labelReason(reason) {
  if (REASON_LABEL[reason]) return REASON_LABEL[reason];
  // "shop_purchase:chicken" 처럼 접두사:상세 형태 → 접두사로 매칭
  const head = String(reason || "").split(":")[0];
  return REASON_LABEL[head] || reason;
}

/** ISO 시간 → 상대 표시 (방금 / N분 전 / 어제). */
function timeAgo(iso) {
  if (!iso) return "";
  // SQLite의 "datetime('now')" 는 UTC. tz 없는 문자열은 UTC로 간주.
  const utc = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  const ms = Date.now() - new Date(utc).getTime();
  if (isNaN(ms)) return iso;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "방금";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(utc).toLocaleDateString("ko-KR");
}

/** 네비게이션 렌더. 현재 페이지 강조. */
function renderNav(currentPage = "") {
  const me = isTokenValid(getToken()) ? decodeJWT(getToken()) : null;
  const navHTML = `
    <nav class="nav">
      <a href="index.html" class="logo">
        <span class="logo-mark">G</span>
        <span>GmI 클랜</span>
      </a>
      <div class="spacer"></div>
      <div class="links">
        <a href="index.html" class="${currentPage === 'index' ? 'active' : ''}">홈</a>
        <a href="casino.html" class="${currentPage === 'casino' ? 'active' : ''}">🎰 카지노</a>
        <a href="matches.html" class="${currentPage === 'matches' ? 'active' : ''}">매치</a>
        <a href="shop.html" class="${currentPage === 'shop' ? 'active' : ''}">🛒 G샵</a>
        <a href="https://shlee9498-dev.github.io/gmi-clancup/gdcup-s3.html">G드컵</a>
        <a href="how.html" class="${currentPage === 'how' ? 'active' : ''}">❓ 방법</a>
      </div>
      ${me ? `
        <div class="me">
          <img class="avatar" src="${avatarUrl(me.sub, me.avatar)}" alt="">
          <span>${me.name}</span>
        </div>
      ` : `
        <a href="login.html" class="btn btn-outline" style="padding:6px 14px;font-size:13px">로그인</a>
      `}
    </nav>
  `;
  document.body.insertAdjacentHTML("afterbegin", navHTML);
}

/** 푸터 렌더. */
function renderFooter() {
  document.body.insertAdjacentHTML("beforeend", `
    <footer class="footer">
      GmI 클랜 · 2026 ·
      <a href="https://discord.gg/YfZD8d22wJ">디스코드</a> ·
      <a href="https://shlee9498-dev.github.io/gmi-clancup/">G드컵</a>
    </footer>
  `);
}

/** PWA 서비스 워커 등록. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(err => {
      console.warn("SW registration failed:", err);
    });
  });
}
