"""Sponsor system: legal-safe donation handling.

Core principle: 후원자에게 코인/환금성 보상 일체 지급 X.
오직 디스코드 역할(명예 보상) + 감사명단 게시만 제공.

Commands:
  /후원안내           후원 정책 + 계좌 안내 (DM/ephemeral)
  /후원자등록         (운영진) 입금 확인 후 후원자 등록
  /후원자명단         시즌 후원자 명예 명단
  /후원내역           본인 시즌 누적 후원 확인
  /후원결산           (운영진) 시즌 후원 결산 요약
"""
from __future__ import annotations

from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import (
    clan_only,
    fmt_won,
    is_admin,
    sponsor_account_info,
    sponsor_announce_channel_id,
    sponsor_role_id,
    sponsor_season_cap,
    sponsor_tier,
    SPONSOR_TIERS,
)


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────

def _season_cumulative(discord_id: str, season_id: int) -> int:
    """해당 시즌 본인 누적 후원액(원)."""
    row = db.fetchone(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM sponsors "
        "WHERE discord_id = ? AND season_id = ?",
        (discord_id, season_id),
    )
    return int(row["total"]) if row else 0


async def _sync_sponsor_role(
    guild: discord.Guild,
    member: discord.Member,
    new_tier_key: str,
) -> Optional[str]:
    """업그레이드된 등급의 역할만 부여. 하위 등급 역할은 제거.

    Returns: 적용 결과 사람읽기용 문자열 (없으면 None).
    """
    role_changes = []
    target_role = None
    if new_tier_key != "none":
        rid = sponsor_role_id(new_tier_key)
        if rid:
            target_role = guild.get_role(rid)

    # 모든 후원자 역할 ID 모음
    all_role_ids = {sponsor_role_id(k) for k, _, _ in SPONSOR_TIERS}
    all_role_ids.discard(None)

    # 현재 보유 중 후원자 역할 제거 (target은 제외)
    to_remove = [
        r for r in member.roles
        if r.id in all_role_ids and (target_role is None or r.id != target_role.id)
    ]
    if to_remove:
        try:
            await member.remove_roles(*to_remove, reason="후원 등급 갱신")
            role_changes.append("이전 등급 역할 제거")
        except discord.Forbidden:
            pass

    # 대상 역할 추가
    if target_role and target_role not in member.roles:
        try:
            await member.add_roles(target_role, reason="후원 등급 부여")
            role_changes.append(f"{target_role.name} 부여")
        except discord.Forbidden:
            role_changes.append(f"역할 부여 실패 (봇 권한 부족: {target_role.name})")

    return " · ".join(role_changes) if role_changes else None


# ─────────────────────────────────────────────────────────────────────────
# Cog
# ─────────────────────────────────────────────────────────────────────────

