"""cogs/coin_grant.py - 일겜/경쟁전 코인 인증 시스템 v2.

이용자가 슬래시 명령으로 4명 클랜원 + 캡쳐를 제출하면 봇이
자동으로 운영진 채널에 등급 버튼이 달린 메시지를 포스팅한다.
운영진이 버튼 클릭 → 4명 전원에게 코인 자동 지급 + DM 알림.

룰:
  일겜 (daily, 5판 1세트):
    complete     5판 완주          3 코인
    win          1등 1회+          4 코인
    win_dmg      1등 + 1,000딜     5 코인
    win_dmg_kill 1등 + 1,000딜+8킬 6 코인
  경쟁전 (ranked, 판당):
    win          1등 (치킨)        1 코인
    win_dmg      1등 + 1,000딜     2 코인
    win_dmg_kill 1등 + 1,000딜+8킬 3 코인

환경변수 (cogs/coin_grant.py 전용):
  GRANT_REVIEW_CHANNEL_ID   운영진 검토 채널 ID (선택, 미설정 시 명령 사용 채널에 포스팅)
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone

import discord
from discord import app_commands
from discord.ext import commands

import db

log = logging.getLogger("gmi.cogs.coin_grant")

CLAN_ROLE_ID = int(os.environ.get("CLAN_ROLE_ID", "0"))
ADMIN_ROLE_ID = int(os.environ.get("ADMIN_ROLE_ID", "0"))
REVIEW_CHANNEL_ID = int(os.environ.get("GRANT_REVIEW_CHANNEL_ID", "0"))

# 룰 매핑: grade -> (coins_per_person, button_label)
GRADE_RULES: dict[str, dict[str, tuple[int, str]]] = {
    "daily": {
        "complete":     (3, "🥉 5판 완주"),
        "win":          (4, "🏆 1등"),
        "win_dmg":      (5, "💪 1등+1000딜"),
        "win_dmg_kill": (6, "🔥 1등+1000딜+8킬"),
    },
    "ranked": {
        "win":          (1, "🏆 1등(치킨)"),
        "win_dmg":      (2, "💪 1등+1000딜"),
        "win_dmg_kill": (3, "🔥 1등+1000딜+8킬"),
    },
}

MODE_LABEL = {"daily": "일겜 (5판 1세트)", "ranked": "경쟁전 (판당)"}

_MENTION_RE = re.compile(r"(\d{15,20})")


def _ensure_table() -> None:
    """coin_grants 테이블 자동 생성 (idempotent)."""
    with db.transaction() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS coin_grants (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                mode           TEXT NOT NULL,
                submitter_id   TEXT NOT NULL,
                member_ids     TEXT NOT NULL,
                screenshot_url TEXT,
                status         TEXT NOT NULL DEFAULT 'pending',
                grade          TEXT,
                coins_each     INTEGER,
                approved_by    TEXT,
                approved_at    TEXT,
                message_id     TEXT,
                channel_id     TEXT,
                created_at     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_grants_submitter
                ON coin_grants(submitter_id);
            CREATE INDEX IF NOT EXISTS idx_grants_status
                ON coin_grants(status);
            CREATE INDEX IF NOT EXISTS idx_grants_created
                ON coin_grants(created_at);
            CREATE INDEX IF NOT EXISTS idx_grants_message
                ON coin_grants(message_id);
        """)


def _is_clan_member(member: discord.Member) -> bool:
    if CLAN_ROLE_ID == 0:
        return True  # 미설정 시 통과 (개발용)
    return any(r.id == CLAN_ROLE_ID for r in member.roles)


def _is_admin(member: discord.Member) -> bool:
    if ADMIN_ROLE_ID == 0:
        return member.guild_permissions.administrator
    return (any(r.id == ADMIN_ROLE_ID for r in member.roles)
            or member.guild_permissions.administrator)


