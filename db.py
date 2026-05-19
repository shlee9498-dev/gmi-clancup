"""GmI Casino Bot - Database layer (SQLite).

Tables:
  users           Discord user registry
  wallets         Coin balances per user
  transactions    All coin movements (audit log)
  matches         Game match records (ilgam / competitive / event)
  seasons         Season metadata
  products        Shop items (max_per_user for limited goods)
  purchases       Purchase log
  pools           Jackpot pools (PvP betting)
  pool_entries    Per-user entries in pools
  burns           Rake / coin burn audit log
  sponsors        Donation records (legal-safe: no coin payout)
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterable, Optional

DB_PATH = os.getenv("DB_PATH", "/data/gmi_casino.db")
_lock = threading.RLock()


# ----- Connection ----------------------------------------------------------

def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    conn = sqlite3.connect(DB_PATH, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


@contextmanager
def transaction():
    """Serialized transaction context. All writes go through this."""
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        finally:
            conn.close()


def fetchone(sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
    conn = _connect()
    try:
        cur = conn.execute(sql, tuple(params))
        return cur.fetchone()
    finally:
        conn.close()


def fetchall(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    conn = _connect()
    try:
        cur = conn.execute(sql, tuple(params))
        return cur.fetchall()
    finally:
        conn.close()


# ----- Schema --------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    discord_id   TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
    discord_id   TEXT PRIMARY KEY REFERENCES users(discord_id) ON DELETE CASCADE,
    balance      INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id   TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    delta        INTEGER NOT NULL,
    reason       TEXT NOT NULL,
    ref_type     TEXT,
    ref_id       INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(discord_id, created_at);

CREATE TABLE IF NOT EXISTS seasons (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    starts_at    TEXT NOT NULL,
    ends_at      TEXT NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS matches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id   TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    match_type   TEXT NOT NULL CHECK (match_type IN ('ilgam','competitive','event')),
    rank1        INTEGER NOT NULL DEFAULT 0,
    damage_1k    INTEGER NOT NULL DEFAULT 0,
    kill_8       INTEGER NOT NULL DEFAULT 0,
    coins        INTEGER NOT NULL DEFAULT 0,
    proof_url    TEXT,
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_match_user ON matches(discord_id, created_at);

CREATE TABLE IF NOT EXISTS products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    description  TEXT,
    price        INTEGER NOT NULL CHECK (price > 0),
    stock        INTEGER,                 -- NULL = unlimited
    max_per_user INTEGER,                 -- NULL = unlimited per season
    season_id    INTEGER REFERENCES seasons(id),
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id   TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id),
    price_paid   INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled')) DEFAULT 'pending',
    note         TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchase_user ON purchases(discord_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchase_status ON purchases(status);

CREATE TABLE IF NOT EXISTS pools (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id   TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    channel_id   TEXT,
    message_id   TEXT,
    duration_min INTEGER NOT NULL CHECK (duration_min IN (5,15,30,60)),
    status       TEXT NOT NULL CHECK (status IN ('open','drawn','refunded','cancelled')) DEFAULT 'open',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    closes_at    TEXT NOT NULL,
    drawn_at     TEXT,
    winner_id    TEXT REFERENCES users(discord_id),
    total_pool   INTEGER NOT NULL DEFAULT 0,
    burned       INTEGER NOT NULL DEFAULT 0,
    payout       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pool_status ON pools(status, closes_at);

CREATE TABLE IF NOT EXISTS pool_entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id      INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
    discord_id   TEXT NOT NULL REFERENCES users(discord_id) ON DELETE CASCADE,
    amount       INTEGER NOT NULL CHECK (amount > 0),
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entry_pool ON pool_entries(pool_id);
CREATE INDEX IF NOT EXISTS idx_entry_user ON pool_entries(discord_id);

CREATE TABLE IF NOT EXISTS burns (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amount       INTEGER NOT NULL CHECK (amount > 0),
    reason       TEXT NOT NULL,
    ref_type     TEXT,
    ref_id       INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sponsors (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id      TEXT,
    nickname_snap   TEXT NOT NULL,
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    amount          INTEGER NOT NULL CHECK (amount > 0),
    tier            TEXT NOT NULL CHECK (tier IN ('bronze','silver','gold','diamond')),
    is_anonymous    INTEGER NOT NULL DEFAULT 0,
    age_confirmed   INTEGER NOT NULL DEFAULT 0,
    registered_by   TEXT NOT NULL,
    note            TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sponsor_season ON sponsors(season_id, discord_id);
"""


