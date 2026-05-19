"""Internal helpers shared across cogs."""
from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

import discord
from discord import app_commands

KST = timezone(timedelta(hours=9))


def admin_ids() -> set[int]:
    raw = os.getenv("ADMIN_IDS", "")
    out = set()
    for s in raw.split(","):
        s = s.strip()
        if s.isdigit():
            out.add(int(s))
    return out


def is_admin(user: discord.abc.User) -> bool:
    return user.id in admin_ids()


def clan_role_ids() -> set[int]:
    """Discord role IDs for G / m / I clan tiers (comma-separated env var)."""
    raw = os.getenv("CLAN_ROLE_IDS", "")
    out = set()
    for s in raw.split(","):
        s = s.strip()
        if s.isdigit():
            out.add(int(s))
    return out


def is_clan_member(user: discord.abc.User) -> bool:
    """True if user has at least one configured clan role, or is an admin.

    Fail-closed: if CLAN_ROLE_IDS is empty, only admins pass. This prevents
    accidental open access on misconfiguration.
    """
    if is_admin(user):
        return True
    role_ids = clan_role_ids()
    if not role_ids:
        return False
    member_roles = getattr(user, "roles", None)
    if not member_roles:
        return False
    return any(getattr(r, "id", None) in role_ids for r in member_roles)


def clan_only():
    """Slash-command check: only G/m/I role holders (or admins) may invoke.

    On failure, sends an ephemeral rejection and short-circuits the handler.
    """
    async def predicate(interaction: discord.Interaction) -> bool:
        if is_clan_member(interaction.user):
            return True
        if interaction.response.is_done():
            await interaction.followup.send(
                "❌ G/m/I 클랜원 역할 보유자만 사용 가능한 명령입니다.",
                ephemeral=True,
            )
        else:
            await interaction.response.send_message(
                "❌ G/m/I 클랜원 역할 보유자만 사용 가능한 명령입니다.",
                ephemeral=True,
            )
        return False
    return app_commands.check(predicate)


def gambling_start_hour() -> int:
    try:
        return int(os.getenv("GAMBLING_START_HOUR", "22"))
    except ValueError:
        return 22


def gambling_end_hour() -> int:
    try:
        return int(os.getenv("GAMBLING_END_HOUR", "2"))
    except ValueError:
        return 2


def now_kst() -> datetime:
    return datetime.now(KST)


def is_gambling_open(at: datetime | None = None) -> bool:
    """Return True if gambling is currently open (KST window)."""
    t = (at or now_kst()).astimezone(KST)
    start, end = gambling_start_hour(), gambling_end_hour()
    h = t.hour
    if start < end:
        return start <= h < end
    # wraps across midnight (e.g. 22 -> 02)
    return h >= start or h < end


def rake_percent() -> int:
    try:
        return int(os.getenv("RAKE_PERCENT", "10"))
    except ValueError:
        return 10


def bet_limit_percent() -> int:
    try:
        return int(os.getenv("BET_LIMIT_PERCENT", "20"))
    except ValueError:
        return 20


def fmt_coins(n: int) -> str:
    return f"{n:,} 코인"


def fmt_won(n: int) -> str:
    return f"{n:,}원"


# ----- Sponsor system ------------------------------------------------------

def sponsor_account_info() -> str:
    """Return the human-readable account string from env (fallback included)."""
    return os.getenv(
        "SPONSOR_ACCOUNT_INFO",
        "KB국민은행 40240204238254 이주형",
    )


def sponsor_season_cap() -> int:
    """1인 시즌 후원 누적 상한 (원)."""
    try:
        return int(os.getenv("SPONSOR_SEASON_CAP", "500000"))
    except ValueError:
        return 500000


SPONSOR_TIERS = [
    ("diamond", "⭐ LEGEND", 50000),
    ("gold",    "👑 ROYAL",  30000),
    ("silver",  "🏆 NOBLE",  10000),
    ("bronze",  "🎖️ PATRON", 5000),
]


def sponsor_tier(amount_cumulative: int) -> tuple[str, str]:
    """Return (tier_key, tier_label) for the given cumulative amount in KRW."""
    for key, label, threshold in SPONSOR_TIERS:
        if amount_cumulative >= threshold:
            return key, label
    return "none", "—"


def sponsor_role_id(tier_key: str) -> int | None:
    """Map tier key -> discord role id from env. None if unset."""
    env = {
        "bronze":  "SPONSOR_BRONZE_ROLE_ID",
        "silver":  "SPONSOR_SILVER_ROLE_ID",
        "gold":    "SPONSOR_GOLD_ROLE_ID",
        "diamond": "SPONSOR_DIAMOND_ROLE_ID",
    }.get(tier_key)
    if not env:
        return None
    raw = os.getenv(env, "").strip()
    return int(raw) if raw.isdigit() else None


def sponsor_announce_channel_id() -> int | None:
    raw = os.getenv("SPONSOR_ANNOUNCE_CHANNEL_ID", "").strip()
    return int(raw) if raw.isdigit() else None
