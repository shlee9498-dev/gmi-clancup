"""Jackpot Pool — PvP betting (시즌1 시범).

Mechanics:
  - /풀생성: anyone can open a pool, choose duration (5/15/30/60 min)
  - /풀참가: any other user joins with a bet amount; same user may stack entries
  - /풀현황: list active pools
  - /풀마감: pool creator can force close their own pool early

Rules:
  - Gambling window: GAMBLING_START_HOUR..GAMBLING_END_HOUR (default 22:00-02:00 KST)
  - Per-user bet cap: BET_LIMIT_PERCENT of current balance (default 20%)
  - Rake on payout: RAKE_PERCENT (default 10%)
  - Minimum bet: 1 coin
  - Minimum participants: 2 (otherwise refund, no burn)
  - Pool creator cannot self-enter (prevents self-dealing rake avoidance)
  - Draw probability: proportional to entry amount (weighted random)

All coin movements use db.transaction() for atomicity.
"""
from __future__ import annotations

import asyncio
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
    KST, bet_limit_percent, clan_only, fmt_coins, is_gambling_open,
    now_kst, rake_percent,
)

log = logging.getLogger("gmi.betting")

DURATION_CHOICES = [
    app_commands.Choice(name="5분", value=5),
    app_commands.Choice(name="15분", value=15),
    app_commands.Choice(name="30분", value=30),
    app_commands.Choice(name="60분", value=60),
]


def _parse_ts(s: str) -> datetime:
    # SQLite datetime('now') returns UTC naive "YYYY-MM-DD HH:MM:SS"
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


