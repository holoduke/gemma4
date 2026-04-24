"""Centralised memory-reclaim for the whole app.

Three places used to reach into each other to free unified memory before
a heavy load (txt2img → mlx_client, main → ollama_client, main → txt2img).
This module owns all of it so callers have one obvious function to call.

Everything is best-effort: a failing subsystem logs but never raises to
the caller. Keeps the txt2img SSE endpoint simple and robust.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess

log = logging.getLogger("chatlm.memory")


def vm_available_gb() -> float:
    """Free + inactive + speculative pages from vm_stat — a usable proxy
    for 'how much can I allocate before macOS starts swapping hard'."""
    try:
        out = subprocess.check_output(["vm_stat"], text=True, timeout=2)
    except Exception:
        return 0.0
    page_size = 16384
    free = inactive = spec = 0
    for line in out.splitlines():
        if "page size of" in line:
            try:
                page_size = int(line.split("page size of")[1].split()[0])
            except Exception:
                pass
        elif "Pages free:" in line:
            free = int(line.split(":")[1].strip().rstrip("."))
        elif "Pages inactive:" in line:
            inactive = int(line.split(":")[1].strip().rstrip("."))
        elif "Pages speculative:" in line:
            spec = int(line.split(":")[1].strip().rstrip("."))
    return (free + inactive + spec) * page_size / 1e9


def flush_mlx() -> int:
    """Drop every MLX model resident in our process. Returns count freed."""
    try:
        import mlx_client
        return mlx_client.unload_all()
    except Exception as err:
        log.debug(f"mlx flush skipped: {err}")
        return 0


def flush_txt2img(reason: str = "memory reclaim") -> bool:
    """Evict the active diffusion pipeline. Returns True iff something was evicted."""
    try:
        import txt2img
        return txt2img.evict_if_loaded(reason=reason)
    except Exception as err:
        log.debug(f"txt2img flush skipped: {err}")
        return False


async def flush_ollama() -> int:
    """Drop every model resident in the Ollama daemon. Returns count freed."""
    try:
        from ollama_client import client
        return await client.unload_all()
    except Exception as err:
        log.debug(f"ollama flush skipped: {err}")
        return 0


async def prepare_for_diffusion() -> None:
    """Run before loading a heavy diffusion pipeline. Drops Ollama from
    the daemon and briefly waits for the kernel to reclaim wired GPU
    pages — the /api/generate keep_alive=0 call returns BEFORE macOS
    actually frees them, and the txt2img memory guardrail would otherwise
    trip on pages that are 'about to' be free."""
    n = await flush_ollama()
    if n:
        log.info(f"pre-load flush: dropped {n} Ollama model(s); waiting for kernel reclaim")
        await asyncio.sleep(0.8)


async def flush_all(reason: str = "manual") -> dict:
    """Evict everything we know how to evict. Returns a counts-dict for logging."""
    mlx_n = flush_mlx()
    t2i = flush_txt2img(reason=f"flush_all({reason})")
    ollama_n = await flush_ollama()
    log.info(f"flush_all[{reason}]: mlx={mlx_n} txt2img={'evicted' if t2i else 'idle'} ollama={ollama_n}")
    return {"mlx_unloaded": mlx_n, "txt2img_evicted": t2i, "ollama_unloaded": ollama_n}
