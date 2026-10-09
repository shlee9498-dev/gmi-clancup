// 로컬 확인용(커밋됨 · 운영 아님) — 가짜 값만. express · playwright 의 절대 경로는 자기 환경에 맞게 고칠 것. gmi-clancup 폴더를 인자로 준다. 인수인계 docs/HANDOFF.md §5
// 킬내기 앱 「내 상금」 로컬 확인용 가짜 서버 — 계약 §2~§4 · §1.20 모양만 흉내. 전부 가짜 값
const path = require("path");
const express = require("C:/Users/User/mri-academy-killrace/node_modules/express");
const app = express();
app.use(express.json());
const people = {
  pa: { ign: "Player_A", lines: [{ kind: "accrue", amount: 40000, event: 4, eventName: "4회 대승배", reason: "1등 팀", at: "2026-10-02T14:10:00Z" }, { kind: "accrue", amount: 20000, event: 5, eventName: "5회 대승배", reason: "2등 팀", at: "2026-10-08T14:30:00Z" }] },
  pb: { ign: "Player_B", lines: [{ kind: "accrue", amount: 20000, event: 5, eventName: "5회 대승배", reason: "3등 팀", at: "2026-10-08T14:30:00Z" }] },
  pc: { ign: "Player_C", lines: [{ kind: "accrue", amount: 40000, event: 3, eventName: "3회 대승배", reason: "1등 팀", at: "2026-09-30T14:10:00Z" }, { kind: "payout", amount: 40000, status: "paid", requestedAt: "2026-10-01T03:00:00Z", paidAt: "2026-10-01T05:12:00Z", at: "2026-10-01T05:12:00Z" }] },
  owner: { ign: "Owner_X", lines: [] },
  fresh: null,
};
const consented = { fresh: false };
const linked = { fresh: false };
let nextId = 10;
const who = (req) => String(req.headers.authorization || "").replace(/^Bearer /, "");
const summarize = (p) => {
  let accrued = 0, paid = 0, open = null;
  for (const l of p.lines) { if (l.kind === "accrue") accrued += l.amount; else if (l.status === "paid") paid += l.amount; else if (l.status === "requested") open = { id: l.id, amount: l.amount, at: l.requestedAt }; }
  const balance = accrued - paid; const min = 30000;
  const reason = open ? "open_request" : balance < min ? "below_min" : null;
  return { accrued, paid, balance, open, min, canRequest: !reason, reason, short: reason === "below_min" ? min - balance : 0 };
};
app.get("/api/auth/login", (req, res) => { const persona = req.query.as || "pa"; res.redirect(`${req.query.return}#token=${persona}&nonce=${req.query.nonce}`); });
app.get("/api/killrace/me", (req, res) => {
  const w = who(req); if (!(w in people)) return res.status(401).json({ error: { code: "login_required" } });
  if (w === "fresh") return res.json({ consentVersion: "2026-10-08", member: consented.fresh ? { needsConsent: false, linked: linked.fresh, platform: linked.fresh ? "steam" : null, ign: linked.fresh ? "Fake_New" : null, key: null, kind: linked.fresh ? "clan" : null } : null, applications: [] });
  res.json({ consentVersion: "2026-10-08", member: { needsConsent: false, linked: true, platform: "steam", ign: people[w].ign, key: "k" + w, kind: "clan" }, applications: [] });
});
app.post("/api/killrace/me/consent", (req, res) => { consented.fresh = true; res.json({ member: { needsConsent: false, linked: false, platform: null, ign: null, key: null, kind: null } }); });
app.post("/api/killrace/me/link", (req, res) => { if (req.body.ign === "nope") return res.status(404).json({ error: { code: "ign_not_found" } }); linked.fresh = true; res.json({ member: { needsConsent: false, linked: true, platform: "steam", ign: "Fake_New", key: "kn", kind: "clan" }, corrected: req.body.ign !== "Fake_New" }); });
app.get("/api/killrace/me/prize", (req, res) => {
  const w = who(req); if (!(w in people)) return res.status(401).json({ error: { code: "login_required" } });
  if (w === "fresh") return consented.fresh ? res.json({ linked: false, ign: null, accrued: 0, paid: 0, balance: 0, open: null, min: 30000, canRequest: false, reason: "not_linked", short: 0, lines: [] }) : res.status(403).json({ error: { code: "not_member" } });
  const p = people[w]; res.json({ linked: true, ign: p.ign, key: "k" + w, ...summarize(p), lines: p.lines.slice().reverse() });
});
app.post("/api/killrace/me/prize/request", (req, res) => {
  const w = who(req); const p = people[w]; if (!p) return res.status(401).json({ error: { code: "login_required" } });
  const s = summarize(p); if (!s.canRequest) return res.status(409).json({ error: { code: s.reason } });
  const at = new Date().toISOString(); const id = nextId++;
  p.lines.push({ id, kind: "payout", amount: s.balance, status: "requested", requestedAt: at, at, owner: w });
  res.json({ ok: true, request: { id, amount: s.balance, at }, notified: true });
});
app.get("/api/killrace/prize/admin", (req, res) => {
  if (who(req) !== "owner") return res.status(403).json({ error: { code: "owner_only" } });
  const all = Object.entries(people).filter(([, p]) => p);
  const pending = []; const recent = []; const players = [];
  for (const [k, p] of all) {
    for (const l of p.lines) {
      if (l.kind !== "payout") continue;
      if (l.status === "requested") pending.push({ id: l.id, ign: p.ign, key: "k" + k, amount: l.amount, requestedAt: l.requestedAt, notified: k !== "pb", perEvent: p.lines.filter((x) => x.kind === "accrue").map((x) => ({ event: x.event, name: x.eventName, amount: x.amount })) });
      if (l.status === "paid") recent.push({ id: l.id || 1, ign: p.ign, key: "k" + k, amount: l.amount, paidAt: l.paidAt, source: "app", notified: true, memo: null });
    }
    const s = summarize(p); if (p.lines.length) players.push({ ign: p.ign, key: "k" + k, ...s, open: s.open ? { id: s.open.id, amount: s.open.amount } : null });
  }
  const sum = (f) => all.flatMap(([, p]) => p.lines).filter(f).reduce((n, l) => n + l.amount, 0);
  res.json({ min: 30000, pending, recent, players: players.sort((a, b) => b.balance - a.balance), totals: { accrued: sum((l) => l.kind === "accrue"), paid: sum((l) => l.kind === "payout" && l.status === "paid"), requested: sum((l) => l.kind === "payout" && l.status === "requested") } });
});
app.post("/api/killrace/prize/admin", (req, res) => {
  if (who(req) !== "owner") return res.status(403).json({ error: { code: "owner_only" } });
  for (const p of Object.values(people)) { if (!p) continue; const l = p.lines.find((x) => x.id === Number(req.body.id)); if (l) { if (l.status !== "requested") return res.status(409).json({ error: { code: "not_requested" } }); l.status = req.body.action === "paid" ? "paid" : "cancelled"; l.paidAt = l.at = new Date().toISOString(); return res.json({ ok: true, id: l.id, status: l.status, at: l.at, notified: true }); } }
  res.status(404).json({ error: { code: "not_found" } });
});
app.use(express.static(path.resolve(process.argv[2])));
app.listen(4312, () => console.log("prize dev http://localhost:4312/killrace/"));
