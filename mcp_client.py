"""Model Context Protocol (MCP) client registry.

Lets the user add remote MCP servers (typically HTTPS endpoints speaking
the Streamable-HTTP transport), probe their tool list, and forward
`tools/call` invocations. Tools surface to the LLM alongside our builtin
run_shell / generate_image, under a mangled name `mcp_<slug>_<toolname>`
so they can't collide.

Design
------
- Tool schemas are FETCHED on add/reconnect and cached in-memory. No live
  connection is held between calls — each tool invocation opens a fresh
  Streamable-HTTP session, calls the tool, closes. That's exactly how
  `mcp` SDK's `streamablehttp_client()` context manager is designed.
- Persistence (which servers are configured, their enabled flag) lives
  in the sessions SQLite DB under a new `mcp_servers` table.
- Thread safety: `_registry` is mutated only from the FastAPI event loop
  (add/remove/call). No cross-thread access.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("chatlm.mcp")

# Short hard timeout for probing. A misconfigured URL should fail fast so
# the UI stays snappy; a real tool call can set its own timeout.
PROBE_TIMEOUT_S = 10.0
CALL_TIMEOUT_S = 60.0

# Tool names get prefixed with `mcp_<slug>_` before being handed to the LLM.
# Keeping the prefix alphanumeric + underscore keeps Ollama/OpenAI happy.
TOOL_PREFIX = "mcp_"


@dataclass
class McpTool:
    """One tool exposed by a remote MCP server. Fields mirror the MCP
    tools/list response, plus `mangled_name` used on the wire to the LLM."""
    name: str
    description: str
    input_schema: dict[str, Any]
    mangled_name: str  # e.g. mcp_sunnycars_search_offers


@dataclass
class McpServer:
    id: str
    name: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    tools: list[McpTool] = field(default_factory=list)
    last_error: str | None = None


# id -> McpServer
_registry: dict[str, McpServer] = {}


def _slug(s: str) -> str:
    """Make an MCP server name safe to embed in a tool name."""
    cleaned = re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")
    return cleaned or "server"


def mangle(server_name: str, tool_name: str) -> str:
    return f"{TOOL_PREFIX}{_slug(server_name)}_{tool_name}"


def parse_mangled(mangled: str) -> tuple[str, str] | None:
    """Reverse mangle -> (server_slug, tool_name). Returns None if the
    name doesn't look like one of ours. We search server registry by
    slug because slug isn't guaranteed unique — reject if ambiguous."""
    if not mangled.startswith(TOOL_PREFIX):
        return None
    rest = mangled[len(TOOL_PREFIX):]
    # Find the longest registered slug that prefixes `rest` so a tool
    # called `rest_of_name` doesn't get split on an arbitrary underscore.
    best: tuple[str, str] | None = None
    for srv in _registry.values():
        slug = _slug(srv.name)
        if rest == slug or rest.startswith(slug + "_"):
            tool = rest[len(slug) + 1:] if rest != slug else ""
            if best is None or len(slug) > len(_slug(best[0])):
                best = (srv.name, tool)
    return best


# ---------- protocol wrappers ----------

async def _probe_tools(url: str, headers: dict[str, str]) -> list[McpTool]:
    """Open a short Streamable-HTTP session, list tools, close. Caller
    gets back a list of McpTool (without mangled names — we add those
    when we know the final server name)."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async def _run() -> list[McpTool]:
        async with streamablehttp_client(url, headers=headers) as (read, write, _get_sid):
            async with ClientSession(read, write) as session:
                await session.initialize()
                resp = await session.list_tools()
                return [
                    McpTool(
                        name=t.name,
                        description=t.description or "",
                        input_schema=dict(t.inputSchema or {"type": "object", "properties": {}}),
                        mangled_name="",  # caller fills in
                    )
                    for t in resp.tools
                ]

    return await asyncio.wait_for(_run(), timeout=PROBE_TIMEOUT_S)


async def _call_tool(url: str, headers: dict[str, str], tool_name: str, arguments: dict) -> dict:
    """Open a short session, invoke one tool, close. Returns a dict
    with {text: str, is_error: bool, structured: any|None}."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client

    async def _run() -> dict:
        async with streamablehttp_client(url, headers=headers) as (read, write, _get_sid):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                # content is list[Annotated[TextContent|ImageContent|...]]
                parts: list[str] = []
                for c in (result.content or []):
                    txt = getattr(c, "text", None)
                    if txt:
                        parts.append(txt)
                structured = getattr(result, "structuredContent", None) or getattr(result, "structured_content", None)
                return {
                    "text": "\n".join(parts),
                    "is_error": bool(getattr(result, "isError", False)),
                    "structured": structured,
                }

    return await asyncio.wait_for(_run(), timeout=CALL_TIMEOUT_S)


