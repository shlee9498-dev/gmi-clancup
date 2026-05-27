"""cogs/admin_coin.py - 운영진 전용 수동 코인 관리.

명령:
  /코인지급 user amount reason   양수만, ledger에 admin_grant 기록
  /코인차감 user amount reason   양수만, 잔액 미달 차단
  /코인이력 user [limit=15]      해당 멤버 ledger 최근 N건
"""
from __future__ import annotations

import logging
import os

import discord
from discord import app_commands
from discord.ext import commands

import db

log = logging.getLogger("gmi.cogs.admin_coin")

ADMIN_ROLE_ID = int(os.environ.get("ADMIN_ROLE_ID", "0"))


def _is_admin(member: discord.Member) -> bool:
    if ADMIN_ROLE_ID == 0:
        return member.guild_permissions.administrator
    return (any(r.id == ADMIN_ROLE_ID for r in member.roles)
            or member.guild_permissions.administrator)


def admin_only():
    async def predicate(interaction: discord.Interaction) -> bool:
        if not isinstance(interaction.user, discord.Member):
            raise app_commands.CheckFailure("❌ 서버 멤버 정보 없음")
        if not _is_admin(interaction.user):
            raise app_commands.CheckFailure("❌ 운영진 전용")
        return True
    return app_commands.check(predicate)


class AdminCoin(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ============================================================ /코인지급
    @app_commands.command(
        name="코인지급",
        description="[운영진] 클랜원에게 코인 수동 지급",
    )
    @app_commands.describe(
        user="대상 클랜원",
        amount="지급할 코인 (1~100000)",
        reason="사유 (기록에 남음)",
    )
    @admin_only()
    async def grant(
        self,
        interaction: discord.Interaction,
        user: discord.Member,
        amount: app_commands.Range[int, 1, 100000],
        reason: str,
    ):
        with db.transaction() as conn:
            db.ensure_user(conn, str(user.id), user.display_name)
            db.add_coins(
                conn, str(user.id), amount,
                reason=f"admin_grant:{reason}",
                entity_type="admin_grant",
                entity_id=interaction.user.id,
            )
        new_bal = db.balance_of(str(user.id))
        await interaction.response.send_message(
            f"✅ {user.mention} **+{amount}코인** 지급\n"
            f"사유: {reason}\n잔액: **{new_bal}코인**",
            ephemeral=False,
        )
        try:
            await user.send(
                f"💰 운영진이 **+{amount}코인** 지급\n"
                f"사유: {reason}\n잔액: {new_bal}코인"
            )
        except Exception:
            pass

    # ============================================================ /코인차감
    @app_commands.command(
        name="코인차감",
        description="[운영진] 클랜원의 코인 수동 차감",
    )
    @app_commands.describe(
        user="대상 클랜원",
        amount="차감할 코인 (1~100000, 양수만)",
        reason="사유 (기록에 남음)",
    )
    @admin_only()
    async def deduct(
        self,
        interaction: discord.Interaction,
        user: discord.Member,
        amount: app_commands.Range[int, 1, 100000],
        reason: str,
    ):
        current = db.balance_of(str(user.id))
        if current < amount:
            return await interaction.response.send_message(
                f"⚠️ 잔액 부족: 현재 {current}코인, 차감 요청 {amount}코인\n"
                f"amount를 {current} 이하로 조정하세요.",
                ephemeral=True,
            )
        with db.transaction() as conn:
            db.ensure_user(conn, str(user.id), user.display_name)
            db.add_coins(
                conn, str(user.id), -amount,
                reason=f"admin_deduct:{reason}",
                entity_type="admin_deduct",
                entity_id=interaction.user.id,
            )
        new_bal = db.balance_of(str(user.id))
        await interaction.response.send_message(
            f"✅ {user.mention} **-{amount}코인** 차감\n"
            f"사유: {reason}\n잔액: **{new_bal}코인**",
            ephemeral=False,
        )
        try:
            await user.send(
                f"⚠️ 운영진이 **-{amount}코인** 차감\n"
                f"사유: {reason}\n잔액: {new_bal}코인"
            )
        except Exception:
            pass

    # ============================================================ /코인이력
    @app_commands.command(
        name="코인이력",
        description="[운영진] 특정 클랜원의 코인 입출금 이력 조회",
    )
    @app_commands.describe(
        user="대상 클랜원",
        limit="조회 개수 (기본 15, 최대 50)",
    )
    @admin_only()
    async def history(
        self,
        interaction: discord.Interaction,
        user: discord.Member,
        limit: app_commands.Range[int, 1, 50] = 15,
    ):
        rows = db.fetchall(
            """SELECT delta, reason, entity_type, entity_id, created_at
               FROM ledger WHERE discord_id=?
               ORDER BY id DESC LIMIT ?""",
            (str(user.id), limit),
        )
        if not rows:
            return await interaction.response.send_message(
                f"{user.mention} 입출금 기록 없음", ephemeral=True
            )

        bal = db.balance_of(str(user.id))
        lines = []
        for r in rows:
            sign = "+" if r["delta"] > 0 else ""
            lines.append(
                f"`{r['created_at'][:16]}` "
                f"`{sign}{r['delta']:>5}` · {r['reason']}"
            )
        embed = discord.Embed(
            title=f"📜 {user.display_name} 코인 이력 (최근 {len(rows)}건)",
            description="\n".join(lines)[:4000],
            color=0x9B59B6,
        )
        embed.set_footer(text=f"현재 잔액: {bal}코인")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(AdminCoin(bot))