def init_db():
    """Create tables, seed season1 and starter products."""
    # executescript() runs its own implicit transaction, so do schema setup
    # on a standalone connection outside our transaction() context manager.
    with _lock:
        conn = _connect()
        try:
            conn.executescript(SCHEMA)
        finally:
            conn.close()

    with transaction() as conn:
        # Seed season1 (timestamps stored in UTC; KST 2026-05-20 00:00 = UTC 2026-05-19 15:00)
        row = conn.execute("SELECT id FROM seasons WHERE name = ?", ("Season 1",)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO seasons (name, starts_at, ends_at, active) VALUES (?,?,?,1)",
                ("Season 1", "2026-05-19 15:00:00", "2026-06-10 14:59:59"),
            )

        season = conn.execute(
            "SELECT id FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        season_id = season["id"] if season else None

        # Seed starter products (idempotent: only seed if no products exist)
        existing = conn.execute("SELECT COUNT(*) AS c FROM products").fetchone()
        if existing["c"] == 0 and season_id is not None:
            seed = [
                ("치킨 기프티콘", "BBQ/BHC 등 클랜장 지정 브랜드", 50, None, 1, season_id),
                ("편의점 5000원권", "GS25/CU 모바일 상품권", 30, None, None, season_id),
                ("편의점 10000원권", "GS25/CU 모바일 상품권", 60, None, None, season_id),
                ("스타벅스 아메리카노", "tall size", 25, None, None, season_id),
            ]
            conn.executemany(
                """INSERT INTO products
                   (name, description, price, stock, max_per_user, season_id, enabled)
                   VALUES (?,?,?,?,?,?,1)""",
                seed,
            )


# ----- Helpers -------------------------------------------------------------

def get_active_season() -> Optional[sqlite3.Row]:
    return fetchone("SELECT * FROM seasons WHERE active = 1 ORDER BY id DESC LIMIT 1")


def ensure_user(conn: sqlite3.Connection, discord_id: str, nickname: str) -> None:
    """Upsert user and wallet rows. Call inside an existing transaction."""
    conn.execute(
        "INSERT OR IGNORE INTO users (discord_id, nickname) VALUES (?, ?)",
        (discord_id, nickname),
    )
    conn.execute(
        "INSERT OR IGNORE INTO wallets (discord_id, balance) VALUES (?, 0)",
        (discord_id,),
    )
    conn.execute(
        "UPDATE users SET nickname = ? WHERE discord_id = ?",
        (nickname, discord_id),
    )


def get_balance(discord_id: str) -> int:
    row = fetchone("SELECT balance FROM wallets WHERE discord_id = ?", (discord_id,))
    return int(row["balance"]) if row else 0


def add_coins(
    conn: sqlite3.Connection,
    discord_id: str,
    delta: int,
    reason: str,
    ref_type: Optional[str] = None,
    ref_id: Optional[int] = None,
) -> int:
    """Adjust balance and log transaction. Returns new balance.

    Negative delta is allowed but the resulting balance must be >= 0
    (enforced by CHECK constraint).
    """
    if delta == 0:
        return get_balance(discord_id)
    conn.execute(
        "UPDATE wallets SET balance = balance + ?, updated_at = datetime('now') WHERE discord_id = ?",
        (delta, discord_id),
    )
    conn.execute(
        """INSERT INTO transactions (discord_id, delta, reason, ref_type, ref_id)
           VALUES (?, ?, ?, ?, ?)""",
        (discord_id, delta, reason, ref_type, ref_id),
    )
    row = conn.execute(
        "SELECT balance FROM wallets WHERE discord_id = ?", (discord_id,)
    ).fetchone()
    return int(row["balance"]) if row else 0


def log_burn(
    conn: sqlite3.Connection,
    amount: int,
    reason: str,
    ref_type: Optional[str] = None,
    ref_id: Optional[int] = None,
) -> None:
    if amount <= 0:
        return
    conn.execute(
        "INSERT INTO burns (amount, reason, ref_type, ref_id) VALUES (?, ?, ?, ?)",
        (amount, reason, ref_type, ref_id),
    )
