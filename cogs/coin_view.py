"""cogs/coin_view.py - 클랜원 본인용 코인 조회.

명령:
  /내코인       내 잔액 + 이번주 입출금 + 누적 입출금
  /코인순위    클랜 전체 코인 랭킹 (TOP 20, 본인 위치 표시)
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import discord
from discord import app_commands
from discord.ext import commands

import db

log = logging.getLogger("gmi.cogs.coin_view")

KST = timezone(timedelta(hours=9))


def _week_start_utc_str() -> str:
    """이번주 월요일 00:00 KST를 UTC 문자열로 변환 (SQLite 비교용)."""
    now_kst = datetime.now(KST)
    week_start_kst = (
        now_kst.replace(hour=0, minute=0, second=0, microsecond=0)
        - timedelta(days=now_kst.weekday())
    )
    return week_start_kst.astimezone(timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


class CoinView(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ============================================================ /내코인
    @app_commands.command(
        name="내코인",
        description="내 잔액 + 이번주 적립 + 누적 지급 조회",
    )
    async def my_coin(self, interaction: discord.Interaction):
        uid = str(interaction.user.id)

        # 지갑 보장 + 닉 동기화
        with db.transaction() as conn:
            db.ensure_user(conn, uid, interaction.user.display_name)

        bal = db.balance_of(uid)
        week_start = _week_start_utc_str()

        week_row = db.fetchone(
            """SELECT
                 COALESCE(SUM(CASE WHEN delta>0 THEN delta END),0) AS pos,
                 COALESCE(SUM(CASE WHEN delta<0 THEN delta END),0) AS neg
               FROM ledger
               WHERE discord_id=? AND created_at>=?""",
            (uid, week_start),
        )
        cum_row = db.fetchone(
            """SELECT
                 COALESCE(SUM(CASE WHEN delta>0 THEN delta END),0) AS pos,
                 COALESCE(SUM(CASE WHEN delta<0 THEN delta END),0) AS neg
               FROM ledger WHERE discord_id=?""",
            (uid,),
        )

        embed = discord.Embed(
            title=f"💰 {interaction.user.display_name}의 코인",
            color=0xF1C40F,
        )
        embed.add_field(
            name="현재 잔액", value=f"**{bal}코인**", inline=False
        )
        embed.add_field(
            name="이번주 (월~)",
            value=f"입금 `+{week_row['pos']}`\n출금 `{week_row['neg']}`",
            inline=True,
        )
        embed.add_field(
            name="누적 (전체)",
            value=f"입금 `+{cum_row['pos']}`\n출금 `{cum_row['neg']}`",
            inline=True,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ============================================================ /코인순위
    @app_commands.command(
        name="코인순위",
        description="클랜 전체 코인 랭킹 (TOP 20)",
    )
    @app_commands.describe(limit="표시 개수 (기본 20, 최대 50)")
    async def ranking(
        self,
        interaction: discord.Interaction,
        limit: app_commands.Range[int, 1, 50] = 20,
    ):
        rows = db.fetchall(
            """SELECT discord_id, display_name, balance
               FROM wallets WHERE balance > 0
               ORDER BY balance DESC, updated_at ASC
               LIMIT ?""",
            (limit,),
        )
        if not rows:
            return await interaction.response.send_message(
                "아직 코인 보유자가 없습니다.", ephemeral=True
            )

        medals = ["🥇", "🥈", "🥉"]
        my_id = str(interaction.user.id)
        my_rank: int | None = None
        lines: list[str] = []

        for i, r in enumerate(rows, start=1):
            mark = medals[i - 1] if i <= 3 else f"`{i:>2}`"
            is_me = r["discord_id"] == my_id
            if is_me:
                my_rank = i
            highlight = " ◀ **나**" if is_me else ""
            name = r["display_name"] or r["discord_id"]
            lines.append(
                f"{mark} {name} — **{r['balance']}**{highlight}"
            )

        if my_rank is None:
            my_bal = db.balance_of(my_id)
            rank_row = db.fetchone(
                """SELECT COUNT(*)+1 AS rank FROM wallets
                   WHERE balance > ?""", (my_bal,)
            )
            lines.append(
                f"\n— 내 순위: `{rank_row['rank']}위` ({my_bal}코인)"
            )

        embed = discord.Embed(
            title=f"🏆 GmI 코인 랭킹 (TOP {len(rows)})",
            description="\n".join(lines)[:4000],
            color=0xF39C12,
        )
        await interaction.response.send_message(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(CoinView(bot))
