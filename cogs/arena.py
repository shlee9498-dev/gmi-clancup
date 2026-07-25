"""GmI 아레나 — 킬내기 세트 자동화 (블랙워크 노래방룰).

담당자(비개발자 클랜원)가 시트를 만지지 않고 디코 버튼만으로 킬내기 세트를
운영·정산한다.

룰:
  - 세트 = 2시간 타이머. 세트 안에서 여러 판(match) 진행.
  - 판 점수는 누적되지 않음(판마다 독립). 판 점수 = team_kills + (chicken ? 0 : -4).
  - 목표점수(TARGET_SCORE, 기본 25)를 한 판에 먼저 달성한 팀 즉시 승리 → 세트 종료.
  - 2시간 경과 시: 팀별 최고 단판점 → 동점 시 치킨 수 → (총딜량은 미집계).
  - 데스·개별 생존 미집계. 판당 입력 = 팀별 총킬(정수) + 치킨(한 팀).

정산(전부 자동):
  - 팟 = 참가비 총액. 1등 55% / 2등 25% / 3등 10% / 4등 10% (팀 내 균등, 잔여 소각).
  - 우승팀 전원 +2, 개인 킬 1위 +3(담당자 선택), 담당자 수당 +4.
  - 모든 아레나 보상 reason 은 'arena_' 접두사 → 주간 상한(grant) 카운트에서 제외.
  - 개인별 주 2회차까지만 보상. 3회차+ 참가는 허용하되 코인 0 (월 00:00 KST 기준 주차).

모든 코인 변동은 db.add_coins / db.log_burn 로 ledger 에 기록된다.
"""
from __future__ import annotations

import logging
import math
import os
import random
from datetime import datetime, timedelta
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands, tasks

import db
from cogs._utils import (
    KST, clan_only, fmt_coins, is_admin, is_clan_member, now_kst,
)

log = logging.getLogger("gmi.arena")

# ---- tunables (env overridable) -------------------------------------------
CHICKEN_PENALTY = -4            # 치킨 실패 시 판 점수 페널티
POT_SPLIT = [55, 25, 10, 10]    # 1~4등 팟 배분(%)
WIN_BONUS = 2                   # 우승팀 전원
MVP_BONUS = 3                   # 개인 킬 1위
MANAGER_BONUS = 4              # 담당자(개설자) 수당
WEEKLY_REWARD_CAP = 2          # 개인별 주 보상 상한(회차)
TEAM_SIZE = 4
MAX_TEAMS = 4                  # A~D
TEAM_KEYS = ["A", "B", "C", "D"]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def default_target() -> int:
    return _env_int("ARENA_TARGET_SCORE", 25)


def default_duration() -> int:
    return _env_int("ARENA_DURATION_MIN", 120)


def default_fee() -> int:
    return _env_int("ARENA_ENTRY_FEE", 1)


def _parse_ts(s: str) -> datetime:
    """SQLite datetime('now') → UTC naive."""
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def _week_key(at: Optional[datetime] = None) -> str:
    """KST 월요일 00:00 기준 주차 키 ('YYYY-MM-DD')."""
    n = at or now_kst()
    monday = n - timedelta(days=n.weekday())
    return monday.strftime("%Y-%m-%d")


def _match_score(kills: int, chicken: bool) -> int:
    return kills + (0 if chicken else CHICKEN_PENALTY)


def _fmt_remaining(seconds: float) -> str:
    seconds = int(max(0, seconds))
    h, rem = divmod(seconds, 3600)
    m, _ = divmod(rem, 60)
    if h > 0:
        return f"{h}시간 {m}분"
    return f"{m}분"


# ---------------------------------------------------------------------------
# Data access helpers (read-only; heavy writes go through db.transaction)
# ---------------------------------------------------------------------------

def _load_set(set_id: int) -> Optional[dict]:
    row = db.fetchone("SELECT * FROM arena_sets WHERE id = ?", (set_id,))
    return dict(row) if row else None


def _team_names(set_id: int) -> dict[str, str]:
    rows = db.fetchall("SELECT team, name FROM arena_teams WHERE set_id = ?", (set_id,))
    return {r["team"]: r["name"] for r in rows}


def _participants(set_id: int) -> list[dict]:
    rows = db.fetchall(
        """SELECT p.discord_id, p.team, u.nickname
           FROM arena_participants p JOIN users u ON u.discord_id = p.discord_id
           WHERE p.set_id = ? ORDER BY p.created_at ASC""",
        (set_id,),
    )
    return [dict(r) for r in rows]


def _team_best(set_id: int) -> dict[str, dict]:
    """team_key -> {best, chickens, n}. best = 최고 단판 점수(없으면 None)."""
    rows = db.fetchall(
        """SELECT team, MAX(score) AS best, SUM(chicken) AS chickens, COUNT(*) AS n
           FROM arena_matches WHERE set_id = ? GROUP BY team""",
        (set_id,),
    )
    out: dict[str, dict] = {}
    for r in rows:
        out[r["team"]] = {
            "best": r["best"],
            "chickens": int(r["chickens"] or 0),
            "n": int(r["n"] or 0),
        }
    return out


def _rank_teams(set_id: int, forced_winner: Optional[str] = None) -> list[str]:
    """정산 순위(team_key). forced_winner 는 무조건 1위로 고정."""
    names = _team_names(set_id)
    best = _team_best(set_id)
    keys = list(names.keys())

    def sort_key(t: str):
        b = best.get(t, {"best": None, "chickens": 0})
        best_score = b["best"] if b["best"] is not None else -10**9
        return (-best_score, -b["chickens"], t)

    if forced_winner and forced_winner in keys:
        rest = sorted([t for t in keys if t != forced_winner], key=sort_key)
        return [forced_winner] + rest
    # only rank teams that actually played at least one match; append the rest
    played = [t for t in keys if best.get(t, {}).get("n", 0) > 0]
    unplayed = [t for t in keys if best.get(t, {}).get("n", 0) == 0]
    return sorted(played, key=sort_key) + sorted(unplayed)


