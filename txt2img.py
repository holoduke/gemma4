"""High-quality text-to-image for chat.

Runs Stable Diffusion XL, FLUX.1-schnell, and SD 3.5 Medium via diffusers
on Apple Silicon (MPS). Slower than the video-loop inpaint/img2img path,
but far higher quality — appropriate for one-off chat generations.
"""
from __future__ import annotations

import base64
import gc
import io
import logging
import os
import threading
import time
from typing import Any

from PIL import Image

log = logging.getLogger("chatlm.txt2img")

# Single-resident cache: keep only one pipeline in unified memory at a time.
# Loading multiple SDXL/FLUX/SD3.5 pipes simultaneously on a 36 GB M3 Pro
# triggered a kernel panic (compressor segments hit 100 %, 41 swapfiles,
# watchdogd timeout) on 2026-04-20.
# Two locks so we can serialise pipeline swaps (a multi-GB load) without
# blocking an already-resident pipe's `pipe(...)` inference from starting
# step callbacks. `_load_lock` guards mutations to `_active_pipe`; the
# returned pipe is used under `_inference_lock` by generate_image().
_active_pipe: tuple[str, Any] | None = None
_current_preset: str = "sdxl-base"
_load_lock = threading.Lock()
_inference_lock = threading.Lock()

TOTAL_RAM_GB = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1e9


# `weight_gb` is the approximate resident-memory footprint of the loaded
# pipeline in its working dtype. Used to refuse loads when free unified
# memory is too low (kernel panic guardrail).
TXT2IMG_PRESETS: dict[str, dict] = {
    "sdxl-base": {
        "label": "SDXL base 1.0 · 25 steps · ~20s",
        "model_id": "stabilityai/stable-diffusion-xl-base-1.0",
        "pipeline": "sdxl",
        "steps": 25,
        "guidance": 7.0,
        "width": 1024,
        "height": 1024,
        "weight_gb": 14.0,  # fp32 on MPS (fp16 produces NaN black output)
    },
    "sdxl-turbo": {
        "label": "SDXL Turbo · 4 steps · ~4s",
        "model_id": "stabilityai/sdxl-turbo",
        "pipeline": "sdxl",
        "steps": 4,
        "guidance": 0.0,
        "width": 512,
        "height": 512,
        "weight_gb": 8.0,  # measured peak ~7.5 GB at 512x512 fp32 on M3 Pro
    },
    "flux-schnell": {
        "label": "FLUX.1-schnell · 4 steps · ~20s (gated, accept license on HF)",
        "model_id": "black-forest-labs/FLUX.1-schnell",
        "pipeline": "flux",
        "steps": 4,
        "guidance": 0.0,
        "width": 1024,
        "height": 1024,
        "weight_gb": 24.0,  # fp16
    },
    "sd35-medium": {
        "label": "SD 3.5 Medium · 28 steps · ~20s (gated, accept license on HF)",
        "model_id": "stabilityai/stable-diffusion-3.5-medium",
        "pipeline": "sd3",
        "steps": 28,
        "guidance": 4.5,
        "width": 1024,
        "height": 1024,
        "weight_gb": 12.0,  # fp16
    },
}

# Reserve memory for the OS, Chrome, FastAPI, etc. on top of model weights.
# Was 6 GB initially — tuned down to 4 after measuring real footprints.
# Each preset's weight_gb is the *peak* resident memory we measured, so
# headroom only needs to cover the rest of the system, not generation spikes.
SAFETY_HEADROOM_GB = 4.0


def _available_gb() -> float:
    """Wrapper around memory.vm_available_gb with TOTAL_RAM_GB as a safe
    fallback — if vm_stat glitches, fail open rather than panic-refuse."""
    import memory
    avail = memory.vm_available_gb()
    return avail if avail > 0 else TOTAL_RAM_GB


def evict_if_loaded(reason: str = "switch") -> bool:
    """Public API: drop the resident pipeline (if any) and force a Metal
    cache flush. Returns True iff a pipeline was actually evicted. Safe
    to call when nothing is loaded."""
    global _active_pipe
    if _active_pipe is None:
        return False
    name, _ = _active_pipe
    log.info(f"evicting txt2img pipeline {name} ({reason})")
    _active_pipe = None
    gc.collect()
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass
    return True


# Internal alias preserved for `_ensure_pipeline` which still calls
# the private name; keeps the diff small inside this file.
_evict_active = evict_if_loaded


def _flush_other_models() -> None:
    """Drop in-process MLX models. Ollama must be flushed from the async
    endpoint (memory.prepare_for_diffusion) because httpx's AsyncClient
    is bound to the event loop and can't be safely driven from this
    worker thread."""
    import memory
    memory.flush_mlx()


def _device_and_dtype(kind: str = "sdxl"):
    import torch
    if torch.backends.mps.is_available():
        # SDXL (and SDXL turbo) produce NaN black output on MPS fp16 even with
        # the fp16-fix VAE, so keep SDXL in fp32 on Apple Silicon. FLUX and
        # SD 3.5 need fp16 to fit in memory and are numerically stable.
        if kind == "sdxl":
            return "mps", torch.float32
        return "mps", torch.float16
    if torch.cuda.is_available():
        return "cuda", torch.float16
    return "cpu", torch.float32


