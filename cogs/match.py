"""Match registration: 일겜 / 경쟁전 / 이벤트 / 회수.

Coin rules (season 1):
  ilgam (clan internal):
    1st place             → +4
    1st + 1000 damage     → +5
    1st + 1000 dmg + 8 kill → +6
  competitive (external matchmaking):
    1st place             → +1
    1st + 1000 damage     → +2
    1st + 1000 dmg + 8 kill → +3
"""
from __future__ import annotations

import os
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import clan_only, fmt_coins, is_admin


ILGAM_REWARD = {(1, 0, 0): 4, (1, 1, 0): 5, (1, 1, 1): 6}
COMP_REWARD = {(1, 0, 0): 1, (1, 1, 0): 2, (1, 1, 1): 3}


def _reward(match_type: str, rank1: bool, dmg1k: bool, kill8: bool) -> int:
    """Return coin reward. Only 1st-place lines are paid in season 1."""
    if not rank1:
        return 0
    if match_type == "ilgam":
        if dmg1k and kill8:
            return ILGAM_REWARD[(1, 1, 1)]
        if dmg1k:
            return ILGAM_REWARD[(1, 1, 0)]
        return ILGAM_REWARD[(1, 0, 0)]
    if match_type == "competitive":
        if dmg1k and kill8:
            return COMP_REWARD[(1, 1, 1)]
        if dmg1k:
            return COMP_REWARD[(1, 1, 0)]
        return COMP_REWARD[(1, 0, 0)]
    return 0