# ---------------------------------------------------------------------------
# Embeds
# ---------------------------------------------------------------------------

def _build_recruit_embed(set_id: int) -> discord.Embed:
    s = _load_set(set_id)
    if not s:
        return discord.Embed(title=f"아레나 #{set_id}", description="not found")
    parts = _participants(set_id)
    teamed = s["status"] in ("teamed",)
    color = 0xF5C518

    embed = discord.Embed(
        title=f"⚔️ GmI 아레나 세트 `#{set_id}` · 모집",
        color=color,
    )
    embed.description = (
        f"**담당자**: <@{s['manager_id']}>\n"
        f"**목표점수**: {s['target_score']}점 · **세트시간**: {s['duration_min']}분 · "
        f"**참가비**: {fmt_coins(s['entry_fee'])}\n"
        f"판 점수 = 총킬 + (치킨 성공 0 / 실패 {CHICKEN_PENALTY})"
    )
    if not teamed:
        names = ", ".join(f"<@{p['discord_id']}>" for p in parts) or "_아직 없음_"
        embed.add_field(
            name=f"참가자 ({len(parts)}명)", value=names, inline=False
        )
    else:
        tnames = _team_names(set_id)
        for tk in TEAM_KEYS:
            members = [p for p in parts if p["team"] == tk]
            if not members:
                continue
            mtxt = ", ".join(f"<@{m['discord_id']}>" for m in members)
            embed.add_field(name=f"팀 {tnames.get(tk, tk)}", value=mtxt, inline=False)
        bench = [p for p in parts if p["team"] == "대기"]
        if bench:
            embed.add_field(
                name="대기",
                value=", ".join(f"<@{m['discord_id']}>" for m in bench),
                inline=False,
            )
    embed.add_field(name="누적 팟", value=f"**{fmt_coins(s['pot'])}**", inline=True)
    embed.set_footer(text="참가비는 참가 시 차감 · 세트 취소 시 전액 환불")
    return embed


def _gauge(best: Optional[int], target: int) -> str:
    if best is None:
        best = 0
    filled = max(0, min(target, best))
    blocks = 10
    on = round(filled / target * blocks) if target > 0 else 0
    return "█" * on + "░" * (blocks - on) + f" {best}/{target}"


def _build_progress_embed(set_id: int) -> discord.Embed:
    s = _load_set(set_id)
    if not s:
        return discord.Embed(title=f"아레나 #{set_id}", description="not found")
    names = _team_names(set_id)
    best = _team_best(set_id)
    target = s["target_score"]

    remaining_txt = "—"
    if s["ends_at"]:
        remaining = (_parse_ts(s["ends_at"]) - datetime.utcnow()).total_seconds()
        remaining_txt = _fmt_remaining(remaining)

    next_no = 1 + (db.fetchone(
        "SELECT COALESCE(MAX(match_no),0) AS m FROM arena_matches WHERE set_id = ?",
        (set_id,),
    )["m"])

    embed = discord.Embed(
        title=f"⚔️ 아레나 세트 `#{set_id}` · 진행 중",
        color=0xF5C518,
    )
    embed.description = (
        f"⏳ 남은 시간 **{remaining_txt}** · 현재 **{next_no}판째** · "
        f"목표 **{target}점**"
    )
    # rank preview
    order = _rank_teams(set_id)
    medal = ["🥇", "🥈", "🥉", "4️⃣"]
    for i, tk in enumerate(order):
        b = best.get(tk, {"best": None, "chickens": 0, "n": 0})
        tag = medal[i] if i < len(medal) else "▫"
        embed.add_field(
            name=f"{tag} {names.get(tk, tk)}",
            value=(
                f"최고 단판 **{b['best'] if b['best'] is not None else '-'}점**\n"
                f"{_gauge(b['best'], target)}\n"
                f"치킨 {b['chickens']}회 · {b['n']}판"
            ),
            inline=True,
        )
    embed.set_footer(text="[판 결과 입력]으로 진행 · 오입력은 [직전 판 취소]")
    return embed


# ---------------------------------------------------------------------------
# Modals
# ---------------------------------------------------------------------------

class TeamNameModal(discord.ui.Modal, title="팀명 편집"):
    def __init__(self, cog: "Arena", set_id: int):
        super().__init__()
        self.cog = cog
        self.set_id = set_id
        self._inputs: dict[str, discord.ui.TextInput] = {}
        names = _team_names(set_id)
        for tk in TEAM_KEYS:
            if tk not in names:
                continue
            ti = discord.ui.TextInput(
                label=f"팀 {tk} 이름",
                default=names[tk],
                required=True,
                max_length=20,
            )
            self._inputs[tk] = ti
            self.add_item(ti)

    async def on_submit(self, interaction: discord.Interaction):
        with db.transaction() as conn:
            for tk, ti in self._inputs.items():
                conn.execute(
                    "UPDATE arena_teams SET name = ? WHERE set_id = ? AND team = ?",
                    (ti.value.strip() or tk, self.set_id, tk),
                )
        await interaction.response.defer()
        await self.cog.refresh_message(self.set_id)


