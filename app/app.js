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
};

function labelReason(reason) {
  return REASON_LABEL[reason] || reason;
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
        <a href="https://shlee9498-dev.github.io/gmi-clancup/gdcup-s2.html">G드컵</a>
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
      <a href="https://discord.gg/9RjqdSKw">디스코드</a> ·
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