def _parse_members(text: str, guild: discord.Guild) -> list[discord.Member]:
    """슬래시 string에서 멘션/ID 파싱 (정규식 기반, 중복 제거)."""
    out: list[discord.Member] = []
    seen: set[int] = set()
    for match in _MENTION_RE.finditer(text):
        uid = int(match.group(1))
        if uid in seen:
            continue
        seen.add(uid)
        m = guild.get_member(uid)
        if m:
            out.append(m)
    return out


def _make_embed(mode: str, submitter: discord.Member,
                members: list[discord.Member],
                screenshot_url: str | None,
                grant_id: int) -> discord.Embed:
    color = 0x3498DB if mode == "daily" else 0xE74C3C
    embed = discord.Embed(
        title=f"🎮 {MODE_LABEL[mode]} 인증 #{grant_id}",
        color=color,
        timestamp=datetime.now(timezone.utc),
    )
    embed.add_field(name="제출자", value=submitter.mention, inline=False)
    embed.add_field(
        name=f"참가 클랜원 ({len(members)}명)",
        value="\n".join(f"• {m.mention}" for m in members),
        inline=False,
    )
    rules = GRADE_RULES[mode]
    rules_text = "\n".join(
        f"`{c}코인` {lbl}" for _, (c, lbl) in rules.items()
    )
    embed.add_field(name="등급 룰", value=rules_text, inline=False)
    embed.set_footer(text=f"grant_id={grant_id} · 운영진 버튼으로 승인")
    if screenshot_url:
        embed.set_image(url=screenshot_url)
    return embed


def _make_view(mode: str, grant_id: int) -> discord.ui.View:
    """등급 버튼 + 반려 버튼. 영구(persistent) — 봇 재시작에도 유지."""
    view = discord.ui.View(timeout=None)
    rules = GRADE_RULES[mode]
    style_map = {
        "complete":     discord.ButtonStyle.secondary,
        "win":          discord.ButtonStyle.primary,
        "win_dmg":      discord.ButtonStyle.primary,
        "win_dmg_kill": discord.ButtonStyle.success,
    }
    for grade, (coins, label) in rules.items():
        view.add_item(discord.ui.Button(
            label=f"{coins}코인 {label}",
            style=style_map.get(grade, discord.ButtonStyle.secondary),
            custom_id=f"grant:{grant_id}:{grade}",
        ))
    view.add_item(discord.ui.Button(
        label="❌ 반려",
        style=discord.ButtonStyle.danger,
        custom_id=f"grant:{grant_id}:reject",
    ))
    return view


