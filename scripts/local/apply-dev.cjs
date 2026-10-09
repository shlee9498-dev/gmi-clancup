// 로컬 확인용(커밋됨 · 운영 아님) — 가짜 값만. express · playwright 의 절대 경로는 자기 환경에 맞게 고칠 것. gmi-clancup 폴더를 인자로 준다. 인수인계 docs/HANDOFF.md §5
// 신청 폼 로컬 확인용 — 메모리 저장 · 가짜 전적
const path = require("path");
const express = require("C:/Users/User/mri-academy-killrace/node_modules/express");
const apply = require("C:/Users/User/mri-academy-krapply/killrace-apply.cjs");
const app = express();
app.use(express.json());
const mem = { apply: null, pay: null };
const FAKE = { Fake_Steam1: ["steam"], Both_Nick: ["steam", "kakao"], Kakao_Only: ["kakao"] };
const info = (platform, ign) => ({ platform, nickname: ign, rankedTier: "Diamond 4", basis: { avgDamage: 287.4 }, sample: { avgDamage: 301, kda: 2.1 }, suggested: { tier: "A" } });
app.get("/api/bpi-suggest-auto", (req, res) => {
  const ign = String(req.query.nickname || "");
  if (ign === "Down_Nick") return res.status(500).json({ error: "pubg_error" });
  const plats = FAKE[ign] || (/^Nick\d+$/.test(ign) ? ["steam"] : null);
  if (!plats) return res.status(404).json({ error: "nf" });
  res.json({ nickname: ign, found: plats.map((p) => info(p, ign)) });
});
const api = apply.createApplyApi({
  store: { load: async () => mem.apply, save: async (s) => { mem.apply = s; }, loadPay: async () => mem.pay, savePay: async (p) => { mem.pay = p; } },
  lookup: async (platform, ign) => {
    const plats = FAKE[ign] || (/^Nick\d+$/.test(ign) ? ["steam"] : null);
    if (!plats || !plats.includes(platform)) throw Object.assign(new Error("nf"), { status: 404 });
    return { ign, ranked: "Diamond 4", grade: "A", avgDamage: 287.4, kda: 2.1 };
  },
  isAdmin: (req) => req.headers["x-admin-key"] === "dev", isOwner: () => false,
  notify: async (embed) => console.log("card", JSON.stringify(embed.fields.map((f) => f.name))),
});
api.mount(app);
app.use(express.static(path.resolve(process.argv[2])));
app.listen(4311, () => console.log("apply dev http://localhost:4311/killnaegi.html"));
