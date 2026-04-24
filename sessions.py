"""SQLite-backed chat session store.

Persists chat history (text + image attachments + tool results) so the
browser can be refreshed, restarted, or replaced and the conversation is
preserved on the server. Single-file SQLite at ./chatlm.db, suitable for
a single-user local app.

Schema
------
sessions(id TEXT PK, title TEXT, created_at REAL, updated_at REAL)
messages(id INTEGER PK, session_id TEXT FK, role TEXT, content TEXT,
         meta TEXT NULL, created_at REAL)
"""
from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Any

log = logging.getLogger("chatlm.sessions")

DB_PATH = Path(__file__).parent / "chatlm.db"
IMAGE_STORAGE_ROOT = Path(__file__).parent / "storage" / "images"
DEFAULT_TITLE = "New chat"
TITLE_MAX_LEN = 60

_lock = Lock()  # sqlite3 with check_same_thread=False still wants serialised writes
_conn: sqlite3.Connection | None = None


def _connect() -> sqlite3.Connection:
    global _conn
    if _conn is not None:
        return _conn
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            role        TEXT NOT NULL,
            content     TEXT NOT NULL,
            meta        TEXT,
            created_at  REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session
            ON messages(session_id, id);
        CREATE TABLE IF NOT EXISTS mcp_servers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            url         TEXT NOT NULL,
            headers     TEXT,            -- JSON object, may be empty/null
            enabled     INTEGER NOT NULL DEFAULT 1,
            added_at    REAL NOT NULL
        );
        """
    )
    _conn = conn
    log.info(f"sessions DB ready at {DB_PATH}")
    return conn


def _now() -> float:
    return time.time()


def list_sessions() -> list[dict]:
    conn = _connect()
    with _lock:
        rows = conn.execute(
            """
            SELECT s.id, s.title, s.created_at, s.updated_at,
                   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
            FROM sessions s
            ORDER BY s.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def create_session(title: str | None = None) -> dict:
    sid = uuid.uuid4().hex[:12]
    now = _now()
    title = (title or DEFAULT_TITLE)[:TITLE_MAX_LEN] or DEFAULT_TITLE
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (sid, title, now, now),
        )
    return {"id": sid, "title": title, "created_at": now, "updated_at": now, "message_count": 0}


def get_session(sid: str) -> dict | None:
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?",
            (sid,),
        ).fetchone()
    return dict(row) if row else None


def rename_session(sid: str, title: str) -> dict | None:
    title = (title or "").strip()[:TITLE_MAX_LEN] or DEFAULT_TITLE
    conn = _connect()
    with _lock:
        conn.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (title, _now(), sid),
        )
    return get_session(sid)


def delete_session(sid: str) -> bool:
    conn = _connect()
    with _lock:
        cur = conn.execute("DELETE FROM sessions WHERE id = ?", (sid,))
    # Best-effort cleanup of generated images for this session.
    img_dir = IMAGE_STORAGE_ROOT / sid
    if img_dir.exists():
        try:
            shutil.rmtree(img_dir)
            log.info(f"removed image dir {img_dir}")
        except OSError as err:
            log.warning(f"failed to remove image dir {img_dir}: {err}")
    return cur.rowcount > 0


def list_messages(sid: str) -> list[dict]:
    conn = _connect()
    with _lock:
        rows = conn.execute(
            """
            SELECT id, role, content, meta, created_at
            FROM messages
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (sid,),
        ).fetchall()
    out = []
    for r in rows:
        item = dict(r)
        if item["meta"]:
            try:
                item["meta"] = json.loads(item["meta"])
            except json.JSONDecodeError:
                item["meta"] = None
        out.append(item)
    return out


def append_message(sid: str, role: str, content: str, meta: dict[str, Any] | None = None) -> dict:
    if not get_session(sid):
        raise KeyError(f"session not found: {sid}")
    now = _now()
    meta_json = json.dumps(meta) if meta else None
    conn = _connect()
    with _lock:
        cur = conn.execute(
            "INSERT INTO messages (session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)",
            (sid, role, content, meta_json, now),
        )
        mid = cur.lastrowid
        # Touch session.updated_at so it bubbles to the top of the sidebar.
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, sid))
        # Auto-title from the first user message if still on default.
        if role == "user":
            row = conn.execute("SELECT title FROM sessions WHERE id = ?", (sid,)).fetchone()
            if row and row["title"] == DEFAULT_TITLE and content.strip():
                new_title = content.strip().splitlines()[0][:TITLE_MAX_LEN]
                conn.execute("UPDATE sessions SET title = ? WHERE id = ?", (new_title, sid))
    return {"id": mid, "session_id": sid, "role": role, "content": content, "meta": meta, "created_at": now}


# ---------- MCP server persistence ----------

def save_mcp_server(sid: str, name: str, url: str, headers: dict | None, enabled: bool) -> None:
    conn = _connect()
    with _lock:
        conn.execute(
            """INSERT OR REPLACE INTO mcp_servers (id, name, url, headers, enabled, added_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (sid, name, url, json.dumps(headers or {}), 1 if enabled else 0, _now()),
        )


def load_mcp_servers() -> list[dict]:
    conn = _connect()
    with _lock:
        rows = conn.execute(
            "SELECT id, name, url, headers, enabled, added_at FROM mcp_servers ORDER BY added_at ASC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["headers"] = json.loads(d["headers"]) if d["headers"] else {}
        except json.JSONDecodeError:
            d["headers"] = {}
        d["enabled"] = bool(d["enabled"])
        out.append(d)
    return out


def update_mcp_server(sid: str, *, enabled: bool | None = None) -> None:
    conn = _connect()
    with _lock:
        if enabled is not None:
            conn.execute("UPDATE mcp_servers SET enabled = ? WHERE id = ?", (1 if enabled else 0, sid))


def delete_mcp_server(sid: str) -> bool:
    conn = _connect()
    with _lock:
        cur = conn.execute("DELETE FROM mcp_servers WHERE id = ?", (sid,))
    return cur.rowcount > 0