def _utc_str() -> str:
    """SQLite datetime('now') 호환 UTC 문자열."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


class CoinGrant(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        _ensure_table()

    # ============================================================ /일겜인증
    @app_commands.command(
        name="일겜인증",
        description="GmI 클랜원 4명 일겜(5판) 인증 — 캡쳐 첨부 필수",
    )
    @app_commands.describe(
        members="참가한 클랜원 4명 멘션 (@A @B @C @D)",
        screenshot="결과 캡쳐 이미지",
    )
    async def daily(
        self,
        interaction: discord.Interaction,
        members: str,
        screenshot: discord.Attachment,
    ):
        await self._submit(interaction, "daily", members, screenshot)

    # ========================================================== /경쟁전인증
    @app_commands.command(
        name="경쟁전인증",
        description="GmI 클랜원 4명 경쟁전(판당) 인증 — 1등 캡쳐 첨부 필수",
    )
    @app_commands.describe(
        members="참가한 클랜원 4명 멘션 (@A @B @C @D)",
        screenshot="결과 캡쳐 이미지",
    )
    async def ranked(
        self,
        interaction: discord.Interaction,
        members: str,
        screenshot: discord.Attachment,
    ):
        await self._submit(interaction, "ranked", members, screenshot)

    # ----------------------------------------------------------- 제출 처리
    async def _submit(
        self,
        interaction: discord.Interaction,
        mode: str,
        members_text: str,
        screenshot: discord.Attachment,
    ):
        if not interaction.guild:
            return await interaction.response.send_message(
                "❌ 서버에서만 사용 가능", ephemeral=True
            )

        # 1. 캡쳐 검증
        ctype = screenshot.content_type or ""
        if not ctype.startswith("image/"):
            return await interaction.response.send_message(
                "❌ 캡쳐는 이미지 파일이어야 합니다.", ephemeral=True
            )

        # 2. 4명 파싱
        parsed = _parse_members(members_text, interaction.guild)
        if len(parsed) != 4:
            return await interaction.response.send_message(
                f"❌ 정확히 4명을 멘션해야 합니다 (현재 {len(parsed)}명 인식).",
                ephemeral=True,
            )

        # 3. 4명 모두 클랜원인지
        non_clan = [m for m in parsed if not _is_clan_member(m)]
        if non_clan:
            return await interaction.response.send_message(
                "❌ 클랜원이 아닌 멤버 포함: "
                + ", ".join(m.mention for m in non_clan),
                ephemeral=True,
            )

        # 4. 24h 중복 차단 (같은 제출자 + 같은 mode)
        recent = db.fetchone(
            """SELECT id FROM coin_grants
               WHERE submitter_id=? AND mode=?
                 AND created_at >= datetime('now', '-24 hours')
               ORDER BY id DESC LIMIT 1""",
            (str(interaction.user.id), mode),
        )
        if recent:
            return await interaction.response.send_message(
                f"❌ 24시간 내 {MODE_LABEL[mode]} 신청 이력 있음 "
                f"(#{recent['id']}). 운영진에 문의.",
                ephemeral=True,
            )

        await interaction.response.defer(ephemeral=True, thinking=True)

        # 5. DB insert (grant_id 확보)
        member_ids_json = json.dumps([str(m.id) for m in parsed])
        with db.transaction() as conn:
            cur = conn.execute(
                """INSERT INTO coin_grants
                     (mode, submitter_id, member_ids, screenshot_url, status)
                   VALUES (?, ?, ?, ?, 'pending')""",
                (mode, str(interaction.user.id),
                 member_ids_json, screenshot.url),
            )
            grant_id = int(cur.lastrowid)

        # 6. 운영진 채널 또는 사용 채널에 포스팅
        channel = interaction.channel
        if REVIEW_CHANNEL_ID:
            ch = interaction.guild.get_channel(REVIEW_CHANNEL_ID)
            if isinstance(ch, (discord.TextChannel, discord.Thread)):
                channel = ch

        embed = _make_embed(
            mode, interaction.user, parsed, screenshot.url, grant_id
        )
        view = _make_view(mode, grant_id)
        try:
            msg = await channel.send(embed=embed, view=view)
        except discord.Forbidden:
            return await interaction.followup.send(
                "❌ 검토 채널 메시지 권한 없음. 운영진에 문의.",
                ephemeral=True,
            )

        # 7. message_id 업데이트
        with db.transaction() as conn:
            conn.execute(
                """UPDATE coin_grants
                   SET message_id=?, channel_id=? WHERE id=?""",
                (str(msg.id), str(msg.channel.id), grant_id),
            )

        await interaction.followup.send(
            f"✅ 인증 #{grant_id} 접수. 운영진 승인 대기 중.\n"
            f"→ {msg.jump_url}",
            ephemeral=True,
        )

    # ========================================================== 버튼 핸들러
    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return
        data = interaction.data or {}
        cid = data.get("custom_id", "")
        if not cid.startswith("grant:"):
            return

        try:
            _, gid_s, action = cid.split(":", 2)
            grant_id = int(gid_s)
        except ValueError:
            return

        if not isinstance(interaction.user, discord.Member):
            return await interaction.response.send_message(
                "❌ 서버 멤버 정보 없음", ephemeral=True
            )
        if not _is_admin(interaction.user):
            return await interaction.response.send_message(
                "❌ 운영진만 사용 가능", ephemeral=True
            )

        row = db.fetchone(
            "SELECT * FROM coin_grants WHERE id=?", (grant_id,)
        )
        if not row:
            return await interaction.response.send_message(
                "❌ 인증 기록 없음", ephemeral=True
            )
        if row["status"] != "pending":
            return await interaction.response.send_message(
                f"⚠️ 이미 처리됨 (status={row['status']})", ephemeral=True
            )

        if action == "reject":
            await self._handle_reject(interaction, row)
            return

        rules = GRADE_RULES.get(row["mode"], {})
        if action not in rules:
            return await interaction.response.send_message(
                f"❌ 알 수 없는 등급: {action}", ephemeral=True
            )
        coins, label = rules[action]
        await self._handle_approve(interaction, row, action, coins, label)

    # ---------------------------------------------------------- 승인 처리
    async def _handle_approve(
        self,
        interaction: discord.Interaction,
        row,
        grade: str,
        coins: int,
        label: str,
    ):
        member_ids: list[str] = json.loads(row["member_ids"])
        guild = interaction.guild

        # DB: 4명 지급 + 상태 업데이트 (단일 트랜잭션)
        granted: list[str] = []
        with db.transaction() as conn:
            for mid in member_ids:
                m = guild.get_member(int(mid)) if guild else None
                name = m.display_name if m else mid
                db.ensure_user(conn, mid, name)
                db.add_coins(
                    conn, mid, coins,
                    reason=f"grant_{row['mode']}_{grade}",
                    entity_type="coin_grant",
                    entity_id=row["id"],
                )
                granted.append(mid)

            conn.execute(
                """UPDATE coin_grants SET
                     status='approved', grade=?, coins_each=?,
                     approved_by=?, approved_at=?
                   WHERE id=?""",
                (grade, coins, str(interaction.user.id),
                 _utc_str(), row["id"]),
            )

        # 메시지 임베드 업데이트 (버튼 제거)
        try:
            old = interaction.message.embeds[0]
            old.color = 0x2ECC71
            old.add_field(
                name="✅ 승인",
                value=(
                    f"{label}\n"
                    f"**{coins}코인 × {len(member_ids)}명 = "
                    f"{coins * len(member_ids)}코인** 지급 완료\n"
                    f"승인: {interaction.user.mention}"
                ),
                inline=False,
            )
            await interaction.message.edit(embed=old, view=None)
        except Exception:
            log.exception("승인 메시지 업데이트 실패 grant_id=%s", row["id"])

        await interaction.response.send_message(
            f"✅ #{row['id']} 승인 ({coins}코인 × {len(member_ids)}명 지급)",
            ephemeral=True,
        )

        # DM 알림 (실패해도 무시)
        for mid in granted:
            try:
                user = await self.bot.fetch_user(int(mid))
                await user.send(
                    f"🎉 **{MODE_LABEL[row['mode']]}** 인증 승인!\n"
                    f"`+{coins}코인` ({label})\n"
                    f"누적 잔액: **{db.balance_of(mid)}코인**"
                )
            except Exception:
                pass

    # ---------------------------------------------------------- 반려 처리
    async def _handle_reject(
        self, interaction: discord.Interaction, row
    ):
        with db.transaction() as conn:
            conn.execute(
                """UPDATE coin_grants SET
                     status='rejected', approved_by=?, approved_at=?
                   WHERE id=?""",
                (str(interaction.user.id), _utc_str(), row["id"]),
            )
        try:
            old = interaction.message.embeds[0]
            old.color = 0x95A5A6
            old.add_field(
                name="❌ 반려",
                value=f"반려: {interaction.user.mention}",
                inline=False,
            )
            await interaction.message.edit(embed=old, view=None)
        except Exception:
            log.exception("반려 메시지 업데이트 실패 grant_id=%s", row["id"])
        await interaction.response.send_message(
            f"❌ #{row['id']} 반려 처리", ephemeral=True
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(CoinGrant(bot))