class MatchResultModal(discord.ui.Modal, title="판 결과 입력"):
    def __init__(self, cog: "Arena", set_id: int):
        super().__init__()
        self.cog = cog
        self.set_id = set_id
        self._kill_inputs: dict[str, discord.ui.TextInput] = {}
        names = _team_names(set_id)
        self._names = names
        for tk in TEAM_KEYS:
            if tk not in names:
                continue
            ti = discord.ui.TextInput(
                label=f"{names[tk]} 총킬",
                placeholder="정수 (예: 12)",
                required=True,
                max_length=3,
            )
            self._kill_inputs[tk] = ti
            self.add_item(ti)
        self._chicken = discord.ui.TextInput(
            label="치킨 획득 팀 (A/B/C/D · 없으면 공란)",
            required=False,
            max_length=2,
        )
        self.add_item(self._chicken)

    async def on_submit(self, interaction: discord.Interaction):
        # parse kills
        kills: dict[str, int] = {}
        for tk, ti in self._kill_inputs.items():
            raw = ti.value.strip()
            if not raw.isdigit():
                await interaction.response.send_message(
                    f"팀 {self._names.get(tk, tk)} 총킬은 0 이상 정수여야 합니다.",
                    ephemeral=True,
                )
                return
            kills[tk] = int(raw)
        chicken_raw = self._chicken.value.strip().upper()
        chicken_team: Optional[str] = None
        if chicken_raw and chicken_raw not in ("없음", "X", "-"):
            if chicken_raw not in self._kill_inputs:
                await interaction.response.send_message(
                    f"치킨 팀은 {'/'.join(self._kill_inputs.keys())} 중 하나거나 공란이어야 합니다.",
                    ephemeral=True,
                )
                return
            chicken_team = chicken_raw

        result = await self.cog.submit_match(
            self.set_id, kills, chicken_team
        )
        if result is None:
            await interaction.response.send_message(
                "세트가 진행 중이 아닙니다.", ephemeral=True
            )
            return

        if result.get("winner"):
            await interaction.response.send_message(
                f"🏁 목표 달성! 팀 **{result['winner_name']}** 승리 — 정산합니다.",
                ephemeral=True,
            )
            await self.cog.settle_set(self.set_id, forced_winner=result["winner"],
                                      reason="목표 달성")
        else:
            await interaction.response.send_message(
                f"✅ {result['match_no']}판 기록 완료.", ephemeral=True
            )
            await self.cog.refresh_message(self.set_id)


# ---------------------------------------------------------------------------
# MVP (개인 킬 1위) select — optional, manager-only, appended after settlement
# ---------------------------------------------------------------------------

class MvpSelect(discord.ui.Select):
    def __init__(self, cog: "Arena", set_id: int, participants: list[dict]):
        self.cog = cog
        self.set_id = set_id
        options = [
            discord.SelectOption(label=p["nickname"][:100], value=p["discord_id"])
            for p in participants[:25]
        ]
        super().__init__(
            placeholder="개인 킬 1위 선택 (동률이면 복수 선택) · 미선택 시 지급 없음",
            min_values=1,
            max_values=min(len(options), 25) if options else 1,
            options=options or [discord.SelectOption(label="없음", value="none")],
        )

    async def callback(self, interaction: discord.Interaction):
        chosen = [v for v in self.values if v != "none"]
        granted = await self.cog.grant_mvp(self.set_id, chosen)
        self.disabled = True
        await interaction.response.edit_message(
            content=(
                f"개인 킬 1위 +{MVP_BONUS}코인 지급 완료: "
                + (", ".join(f"<@{u}>" for u in granted) if granted else "없음")
            ),
            view=None,
        )


class MvpView(discord.ui.View):
    def __init__(self, cog: "Arena", set_id: int, participants: list[dict]):
        super().__init__(timeout=180)
        self.add_item(MvpSelect(cog, set_id, participants))


# ---------------------------------------------------------------------------
# Main control view (status-aware, persistent)
# ---------------------------------------------------------------------------

