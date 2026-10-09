// 로컬 확인용(커밋됨 · 운영 아님) — 가짜 값만. express · playwright 의 절대 경로는 자기 환경에 맞게 고칠 것. gmi-clancup 폴더를 인자로 준다. 인수인계 docs/HANDOFF.md §5
// 킬내기 앱 내 상금 — 폭 360 캡처 · 흐름 확인
const { chromium } = require("C:/Users/User/mri-student-app/.ds-sync/node_modules/playwright-core");
const path = require("path"); const fs = require("fs");
const OUT = path.join(__dirname, "shots-prize"); fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:4312"; const errors = [];
(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const open = async (url) => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(url + ": " + e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/favicon|fonts|pretendard|status of 4/i.test(m.text())) errors.push(url + ": console " + m.text()); });
    p.on("dialog", (d) => d.accept());
    await p.goto(BASE + url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(1200); return p;
  };
  const shot = async (p, name, full = true) => { await p.waitForTimeout(500); await p.screenshot({ path: path.join(OUT, name + ".png"), fullPage: full }); console.log("shot", name); };
  const overflow = async (p, name) => { const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (o > 1) errors.push(name + " 가로 넘침 " + o); };
  // 로그인 흐름: 로그인 버튼 → 가짜 디스코드 → 돌아와 토큰 저장(nonce 대조) · 주소에서 token 삭제
  const loginAs = async (persona, page = "prize.html") => {
    const p = await open("/killrace/" + page);
    await p.evaluate((as) => { const orig = location.href; window.__as = as; }, persona);
    // 가짜 서버는 ?as= 로 사람을 고른다 — 로그인 주소에 끼워 넣는다
    await p.route("**/api/auth/login*", (route) => route.continue({ url: route.request().url() + "&as=" + persona }));
    await p.click('[data-act="login"]'); await p.waitForTimeout(1500);
    const hash = await p.evaluate(() => location.hash); if (hash.includes("token=")) errors.push("주소에 token 이 남아 있다");
    return p;
  };
  // 0) 로그인 전
  const anon = await open("/killrace/prize.html"); await shot(anon, "00-anon", false); await overflow(anon, "anon");
  // 1) 선수 A — 잔액 60,000(3만 원 이상) → 칩 켜짐
  const pa = await loginAs("pa");
  console.log("pa:", (await pa.textContent("#balance")).trim(), "|", (await pa.textContent("#action")).trim(), "|", (await pa.textContent("#actionNote")).trim());
  await shot(pa, "01-pa-chip"); await overflow(pa, "pa");
  const ownerHidden = await pa.isHidden("#owner"); if (!ownerHidden) errors.push("선수에게 오너 칸이 보인다");
  // 2) 선수 B — 20,000(3만 원 미만) → 3만 원 안내
  const pb = await loginAs("pb");
  console.log("pb:", (await pb.textContent("#actionNote")).trim(), "| chip:", await pb.locator("#reqBtn").count());
  await shot(pb, "02-pb-below"); await overflow(pb, "pb");
  // 3) 선수 C — 잔액 0 · 지급 완료 이력
  const pc = await loginAs("pc");
  console.log("pc:", (await pc.textContent("#balance")).trim(), "|", (await pc.textContent("#lines")).replace(/\s+/g, " ").trim().slice(0, 80));
  await shot(pc, "03-pc-paid");
  // 4) 오너 — 지급 대기 0건
  const owner = await loginAs("owner");
  await owner.waitForTimeout(600);
  console.log("owner pending:", (await owner.textContent("#pending")).replace(/\s+/g, " ").trim());
  await shot(owner, "04-owner-pending-0"); await overflow(owner, "owner");
  // 5) 선수 A 요청 → 오너 목록에 1건 → 지급 완료 → 선수 A 화면 이력
  await pa.click("#reqBtn"); await pa.waitForTimeout(900);
  console.log("pa after:", (await pa.textContent("#action")).trim(), "|", (await pa.textContent("#mineMsg")).trim());
  await shot(pa, "05-pa-requested", false);
  await owner.reload(); await owner.waitForTimeout(1200);
  console.log("owner pending:", (await owner.textContent("#pending")).replace(/\s+/g, " ").trim().slice(0, 100));
  await shot(owner, "06-owner-pending-1");
  await owner.click("[data-pay]"); await owner.waitForTimeout(1200);
  console.log("owner msg:", (await owner.textContent("#ownerMsg")).trim(), "| pending:", (await owner.textContent("#pending")).replace(/\s+/g, " ").trim().slice(0, 40));
  await pa.reload(); await pa.waitForTimeout(1200);
  console.log("pa final:", (await pa.textContent("#balance")).trim(), "|", (await pa.textContent("#actionNote")).trim());
  await shot(pa, "07-pa-paid");
  // 6) 새 회원 — 동의 → 연결
  const fresh = await loginAs("fresh", "index.html");
  console.log("fresh:", await fresh.isVisible("#consentCard"));
  await fresh.click("#consentBtn"); await fresh.waitForTimeout(400); console.log("consent msg:", (await fresh.textContent("#consentMsg")).trim());
  await fresh.check("#age14"); await fresh.click("#consentBtn"); await fresh.waitForTimeout(600);
  console.log("link visible:", await fresh.isVisible("#linkCard"));
  await shot(fresh, "08-fresh-link", false);
  await fresh.fill("#ign", "nope"); await fresh.click("#linkBtn"); await fresh.waitForTimeout(500); console.log("link err:", (await fresh.textContent("#linkMsg")).trim());
  await fresh.fill("#ign", "fake_new"); await fresh.click("#linkBtn"); await fresh.waitForTimeout(500); console.log("link ok:", (await fresh.textContent("#linkMsg")).trim(), "|", (await fresh.textContent("#linkedIgn")).trim());
  await shot(fresh, "09-fresh-linked", false);
  // 응답 · 화면에 계좌 · 번호가 없는지
  for (const p of [pa, owner]) { const html = await p.content(); if (/account_id|discord_id|계좌번호/.test(html)) errors.push("화면에 민감 값"); }
  await browser.close(); console.log(errors.length ? "ERRORS\n" + errors.join("\n") : "no page errors · no overflow · token not left in URL");
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
