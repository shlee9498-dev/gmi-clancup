"""Admin commands: 구매목록 / 구매승인 / 구매취소 / 상품추가 / 잔액조회 / db백업."""
from __future__ import annotations

import os
import shutil
from datetime import datetime
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

import db
from cogs._utils import fmt_coins, is_admin


class Admin(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="구매목록", description="(운영진) 대기 중인 구매 신청 목록")
    async def list_purchases(self, interaction: discord.Interaction):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        rows = db.fetchall(
            """SELECT p.id, p.discord_id, p.price_paid, p.note, p.created_at,
                      pr.name AS product_name, u.nickname
               FROM purchases p
               JOIN products pr ON pr.id = p.product_id
               JOIN users u ON u.discord_id = p.discord_id
               WHERE p.status = 'pending'
               ORDER BY p.id ASC
               LIMIT 30"""
        )
        if not rows:
            await interaction.response.send_message(
                "대기 중인 구매가 없습니다.", ephemeral=True
            )
            return
        lines = []
        for r in rows:
            note = f" · 메모: {r['note']}" if r["note"] else ""
            lines.append(
                f"`#{r['id']}` {r['nickname']} - **{r['product_name']}** "
                f"({fmt_coins(int(r['price_paid']))}) `{r['created_at']}`{note}"
            )
        embed = discord.Embed(
            title="🧾 대기 중인 구매 신청",
            description="\n".join(lines),
            color=0x805AD5,
        )
        await interaction.response.send_message(embed=embed, ephemeral=True)

    @app_commands.command(name="구매승인", description="(운영진) 구매를 승인 처리합니다.")
    @app_commands.describe(구매번호="purchase_id")
    async def approve(self, interaction: discord.Interaction, 구매번호: int):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        with db.transaction() as conn:
            row = conn.execute(
                "SELECT id, status FROM purchases WHERE id = ?", (구매번호,)
            ).fetchone()
            if row is None:
                raise RuntimeError("구매 기록을 찾을 수 없습니다.")
            if row["status"] != "pending":
                raise RuntimeError(f"이미 처리됨: {row['status']}")
            conn.execute(
                "UPDATE purchases SET status = 'approved', updated_at = datetime('now') WHERE id = ?",
                (구매번호,),
            )
        await interaction.response.send_message(
            f"✅ 구매 `#{구매번호}` 승인 완료.", ephemeral=True
        )

    @app_commands.command(name="구매취소", description="(운영진) 구매 취소 + 코인 환불")
    @app_commands.describe(구매번호="purchase_id", 사유="취소 사유")
    async def cancel(
        self, interaction: discord.Interaction, 구매번호: int, 사유: str
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        with db.transaction() as conn:
            row = conn.execute(
                """SELECT p.id, p.discord_id, p.price_paid, p.status, p.product_id,
                          pr.stock IS NOT NULL AS has_stock
                   FROM purchases p
                   JOIN products pr ON pr.id = p.product_id
                   WHERE p.id = ?""",
                (구매번호,),
            ).fetchone()
            if row is None:
                raise RuntimeError("구매 기록을 찾을 수 없습니다.")
            if row["status"] not in ("pending", "approved"):
                raise RuntimeError(f"이미 처리됨: {row['status']}")
            # refund
            new_bal = db.add_coins(
                conn, row["discord_id"], int(row["price_paid"]),
                reason=f"구매 취소 환불: {사유}",
                ref_type="purchase_cancel",
                ref_id=구매번호,
            )
            # restock if applicable
            if row["has_stock"]:
                conn.execute(
                    "UPDATE products SET stock = stock + 1 WHERE id = ?",
                    (row["product_id"],),
                )
            conn.execute(
                "UPDATE purchases SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?",
                (구매번호,),
            )
        await interaction.response.send_message(
            f"♻️ 구매 `#{구매번호}` 취소 완료. 환불 후 잔액 {fmt_coins(new_bal)}.",
            ephemeral=True,
        )

    @app_commands.command(name="상품추가", description="(운영진) 상점에 상품을 추가합니다.")
    @app_commands.describe(
        이름="상품명",
        가격="코인 가격 (양의 정수)",
        설명="상품 설명 (선택)",
        재고="재고 수량 (생략 시 무제한)",
        시즌제한="유저당 시즌 구매 횟수 제한 (생략 시 무제한)",
    )
    async def add_product(
        self,
        interaction: discord.Interaction,
        이름: str,
        가격: int,
        설명: Optional[str] = None,
        재고: Optional[int] = None,
        시즌제한: Optional[int] = None,
    ):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        if 가격 <= 0:
            await interaction.response.send_message("가격은 1 이상이어야 합니다.", ephemeral=True)
            return
        season = db.get_active_season()
        season_id = season["id"] if season else None
        with db.transaction() as conn:
            cur = conn.execute(
                """INSERT INTO products (name, description, price, stock, max_per_user, season_id, enabled)
                   VALUES (?, ?, ?, ?, ?, ?, 1)""",
                (이름, 설명, 가격, 재고, 시즌제한, season_id),
            )
            pid = cur.lastrowid
        await interaction.response.send_message(
            f"✅ 상품 추가됨 `#{pid}` **{이름}** ({fmt_coins(가격)})", ephemeral=True
        )

    @app_commands.command(name="잔액조회", description="(운영진) 특정 클랜원 잔액 확인")
    @app_commands.describe(대상="조회할 클랜원")
    async def check_balance(self, interaction: discord.Interaction, 대상: discord.Member):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        bal = db.get_balance(str(대상.id))
        await interaction.response.send_message(
            f"💰 **{대상.display_name}** 잔액: **{fmt_coins(bal)}**", ephemeral=True
        )

    @app_commands.command(name="db백업", description="(운영진) DB 파일을 백업합니다.")
    async def backup_db(self, interaction: discord.Interaction):
        if not is_admin(interaction.user):
            await interaction.response.send_message("운영진 전용입니다.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        src = db.DB_PATH
        if not os.path.exists(src):
            await interaction.followup.send("DB 파일이 없습니다.", ephemeral=True)
            return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        dst = f"{src}.backup.{ts}"
        try:
            # use sqlite online backup for consistency
            import sqlite3
            srcconn = sqlite3.connect(src)
            dstconn = sqlite3.connect(dst)
            with dstconn:
                srcconn.backup(dstconn)
            srcconn.close()
            dstconn.close()
        except Exception:
            # fallback to file copy
            shutil.copy2(src, dst)
        size = os.path.getsize(dst)
        await interaction.followup.send(
            f"✅ 백업 생성: `{dst}` ({size:,} bytes)\n"
            f"Railway 환경이면 `/data` 볼륨 내에 저장되어 영속됩니다.",
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(Admin(bot))