def _build_pipeline(preset_key: str):
    preset = TXT2IMG_PRESETS[preset_key]
    kind = preset["pipeline"]
    device, dtype = _device_and_dtype(kind)
    model_id = preset["model_id"]

    log.info(f"loading txt2img preset={preset_key} model={model_id} device={device}")
    t0 = time.perf_counter()

    if kind == "sdxl":
        from diffusers import StableDiffusionXLPipeline
        pipe = StableDiffusionXLPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            use_safetensors=True,
        )
    elif kind == "flux":
        from diffusers import FluxPipeline
        pipe = FluxPipeline.from_pretrained(model_id, torch_dtype=dtype)
    elif kind == "sd3":
        from diffusers import StableDiffusion3Pipeline
        pipe = StableDiffusion3Pipeline.from_pretrained(model_id, torch_dtype=dtype)
    else:
        raise ValueError(f"unknown pipeline kind: {kind}")

    pipe = pipe.to(device)
    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass
    log.info(f"txt2img preset={preset_key} ready in {time.perf_counter() - t0:.1f}s")
    return pipe


def _ensure_pipeline(preset_key: str):
    global _active_pipe
    with _load_lock:
        if preset_key not in TXT2IMG_PRESETS:
            raise ValueError(f"unknown txt2img preset: {preset_key}")
        preset = TXT2IMG_PRESETS[preset_key]

        if _active_pipe and _active_pipe[0] == preset_key:
            return _active_pipe[1], preset

        # Evict prior pipe before loading a new one — txt2img pipes are
        # 12-24 GB each; keeping two resident will panic the kernel.
        _evict_active(reason=f"switching to {preset_key}")
        _flush_other_models()

        need = preset["weight_gb"] + SAFETY_HEADROOM_GB
        avail = _available_gb()
        if avail < need:
            raise RuntimeError(
                f"not enough free memory for {preset_key}: "
                f"need ~{need:.0f} GB (weights {preset['weight_gb']:.0f} + "
                f"headroom {SAFETY_HEADROOM_GB:.0f}), available {avail:.1f} GB. "
                f"Close other apps or pick a smaller preset."
            )

        pipe = _build_pipeline(preset_key)
        _active_pipe = (preset_key, pipe)
        return pipe, preset


def list_presets() -> list[dict]:
    active = _active_pipe[0] if _active_pipe else None
    return [
        {
            "name": k,
            "label": v["label"],
            "loaded": k == active,
            "weight_gb": v["weight_gb"],
            "fits": v["weight_gb"] + SAFETY_HEADROOM_GB <= TOTAL_RAM_GB,
        }
        for k, v in TXT2IMG_PRESETS.items()
    ]


def get_current() -> str:
    return _current_preset


def set_current(preset_key: str) -> None:
    global _current_preset
    if preset_key not in TXT2IMG_PRESETS:
        raise ValueError(f"unknown txt2img preset: {preset_key}")
    _current_preset = preset_key


def generate_image(
    prompt: str,
    negative_prompt: str | None = None,
    preset_key: str | None = None,
    steps: int | None = None,
    guidance: float | None = None,
    width: int | None = None,
    height: int | None = None,
    seed: int | None = None,
    out_path: str | None = None,
    step_callback=None,
) -> dict:
    """`step_callback(step:int, total:int)` is invoked after each diffusion
    step. Use it to drive a server-sent-events progress stream. Runs in the
    same thread that owns the pipeline, so keep it cheap (no VAE decode)."""
    key = preset_key or _current_preset
    pipe, preset = _ensure_pipeline(key)

    total_steps = steps or preset["steps"]
    kwargs: dict = {
        "prompt": prompt,
        "num_inference_steps": total_steps,
        "guidance_scale": guidance if guidance is not None else preset["guidance"],
        "width": width or preset["width"],
        "height": height or preset["height"],
    }
    # negative_prompt is unsupported by FLUX.
    if preset["pipeline"] != "flux" and negative_prompt:
        kwargs["negative_prompt"] = negative_prompt
    if seed is not None:
        import torch
        device, _ = _device_and_dtype(preset["pipeline"])
        kwargs["generator"] = torch.Generator(device=device).manual_seed(int(seed))

    if step_callback is not None:
        def _on_step_end(_pipe, step_index, _ts, callback_kwargs):
            try:
                step_callback(step_index + 1, total_steps)
            except Exception as err:
                log.debug(f"step_callback raised: {err}")
            return callback_kwargs
        kwargs["callback_on_step_end"] = _on_step_end

    log.info(f"/txt2img preset={key} prompt={prompt[:80]!r} steps={total_steps} size={kwargs['width']}x{kwargs['height']}")
    t0 = time.perf_counter()
    with _inference_lock:
        result = pipe(**kwargs)
    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    img = result.images[0]
    out: dict = {
        "width": img.width,
        "height": img.height,
        "preset": key,
        "steps": kwargs["num_inference_steps"],
        "latency_ms": elapsed_ms,
    }
    if out_path:
        from pathlib import Path
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path, format="PNG")
        out["path"] = out_path
    else:
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        out["image"] = base64.b64encode(buf.getvalue()).decode("ascii")
    log.info(f"/txt2img preset={key} done in {elapsed_ms}ms -> {out_path or 'inline-b64'}")
    return out
