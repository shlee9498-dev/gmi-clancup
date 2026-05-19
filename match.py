"""Wallet commands: 등록 / 지갑 / 내기록."""
from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import clan_only, fmt_coins


class Wallet(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="등록", description="GmI Casino에 최초 가입합니다.")
    @clan_only()
    async def register(self, interaction: discord.Interaction):
        nickname = interaction.user.display_name
        discord_id = str(interaction.user.id)
        with db.transaction() as conn:
            existed = conn.execute(
                "SELECT 1 FROM users WHERE discord_id = ?", (discord_id,)
            ).fetchone()
            db.ensure_user(conn, discord_id, nickname)
        if existed:
            await interaction.response.send_message(
                f"이미 등록되어 있습니다. 닉네임을 `{nickname}` 으로 갱신했습니다.",
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                f"✅ `{nickname}` 등록 완료. `/지갑` 으로 잔액을 확인하세요.",
                ephemeral=True,
            )

    @app_commands.command(name="지갑", description="내 코인 잔액을 확인합니다.")
    @clan_only()
    async def wallet(self, interaction: discord.Interaction):
        discord_id = str(interaction.user.id)
        row = db.fetchone(
            "SELECT balance FROM wallets WHERE discord_id = ?", (discord_id,)
        )
        if row is None:
            await interaction.response.send_message(
                "먼저 `/등록` 으로 가입해 주세요.", ephemeral=True
            )
            return
        bal = int(row["balance"])
        await interaction.response.send_message(
            f"💰 **{interaction.user.display_name}** 님의 잔액: **{fmt_coins(bal)}**",
            ephemeral=True,
        )

    @app_commands.command(name="내기록", description="최근 코인 적립/소비 내역을 봅니다.")
    @app_commands.describe(개수="조회할 거래 개수 (기본 10, 최대 30)")
    @clan_only()
    async def history(self, interaction: discord.Interaction, 개수: int = 10):
        n = max(1, min(30, 개수))
        discord_id = str(interaction.user.id)
        rows = db.fetchall(
            """SELECT delta, reason, created_at FROM transactions
               WHERE discord_id = ? ORDER BY id DESC LIMIT ?""",
            (discord_id, n),
        )
        if not rows:
            await interaction.response.send_message(
                "거래 내역이 없습니다.", ephemeral=True
            )
            return
        lines = []
        for r in rows:
            delta = int(r["delta"])
            sign = "+" if delta > 0 else ""
            lines.append(
                f"`{r['created_at']}` `{sign}{delta:>+4d}` · {r['reason']}"
            )
        embed = discord.Embed(
            title=f"📒 {interaction.user.display_name} 거래 내역 (최근 {n}건)",
            description="\n".join(lines),
            color=0x2B6CB0,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Wallet(bot))
