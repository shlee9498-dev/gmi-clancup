"""Shop commands: 상점 / 구매.

Season-bounded per-user purchase limit:
  products.max_per_user (NULL = unlimited, 1 = once per active season)

The limit is evaluated against purchases created within the active season window
and not in 'cancelled'/'rejected' status.
"""
from __future__ import annotations

import os
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import clan_only, fmt_coins


def _count_user_purchases_in_season(
    discord_id: str, product_id: int, season_starts_at: str, season_ends_at: str
) -> int:
    row = db.fetchone(
        """SELECT COUNT(*) AS c FROM purchases
           WHERE discord_id = ? AND product_id = ?
             AND status IN ('pending','approved')
             AND created_at BETWEEN ? AND ?""",
        (discord_id, product_id, season_starts_at, season_ends_at),
    )
    return int(row["c"]) if row else 0


class Shop(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="상점", description="교환 가능한 상품 목록을 봅니다.")
    @clan_only()
    async def shop(self, interaction: discord.Interaction):
        season = db.get_active_season()
        if season is None:
            await interaction.response.send_message(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return

        rows = db.fetchall(
            """SELECT id, name, description, price, stock, max_per_user
               FROM products
               WHERE enabled = 1 AND (season_id IS NULL OR season_id = ?)
               ORDER BY price ASC, id ASC""",
            (season["id"],),
        )
        if not rows:
            await interaction.response.send_message(
                "현재 상점 상품이 없습니다.", ephemeral=True
            )
            return

        bal = db.get_balance(str(interaction.user.id))
        lines = [f"💰 내 잔액: **{fmt_coins(bal)}**", ""]
        for r in rows:
            limit_tag = ""
            if r["max_per_user"] is not None:
                limit_tag = f" · 시즌 {r['max_per_user']}회 제한"
            stock_tag = ""
            if r["stock"] is not None:
                stock_tag = f" · 재고 {r['stock']}"
            lines.append(
                f"**[{r['id']}] {r['name']}** - {fmt_coins(int(r['price']))}{limit_tag}{stock_tag}"
            )
            if r["description"]:
                lines.append(f"> {r['description']}")
            lines.append("")

        embed = discord.Embed(
            title="🛒 GmI Casino Shop",
            description="\n".join(lines).rstrip(),
            color=0xD69E2E,
        )
        embed.set_footer(text="구매: /구매 상품번호:N")
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="구매", description="상품을 구매합니다.")
    @app_commands.describe(상품번호="상점에서 확인한 상품 ID", 메모="배송 메모 등 (선택)")
    @clan_only()
    async def buy(
        self,
        interaction: discord.Interaction,
        상품번호: int,
        메모: Optional[str] = None,
    ):
        discord_id = str(interaction.user.id)
        season = db.get_active_season()
        if season is None:
            await interaction.response.send_message(
                "활성 시즌이 없습니다.", ephemeral=True
            )
            return

        product = db.fetchone(
            """SELECT id, name, price, stock, max_per_user, season_id, enabled
               FROM products WHERE id = ?""",
            (상품번호,),
        )
        if product is None or not product["enabled"]:
            await interaction.response.send_message(
                "해당 상품을 찾을 수 없습니다.", ephemeral=True
            )
            return
        if product["season_id"] is not None and product["season_id"] != season["id"]:
            await interaction.response.send_message(
                "이번 시즌에 판매되는 상품이 아닙니다.", ephemeral=True
            )
            return

        # season-bounded per-user limit
        if product["max_per_user"] is not None:
            cnt = _count_user_purchases_in_season(
                discord_id, int(product["id"]),
                season["starts_at"], season["ends_at"],
            )
            if cnt >= int(product["max_per_user"]):
                await interaction.response.send_message(
                    f"⚠️ **{product['name']}** 은(는) 이번 시즌 "
                    f"{product['max_per_user']}회 구매 제한에 도달했습니다. "
                    f"(현재 {cnt}회)",
                    ephemeral=True,
                )
                return

        price = int(product["price"])
        bal = db.get_balance(discord_id)
        if bal < price:
            await interaction.response.send_message(
                f"잔액 부족: 필요 {fmt_coins(price)} · 현재 {fmt_coins(bal)}",
                ephemeral=True,
            )
            return

        with db.transaction() as conn:
            db.ensure_user(conn, discord_id, interaction.user.display_name)

            # re-check stock under lock
            if product["stock"] is not None:
                row = conn.execute(
                    "SELECT stock FROM products WHERE id = ?", (상품번호,)
                ).fetchone()
                if row is None or row["stock"] <= 0:
                    raise RuntimeError("재고가 없습니다.")
                conn.execute(
                    "UPDATE products SET stock = stock - 1 WHERE id = ?", (상품번호,)
                )

            # re-check per-user limit under lock
            if product["max_per_user"] is not None:
                cnt2 = conn.execute(
                    """SELECT COUNT(*) AS c FROM purchases
                       WHERE discord_id = ? AND product_id = ?
                         AND status IN ('pending','approved')
                         AND created_at BETWEEN ? AND ?""",
                    (
                        discord_id, 상품번호,
                        season["starts_at"], season["ends_at"],
                    ),
                ).fetchone()
                if int(cnt2["c"]) >= int(product["max_per_user"]):
                    raise RuntimeError("시즌 구매 제한에 도달했습니다.")

            # deduct coins and create purchase record (pending → admin approves)
            new_bal = db.add_coins(
                conn, discord_id, -price,
                reason=f"구매 신청: {product['name']}",
                ref_type="purchase",
            )
            cur = conn.execute(
                """INSERT INTO purchases (discord_id, product_id, price_paid, status, note)
                   VALUES (?, ?, ?, 'pending', ?)""",
                (discord_id, 상품번호, price, 메모),
            )
            purchase_id = cur.lastrowid

        embed = discord.Embed(
            title="🛒 구매 신청 접수",
            description=(
                f"**{product['name']}** · {fmt_coins(price)} 차감\n"
                f"잔액: {fmt_coins(new_bal)}\n"
                f"운영진 승인 후 보상이 지급됩니다."
            ),
            color=0xD69E2E,
        )
        embed.set_footer(text=f"purchase_id={purchase_id}")
        await interaction.response.send_message(embed=embed, ephemeral=True)

        # notify purchase channel
        ch_id = os.getenv("PURCHASE_CHANNEL_ID", "").strip()
        if ch_id.isdigit():
            ch = interaction.client.get_channel(int(ch_id))
            if ch is not None:
                try:
                    await ch.send(
                        f"🧾 신규 구매 신청 `#{purchase_id}` - "
                        f"<@{discord_id}> · {product['name']} ({fmt_coins(price)})"
                        + (f"\n메모: {메모}" if 메모 else "")
                    )
                except discord.Forbidden:
                    pass


async def setup(bot: commands.Bot):
    await bot.add_cog(Shop(bot))