class Betting(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._drawing: set[int] = set()
        self.pool_reaper.start()

    def cog_unload(self):
        self.pool_reaper.cancel()

    # ---------- /풀생성 ----------
    @app_commands.command(
        name="풀생성",
        description="잭팟 풀을 개설합니다. (22~02시 한정, 본인은 참가 불가)",
    )
    @app_commands.describe(마감="모집 마감 시간")
    @app_commands.choices(마감=DURATION_CHOICES)
    @clan_only()
    async def create_pool(
        self,
        interaction: discord.Interaction,
        마감: app_commands.Choice[int],
    ):
        if not is_gambling_open():
            await interaction.response.send_message(
                "⏰ 잭팟 풀은 **22:00~02:00 (KST)** 에만 운영됩니다.",
                ephemeral=True,
            )
            return

        creator_id = str(interaction.user.id)

        # check: user has no other active pool as creator
        existing = db.fetchone(
            "SELECT id FROM pools WHERE creator_id = ? AND status = 'open' LIMIT 1",
            (creator_id,),
        )
        if existing is not None:
            await interaction.response.send_message(
                f"이미 진행 중인 풀이 있습니다 (`#{existing['id']}`). 마감 후 다시 생성하세요.",
                ephemeral=True,
            )
            return

        duration_min = 마감.value
        with db.transaction() as conn:
            db.ensure_user(conn, creator_id, interaction.user.display_name)
            cur = conn.execute(
                """INSERT INTO pools
                   (creator_id, channel_id, duration_min, status, closes_at)
                   VALUES (?, ?, ?, 'open', datetime('now', ?))""",
                (
                    creator_id,
                    str(interaction.channel_id) if interaction.channel_id else None,
                    duration_min,
                    f"+{duration_min} minutes",
                ),
            )
            pool_id = cur.lastrowid

        embed = await self._build_pool_embed(pool_id)
        embed.title = f"🎲 잭팟 풀 모집 시작 `#{pool_id}`"
        embed.description = (
            f"**생성자**: {interaction.user.mention}\n"
            f"**마감**: {duration_min}분 후 자동 추첨\n"
            f"**최소 베팅**: 1코인 / **최대**: 본인 보유의 {bet_limit_percent()}%\n"
            f"**Rake**: 풀 전액의 {rake_percent()}% 자동 소각\n"
            f"\n참가: `/풀참가 풀번호:{pool_id} 금액:N`"
        )
        await interaction.response.send_message(embed=embed)
        try:
            msg = await interaction.original_response()
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE pools SET message_id = ? WHERE id = ?",
                    (str(msg.id), pool_id),
                )
        except Exception:
            pass

    # ---------- /풀참가 ----------
    @app_commands.command(name="풀참가", description="진행 중인 잭팟 풀에 베팅합니다.")
    @app_commands.describe(풀번호="풀 ID", 금액="베팅할 코인 (1코인 이상, 보유 20% 이하)")
    @clan_only()
    async def join_pool(
        self,
        interaction: discord.Interaction,
        풀번호: int,
        금액: int,
    ):
        if not is_gambling_open():
            await interaction.response.send_message(
                "⏰ 잭팟 풀은 **22:00~02:00 (KST)** 에만 참가 가능합니다.",
                ephemeral=True,
            )
            return
        if 금액 < 1:
            await interaction.response.send_message(
                "최소 베팅은 1코인입니다.", ephemeral=True
            )
            return

        user_id = str(interaction.user.id)
        with db.transaction() as conn:
            db.ensure_user(conn, user_id, interaction.user.display_name)

            pool = conn.execute(
                "SELECT id, creator_id, status, closes_at FROM pools WHERE id = ?",
                (풀번호,),
            ).fetchone()
            if pool is None:
                raise RuntimeError("해당 풀을 찾을 수 없습니다.")
            if pool["status"] != "open":
                raise RuntimeError(f"이미 마감된 풀입니다 (status={pool['status']}).")
            if pool["creator_id"] == user_id:
                raise RuntimeError("본인 풀에는 참가할 수 없습니다 (자전거래 방지).")

            closes_at = _parse_ts(pool["closes_at"])
            if closes_at <= datetime.utcnow():
                raise RuntimeError("이미 마감 시각이 지난 풀입니다.")

            bal_row = conn.execute(
                "SELECT balance FROM wallets WHERE discord_id = ?", (user_id,)
            ).fetchone()
            bal = int(bal_row["balance"]) if bal_row else 0
            if bal < 금액:
                raise RuntimeError(
                    f"잔액 부족: 현재 {fmt_coins(bal)} / 베팅 {fmt_coins(금액)}"
                )

            # 20% cap is on the user's pre-bet balance
            cap = max(1, math.floor(bal * bet_limit_percent() / 100))
            # also count any previous entries the user has in this same pool
            prev_row = conn.execute(
                "SELECT COALESCE(SUM(amount), 0) AS s FROM pool_entries WHERE pool_id = ? AND discord_id = ?",
                (풀번호, user_id),
            ).fetchone()
            prev = int(prev_row["s"]) if prev_row else 0
            if prev + 금액 > cap:
                allowed = max(0, cap - prev)
                raise RuntimeError(
                    f"베팅 한도 초과: 1회 풀당 최대 {fmt_coins(cap)} ({bet_limit_percent()}%) "
                    f"· 잔여 한도 {fmt_coins(allowed)}"
                )

            # deduct + record entry + update pool total
            db.add_coins(
                conn, user_id, -금액,
                reason=f"잭팟 풀 #{풀번호} 베팅",
                ref_type="pool_entry",
                ref_id=풀번호,
            )
            conn.execute(
                "INSERT INTO pool_entries (pool_id, discord_id, amount) VALUES (?, ?, ?)",
                (풀번호, user_id, 금액),
            )
            conn.execute(
                "UPDATE pools SET total_pool = total_pool + ? WHERE id = ?",
                (금액, 풀번호),
            )

        await interaction.response.send_message(
            f"🎲 풀 `#{풀번호}` 에 **{fmt_coins(금액)}** 베팅 완료.",
            ephemeral=True,
        )
        # update public embed
        await self._refresh_pool_message(풀번호)

    # ---------- /풀현황 ----------
    @app_commands.command(name="풀현황", description="진행 중인 잭팟 풀 목록")
    @clan_only()
    async def list_pools(self, interaction: discord.Interaction):
        rows = db.fetchall(
            """SELECT p.id, p.creator_id, p.duration_min, p.closes_at,
                      p.total_pool, u.nickname,
                      (SELECT COUNT(DISTINCT discord_id) FROM pool_entries WHERE pool_id = p.id) AS n_players
               FROM pools p JOIN users u ON u.discord_id = p.creator_id
               WHERE p.status = 'open' ORDER BY p.closes_at ASC LIMIT 10"""
        )
        if not rows:
            await interaction.response.send_message(
                "진행 중인 풀이 없습니다.", ephemeral=True
            )
            return
        lines = []
        for r in rows:
            lines.append(
                f"`#{r['id']}` 생성자 **{r['nickname']}** · "
                f"풀 **{fmt_coins(int(r['total_pool']))}** · "
                f"참가자 {r['n_players']}명 · 마감 `{r['closes_at']} UTC`"
            )
        embed = discord.Embed(
            title="🎲 진행 중인 잭팟 풀",
            description="\n".join(lines),
            color=0x9F7AEA,
        )
        embed.set_footer(text=f"운영시간 22:00~02:00 KST · Rake {rake_percent()}% · 한도 {bet_limit_percent()}%")
        await interaction.response.send_message(embed=embed)

    # ---------- /풀마감 ----------
    @app_commands.command(name="풀마감", description="본인이 생성한 풀을 즉시 마감합니다.")
    @app_commands.describe(풀번호="풀 ID")
    @clan_only()
    async def close_pool(self, interaction: discord.Interaction, 풀번호: int):
        user_id = str(interaction.user.id)
        with db.transaction() as conn:
            pool = conn.execute(
                "SELECT id, creator_id, status FROM pools WHERE id = ?",
                (풀번호,),
            ).fetchone()
            if pool is None:
                raise RuntimeError("해당 풀을 찾을 수 없습니다.")
            if pool["creator_id"] != user_id:
                raise RuntimeError("본인이 생성한 풀만 마감할 수 있습니다.")
            if pool["status"] != "open":
                raise RuntimeError(f"이미 마감된 풀입니다 (status={pool['status']}).")
            # force closes_at to now
            conn.execute(
                "UPDATE pools SET closes_at = datetime('now') WHERE id = ?",
                (풀번호,),
            )
        await interaction.response.send_message(
            f"풀 `#{풀번호}` 마감 처리. 곧 추첨됩니다.", ephemeral=True
        )
        await self._draw_pool(풀번호)

    # ---------- background reaper ----------
    @tasks.loop(seconds=15.0)
    async def pool_reaper(self):
        """Find pools whose closes_at <= now and run the draw."""
        try:
            rows = db.fetchall(
                "SELECT id FROM pools WHERE status = 'open' AND closes_at <= datetime('now')"
            )
            for r in rows:
                pid = int(r["id"])
                if pid in self._drawing:
                    continue
                self._drawing.add(pid)
                self.bot.loop.create_task(self._draw_and_cleanup(pid))
        except Exception:
            log.exception("pool_reaper failed")

    @pool_reaper.before_loop
    async def _before_reaper(self):
        await self.bot.wait_until_ready()

    async def _draw_and_cleanup(self, pool_id: int):
        try:
            await self._draw_pool(pool_id)
        except Exception:
            log.exception("draw failed for pool=%s", pool_id)
        finally:
            self._drawing.discard(pool_id)

    # ---------- draw logic ----------
    async def _draw_pool(self, pool_id: int):
        """Atomically settle a pool: refund (if <2 players) or pick a weighted winner."""
        notify_channel_id: Optional[str] = None
        result_payload: Optional[dict] = None

        with db.transaction() as conn:
            pool = conn.execute(
                "SELECT id, creator_id, status, total_pool, channel_id, message_id FROM pools WHERE id = ?",
                (pool_id,),
            ).fetchone()
            if pool is None or pool["status"] != "open":
                return

            entries = conn.execute(
                """SELECT discord_id, SUM(amount) AS amount
                   FROM pool_entries WHERE pool_id = ?
                   GROUP BY discord_id""",
                (pool_id,),
            ).fetchall()
            distinct_players = [(e["discord_id"], int(e["amount"])) for e in entries]

            notify_channel_id = pool["channel_id"]

            if len(distinct_players) < 2:
                # refund all
                for uid, amt in distinct_players:
                    db.add_coins(
                        conn, uid, amt,
                        reason=f"잭팟 풀 #{pool_id} 환불 (참가자 부족)",
                        ref_type="pool_refund",
                        ref_id=pool_id,
                    )
                conn.execute(
                    """UPDATE pools SET status = 'refunded',
                       drawn_at = datetime('now'), burned = 0, payout = 0
                       WHERE id = ?""",
                    (pool_id,),
                )
                result_payload = {"kind": "refunded", "players": distinct_players}
            else:
                total = sum(amt for _, amt in distinct_players)
                burn = math.floor(total * rake_percent() / 100)
                payout = total - burn

                weights = [amt for _, amt in distinct_players]
                rng = random.SystemRandom()
                winner_id, winner_amt = rng.choices(distinct_players, weights=weights, k=1)[0]

                db.add_coins(
                    conn, winner_id, payout,
                    reason=f"잭팟 풀 #{pool_id} 당첨",
                    ref_type="pool_payout",
                    ref_id=pool_id,
                )
                if burn > 0:
                    db.log_burn(conn, burn, f"잭팟 풀 #{pool_id} Rake", "pool", pool_id)

                conn.execute(
                    """UPDATE pools SET status = 'drawn', drawn_at = datetime('now'),
                       winner_id = ?, burned = ?, payout = ?
                       WHERE id = ?""",
                    (winner_id, burn, payout, pool_id),
                )
                result_payload = {
                    "kind": "drawn",
                    "winner_id": winner_id,
                    "winner_amt": winner_amt,
                    "total": total,
                    "burn": burn,
                    "payout": payout,
                    "entries": distinct_players,
                }

        # post outside transaction
        if result_payload is None:
            return
        await self._announce_result(pool_id, notify_channel_id, result_payload)
        await self._refresh_pool_message(pool_id)

    async def _announce_result(
        self, pool_id: int, channel_id: Optional[str], payload: dict
    ):
        ch = None
        if channel_id and channel_id.isdigit():
            ch = self.bot.get_channel(int(channel_id))
        if ch is None:
            # nothing to do
            return
        try:
            if payload["kind"] == "refunded":
                desc = (
                    f"참가자 2명 미만으로 자동 환불되었습니다.\n"
                    f"환불 인원: {len(payload['players'])}명 · 소각 없음"
                )
                embed = discord.Embed(
                    title=f"♻️ 잭팟 풀 `#{pool_id}` 환불",
                    description=desc,
                    color=0xA0AEC0,
                )
            else:
                lines = []
                for uid, amt in payload["entries"]:
                    prob = amt / payload["total"] * 100
                    lines.append(f"<@{uid}> · {fmt_coins(amt)} ({prob:.1f}%)")
                desc = (
                    f"🏆 당첨자: <@{payload['winner_id']}>\n"
                    f"풀 전액: **{fmt_coins(payload['total'])}**\n"
                    f"소각 (Rake {rake_percent()}%): **{fmt_coins(payload['burn'])}**\n"
                    f"지급: **{fmt_coins(payload['payout'])}**\n\n"
                    f"**참가 내역**\n" + "\n".join(lines)
                )
                embed = discord.Embed(
                    title=f"🎉 잭팟 풀 `#{pool_id}` 추첨 결과",
                    description=desc,
                    color=0xD53F8C,
                )
            await ch.send(embed=embed)
        except discord.Forbidden:
            pass

    # ---------- helpers ----------
    async def _build_pool_embed(self, pool_id: int) -> discord.Embed:
        pool = db.fetchone(
            """SELECT p.id, p.creator_id, p.duration_min, p.closes_at, p.status,
                      p.total_pool, p.burned, p.payout, p.winner_id,
                      u.nickname AS creator_name
               FROM pools p JOIN users u ON u.discord_id = p.creator_id
               WHERE p.id = ?""",
            (pool_id,),
        )
        if pool is None:
            return discord.Embed(title=f"풀 #{pool_id}", description="not found")

        entries = db.fetchall(
            """SELECT e.discord_id, SUM(e.amount) AS amount, u.nickname
               FROM pool_entries e JOIN users u ON u.discord_id = e.discord_id
               WHERE e.pool_id = ? GROUP BY e.discord_id
               ORDER BY amount DESC""",
            (pool_id,),
        )
        total = int(pool["total_pool"])
        lines = []
        for e in entries:
            amt = int(e["amount"])
            prob = (amt / total * 100) if total > 0 else 0
            lines.append(f"• **{e['nickname']}** — {fmt_coins(amt)} ({prob:.1f}%)")
        body = "\n".join(lines) if lines else "_아직 참가자가 없습니다._"

        color = {
            "open": 0x9F7AEA, "drawn": 0xD53F8C,
            "refunded": 0xA0AEC0, "cancelled": 0x718096,
        }.get(pool["status"], 0x9F7AEA)

        embed = discord.Embed(
            title=f"🎲 잭팟 풀 `#{pool_id}` · {pool['status'].upper()}",
            color=color,
        )
        embed.add_field(name="현재 풀", value=f"**{fmt_coins(total)}**", inline=True)
        embed.add_field(name="참가자", value=f"{len(entries)}명", inline=True)
        embed.add_field(name="마감", value=f"`{pool['closes_at']} UTC`", inline=True)
        embed.add_field(name="참가 현황", value=body, inline=False)
        embed.set_footer(
            text=f"Rake {rake_percent()}% · 1인 한도 {bet_limit_percent()}% · 본인 풀 참가 불가"
        )
        return embed

    async def _refresh_pool_message(self, pool_id: int):
        row = db.fetchone(
            "SELECT channel_id, message_id FROM pools WHERE id = ?", (pool_id,)
        )
        if row is None:
            return
        cid, mid = row["channel_id"], row["message_id"]
        if not (cid and mid and cid.isdigit() and mid.isdigit()):
            return
        ch = self.bot.get_channel(int(cid))
        if ch is None:
            return
        try:
            msg = await ch.fetch_message(int(mid))
            embed = await self._build_pool_embed(pool_id)
            await msg.edit(embed=embed)
        except (discord.NotFound, discord.Forbidden):
            pass


async def setup(bot: commands.Bot):
    await bot.add_cog(Betting(bot))
