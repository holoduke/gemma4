"""MLX-VLM backend for Gemma 4 (text + vision).

Mirrors the surface of OllamaClient used by main.py so the chat/scan endpoints
can dispatch to either backend transparently. Model names with the `mlx:`
prefix are routed here.
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import re
import time
from typing import Any, AsyncIterator

log = logging.getLogger("gemma4.mlx")

# Catalogue of MLX-community Gemma 4 models; label drives the dropdown.
MLX_MODELS: dict[str, dict] = {
    "mlx:gemma-4-e2b-it-4bit": {
        "repo": "mlx-community/gemma-4-e2b-it-4bit",
        "label": "MLX · Gemma 4 E2B-IT 4bit",
        "parameter_size": "5.1B",
        "quantization": "q4",
        "size_gb": 3.6,
    },
    "mlx:gemma-4-e4b-it-4bit": {
        "repo": "mlx-community/gemma-4-e4b-it-4bit",
        "label": "MLX · Gemma 4 E4B-IT 4bit",
        "parameter_size": "8.0B",
        "quantization": "q4",
        "size_gb": 5.8,
    },
    "mlx:gemma-4-e2b-it-8bit": {
        "repo": "mlx-community/gemma-4-e2b-it-8bit",
        "label": "MLX · Gemma 4 E2B-IT 8bit",
        "parameter_size": "5.1B",
        "quantization": "q8",
        "size_gb": 6.1,
    },
    "mlx:gemma-4-e4b-it-8bit": {
        "repo": "mlx-community/gemma-4-E4B-it-8bit",
        "label": "MLX · Gemma 4 E4B-IT 8bit",
        "parameter_size": "8.0B",
        "quantization": "q8",
        "size_gb": 8.4,
    },
    "mlx:gemma-4-e4b-it-ud-4bit": {
        "repo": "unsloth/gemma-4-E4B-it-UD-MLX-4bit",
        "label": "MLX · Gemma 4 E4B-IT UD 4bit (Unsloth)",
        "parameter_size": "8.0B",
        "quantization": "q4-ud",
        "size_gb": 6.2,
    },
    "mlx:gemma-4-26b-a4b-it-4bit": {
        "repo": "mlx-community/gemma-4-26b-a4b-it-4bit",
        "label": "MLX · Gemma 4 26B-A4B-IT 4bit (MoE)",
        "parameter_size": "26B MoE (~3.8B active)",
        "quantization": "q4",
        "size_gb": 15.0,
    },
    "mlx:gemma-4-26b-a4b-it-ud-4bit": {
        "repo": "unsloth/gemma-4-26b-a4b-it-UD-MLX-4bit",
        "label": "MLX · Gemma 4 26B-A4B-IT UD 4bit (Unsloth MoE)",
        "parameter_size": "26B MoE (~3.8B active)",
        "quantization": "q4-ud",
        "size_gb": 15.0,
    },
}


_loaded: dict[str, tuple[Any, Any, Any]] = {}
_load_lock = asyncio.Lock()
# mlx_vlm generate/stream_generate is NOT reentrant — concurrent calls cause
# segfaults or OOMs on shared Metal buffers. Serialise all inference.
_infer_lock = asyncio.Lock()


def is_mlx_name(name: str) -> bool:
    return name.startswith("mlx:")


def _resolve_repo(name: str) -> str:
    preset = MLX_MODELS.get(name)
    if preset:
        return preset["repo"]
    # fall back to stripping prefix
    return name.removeprefix("mlx:")


async def _ensure_loaded(name: str):
    async with _load_lock:
        if name in _loaded:
            return _loaded[name]

        def _load():
            from mlx_vlm import load
            from mlx_vlm.utils import load_config

            repo = _resolve_repo(name)
            log.info(f"loading MLX model {repo}...")
            t0 = time.perf_counter()
            model, processor = load(repo)
            config = load_config(repo)
            log.info(f"MLX model ready in {time.perf_counter() - t0:.1f}s")
            return model, processor, config

        triple = await asyncio.to_thread(_load)
        _loaded[name] = triple
        return triple


def _extract_images(messages: list[dict]) -> list[str]:
    """Return a list of temp file paths for any base64 images in the messages.
    mlx_vlm expects image paths or PIL images, not base64 strings."""
    import tempfile

    paths: list[str] = []
    for m in messages:
        imgs = m.get("images") or []
        for b64 in imgs:
            data = base64.b64decode(b64)
            f = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
            f.write(data)
            f.close()
            paths.append(f.name)
    return paths


_CHANNEL_PATTERN = re.compile(r"<\|channel\|>thought.*?<\|/channel\|>", re.DOTALL)


def _strip_thought(text: str) -> str:
    """Gemma 4 wraps internal reasoning in channel tokens; drop them unless
    the caller opted into think mode (we currently always strip)."""
    return _CHANNEL_PATTERN.sub("", text).strip()


def _messages_for_template(messages: list[dict]) -> list[dict]:
    """mlx_vlm's apply_chat_template wants `content` as a plain string —
    strip our images/tool_calls extras."""
    out = []
    for m in messages:
        out.append({"role": m.get("role", "user"), "content": m.get("content", "")})
    return out


async def chat(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int | None,
    think: bool = False,
    format: Any = None,
    tools: list[dict] | None = None,
) -> dict:
    """Non-streaming single-shot completion, shaped like Ollama's /api/chat."""
    model_obj, processor, config = await _ensure_loaded(model)
    image_paths = _extract_images(messages)
    simple_msgs = _messages_for_template(messages)

    def _run() -> dict:
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template

        prompt = apply_chat_template(
            processor, config, simple_msgs, num_images=len(image_paths)
        )
        t_eval = time.perf_counter()
        result = generate(
            model_obj,
            processor,
            prompt,
            image=image_paths if image_paths else None,
            max_tokens=max_tokens or 500,
            temperature=temperature,
            verbose=False,
        )
        elapsed = time.perf_counter() - t_eval
        text = getattr(result, "text", None) or str(result)
        if not think:
            text = _strip_thought(text)
        eval_count = getattr(result, "generation_tokens", None) or 0
        prompt_tokens = getattr(result, "prompt_tokens", None) or 0
        return {
            "model": model,
            "message": {"role": "assistant", "content": text},
            "done": True,
            "total_duration": int(elapsed * 1e9),
            "load_duration": 0,
            "prompt_eval_count": prompt_tokens,
            "prompt_eval_duration": 0,
            "eval_count": eval_count,
            "eval_duration": int(elapsed * 1e9),
        }

    try:
        async with _infer_lock:
            out = await asyncio.to_thread(_run)
    finally:
        for p in image_paths:
            try:
                import os
                os.unlink(p)
            except Exception:
                pass
    return out


