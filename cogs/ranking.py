"""Ranking command: /순위."""
from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import clan_only, fmt_coins


class Ranking(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="순위", description="클랜 코인 보유 랭킹 (Top 20)")
    @clan_only()
    async def ranking(self, interaction: discord.Interaction):
        rows = db.fetchall(
            """SELECT u.nickname, w.balance
               FROM wallets w JOIN users u ON u.discord_id = w.discord_id
               WHERE w.balance > 0
               ORDER BY w.balance DESC, u.created_at ASC
               LIMIT 20"""
        )
        if not rows:
            await interaction.response.send_message(
                "랭킹 데이터가 없습니다.", ephemeral=True
            )
            return
        lines = []
        for i, r in enumerate(rows, 1):
            medal = "🥇" if i == 1 else "🥈" if i == 2 else "🥉" if i == 3 else f"`{i:>2d}`"
            lines.append(f"{medal} {r['nickname']} — **{fmt_coins(int(r['balance']))}**")
        embed = discord.Embed(
            title="🏆 GmI Coin 랭킹 Top 20",
            description="\n".join(lines),
            color=0xE53E3E,
        )
        await interaction.response.send_message(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(Ranking(bot))