class ArenaView(discord.ui.View):
    def __init__(self, cog: "Arena", set_id: int, status: str):
        super().__init__(timeout=None)
        self.cog = cog
        self.set_id = set_id
        self.status = status
        self._build(status)

    def _btn(self, label, style, action, emoji=None, disabled=False):
        b = discord.ui.Button(
            label=label, style=style, emoji=emoji, disabled=disabled,
            custom_id=f"arena:{action}:{self.set_id}",
        )
        b.callback = getattr(self, f"_cb_{action}")
        self.add_item(b)
        return b

    def _build(self, status: str):
        S = discord.ButtonStyle
        if status == "recruiting":
            self._btn("참가", S.success, "join", "✅")
            self._btn("참가취소", S.secondary, "leave", "↩️")
            self._btn("팀 편성", S.primary, "team", "🧩")
            self._btn("세트 인수", S.secondary, "takeover", "🛟")
            self._btn("세트 취소", S.danger, "cancel", "🗑️")
        elif status == "teamed":
            self._btn("팀 다시 편성", S.secondary, "team", "🔀")
            self._btn("팀명 편집", S.secondary, "teamname", "✏️")
            self._btn("세트 시작", S.success, "start", "▶️")
            self._btn("세트 인수", S.secondary, "takeover", "🛟")
            self._btn("세트 취소", S.danger, "cancel", "🗑️")
        elif status == "running":
            self._btn("판 결과 입력", S.success, "matchinput", "📝")
            self._btn("직전 판 취소", S.secondary, "cancel_last", "↩️")
            self._btn("수동 종료", S.danger, "end", "🏁")
            self._btn("세트 인수", S.secondary, "takeover", "🛟")

    # ---- permission helpers ----
    def _is_manager(self, interaction: discord.Interaction, s: dict) -> bool:
        return str(interaction.user.id) == s["manager_id"] or is_admin(interaction.user)

    async def _deny(self, interaction, msg):
        await interaction.response.send_message(msg, ephemeral=True)

    # ---- callbacks ----
    async def _cb_join(self, interaction: discord.Interaction):
        if not is_clan_member(interaction.user):
            return await self._deny(interaction, "클랜원 전용입니다.")
        try:
            bal = await self.cog.join(self.set_id, interaction.user)
        except RuntimeError as e:
            return await self._deny(interaction, str(e))
        await interaction.response.send_message(
            f"✅ 참가 완료. 참가비 차감 후 잔액 {fmt_coins(bal)}.", ephemeral=True
        )
        await self.cog.refresh_message(self.set_id)

    async def _cb_leave(self, interaction: discord.Interaction):
        try:
            bal = await self.cog.leave(self.set_id, str(interaction.user.id))
        except RuntimeError as e:
            return await self._deny(interaction, str(e))
        await interaction.response.send_message(
            f"↩️ 참가 취소. 참가비 환불 후 잔액 {fmt_coins(bal)}.", ephemeral=True
        )
        await self.cog.refresh_message(self.set_id)

    async def _cb_team(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 편성할 수 있습니다.")
        try:
            summary = await self.cog.form_teams(self.set_id)
        except RuntimeError as e:
            return await self._deny(interaction, str(e))
        await interaction.response.send_message(f"🧩 팀 편성 완료. {summary}", ephemeral=True)
        await self.cog.refresh_message(self.set_id)

    async def _cb_teamname(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 편집할 수 있습니다.")
        await interaction.response.send_modal(TeamNameModal(self.cog, self.set_id))

    async def _cb_start(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 시작할 수 있습니다.")
        try:
            await self.cog.start_set(self.set_id)
        except RuntimeError as e:
            return await self._deny(interaction, str(e))
        await interaction.response.send_message("▶️ 세트 시작! 타이머 가동.", ephemeral=True)
        await self.cog.refresh_message(self.set_id)

    async def _cb_matchinput(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 입력할 수 있습니다.")
        if s["status"] != "running":
            return await self._deny(interaction, "진행 중인 세트가 아닙니다.")
        await interaction.response.send_modal(MatchResultModal(self.cog, self.set_id))

    async def _cb_cancel_last(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 되돌릴 수 있습니다.")
        n = await self.cog.cancel_last_match(self.set_id)
        if n is None:
            return await self._deny(interaction, "취소할 판이 없습니다.")
        await interaction.response.send_message(f"↩️ {n}판 기록을 취소했습니다.", ephemeral=True)
        await self.cog.refresh_message(self.set_id)

    async def _cb_end(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 종료할 수 있습니다.")
        await interaction.response.send_message("🏁 세트를 종료하고 정산합니다.", ephemeral=True)
        await self.cog.settle_set(self.set_id, reason="수동 종료")

    async def _cb_takeover(self, interaction: discord.Interaction):
        if not is_admin(interaction.user):
            return await self._deny(interaction, "운영진만 인수할 수 있습니다.")
        await self.cog.takeover(self.set_id, str(interaction.user.id))
        await interaction.response.send_message("🛟 담당자를 인수했습니다.", ephemeral=True)
        await self.cog.refresh_message(self.set_id)

    async def _cb_cancel(self, interaction: discord.Interaction):
        s = _load_set(self.set_id)
        if not s or not self._is_manager(interaction, s):
            return await self._deny(interaction, "담당자/운영진만 취소할 수 있습니다.")
        refunded = await self.cog.cancel_set(self.set_id)
        await interaction.response.send_message(
            f"🗑️ 세트 취소. 참가비 {refunded}건 전액 환불 완료.", ephemeral=True
        )
        await self.cog.refresh_message(self.set_id)


# ---------------------------------------------------------------------------
# Cog
# ---------------------------------------------------------------------------

class Arena(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._settling: set[int] = set()
        self.reaper.start()

    def cog_unload(self):
        self.reaper.cancel()

    # ===================== slash commands =====================
    @app_commands.command(
        name="아레나개설",
        description="(운영진) 킬내기 아레나 세트를 개설합니다.",
    )
    @app_commands.describe(
        목표점수="한 판에 먼저 도달하면 즉시 승리 (기본 25)",
        세트시간="세트 제한시간(분, 기본 120)",
        참가비="1인 참가비 코인 (기본 1)",
    )
    async def open_arena(
        self,
        interaction: discord.Interaction,
        목표점수: Optional[int] = None,
        세트시간: Optional[int] = None,
        참가비: Optional[int] = None,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        target = 목표점수 if 목표점수 is not None else default_target()
        duration = 세트시간 if 세트시간 is not None else default_duration()
        fee = 참가비 if 참가비 is not None else default_fee()
        if target < 1 or duration < 1 or fee < 0:
            await interaction.response.send_message(
                "목표점수·세트시간은 1 이상, 참가비는 0 이상이어야 합니다.", ephemeral=True
            )
            return

        opener = str(interaction.user.id)
        with db.transaction() as conn:
            db.ensure_user(conn, opener, interaction.user.display_name)
            cur = conn.execute(
                """INSERT INTO arena_sets
                   (opened_by, manager_id, channel_id, target_score, duration_min, entry_fee, status)
                   VALUES (?, ?, ?, ?, ?, ?, 'recruiting')""",
                (
                    opener, opener,
                    str(interaction.channel_id) if interaction.channel_id else None,
                    target, duration, fee,
                ),
            )
            set_id = cur.lastrowid

        embed = _build_recruit_embed(set_id)
        view = ArenaView(self, set_id, "recruiting")
        await interaction.response.send_message(embed=embed, view=view)
        try:
            msg = await interaction.original_response()
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE arena_sets SET message_id = ? WHERE id = ?",
                    (str(msg.id), set_id),
                )
            self.bot.add_view(view, message_id=msg.id)
        except Exception:
            log.exception("failed to persist arena message id")

    @app_commands.command(name="아레나기록", description="최근 아레나 세트 + 내 통산 기록")
    @clan_only()
    async def arena_record(self, interaction: discord.Interaction):
        recent = db.fetchall(
            """SELECT id, winner_team, pot, target_score, ended_at
               FROM arena_sets WHERE status = 'ended'
               ORDER BY ended_at DESC LIMIT 5"""
        )
        uid = str(interaction.user.id)
        mine = db.fetchone(
            """SELECT
                 COUNT(DISTINCT ap.set_id) AS sets,
                 COALESCE(SUM(CASE WHEN ap.team = s.winner_team THEN 1 ELSE 0 END),0) AS wins
               FROM arena_participants ap JOIN arena_sets s ON s.id = ap.set_id
               WHERE ap.discord_id = ? AND s.status = 'ended'""",
            (uid,),
        )
        best = db.fetchone(
            """SELECT COALESCE(MAX(m.score),0) AS best
               FROM arena_matches m
               JOIN arena_participants ap ON ap.set_id = m.set_id AND ap.team = m.team
               WHERE ap.discord_id = ?""",
            (uid,),
        )
        embed = discord.Embed(title="⚔️ 아레나 기록", color=0xF5C518)
        if recent:
            lines = []
            for r in recent:
                names = _team_names(r["id"])
                wt = names.get(r["winner_team"], r["winner_team"] or "-")
                lines.append(
                    f"`#{r['id']}` 우승 **{wt}** · 팟 {fmt_coins(int(r['pot']))} · "
                    f"목표 {r['target_score']}점"
                )
            embed.add_field(name="최근 세트", value="\n".join(lines), inline=False)
        else:
            embed.add_field(name="최근 세트", value="_아직 없음_", inline=False)
        embed.add_field(
            name=f"{interaction.user.display_name} 통산",
            value=(
                f"참가 {int(mine['sets']) if mine else 0}세트 · "
                f"우승 {int(mine['wins']) if mine else 0}회 · "
                f"최고 단판 {int(best['best']) if best else 0}점"
            ),
            inline=False,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(
        name="아레나통계",
        description="판별 점수 분포(평균·최고·목표달성률) — 목표점수 캘리브레이션용",
    )
    @clan_only()
    async def arena_stats(self, interaction: discord.Interaction):
        row = db.fetchone(
            """SELECT COUNT(*) AS n, AVG(score) AS avg, MAX(score) AS best,
                      MIN(score) AS worst
               FROM arena_matches m JOIN arena_sets s ON s.id = m.set_id
               WHERE s.status = 'ended'"""
        )
        # 목표달성률: 목표 이상 점수를 낸 판 비율 (세트별 목표 기준)
        hit = db.fetchone(
            """SELECT
                 SUM(CASE WHEN m.score >= s.target_score THEN 1 ELSE 0 END) AS hits,
                 COUNT(*) AS total
               FROM arena_matches m JOIN arena_sets s ON s.id = m.set_id
               WHERE s.status = 'ended'"""
        )
        n = int(row["n"]) if row and row["n"] else 0
        if n == 0:
            await interaction.response.send_message(
                "집계할 판 데이터가 없습니다.", ephemeral=True
            )
            return
        rate = (int(hit["hits"] or 0) / int(hit["total"]) * 100) if hit and hit["total"] else 0
        embed = discord.Embed(title="📊 아레나 판 점수 통계", color=0xF5C518)
        embed.description = (
            f"집계 판수 **{n}**\n"
            f"평균 **{row['avg']:.1f}점** · 최고 **{int(row['best'])}점** · 최저 **{int(row['worst'])}점**\n"
            f"목표 달성 판 비율 **{rate:.1f}%**"
        )
        embed.set_footer(text="첫 2회차 후 목표점수 조정 판단에 활용")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ===================== participation =====================
    async def join(self, set_id: int, user: discord.abc.User) -> int:
        uid = str(user.id)
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status, entry_fee FROM arena_sets WHERE id = ?", (set_id,)
            ).fetchone()
            if s is None:
                raise RuntimeError("세트를 찾을 수 없습니다.")
            if s["status"] != "recruiting":
                raise RuntimeError("모집이 마감된 세트입니다.")
            dup = conn.execute(
                "SELECT 1 FROM arena_participants WHERE set_id = ? AND discord_id = ?",
                (set_id, uid),
            ).fetchone()
            if dup is not None:
                raise RuntimeError("이미 참가 중입니다.")
            db.ensure_user(conn, uid, user.display_name)
            fee = int(s["entry_fee"])
            if fee > 0:
                bal = conn.execute(
                    "SELECT balance FROM wallets WHERE discord_id = ?", (uid,)
                ).fetchone()
                if not bal or int(bal["balance"]) < fee:
                    raise RuntimeError(
                        f"잔액 부족: 참가비 {fmt_coins(fee)} 필요."
                    )
                db.add_coins(
                    conn, uid, -fee,
                    reason=f"arena_참가비 (세트 #{set_id})",
                    ref_type="arena_fee", ref_id=set_id,
                )
            conn.execute(
                "INSERT INTO arena_participants (set_id, discord_id, fee_paid) VALUES (?, ?, ?)",
                (set_id, uid, fee),
            )
            conn.execute(
                "UPDATE arena_sets SET pot = pot + ? WHERE id = ?", (fee, set_id)
            )
            new_bal = int(conn.execute(
                "SELECT balance FROM wallets WHERE discord_id = ?", (uid,)
            ).fetchone()["balance"])
        return new_bal

    async def leave(self, set_id: int, uid: str) -> int:
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status FROM arena_sets WHERE id = ?", (set_id,)
            ).fetchone()
            if s is None:
                raise RuntimeError("세트를 찾을 수 없습니다.")
            if s["status"] != "recruiting":
                raise RuntimeError("모집 단계에서만 취소할 수 있습니다.")
            row = conn.execute(
                "SELECT fee_paid FROM arena_participants WHERE set_id = ? AND discord_id = ?",
                (set_id, uid),
            ).fetchone()
            if row is None:
                raise RuntimeError("참가 내역이 없습니다.")
            fee = int(row["fee_paid"])
            if fee > 0:
                db.add_coins(
                    conn, uid, fee,
                    reason=f"arena_참가비환불 (세트 #{set_id})",
                    ref_type="arena_refund", ref_id=set_id,
                )
            conn.execute(
                "DELETE FROM arena_participants WHERE set_id = ? AND discord_id = ?",
                (set_id, uid),
            )
            conn.execute(
                "UPDATE arena_sets SET pot = MAX(0, pot - ?) WHERE id = ?", (fee, set_id)
            )
            bal = conn.execute(
                "SELECT balance FROM wallets WHERE discord_id = ?", (uid,)
            ).fetchone()
            new_bal = int(bal["balance"]) if bal else 0
        return new_bal

    # ===================== team formation =====================
    async def form_teams(self, set_id: int) -> str:
        parts = _participants(set_id)
        if len(parts) < 2:
            raise RuntimeError("참가자가 2명 이상이어야 편성할 수 있습니다.")
        ids = [p["discord_id"] for p in parts]
        random.shuffle(ids)

        playing = ids[: TEAM_SIZE * MAX_TEAMS]
        bench = ids[TEAM_SIZE * MAX_TEAMS:]

        n = len(playing)
        base, rem = divmod(n, TEAM_SIZE)
        sizes: list[int] = []
        if rem == 0:
            sizes = [TEAM_SIZE] * base
        elif rem == TEAM_SIZE - 1:  # 3인 팀 1개 허용
            sizes = [TEAM_SIZE] * base + [rem]
        else:  # 1~2명 남으면 대기
            sizes = [TEAM_SIZE] * base
            leftover = playing[TEAM_SIZE * base:]
            bench = leftover + bench
            playing = playing[: TEAM_SIZE * base]
        sizes = sizes[:MAX_TEAMS]
        if len(sizes) < 2:
            raise RuntimeError(
                "팀을 2개 이상 만들 수 없습니다. (4인 기준 최소 7명 필요 — 현재 "
                f"{len(parts)}명)"
            )

        assignments: dict[str, str] = {}
        idx = 0
        for ti, size in enumerate(sizes):
            tk = TEAM_KEYS[ti]
            for _ in range(size):
                assignments[playing[idx]] = tk
                idx += 1
        for uid in bench:
            assignments[uid] = "대기"

        with db.transaction() as conn:
            for uid, tk in assignments.items():
                conn.execute(
                    "UPDATE arena_participants SET team = ? WHERE set_id = ? AND discord_id = ?",
                    (tk, set_id, uid),
                )
            conn.execute("DELETE FROM arena_teams WHERE set_id = ?", (set_id,))
            for ti in range(len(sizes)):
                tk = TEAM_KEYS[ti]
                conn.execute(
                    "INSERT INTO arena_teams (set_id, team, name) VALUES (?, ?, ?)",
                    (set_id, tk, f"팀 {tk}"),
                )
            conn.execute(
                "UPDATE arena_sets SET status = 'teamed' WHERE id = ? AND status IN ('recruiting','teamed')",
                (set_id,),
            )
        team_ct = len(sizes)
        bench_ct = len(bench)
        return f"{team_ct}팀 편성" + (f" · 대기 {bench_ct}명" if bench_ct else "")

    # ===================== set lifecycle =====================
    async def start_set(self, set_id: int):
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status, duration_min FROM arena_sets WHERE id = ?", (set_id,)
            ).fetchone()
            if s is None:
                raise RuntimeError("세트를 찾을 수 없습니다.")
            if s["status"] != "teamed":
                raise RuntimeError("팀 편성 후에만 시작할 수 있습니다.")
            teams = conn.execute(
                "SELECT COUNT(*) AS c FROM arena_teams WHERE set_id = ?", (set_id,)
            ).fetchone()
            if int(teams["c"]) < 2:
                raise RuntimeError("최소 2팀이 필요합니다.")
            conn.execute(
                """UPDATE arena_sets
                   SET status = 'running',
                       started_at = datetime('now'),
                       ends_at = datetime('now', ?)
                   WHERE id = ?""",
                (f"+{int(s['duration_min'])} minutes", set_id),
            )
        # 관전 베팅 연동: 현 betting.py 는 잭팟풀(무작위 추첨) 구조라 팀 승부 배당에
        # 직접 연결 불가 → 후속 PR에서 아레나 전용 베팅으로 구현 예정. (PR 본문 참조)

    async def submit_match(
        self, set_id: int, kills: dict[str, int], chicken_team: Optional[str]
    ) -> Optional[dict]:
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status, target_score FROM arena_sets WHERE id = ?", (set_id,)
            ).fetchone()
            if s is None or s["status"] != "running":
                return None
            target = int(s["target_score"])
            next_no = 1 + int(conn.execute(
                "SELECT COALESCE(MAX(match_no),0) AS m FROM arena_matches WHERE set_id = ?",
                (set_id,),
            ).fetchone()["m"])
            scores: dict[str, int] = {}
            for tk, k in kills.items():
                is_chk = (tk == chicken_team)
                sc = _match_score(k, is_chk)
                scores[tk] = sc
                conn.execute(
                    """INSERT INTO arena_matches (set_id, match_no, team, kills, chicken, score)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (set_id, next_no, tk, k, int(is_chk), sc),
                )
        # winner check (immediate target)
        reached = {tk: sc for tk, sc in scores.items() if sc >= target}
        winner = None
        if reached:
            # highest this-match score; tie → chicken team; else key order
            def wkey(tk):
                return (-reached[tk], 0 if tk == chicken_team else 1, tk)
            winner = sorted(reached.keys(), key=wkey)[0]
        names = _team_names(set_id)
        return {
            "match_no": next_no,
            "winner": winner,
            "winner_name": names.get(winner, winner) if winner else None,
        }

    async def cancel_last_match(self, set_id: int) -> Optional[int]:
        with db.transaction() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(match_no),0) AS m FROM arena_matches WHERE set_id = ?",
                (set_id,),
            ).fetchone()
            last = int(row["m"])
            if last <= 0:
                return None
            conn.execute(
                "DELETE FROM arena_matches WHERE set_id = ? AND match_no = ?",
                (set_id, last),
            )
        return last

    async def takeover(self, set_id: int, new_manager: str):
        with db.transaction() as conn:
            db.ensure_user(conn, new_manager, new_manager)
            conn.execute(
                "UPDATE arena_sets SET manager_id = ? WHERE id = ?",
                (new_manager, set_id),
            )

    async def cancel_set(self, set_id: int) -> int:
        refunded = 0
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status FROM arena_sets WHERE id = ?", (set_id,)
            ).fetchone()
            if s is None or s["status"] in ("ended", "cancelled"):
                return 0
            parts = conn.execute(
                "SELECT discord_id, fee_paid FROM arena_participants WHERE set_id = ?",
                (set_id,),
            ).fetchall()
            for p in parts:
                fee = int(p["fee_paid"])
                if fee > 0:
                    db.add_coins(
                        conn, p["discord_id"], fee,
                        reason=f"arena_세트취소환불 (세트 #{set_id})",
                        ref_type="arena_refund", ref_id=set_id,
                    )
                    refunded += 1
            conn.execute(
                "UPDATE arena_sets SET status = 'cancelled', ended_at = datetime('now'), pot = 0 WHERE id = ?",
                (set_id,),
            )
        return refunded

    # ===================== settlement =====================
    async def settle_set(
        self, set_id: int, forced_winner: Optional[str] = None, reason: str = "종료"
    ):
        if set_id in self._settling:
            return
        self._settling.add(set_id)
        try:
            payload = self._do_settle(set_id, forced_winner, reason)
        finally:
            self._settling.discard(set_id)
        if payload is None:
            return
        await self._post_settlement(set_id, payload)

    def _do_settle(
        self, set_id: int, forced_winner: Optional[str], reason: str
    ) -> Optional[dict]:
        order = _rank_teams(set_id, forced_winner)
        with db.transaction() as conn:
            s = conn.execute(
                "SELECT status, pot, opened_by, manager_id FROM arena_sets WHERE id = ?",
                (set_id,),
            ).fetchone()
            if s is None or s["status"] not in ("running", "teamed"):
                return None
            pot = int(s["pot"])
            manager_id = s["manager_id"]

            # team membership (exclude 대기)
            parts = conn.execute(
                "SELECT discord_id, team FROM arena_participants WHERE set_id = ?",
                (set_id,),
            ).fetchall()
            members: dict[str, list[str]] = {}
            all_players: list[str] = []
            for p in parts:
                if p["team"] and p["team"] != "대기":
                    members.setdefault(p["team"], []).append(p["discord_id"])
                    all_players.append(p["discord_id"])

            winner_team = order[0] if order else None
            wk = _week_key()

            # weekly reward eligibility per player (2 reward sets / week)
            eligible: dict[str, bool] = {}
            for uid in all_players:
                prior = conn.execute(
                    """SELECT COUNT(*) AS c FROM arena_participation
                       WHERE discord_id = ? AND week_key = ? AND rewarded = 1 AND set_id != ?""",
                    (uid, wk, set_id),
                ).fetchone()
                eligible[uid] = int(prior["c"]) < WEEKLY_REWARD_CAP

            grants: dict[str, int] = {}      # uid -> coins (pot + bonus)
            burn = 0

            # ---- pot distribution ----
            for i, tk in enumerate(order[:MAX_TEAMS]):
                pct = POT_SPLIT[i] if i < len(POT_SPLIT) else 0
                team_share = pot * pct // 100
                mlist = members.get(tk, [])
                if not mlist or team_share == 0:
                    burn += team_share
                    continue
                per = team_share // len(mlist)
                paid = 0
                for uid in mlist:
                    if eligible.get(uid):
                        grants[uid] = grants.get(uid, 0) + per
                        paid += per
                burn += team_share - paid
            # any pot not covered by ranked teams (rounding / missing ranks)
            allocated = sum(pot * (POT_SPLIT[i] if i < len(POT_SPLIT) else 0) // 100
                            for i in range(min(len(order), MAX_TEAMS)))
            burn += pot - allocated

            # ---- winner bonus ----
            if winner_team:
                for uid in members.get(winner_team, []):
                    if eligible.get(uid):
                        grants[uid] = grants.get(uid, 0) + WIN_BONUS

            # ---- apply grants ----
            for uid, amt in grants.items():
                if amt > 0:
                    db.add_coins(
                        conn, uid, amt,
                        reason=f"arena_상금 (세트 #{set_id})",
                        ref_type="arena_settle", ref_id=set_id,
                    )
            # ---- manager duty pay (수당은 상한 제외·항상 지급) ----
            db.ensure_user(conn, manager_id, manager_id)
            db.add_coins(
                conn, manager_id, MANAGER_BONUS,
                reason=f"arena_개설자수당 (세트 #{set_id})",
                ref_type="arena_settle", ref_id=set_id,
            )
            # ---- record participation (weekly counter) ----
            for uid in all_players:
                conn.execute(
                    """INSERT OR IGNORE INTO arena_participation
                       (discord_id, week_key, set_id, rewarded) VALUES (?, ?, ?, ?)""",
                    (uid, wk, set_id, 1 if eligible.get(uid) else 0),
                )
            # ---- burn remainder ----
            if burn > 0:
                db.log_burn(conn, burn, f"arena_잔여소각 (세트 #{set_id})", "arena", set_id)

            conn.execute(
                """UPDATE arena_sets
                   SET status = 'ended', winner_team = ?, ended_at = datetime('now')
                   WHERE id = ?""",
                (winner_team, set_id),
            )

        return {
            "order": order,
            "winner_team": winner_team,
            "pot": pot,
            "grants": grants,
            "burn": burn,
            "reason": reason,
            "manager_id": manager_id,
        }

    async def grant_mvp(self, set_id: int, uids: list[str]) -> list[str]:
        """개인 킬 1위 +MVP_BONUS (주간 상한 적용). 반환: 실제 지급된 uid."""
        if not uids:
            return []
        wk = _week_key()
        granted: list[str] = []
        with db.transaction() as conn:
            for uid in uids:
                prior = conn.execute(
                    """SELECT COUNT(*) AS c FROM arena_participation
                       WHERE discord_id = ? AND week_key = ? AND rewarded = 1 AND set_id != ?""",
                    (uid, wk, set_id),
                ).fetchone()
                if int(prior["c"]) >= WEEKLY_REWARD_CAP:
                    continue
                db.add_coins(
                    conn, uid, MVP_BONUS,
                    reason=f"arena_킬1위 (세트 #{set_id})",
                    ref_type="arena_settle", ref_id=set_id,
                )
                granted.append(uid)
        return granted

    async def _post_settlement(self, set_id: int, payload: dict):
        names = _team_names(set_id)
        best = _team_best(set_id)
        embed = discord.Embed(
            title=f"🏆 아레나 세트 `#{set_id}` 정산 ({payload['reason']})",
            color=0xF5C518,
        )
        medal = ["🥇", "🥈", "🥉", "4️⃣"]
        rank_lines = []
        for i, tk in enumerate(payload["order"][:MAX_TEAMS]):
            b = best.get(tk, {"best": None, "chickens": 0})
            tag = medal[i] if i < len(medal) else "▫"
            pct = POT_SPLIT[i] if i < len(POT_SPLIT) else 0
            rank_lines.append(
                f"{tag} **{names.get(tk, tk)}** — 최고 {b['best'] if b['best'] is not None else '-'}점 "
                f"· 치킨 {b['chickens']}회 · 팟 {pct}%"
            )
        embed.add_field(name="최종 순위", value="\n".join(rank_lines) or "-", inline=False)

        pay_lines = []
        for uid, amt in sorted(payload["grants"].items(), key=lambda x: -x[1]):
            if amt > 0:
                pay_lines.append(f"<@{uid}> +{amt}")
        embed.add_field(
            name="상금·보너스",
            value=("\n".join(pay_lines) if pay_lines else "지급 대상 없음"),
            inline=False,
        )
        embed.add_field(
            name="정산 요약",
            value=(
                f"팟 {fmt_coins(payload['pot'])} · 소각 {fmt_coins(payload['burn'])}\n"
                f"담당자 수당 <@{payload['manager_id']}> +{MANAGER_BONUS}\n"
                f"우승팀 전원 +{WIN_BONUS} · 개인 킬 1위 +{MVP_BONUS}(아래 선택)"
            ),
            inline=False,
        )
        embed.set_footer(text="아레나 보상은 주간 상한(grant) 제외 · 개인 주 2회차까지만 지급")

        ch = self._channel_of(set_id)
        # freeze the control message
        await self.refresh_message(set_id)
        if ch is None:
            return
        try:
            await ch.send(embed=embed)
            # optional 개인 킬 1위 선택 (담당자)
            parts = _participants(set_id)
            playing = [p for p in parts if p["team"] and p["team"] != "대기"]
            if playing:
                await ch.send(
                    content=f"<@{payload['manager_id']}> 개인 킬 1위를 선택하면 +{MVP_BONUS}코인 지급됩니다 (선택).",
                    view=MvpView(self, set_id, playing),
                )
        except discord.Forbidden:
            pass

    # ===================== message refresh / recovery =====================
    def _channel_of(self, set_id: int):
        s = _load_set(set_id)
        if not s or not s["channel_id"] or not str(s["channel_id"]).isdigit():
            return None
        return self.bot.get_channel(int(s["channel_id"]))

    async def refresh_message(self, set_id: int):
        s = _load_set(set_id)
        if not s:
            return
        cid, mid = s["channel_id"], s["message_id"]
        if not (cid and mid and str(cid).isdigit() and str(mid).isdigit()):
            return
        ch = self.bot.get_channel(int(cid))
        if ch is None:
            return
        status = s["status"]
        if status in ("recruiting", "teamed"):
            embed = _build_recruit_embed(set_id)
            view = ArenaView(self, set_id, status)
        elif status == "running":
            embed = _build_progress_embed(set_id)
            view = ArenaView(self, set_id, status)
        else:  # ended / cancelled
            embed = _build_recruit_embed(set_id) if status == "cancelled" else _build_progress_embed(set_id)
            embed.title = f"⚔️ 아레나 세트 `#{set_id}` · {'취소됨' if status == 'cancelled' else '종료'}"
            view = None
        try:
            msg = await ch.fetch_message(int(mid))
            await msg.edit(embed=embed, view=view)
        except (discord.NotFound, discord.Forbidden):
            pass

    @tasks.loop(seconds=30.0)
    async def reaper(self):
        """시간 만료된 running 세트 자동 종료 + 진행 임베드 갱신."""
        try:
            rows = db.fetchall(
                "SELECT id, ends_at FROM arena_sets WHERE status = 'running'"
            )
            for r in rows:
                sid = int(r["id"])
                if r["ends_at"] and _parse_ts(r["ends_at"]) <= datetime.utcnow():
                    if sid not in self._settling:
                        self.bot.loop.create_task(
                            self.settle_set(sid, reason="시간 만료")
                        )
                else:
                    await self.refresh_message(sid)
        except Exception:
            log.exception("arena reaper failed")

    @reaper.before_loop
    async def _before_reaper(self):
        await self.bot.wait_until_ready()
        # 봇 재시작 복구: 진행/모집 중 세트의 뷰 재등록
        try:
            rows = db.fetchall(
                "SELECT id, message_id, status FROM arena_sets "
                "WHERE status IN ('recruiting','teamed','running')"
            )
            for r in rows:
                mid = r["message_id"]
                if mid and str(mid).isdigit():
                    self.bot.add_view(
                        ArenaView(self, int(r["id"]), r["status"]),
                        message_id=int(mid),
                    )
            if rows:
                log.info("arena: restored %d active set view(s)", len(rows))
        except Exception:
            log.exception("arena view recovery failed")


async def setup(bot: commands.Bot):
    await bot.add_cog(Arena(bot))