class Match(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ---------- /일겜등록 (admin) ----------
    @app_commands.command(
        name="일겜등록",
        description="(운영진) 일겜 결과를 등록하고 코인을 자동 지급합니다. 캡쳐 첨부 필수.",
    )
    @app_commands.describe(
        대상="코인을 지급할 클랜원",
        캡쳐="매치 결과 화면 스크린샷 (필수)",
        치킨="1등(치킨) 여부",
        딜1000="1000딜 이상 여부",
        킬8="8킬 이상 여부",
        메모="비고 (선택)",
    )
    async def ilgam(
        self,
        interaction: discord.Interaction,
        대상: discord.Member,
        캡쳐: discord.Attachment,
        치킨: bool,
        딜1000: bool = False,
        킬8: bool = False,
        메모: Optional[str] = None,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message(
                "운영진 전용 명령입니다.", ephemeral=True
            )
            return

        # validate attachment
        if not (캡쳐.content_type or "").startswith("image/"):
            await interaction.response.send_message(
                "이미지 파일만 첨부 가능합니다.", ephemeral=True
            )
            return

        # invalid combos: damage/kill bonus requires 1st
        if (딜1000 or 킬8) and not 치킨:
            await interaction.response.send_message(
                "시즌1 룰: 1등(치킨) 없이는 딜/킬 보너스가 적용되지 않습니다.",
                ephemeral=True,
            )
            return

        coins = _reward("ilgam", 치킨, 딜1000, 킬8)
        if coins == 0:
            await interaction.response.send_message(
                "지급 대상 조건이 없습니다. (치킨 미달성)", ephemeral=True
            )
            return

        target_id = str(대상.id)
        with db.transaction() as conn:
            db.ensure_user(conn, target_id, 대상.display_name)
            cur = conn.execute(
                """INSERT INTO matches
                   (discord_id, match_type, rank1, damage_1k, kill_8, coins, proof_url, note)
                   VALUES (?, 'ilgam', ?, ?, ?, ?, ?, ?)""",
                (target_id, int(치킨), int(딜1000), int(킬8), coins, 캡쳐.url, 메모),
            )
            match_id = cur.lastrowid
            new_bal = db.add_coins(
                conn, target_id, coins,
                reason=f"일겜 보상 (1등{'+1000딜' if 딜1000 else ''}{'+8킬' if 킬8 else ''})",
                ref_type="match",
                ref_id=match_id,
            )

        embed = discord.Embed(
            title="🎮 일겜 보상 지급",
            description=(
                f"**{대상.display_name}** 에게 **{fmt_coins(coins)}** 지급\n"
                f"잔액: {fmt_coins(new_bal)}\n"
                f"등록자: {interaction.user.mention}"
            ),
            color=0x38A169,
        )
        embed.add_field(name="치킨", value="✅" if 치킨 else "❌", inline=True)
        embed.add_field(name="1000딜", value="✅" if 딜1000 else "❌", inline=True)
        embed.add_field(name="8킬", value="✅" if 킬8 else "❌", inline=True)
        if 메모:
            embed.add_field(name="메모", value=메모, inline=False)
        embed.set_image(url=캡쳐.url)
        embed.set_footer(text=f"match_id={match_id} · 부정등록 의심 시 운영진 DM")

        await interaction.response.send_message(embed=embed)

        # mirror to verify channel for transparency
        verify_channel_id = os.getenv("VERIFY_CHANNEL_ID", "").strip()
        if verify_channel_id.isdigit():
            ch = interaction.client.get_channel(int(verify_channel_id))
            if ch is not None:
                try:
                    await ch.send(
                        content=f"🧾 일겜 등록 - <@{target_id}> (by {interaction.user.mention})",
                        embed=embed,
                    )
                except discord.Forbidden:
                    pass

    # ---------- /경쟁전등록 (self) ----------
    @app_commands.command(
        name="경쟁전등록",
        description="본인 경쟁전 결과를 등록합니다. 캡쳐 첨부 필수.",
    )
    @app_commands.describe(
        캡쳐="결과 화면 스크린샷 (필수)",
        치킨="1등(치킨) 여부",
        딜1000="1000딜 이상 여부",
        킬8="8킬 이상 여부",
    )
    @clan_only()
    async def competitive(
        self,
        interaction: discord.Interaction,
        캡쳐: discord.Attachment,
        치킨: bool,
        딜1000: bool = False,
        킬8: bool = False,
    ):
        # ensure attachment is an image
        if not (캡쳐.content_type or "").startswith("image/"):
            await interaction.response.send_message(
                "이미지 파일만 첨부 가능합니다.", ephemeral=True
            )
            return

        if not 치킨:
            await interaction.response.send_message(
                "시즌1 룰: 1등(치킨) 없는 경쟁전은 보상이 없습니다.",
                ephemeral=True,
            )
            return
        if (딜1000 or 킬8) and not 치킨:
            await interaction.response.send_message(
                "딜/킬 보너스는 1등(치킨) 시에만 적용됩니다.", ephemeral=True
            )
            return

        coins = _reward("competitive", 치킨, 딜1000, 킬8)
        if coins == 0:
            await interaction.response.send_message(
                "지급 대상 조건이 없습니다.", ephemeral=True
            )
            return

        discord_id = str(interaction.user.id)
        with db.transaction() as conn:
            db.ensure_user(conn, discord_id, interaction.user.display_name)
            cur = conn.execute(
                """INSERT INTO matches
                   (discord_id, match_type, rank1, damage_1k, kill_8, coins, proof_url)
                   VALUES (?, 'competitive', ?, ?, ?, ?, ?)""",
                (discord_id, int(치킨), int(딜1000), int(킬8), coins, 캡쳐.url),
            )
            match_id = cur.lastrowid
            new_bal = db.add_coins(
                conn, discord_id, coins,
                reason=f"경쟁전 보상 (1등{'+1000딜' if 딜1000 else ''}{'+8킬' if 킬8 else ''})",
                ref_type="match",
                ref_id=match_id,
            )

        # build receipt embed
        embed = discord.Embed(
            title="🌐 경쟁전 보상 지급",
            description=(
                f"**{interaction.user.display_name}** 자가등록\n"
                f"+{coins} 코인 (잔액 {fmt_coins(new_bal)})"
            ),
            color=0x3182CE,
        )
        embed.add_field(name="치킨", value="✅" if 치킨 else "❌", inline=True)
        embed.add_field(name="1000딜", value="✅" if 딜1000 else "❌", inline=True)
        embed.add_field(name="8킬", value="✅" if 킬8 else "❌", inline=True)
        embed.set_image(url=캡쳐.url)
        embed.set_footer(text=f"match_id={match_id} · 부정행위 적발 시 회수+제재")

        # respond to user, then mirror to verify channel if configured
        await interaction.response.send_message(embed=embed)

        verify_channel_id = os.getenv("VERIFY_CHANNEL_ID", "").strip()
        if verify_channel_id.isdigit():
            ch = interaction.client.get_channel(int(verify_channel_id))
            if ch is not None:
                try:
                    await ch.send(
                        content=f"🧾 경쟁전 자동 게시 - <@{discord_id}>",
                        embed=embed,
                    )
                except discord.Forbidden:
                    pass

    # ---------- /이벤트지급 (admin) ----------
    @app_commands.command(
        name="이벤트지급",
        description="(운영진) 이벤트 보상을 지정 인원에게 지급합니다.",
    )
    @app_commands.describe(대상="지급 대상", 금액="지급할 코인 (양의 정수)", 사유="이벤트 명/사유")
    async def event_pay(
        self,
        interaction: discord.Interaction,
        대상: discord.Member,
        금액: int,
        사유: str,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        if 금액 <= 0:
            await interaction.response.send_message("금액은 1 이상이어야 합니다.", ephemeral=True)
            return
        target_id = str(대상.id)
        with db.transaction() as conn:
            db.ensure_user(conn, target_id, 대상.display_name)
            cur = conn.execute(
                """INSERT INTO matches
                   (discord_id, match_type, rank1, damage_1k, kill_8, coins, note)
                   VALUES (?, 'event', 0, 0, 0, ?, ?)""",
                (target_id, 금액, 사유),
            )
            match_id = cur.lastrowid
            new_bal = db.add_coins(
                conn, target_id, 금액,
                reason=f"이벤트: {사유}",
                ref_type="event",
                ref_id=match_id,
            )
        await interaction.response.send_message(
            f"🎁 **{대상.display_name}** 에게 **{fmt_coins(금액)}** 지급 (사유: {사유})\n"
            f"잔액: {fmt_coins(new_bal)}"
        )

    # ---------- /회수 (admin) ----------
    @app_commands.command(
        name="회수",
        description="(운영진) 부정행위/오지급 코인을 회수합니다.",
    )
    @app_commands.describe(대상="회수 대상", 금액="회수할 코인 (양의 정수)", 사유="회수 사유")
    async def revoke(
        self,
        interaction: discord.Interaction,
        대상: discord.Member,
        금액: int,
        사유: str,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        if 금액 <= 0:
            await interaction.response.send_message("금액은 1 이상이어야 합니다.", ephemeral=True)
            return
        target_id = str(대상.id)
        bal = db.get_balance(target_id)
        if bal < 금액:
            await interaction.response.send_message(
                f"잔액 부족: 현재 {fmt_coins(bal)}, 회수 요청 {fmt_coins(금액)}",
                ephemeral=True,
            )
            return
        with db.transaction() as conn:
            new_bal = db.add_coins(
                conn, target_id, -금액,
                reason=f"회수: {사유}",
                ref_type="revoke",
            )
        await interaction.response.send_message(
            f"♻️ **{대상.display_name}** 로부터 **{fmt_coins(금액)}** 회수\n"
            f"잔액: {fmt_coins(new_bal)}"
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(Match(bot))