async def chat_stream(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int | None,
    think: bool = False,
    tools: list[dict] | None = None,
) -> AsyncIterator[str]:
    """Streaming generator yielding NDJSON lines matching Ollama's /api/chat."""
    import json

    model_obj, processor, config = await _ensure_loaded(model)
    image_paths = _extract_images(messages)
    simple_msgs = _messages_for_template(messages)

    queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _produce():
        try:
            from mlx_vlm import stream_generate
            from mlx_vlm.prompt_utils import apply_chat_template

            prompt = apply_chat_template(
                processor, config, simple_msgs, num_images=len(image_paths)
            )
            t0 = time.perf_counter()
            total_tokens = 0
            buf = ""
            in_thought = False
            for chunk in stream_generate(
                model_obj,
                processor,
                prompt,
                image=image_paths if image_paths else None,
                max_tokens=max_tokens or 500,
                temperature=temperature,
            ):
                text = getattr(chunk, "text", None) or ""
                total_tokens += 1
                if not text:
                    continue
                # Rough channel-token filter (same motivation as _strip_thought
                # but for streaming output; keeps reasoning out of the UI by
                # default — matches Ollama's behaviour with think=False).
                buf += text
                if not think and "<|channel|>thought" in buf and not in_thought:
                    in_thought = True
                    buf = ""
                    continue
                if in_thought:
                    if "<|/channel|>" in buf:
                        in_thought = False
                        buf = buf.split("<|/channel|>", 1)[1]
                    else:
                        continue
                evt = {
                    "model": model,
                    "message": {"role": "assistant", "content": buf},
                    "done": False,
                }
                asyncio.run_coroutine_threadsafe(queue.put(json.dumps(evt)), loop)
                buf = ""
            elapsed = time.perf_counter() - t0
            final = {
                "model": model,
                "message": {"role": "assistant", "content": ""},
                "done": True,
                "done_reason": "stop",
                "total_duration": int(elapsed * 1e9),
                "load_duration": 0,
                "prompt_eval_count": 0,
                "prompt_eval_duration": 0,
                "eval_count": total_tokens,
                "eval_duration": int(elapsed * 1e9),
            }
            asyncio.run_coroutine_threadsafe(queue.put(json.dumps(final)), loop)
        except Exception as err:
            log.error(f"mlx stream error: {err}")
            asyncio.run_coroutine_threadsafe(
                queue.put(json.dumps({"error": str(err)})), loop
            )
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    await _infer_lock.acquire()
    try:
        asyncio.get_running_loop().run_in_executor(None, _produce)
        while True:
            item = await queue.get()
            if item is None:
                break
            yield item
    finally:
        _infer_lock.release()
        for p in image_paths:
            try:
                import os
                os.unlink(p)
            except Exception:
                pass


async def generate(
    model: str,
    prompt: str,
    temperature: float,
    max_tokens: int | None,
) -> dict:
    """Single-turn text generation (used for warmup in main.py lifespan)."""
    messages = [{"role": "user", "content": prompt}]
    out = await chat(model, messages, temperature, max_tokens, think=False)
    return {
        "model": model,
        "response": out["message"]["content"],
    }


async def list_models() -> dict:
    """Catalogue visible to /models endpoint."""
    return {
        "models": [
            {
                "name": k,
                "details": {
                    "parameter_size": v["parameter_size"],
                    "quantization_level": v["quantization"],
                    "family": "gemma4-mlx",
                },
                "size": int(v["size_gb"] * 1024**3),
            }
            for k, v in MLX_MODELS.items()
        ]
    }