class Sponsor(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── /후원안내 ────────────────────────────────────────────────────────
    @app_commands.command(
        name="후원안내",
        description="GmI 클랜 후원 정책 + 계좌 안내 (본인에게만 표시)",
    )
    @clan_only()
    async def info(self, interaction: discord.Interaction):
        cap = sponsor_season_cap()
        tier_lines = []
        for key, label, threshold in reversed(SPONSOR_TIERS):  # bronze→diamond 순
            tier_lines.append(f"• {label} — {fmt_won(threshold)}+")

        embed = discord.Embed(
            title="💝 GmI 클랜 후원 안내",
            description=(
                "GmI 클랜은 친목 클랜입니다. 클랜 운영비(보상 풀)는 "
                "전적으로 클랜장 사비로 충당되어 왔습니다.\n\n"
                "본 후원은 **자발적**이며, **어떠한 강제성도 없습니다**.\n"
                "후원하지 않아도 모든 클랜 활동과 보상에 동등하게 참여 가능합니다."
            ),
            color=discord.Color.gold(),
        )
        embed.add_field(
            name="📌 후원 계좌",
            value=f"```\n{sponsor_account_info()}\n```\n입금자명에 **디스코드 닉네임** 기입 부탁드립니다.",
            inline=False,
        )
        embed.add_field(
            name="🏅 후원자 등급",
            value="\n".join(tier_lines) + "\n*시즌 누적액 기준으로 자동 산정*",
            inline=False,
        )
        embed.add_field(
            name="🎁 후원자 혜택 (비도박·비환금성 한정)",
            value=(
                "• 디스코드 후원자 명예 역할 부여\n"
                "• 시즌 종료 시 감사 명단 게시 (익명 옵션 가능)\n"
                "• ROYAL+ : 다음 시즌 신상품 추천권 (1건)\n"
                "• LEGEND : 클랜장과 PUBG 1:1 듀오 매치 1회 (친선전)"
            ),
            inline=False,
        )
        embed.add_field(
            name="⚖️ 필독 사항",
            value=(
                f"▫ **만 19세 이상**만 후원 가능합니다\n"
                f"▫ **1인 시즌 누적 상한: {fmt_won(cap)}**\n"
                f"▫ 후원금은 **환불되지 않습니다**\n"
                f"▫ 후원 대가로 **코인·기프티콘 등 환금성 보상 일체 지급 X**\n"
                f"▫ **잭팟·인디언 포커 등 게임상 우대 일체 없음** (참여권/한도/보너스 등)\n"
                f"▫ 후원금은 **클랜 운영비**로만 사용되며 시즌 종료 시 사용 내역 공개\n"
                f"▫ 외부 거래·환전 시도 시 영구 제명"
            ),
            inline=False,
        )
        embed.set_footer(
            text="입금 후 운영진에게 DM 부탁드립니다. 운영진이 확인 후 등록 처리합니다."
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── /후원자등록 (운영진) ──────────────────────────────────────────────
    @app_commands.command(
        name="후원자등록",
        description="(운영진) 입금 확인된 후원자 등록",
    )
    @app_commands.describe(
        후원자="후원한 클랜원",
        금액="후원 금액 (원)",
        익명="감사명단 익명 게시 여부 (기본: 공개)",
        성인확인="만 19세 이상 확인 여부 (기본: 확인됨)",
        메모="관리용 메모 (선택)",
    )
    async def register(
        self,
        interaction: discord.Interaction,
        후원자: discord.Member,
        금액: int,
        익명: bool = False,
        성인확인: bool = True,
        메모: Optional[str] = None,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message(
                "운영진 전용입니다.", ephemeral=True
            )
            return

        if 금액 <= 0:
            await interaction.response.send_message(
                "금액은 1원 이상이어야 합니다.", ephemeral=True
            )
            return

        if not 성인확인:
            await interaction.response.send_message(
                "❌ 미성년자 후원은 받을 수 없습니다. 등록 거부.",
                ephemeral=True,
            )
            return

        await interaction.response.defer(ephemeral=True)

        season = db.get_active_season()
        if not season:
            await interaction.followup.send(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return

        season_id = int(season["id"])
        cap = sponsor_season_cap()
        before = _season_cumulative(str(후원자.id), season_id)
        after = before + 금액

        if after > cap:
            await interaction.followup.send(
                f"❌ 1인 시즌 누적 상한 초과\n"
                f"- 기존 누적: {fmt_won(before)}\n"
                f"- 이번 금액: {fmt_won(금액)}\n"
                f"- 합계: {fmt_won(after)}\n"
                f"- 시즌 상한: {fmt_won(cap)}\n\n"
                f"등록 거부됨. 환불 처리 필요.",
                ephemeral=True,
            )
            return

        new_tier_key, new_tier_label = sponsor_tier(after)
        old_tier_key, _ = sponsor_tier(before)

        # DB 기록
        with db.transaction() as conn:
            db.ensure_user(conn, str(후원자.id), 후원자.display_name)
            conn.execute(
                """INSERT INTO sponsors
                   (discord_id, nickname_snap, season_id, amount, tier,
                    is_anonymous, age_confirmed, registered_by, note)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    str(후원자.id),
                    후원자.display_name,
                    season_id,
                    금액,
                    new_tier_key,
                    1 if 익명 else 0,
                    1,
                    str(interaction.user.id),
                    메모,
                ),
            )

        # 역할 갱신 (등급 변동 있을 때만)
        role_msg = None
        if new_tier_key != old_tier_key and interaction.guild:
            role_msg = await _sync_sponsor_role(
                interaction.guild, 후원자, new_tier_key
            )

        # 운영진 응답
        lines = [
            f"✅ 후원자 등록 완료",
            f"- 대상: {후원자.mention}",
            f"- 금액: {fmt_won(금액)}",
            f"- 시즌 누적: {fmt_won(before)} → **{fmt_won(after)}**",
            f"- 등급: **{new_tier_label}**",
            f"- 익명: {'예' if 익명 else '아니오'}",
        ]
        if role_msg:
            lines.append(f"- 역할: {role_msg}")
        await interaction.followup.send("\n".join(lines), ephemeral=True)

        # 공개 감사 메시지 (지정 채널 + 익명 아닐 때만)
        announce_id = sponsor_announce_channel_id()
        if announce_id and not 익명:
            ch = interaction.guild.get_channel(announce_id) if interaction.guild else None
            if isinstance(ch, discord.TextChannel):
                embed = discord.Embed(
                    title=f"{new_tier_label} 후원 감사드립니다",
                    description=(
                        f"{후원자.mention}님께서 클랜 운영비를 후원해주셨습니다.\n"
                        f"덕분에 더 풍성한 클랜 활동이 가능합니다. 🙏"
                    ),
                    color=discord.Color.green(),
                )
                embed.set_footer(text="GmI 클랜 후원 시스템 · 환금성 보상 없음")
                try:
                    await ch.send(embed=embed)
                except discord.Forbidden:
                    pass

        # 익명일 때도 운영진 채널에는 익명 알림
        if announce_id and 익명:
            ch = interaction.guild.get_channel(announce_id) if interaction.guild else None
            if isinstance(ch, discord.TextChannel):
                embed = discord.Embed(
                    title=f"{new_tier_label} 익명 후원 감사드립니다",
                    description="익명의 후원자께서 클랜 운영비를 후원해주셨습니다. 🙏",
                    color=discord.Color.green(),
                )
                embed.set_footer(text="GmI 클랜 후원 시스템 · 환금성 보상 없음")
                try:
                    await ch.send(embed=embed)
                except discord.Forbidden:
                    pass

    # ── /후원자명단 ──────────────────────────────────────────────────────
    @app_commands.command(
        name="후원자명단",
        description="현재 시즌 후원자 명예 명단",
    )
    @clan_only()
    async def roster(self, interaction: discord.Interaction):
        season = db.get_active_season()
        if not season:
            await interaction.response.send_message(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return
        season_id = int(season["id"])

        rows = db.fetchall(
            """SELECT discord_id, nickname_snap, SUM(amount) AS total,
                      MAX(is_anonymous) AS anon
               FROM sponsors
               WHERE season_id = ?
               GROUP BY discord_id
               ORDER BY total DESC""",
            (season_id,),
        )
        if not rows:
            await interaction.response.send_message(
                "이번 시즌 등록된 후원자가 아직 없습니다.\n"
                "여러분의 후원이 클랜을 살립니다 💝",
                ephemeral=True,
            )
            return

        lines = []
        total_sum = 0
        for r in rows:
            total = int(r["total"])
            total_sum += total
            tier_key, label = sponsor_tier(total)
            if int(r["anon"]):
                display = "익명 후원자"
            else:
                display = r["nickname_snap"]
            lines.append(f"{label} · **{display}**")

        embed = discord.Embed(
            title=f"💝 {season['name']} 후원자 명예 명단",
            description="\n".join(lines),
            color=discord.Color.gold(),
        )
        embed.add_field(
            name="총 후원 인원",
            value=f"{len(rows)}명",
            inline=True,
        )
        embed.set_footer(
            text="모든 후원자께 깊이 감사드립니다 · 환금성 보상 없는 명예 표시"
        )
        await interaction.response.send_message(embed=embed)

    # ── /후원내역 ────────────────────────────────────────────────────────
    @app_commands.command(
        name="후원내역",
        description="본인 시즌 누적 후원 내역 확인",
    )
    @clan_only()
    async def my_records(self, interaction: discord.Interaction):
        season = db.get_active_season()
        if not season:
            await interaction.response.send_message(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return
        season_id = int(season["id"])

        rows = db.fetchall(
            """SELECT amount, tier, is_anonymous, created_at, note
               FROM sponsors
               WHERE discord_id = ? AND season_id = ?
               ORDER BY id ASC""",
            (str(interaction.user.id), season_id),
        )
        if not rows:
            await interaction.response.send_message(
                "이번 시즌 후원 내역이 없습니다.\n"
                "`/후원안내` 로 후원 방법을 확인하세요.",
                ephemeral=True,
            )
            return

        total = sum(int(r["amount"]) for r in rows)
        tier_key, label = sponsor_tier(total)
        cap = sponsor_season_cap()
        remaining = max(0, cap - total)

        lines = []
        for r in rows:
            anon = " (익명)" if int(r["is_anonymous"]) else ""
            note = f" · {r['note']}" if r["note"] else ""
            lines.append(
                f"`{r['created_at']}` {fmt_won(int(r['amount']))}{anon}{note}"
            )

        embed = discord.Embed(
            title=f"💝 {season['name']} 본인 후원 내역",
            description="\n".join(lines),
            color=discord.Color.blue(),
        )
        embed.add_field(name="시즌 누적", value=fmt_won(total), inline=True)
        embed.add_field(name="현재 등급", value=label, inline=True)
        embed.add_field(name="잔여 한도", value=fmt_won(remaining), inline=True)
        await interaction.response.send_message(embed=embed, ephemeral=True)

    # ── /후원결산 (운영진) ────────────────────────────────────────────────
    @app_commands.command(
        name="후원결산",
        description="(운영진) 시즌 후원 결산 요약",
    )
    async def summary(self, interaction: discord.Interaction):
        if not is_admin(interaction.user):
            await interaction.response.send_message(
                "운영진 전용입니다.", ephemeral=True
            )
            return

        season = db.get_active_season()
        if not season:
            await interaction.response.send_message(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return
        season_id = int(season["id"])

        total_row = db.fetchone(
            """SELECT COUNT(DISTINCT discord_id) AS sponsors,
                      COUNT(*)                   AS entries,
                      COALESCE(SUM(amount), 0)   AS total
               FROM sponsors WHERE season_id = ?""",
            (season_id,),
        )

        tier_rows = db.fetchall(
            """SELECT t.tier, COUNT(DISTINCT t.discord_id) AS n, SUM(t.total) AS sum_amt
               FROM (
                   SELECT discord_id, SUM(amount) AS total,
                          CASE
                            WHEN SUM(amount) >= 50000 THEN 'diamond'
                            WHEN SUM(amount) >= 30000 THEN 'gold'
                            WHEN SUM(amount) >= 10000 THEN 'silver'
                            WHEN SUM(amount) >= 5000  THEN 'bronze'
                            ELSE 'none'
                          END AS tier
                   FROM sponsors WHERE season_id = ?
                   GROUP BY discord_id
               ) t
               GROUP BY t.tier
               ORDER BY CASE t.tier
                   WHEN 'diamond' THEN 1
                   WHEN 'gold'    THEN 2
                   WHEN 'silver'  THEN 3
                   WHEN 'bronze'  THEN 4
                   ELSE 5 END""",
            (season_id,),
        )

        tier_labels = {k: l for k, l, _ in SPONSOR_TIERS}
        tier_lines = []
        for r in tier_rows:
            label = tier_labels.get(r["tier"], r["tier"])
            tier_lines.append(
                f"• {label} — {r['n']}명, {fmt_won(int(r['sum_amt']))}"
            )

        embed = discord.Embed(
            title=f"📊 {season['name']} 후원 결산",
            color=discord.Color.purple(),
        )
        embed.add_field(name="총 후원자", value=f"{total_row['sponsors']}명", inline=True)
        embed.add_field(name="총 후원 건수", value=f"{total_row['entries']}건", inline=True)
        embed.add_field(
            name="총 후원 금액",
            value=fmt_won(int(total_row["total"])),
            inline=True,
        )
        if tier_lines:
            embed.add_field(
                name="등급별 분포",
                value="\n".join(tier_lines),
                inline=False,
            )
        embed.set_footer(text="운영진 전용 · 클랜원에게는 /후원자명단 으로 안내")
        await interaction.response.send_message(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(Sponsor(bot))
