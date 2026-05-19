"""GmI Casino Bot v1.0 - Entry point.

Loads environment variables, initializes the database, registers all cogs
under ./cogs/, and starts the discord client.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

import discord
from discord.ext import commands
from dotenv import load_dotenv

import db

load_dotenv()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("gmi")

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
GUILD_ID = os.getenv("GUILD_ID")

if not DISCORD_TOKEN:
    raise RuntimeError("DISCORD_TOKEN is not set")

intents = discord.Intents.default()
intents.members = True
intents.message_content = False  # slash commands only


class GmICasinoBot(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix="!", intents=intents, help_command=None)

    async def setup_hook(self) -> None:
        # initialize DB on startup
        db.init_db()
        log.info("Database initialized at %s", db.DB_PATH)

        # auto-load all cogs in ./cogs/
        cogs_dir = Path(__file__).parent / "cogs"
        for path in sorted(cogs_dir.glob("*.py")):
            if path.name.startswith("_"):
                continue
            module = f"cogs.{path.stem}"
            try:
                await self.load_extension(module)
                log.info("Loaded cog: %s", module)
            except Exception as e:
                log.exception("Failed to load %s: %s", module, e)

        # sync slash commands
        if GUILD_ID:
            guild = discord.Object(id=int(GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            synced = await self.tree.sync(guild=guild)
            log.info("Synced %d guild commands to %s", len(synced), GUILD_ID)
        else:
            synced = await self.tree.sync()
            log.info("Synced %d global commands", len(synced))

    async def on_ready(self):
        log.info("Logged in as %s (id=%s)", self.user, self.user.id if self.user else "?")


async def _on_app_command_error(
    interaction: discord.Interaction, error: discord.app_commands.AppCommandError
):
    """Global slash-command error handler.

    - CheckFailure: rejection message already sent by the check; swallow here.
    - Other errors: report a brief message and log full traceback.
    """
    if isinstance(error, discord.app_commands.CheckFailure):
        return
    log.exception("Slash command error: %s", error)
    msg = f"⚠️ 처리 중 오류: `{error.__class__.__name__}` {error}"
    try:
        if interaction.response.is_done():
            await interaction.followup.send(msg, ephemeral=True)
        else:
            await interaction.response.send_message(msg, ephemeral=True)
    except Exception:
        pass


def main():
    bot = GmICasinoBot()
    bot.tree.on_error = _on_app_command_error
    bot.run(DISCORD_TOKEN, log_handler=None)


if __name__ == "__main__":
    main()