# ---------- public API ----------

async def add_server(name: str, url: str, headers: dict[str, str] | None = None) -> McpServer:
    """Register a new MCP server, probe it, cache its tool list."""
    headers = headers or {}
    srv = McpServer(
        id=uuid.uuid4().hex[:12],
        name=name.strip() or "server",
        url=url,
        headers=headers,
    )
    try:
        tools = await _probe_tools(url, headers)
    except Exception as err:
        srv.last_error = str(err)
        log.warning(f"MCP probe failed for {url}: {err}")
        raise
    for t in tools:
        t.mangled_name = mangle(srv.name, t.name)
    srv.tools = tools
    _registry[srv.id] = srv
    log.info(f"MCP server {srv.name!r} added ({srv.id}, {len(tools)} tools)")
    return srv


async def reconnect(sid: str) -> McpServer:
    """Re-probe an existing server (e.g. it went away and came back)."""
    srv = _registry.get(sid)
    if not srv:
        raise KeyError(sid)
    try:
        tools = await _probe_tools(srv.url, srv.headers)
    except Exception as err:
        srv.last_error = str(err)
        raise
    for t in tools:
        t.mangled_name = mangle(srv.name, t.name)
    srv.tools = tools
    srv.last_error = None
    return srv


def remove_server(sid: str) -> bool:
    return _registry.pop(sid, None) is not None


def list_servers() -> list[dict]:
    out = []
    for srv in _registry.values():
        out.append({
            "id": srv.id,
            "name": srv.name,
            "url": srv.url,
            "enabled": srv.enabled,
            "last_error": srv.last_error,
            "tools": [
                {"name": t.name, "mangled_name": t.mangled_name, "description": t.description}
                for t in srv.tools
            ],
        })
    return out


def set_enabled(sid: str, enabled: bool) -> bool:
    srv = _registry.get(sid)
    if not srv:
        return False
    srv.enabled = enabled
    return True


def get_enabled_tools_openai_shape() -> list[dict]:
    """Return every enabled MCP tool formatted as an OpenAI-style function
    tool, ready to append to the chat request's `tools` array. Names are
    already mangled, so the LLM will emit them verbatim and we can route
    back to the right server without ambiguity."""
    out = []
    for srv in _registry.values():
        if not srv.enabled:
            continue
        for t in srv.tools:
            # MCP input_schema is already JSON Schema; truncate description
            # so we don't blow out the system prompt budget.
            desc = t.description or f"MCP tool {t.name} from {srv.name}"
            if len(desc) > 800:
                desc = desc[:800] + "…"
            out.append({
                "type": "function",
                "function": {
                    "name": t.mangled_name,
                    "description": desc,
                    "parameters": t.input_schema or {"type": "object", "properties": {}},
                },
            })
    return out


async def dispatch_mangled(mangled_name: str, arguments: dict) -> dict:
    """Called from /mcp/call: find the MCP server that owns this mangled
    tool, forward the invocation. Raises if not found."""
    parsed = parse_mangled(mangled_name)
    if not parsed:
        raise ValueError(f"not an MCP tool name: {mangled_name!r}")
    server_name, tool_name = parsed
    # Locate by name (parse_mangled already resolved the longest-slug match
    # but returned the server_name, not the id).
    srv = next((s for s in _registry.values() if s.name == server_name), None)
    if srv is None:
        raise ValueError(f"MCP server {server_name!r} not found")
    if not srv.enabled:
        raise ValueError(f"MCP server {server_name!r} is disabled")
    t0 = time.perf_counter()
    result = await _call_tool(srv.url, srv.headers, tool_name, arguments)
    result["latency_ms"] = int((time.perf_counter() - t0) * 1000)
    result["server"] = srv.name
    result["tool"] = tool_name
    return result
