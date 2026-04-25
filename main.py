import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import detect as detect_module
import logging_setup
import mcp_client
import memory
import mlx_client
import stats as sysstats
from config import settings
from ollama_client import OllamaError, client


def _dispatch(model_name: str):
    """Pick the right chat backend based on model name prefix."""
    return mlx_client if mlx_client.is_mlx_name(model_name) else client
from schemas import (
    ChatRequest,
    ChatResponse,
    DepthRequest,
    DepthResponse,
    DetectRequest,
    DetectResponse,
    FaceMeshResponse,
    FaceRequest,
    GenerateRequest,
    GenerateResponse,
    ImageOnlyRequest,
    Img2ImgRequest,
    Img2ImgResponse,
    InpaintRequest,
    InpaintResponse,
    Message,
    OcrResponse,
    PeopleSegResponse,
    PoseRequest,
    PoseResponse,
    AnimeRequest,
    AnimeResponse,
    BgSubRequest,
    BgSubResponse,
    SegmentAllRequest,
    SegmentAllResponse,
    RmbgRequest,
    RmbgResponse,
    ScanRequest,
    ScanResponse,
    SetModelRequest,
    CloneVoiceRequest,
    SpeakRequest,
    SpeakResponse,
    ToolExecRequest,
    ToolExecResponse,
    Txt2ImgRequest,
    Txt2ImgResponse,
    AppendMessageRequest,
    CreateSessionRequest,
    RenameSessionRequest,
    UpdateMessageRequest,
    AddMcpServerRequest,
    UpdateMcpServerRequest,
    McpCallRequest,
    TranscribeRequest,
    TranscribeResponse,
    TranslateRequest,
    TranslateResponse,
)

logging_setup.configure()
log = logging.getLogger("chatlm")

from dataclasses import dataclass, fields as _dc_fields


@dataclass
class AppState:
    """Runtime model-selection state. Each field is the currently-active
    model/preset for a given subsystem; swapped by /models/<field>."""
    emma: str
    scan: str
    detector: str = "yolov8s-world.pt"
    segmenter: str = "mobile_sam.pt"
    inpaint: str = "sd15-lcm-fast"
    txt2img: str = "sdxl-base"

    def values_for_eviction(self) -> tuple[str, ...]:
        """Every currently-referenced model name — used by the MLX orphan
        check to decide whether it's safe to unload the prior selection."""
        return tuple(getattr(self, f.name) for f in _dc_fields(self))


_STATE = AppState(emma=settings.model_name, scan=settings.model_name)

MAX_LOCAL_MODEL_GB = 20.0  # fits gemma4:26b-a4b Q4 (~15 GB); Q8 (>27 GB) still hidden


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info(f"startup · emma={_STATE.emma} · scan={_STATE.scan} · detector={_STATE.detector} · segmenter={_STATE.segmenter} · ollama={settings.ollama_host}")
    t0 = time.perf_counter()
    try:
        await client.generate(
            model=_STATE.emma,
            prompt="ok",
            temperature=0.0,
            max_tokens=1,
        )
        log.info(f"warmup complete in {time.perf_counter() - t0:.2f}s")
    except Exception as err:
        log.warning(f"warmup failed: {err}")
    # Re-probe any MCP servers the user configured in previous sessions.
    # Probes run in parallel so a single slow/dead server doesn't hold
    # the app hostage; failures are logged but non-fatal.
    try:
        import sessions as _sessions_mod
        saved = _sessions_mod.load_mcp_servers()
        async def _restore(row):
            try:
                srv = await mcp_client.add_server(row["name"], row["url"], row["headers"])
                # Preserve the DB id instead of the fresh UUID so stored
                # enabled state + next /mcp/servers GET is consistent.
                mcp_client._registry.pop(srv.id, None)
                srv.id = row["id"]
                srv.enabled = row["enabled"]
                mcp_client._registry[srv.id] = srv
            except Exception as err:
                log.warning(f"MCP restore failed for {row['name']!r}: {err}")
        await asyncio.gather(*[_restore(r) for r in saved])
    except Exception as err:
        log.debug(f"MCP restore skipped: {err}")
    yield
    await client.close()


app = FastAPI(title="chatlm", version="0.1.0", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"
class _NoCacheStatic(StaticFiles):
    """Tiny subclass that slaps Cache-Control: no-store on every static
    response. Aggressive browser caching of ES modules during dev makes
    code changes invisible without Cmd+Shift+R — this keeps iteration
    tight. Safe because the whole app is localhost-only."""
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/static", _NoCacheStatic(directory=STATIC_DIR), name="static")

# Persistent on-disk storage for generated images. Layout:
#   storage/images/<session_id>/<uuid>.png   — per-session
#   storage/images/_inline/<uuid>.png        — generated outside any session
# Served at /storage so the frontend just dereferences the URL.
STORAGE_DIR = Path(__file__).parent / "storage"
(STORAGE_DIR / "images").mkdir(parents=True, exist_ok=True)
app.mount("/storage", StaticFiles(directory=STORAGE_DIR), name="storage")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/stats")
async def stats_endpoint() -> dict:
    data = await asyncio.to_thread(sysstats.collect)
    current = _STATE.emma
    model_info = None
    # Merge Ollama + MLX catalogues so MLX models also report params/quant.
    try:
        if mlx_client.is_mlx_name(current):
            mlx_list = (await mlx_client.list_models()).get("models", [])
            for m in mlx_list:
                if m.get("name") == current:
                    d = m.get("details", {})
                    model_info = {
                        "name": m["name"],
                        "parameter_size": d.get("parameter_size"),
                        "quantization": d.get("quantization_level"),
                        "size_gb": round(m.get("size", 0) / 1024**3, 2),
                        "backend": "mlx",
                    }
                    break
        else:
            models = await client.list_models()
            for m in models.get("models", []):
                if m.get("name") == current:
                    d = m.get("details", {})
                    model_info = {
                        "name": m["name"],
                        "parameter_size": d.get("parameter_size"),
                        "quantization": d.get("quantization_level"),
                        "size_gb": round(m.get("size", 0) / 1024**3, 2),
                        "backend": "ollama",
                    }
                    break
    except Exception:
        pass
    data["model"] = model_info or {"name": current, "backend": "mlx" if mlx_client.is_mlx_name(current) else "ollama"}
    from dataclasses import asdict
    data["state"] = asdict(_STATE)
    return data


@app.get("/health")
async def health() -> dict:
    try:
        models = await client.list_models()
    except OllamaError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except Exception as err:
        raise HTTPException(status_code=503, detail=f"ollama unreachable: {err}") from err
    return {"status": "ok", "default_model": _STATE.emma, "models": models.get("models", [])}


def _prompt_stats(messages: list) -> tuple[int, int]:
    total_chars = sum(len(m.get("content", "")) for m in messages)
    return len(messages), total_chars


def _merge_tools_with_mcp(user_tools: list[dict] | None) -> list[dict] | None:
    """Append every enabled MCP server's tool list (OpenAI-shaped) onto
    the frontend-provided tools array. Returns None if neither source
    contributes anything — keeps `tools=` unset for plain chat requests."""
    mcp_tools = mcp_client.get_enabled_tools_openai_shape()
    if not user_tools and not mcp_tools:
        return None
    return (user_tools or []) + mcp_tools


async def _pick_tool_fallback() -> str:
    """When the selected model is MLX and tools are requested, MLX can't
    drive tool calls — fall back to an installed Ollama model. Prefers
    the largest available (26b-a4b MoE > e4b > e2b). Override via the
    CHATLM_TOOL_FALLBACK env var."""
    import os
    override = os.environ.get("CHATLM_TOOL_FALLBACK")
    if override:
        return override
    try:
        installed = {m.get("name") for m in (await client.list_models()).get("models", [])}
    except Exception:
        installed = set()
    for candidate in ("gemma4:26b", "gemma4:e4b", "gemma4:e2b"):
        if candidate in installed:
            return candidate
    return "gemma4:e4b"


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    if request.stream:
        raise HTTPException(status_code=400, detail="Use /chat/stream for streaming")
    model = request.model or _STATE.emma
    effective_tools = _merge_tools_with_mcp(request.tools)
    if effective_tools and mlx_client.is_mlx_name(model):
        model = await _pick_tool_fallback()
    msgs = [m.model_dump(exclude_none=True) for m in request.messages]
    n_msgs, n_chars = _prompt_stats(msgs)
    backend = _dispatch(model)
    log.info(f"/chat <- model={model} msgs={n_msgs} chars={n_chars} think={request.think} tools={len(effective_tools) if effective_tools else 0} backend={'mlx' if backend is mlx_client else 'ollama'}")
    t0 = time.perf_counter()
    try:
        raw = await backend.chat(
            model=model,
            messages=msgs,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            think=request.think,
            tools=effective_tools,
        )
    except OllamaError as err:
        log.error(f"/chat !! {err}")
        raise HTTPException(status_code=502, detail=str(err)) from err
    except Exception as err:
        log.error(f"/chat !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err

    wall = time.perf_counter() - t0
    msg = raw.get("message", {})
    total_ns = raw.get("total_duration") or 0
    load_ms = (raw.get("load_duration") or 0) / 1e6
    prefill_ms = (raw.get("prompt_eval_duration") or 0) / 1e6
    eval_ms = (raw.get("eval_duration") or 0) / 1e6
    tokens = raw.get("eval_count") or 0
    tps = (tokens / (eval_ms / 1000)) if eval_ms > 0 else 0
    log.info(
        f"/chat -> {wall:.2f}s  load={load_ms:.0f}ms prefill={prefill_ms:.0f}ms "
        f"gen={eval_ms:.0f}ms  tokens={tokens}  {tps:.1f} tok/s"
    )
    return ChatResponse(
        model=raw.get("model", model),
        message=Message(
            role=msg.get("role", "assistant"),
            content=msg.get("content", ""),
            tool_calls=msg.get("tool_calls"),
        ),
        prompt_tokens=raw.get("prompt_eval_count"),
        completion_tokens=tokens,
        total_duration_ms=(total_ns // 1_000_000) if isinstance(total_ns, int) else None,
    )


@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    model = request.model or _STATE.emma
    effective_tools = _merge_tools_with_mcp(request.tools)
    # MLX has no tool-calling path, so re-route tool requests to an Ollama
    # model that does (gemma4:e2b supports tool_calls via Ollama's template).
    if effective_tools and mlx_client.is_mlx_name(model):
        model = await _pick_tool_fallback()
    msgs = [m.model_dump(exclude_none=True) for m in request.messages]
    n_msgs, n_chars = _prompt_stats(msgs)
    backend = _dispatch(model)
    log.info(f"/chat/stream <- model={model} msgs={n_msgs} chars={n_chars} think={request.think} tools={len(effective_tools) if effective_tools else 0} backend={'mlx' if backend is mlx_client else 'ollama'}")

    async def event_stream():
        t0 = time.perf_counter()
        ttft = None
        final = None
        try:
            async for chunk in backend.chat_stream(
                model=model,
                messages=msgs,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
                think=request.think,
                tools=effective_tools,
            ):
                if ttft is None:
                    ttft = time.perf_counter() - t0
                try:
                    evt = json.loads(chunk)
                    if evt.get("done"):
                        final = evt
                except json.JSONDecodeError:
                    pass
                yield chunk + "\n"
        except OllamaError as err:
            log.error(f"/chat/stream !! {err}")
            yield f'{{"error": {str(err)!r}}}\n'
            return
        except (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError) as err:
            # Upstream Ollama crashed or stalled longer than allowed. Send
            # the error as a final SSE event so the browser shows a real
            # message instead of "network error" from a torn TCP connection.
            log.error(f"/chat/stream !! upstream-stream-error {type(err).__name__}: {err}")
            yield f'{{"error": "upstream stream error: {type(err).__name__} — Ollama may have crashed or run out of memory. Try /memory/flush and resend."}}\n'
            return

        wall = time.perf_counter() - t0
        if final:
            load_ms = (final.get("load_duration") or 0) / 1e6
            prefill_ms = (final.get("prompt_eval_duration") or 0) / 1e6
            eval_ms = (final.get("eval_duration") or 0) / 1e6
            tokens = final.get("eval_count") or 0
            tps = (tokens / (eval_ms / 1000)) if eval_ms > 0 else 0
            log.info(
                f"/chat/stream -> wall={wall:.2f}s ttft={ttft:.2f}s  "
                f"load={load_ms:.0f}ms prefill={prefill_ms:.0f}ms gen={eval_ms:.0f}ms  "
                f"tokens={tokens}  {tps:.1f} tok/s"
            )
        else:
            log.info(f"/chat/stream -> wall={wall:.2f}s ttft={ttft}  (no final event)")

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
_JSON_OBJECT = re.compile(r"\{.*?\}", re.DOTALL)


def _parse_json_loose(text: str) -> dict:
    if not text:
        return {}
    for pat in (_JSON_FENCE, _JSON_OBJECT):
        m = pat.search(text)
        if m:
            candidate = m.group(1) if pat is _JSON_FENCE else m.group(0)
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                continue
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"description": text[:200], "objects": []}


_SCAN_SCHEMA = {
    "type": "object",
    "properties": {
        "objects": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["objects"],
}


_DEFAULT_SCAN_TEMPLATE = (
    "List up to {max_objects} distinct physical objects visible in this image. "
    "Use lowercase singular nouns, one or two words each, no duplicates."
)
_SCAN_JSON_SUFFIX = ' Respond with JSON: {"objects": ["noun", ...]} and nothing else.'


@app.post("/scan", response_model=ScanResponse)
async def scan_endpoint(request: ScanRequest) -> ScanResponse:
    t0 = time.perf_counter()
    user_template = (request.prompt or "").strip()
    if user_template:
        body = user_template.format(max_objects=request.max_objects) if "{max_objects}" in user_template else user_template
    else:
        body = _DEFAULT_SCAN_TEMPLATE.format(max_objects=request.max_objects)
    prompt = body + _SCAN_JSON_SUFFIX
    scan_model = _STATE.scan
    backend = _dispatch(scan_model)
    try:
        raw = await backend.chat(
            model=scan_model,
            messages=[{"role": "user", "content": prompt, "images": [request.image]}],
            temperature=0.0,
            max_tokens=150,
            think=False,
            format=_SCAN_SCHEMA,
        )
    except OllamaError as err:
        log.error(f"/scan !! {err}")
        raise HTTPException(status_code=502, detail=str(err)) from err
    except Exception as err:
        log.error(f"/scan !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err

    content = (raw.get("message", {}).get("content", "") or "").strip()
    parsed = _parse_json_loose(content)

    description = str(parsed.get("description", ""))[:300]
    raw_objs = parsed.get("objects", []) or []
    seen: set[str] = set()
    objects: list[str] = []
    for o in raw_objs:
        if not isinstance(o, str):
            continue
        key = o.strip().lower()
        if 1 <= len(key) <= 40 and key not in seen:
            seen.add(key)
            objects.append(key)
        if len(objects) >= request.max_objects:
            break

    latency_ms = int((time.perf_counter() - t0) * 1000)
    log.info(f"/scan -> {latency_ms}ms  objects={objects}")
    return ScanResponse(description=description, objects=objects, latency_ms=latency_ms)


@app.post("/detect", response_model=DetectResponse)
async def detect_endpoint(request: DetectRequest) -> DetectResponse:
    t0 = time.perf_counter()
    try:
        result = await asyncio.to_thread(
            detect_module.detect_and_segment,
            request.image,
            request.prompt,
            request.conf,
            request.masks,
            request.imgsz,
            request.track,
        )
    except Exception as err:
        log.error(f"/detect !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err

    latency_ms = int((time.perf_counter() - t0) * 1000)
    log.info(
        f"/detect prompt={request.prompt!r} hits={len(result['labels'])} "
        f"masks={request.masks} imgsz={request.imgsz} "
        f"{latency_ms}ms  timings={result.get('timings_ms')}"
    )
    return DetectResponse(**result, latency_ms=latency_ms)


@app.get("/models")
async def list_models_endpoint() -> dict:
    try:
        raw = await client.list_models()
        all_models = raw.get("models", []) or []
    except Exception as err:
        log.warning(f"/models: ollama list failed: {err}")
        all_models = []
    # Add MLX presets alongside Ollama models.
    try:
        mlx_raw = await mlx_client.list_models()
        all_models = all_models + (mlx_raw.get("models") or [])
    except Exception as err:
        log.warning(f"/models: mlx list failed: {err}")
    available = []
    for m in all_models:
        size_gb = round(m.get("size", 0) / 1024**3, 2)
        if size_gb > MAX_LOCAL_MODEL_GB:
            continue
        details = m.get("details") or {}
        available.append({
            "name": m.get("name"),
            "size_gb": size_gb,
            "parameter_size": details.get("parameter_size"),
            "quantization": details.get("quantization_level"),
            "family": details.get("family"),
        })
    available.sort(key=lambda x: (x.get("family") or "", x.get("size_gb", 0)))
    detectors = [{"name": k, "label": v["label"], "kind": v["kind"]} for k, v in detect_module.DETECTOR_PRESETS.items()]
    segmenters = [{"name": k, "label": v["label"], "kind": v["kind"]} for k, v in detect_module.SEGMENTER_PRESETS.items()]
    import inpaint as inpaint_mod
    inpaints = [{"name": k, "label": v["label"]} for k, v in inpaint_mod.INPAINT_PRESETS.items()]
    import txt2img as txt2img_mod
    txt2imgs = txt2img_mod.list_presets()
    return {
        "emma": {"current": _STATE.emma, "available": available},
        "scan": {"current": _STATE.scan, "available": available},
        "detector": {"current": _STATE.detector, "presets": detectors},
        "segmenter": {"current": _STATE.segmenter, "presets": segmenters},
        "inpaint": {"current": _STATE.inpaint, "presets": inpaints},
        "txt2img": {"current": _STATE.txt2img, "presets": txt2imgs},
    }


async def _validate_chat_model(name: str) -> None:
    """Cheap existence check — avoids warming a multi-GB model on dropdown
    change (that was blocking the UI for tens of seconds)."""
    if mlx_client.is_mlx_name(name):
        if name not in mlx_client.MLX_MODELS:
            raise HTTPException(status_code=400, detail=f"unknown MLX model '{name}'")
        return
    try:
        tags = await client.list_models()
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"ollama unreachable: {err}") from err
    names = {m.get("name") for m in tags.get("models", [])}
    if name not in names:
        raise HTTPException(status_code=400, detail=f"model '{name}' not installed on Ollama")


def _evict_orphan_mlx(old_name: str) -> None:
    """After a dropdown switch, unload the previous MLX model iff no other
    state slot still points at it. Prevents the EMMA/SCAN dropdowns from
    accumulating multi-GB resident models in unified memory."""
    if not mlx_client.is_mlx_name(old_name):
        return
    if old_name in _STATE.values_for_eviction():
        return  # still referenced (e.g. SCAN still points at it)
    mlx_client.unload_model(old_name)


@app.post("/models/emma")
async def set_emma(req: SetModelRequest) -> dict:
    await _validate_chat_model(req.name)
    old = _STATE.emma
    _STATE.emma = req.name
    if old != req.name:
        _evict_orphan_mlx(old)
    log.info(f"/models/emma -> {req.name}")
    return {"current": _STATE.emma}


@app.post("/models/scan")
async def set_scan(req: SetModelRequest) -> dict:
    await _validate_chat_model(req.name)
    old = _STATE.scan
    _STATE.scan = req.name
    if old != req.name:
        _evict_orphan_mlx(old)
    log.info(f"/models/scan -> {req.name}")
    return {"current": _STATE.scan}


@app.post("/models/detector")
async def set_detector(req: SetModelRequest) -> dict:
    try:
        await asyncio.to_thread(detect_module.set_detector, req.name)
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"detector load failed: {err}") from err
    _STATE.detector = req.name
    log.info(f"/models/detector -> {req.name}")
    return {"current": req.name}


@app.post("/models/segmenter")
async def set_segmenter(req: SetModelRequest) -> dict:
    try:
        await asyncio.to_thread(detect_module.set_segmenter, req.name)
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"segmenter load failed: {err}") from err
    _STATE.segmenter = req.name
    log.info(f"/models/segmenter -> {req.name}")
    return {"current": req.name}


@app.post("/models/inpaint")
async def set_inpaint(req: SetModelRequest) -> dict:
    import inpaint as inpaint_mod
    try:
        await asyncio.to_thread(inpaint_mod.set_preset, req.name)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"inpaint preset failed: {err}") from err
    _STATE.inpaint = req.name
    log.info(f"/models/inpaint -> {req.name}")
    return {"current": req.name}


# Back-compat alias so old frontends still work during a refresh.
@app.post("/models/yolo")
async def set_yolo_alias(req: SetModelRequest) -> dict:
    return await set_detector(req)


def _make_image_path(session_id: str | None) -> tuple[str, Path]:
    """Compose the per-session disk path for a freshly generated image."""
    import uuid as _uuid
    sid = session_id or "_inline"
    rel = f"images/{sid}/{_uuid.uuid4().hex}.png"
    return rel, STORAGE_DIR / rel


def _txt2img_kwargs(request: Txt2ImgRequest, abs_path: Path, **extra) -> dict:
    """All the per-call args shared by the blocking and streaming endpoints."""
    return dict(
        prompt=request.prompt,
        negative_prompt=request.negative_prompt,
        preset_key=request.preset,
        steps=request.steps,
        guidance=request.guidance,
        width=request.width,
        height=request.height,
        seed=request.seed,
        out_path=str(abs_path),
        **extra,
    )


@app.post("/txt2img", response_model=Txt2ImgResponse)
async def txt2img_endpoint(request: Txt2ImgRequest) -> Txt2ImgResponse:
    import txt2img as txt2img_mod
    rel_path, abs_path = _make_image_path(request.session_id)
    await memory.prepare_for_diffusion()
    try:
        res = await asyncio.to_thread(
            txt2img_mod.generate_image,
            **_txt2img_kwargs(request, abs_path),
        )
    except Exception as err:
        log.error(f"/txt2img !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    return Txt2ImgResponse(
        image_url=f"/storage/{rel_path}",
        path=str(abs_path),
        width=res["width"],
        height=res["height"],
        preset=res["preset"],
        steps=res["steps"],
        latency_ms=res["latency_ms"],
    )


@app.post("/txt2img/stream")
async def txt2img_stream(request: Txt2ImgRequest):
    """SSE/NDJSON stream emitting per-step progress and a final 'done' event
    with the disk URL. Frontend uses this to drive a real progress bar
    instead of the time-estimated one."""
    import txt2img as txt2img_mod
    rel_path, abs_path = _make_image_path(request.session_id)
    await memory.prepare_for_diffusion()

    queue: asyncio.Queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def on_step(step: int, total: int) -> None:
        # Called from the diffusion worker thread — bounce to the loop.
        loop.call_soon_threadsafe(
            queue.put_nowait, {"type": "step", "step": step, "total": total}
        )

    async def run_generation() -> None:
        try:
            res = await asyncio.to_thread(
                txt2img_mod.generate_image,
                **_txt2img_kwargs(request, abs_path, step_callback=on_step),
            )
            await queue.put({
                "type": "done",
                "image_url": f"/storage/{rel_path}",
                "path": str(abs_path),
                "width": res["width"],
                "height": res["height"],
                "preset": res["preset"],
                "steps": res["steps"],
                "latency_ms": res["latency_ms"],
            })
        except Exception as err:
            log.error(f"/txt2img/stream !! {err}")
            await queue.put({"type": "error", "detail": str(err)})
        finally:
            await queue.put(None)  # sentinel: end of stream

    async def event_gen():
        task = asyncio.create_task(run_generation())
        try:
            while True:
                evt = await queue.get()
                if evt is None:
                    break
                yield json.dumps(evt) + "\n"
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


@app.post("/memory/flush")
async def memory_flush() -> dict:
    """Force-evict every model resident in our process and the Ollama daemon.
    Useful when a heavy task (diffusion, video pipeline) is queued and unified
    memory is tight."""
    return await memory.flush_all(reason="/memory/flush")


@app.post("/models/txt2img")
async def set_txt2img(req: SetModelRequest) -> dict:
    import txt2img as txt2img_mod
    try:
        await asyncio.to_thread(txt2img_mod.set_current, req.name)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"txt2img preset failed: {err}") from err
    _STATE.txt2img = req.name
    log.info(f"/models/txt2img -> {req.name}")
    return {"current": req.name}


# ---------- chat session persistence (SQLite via sessions.py) ----------

import sessions as sessions_mod


@app.get("/sessions")
async def list_sessions_endpoint() -> dict:
    return {"sessions": sessions_mod.list_sessions()}


@app.post("/sessions")
async def create_session_endpoint(req: CreateSessionRequest) -> dict:
    return sessions_mod.create_session(req.title)


@app.get("/sessions/{sid}/messages")
async def get_session_messages(sid: str) -> dict:
    if not sessions_mod.get_session(sid):
        raise HTTPException(status_code=404, detail=f"session not found: {sid}")
    return {"session": sessions_mod.get_session(sid), "messages": sessions_mod.list_messages(sid)}


@app.post("/sessions/{sid}/messages")
async def append_session_message(sid: str, req: AppendMessageRequest) -> dict:
    try:
        return sessions_mod.append_message(sid, req.role, req.content, req.meta)
    except KeyError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err


@app.patch("/sessions/{sid}/messages/{mid}")
async def update_session_message(sid: str, mid: int, req: UpdateMessageRequest) -> dict:
    """Replace an existing row's content + meta. Used by the chat client
    to swap an in-progress placeholder for the final streamed text."""
    out = sessions_mod.update_message(sid, mid, req.content, req.meta)
    if out is None:
        raise HTTPException(status_code=404, detail=f"message {mid} not in session {sid}")
    return out


@app.patch("/sessions/{sid}")
async def rename_session_endpoint(sid: str, req: RenameSessionRequest) -> dict:
    out = sessions_mod.rename_session(sid, req.title)
    if not out:
        raise HTTPException(status_code=404, detail=f"session not found: {sid}")
    return out


@app.delete("/sessions/{sid}")
async def delete_session_endpoint(sid: str) -> dict:
    if not sessions_mod.delete_session(sid):
        raise HTTPException(status_code=404, detail=f"session not found: {sid}")
    return {"deleted": sid}


# ---------- MCP (Model Context Protocol) remote tool servers ----------


@app.get("/mcp/servers")
async def list_mcp_servers() -> dict:
    return {"servers": mcp_client.list_servers()}


@app.post("/mcp/servers")
async def add_mcp_server(req: AddMcpServerRequest) -> dict:
    try:
        srv = await mcp_client.add_server(req.name, req.url, req.headers or {})
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"MCP probe failed: {err}") from err
    sessions_mod.save_mcp_server(srv.id, srv.name, srv.url, srv.headers, srv.enabled)
    return mcp_client.list_servers()[-1] if False else {
        "id": srv.id, "name": srv.name, "url": srv.url, "enabled": srv.enabled,
        "tools": [{"name": t.name, "mangled_name": t.mangled_name, "description": t.description} for t in srv.tools],
    }


@app.patch("/mcp/servers/{sid}")
async def update_mcp_server(sid: str, req: UpdateMcpServerRequest) -> dict:
    if not mcp_client.set_enabled(sid, req.enabled):
        raise HTTPException(status_code=404, detail=f"MCP server not found: {sid}")
    sessions_mod.update_mcp_server(sid, enabled=req.enabled)
    return {"id": sid, "enabled": req.enabled}


@app.post("/mcp/servers/{sid}/reconnect")
async def reconnect_mcp_server(sid: str) -> dict:
    try:
        srv = await mcp_client.reconnect(sid)
    except KeyError as err:
        raise HTTPException(status_code=404, detail=f"MCP server not found: {sid}") from err
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"MCP reconnect failed: {err}") from err
    return {"id": srv.id, "tools": len(srv.tools)}


@app.delete("/mcp/servers/{sid}")
async def delete_mcp_server(sid: str) -> dict:
    removed = mcp_client.remove_server(sid)
    sessions_mod.delete_mcp_server(sid)
    if not removed:
        raise HTTPException(status_code=404, detail=f"MCP server not found: {sid}")
    return {"deleted": sid}


@app.post("/mcp/call")
async def call_mcp_tool(req: McpCallRequest) -> dict:
    """Invoked by the frontend's dispatchToolCall when the LLM emits a
    tool_call whose name begins with 'mcp_'. Opens a fresh Streamable-HTTP
    session, forwards the call, returns text + structured."""
    try:
        return await mcp_client.dispatch_mangled(req.tool, req.arguments)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except Exception as err:
        log.error(f"/mcp/call !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err


MAX_TOOL_OUTPUT = 8000  # truncate large outputs so the context doesn't blow up


@app.post("/inpaint", response_model=InpaintResponse)
async def inpaint_endpoint(request: InpaintRequest) -> InpaintResponse:
    import inpaint as inpaint_mod

    t0 = time.perf_counter()
    mask_b64 = request.mask
    if not mask_b64:
        if not request.width or not request.height:
            raise HTTPException(status_code=400, detail="width/height required when generating a mask from polygons/boxes")
        if request.polygons:
            mask_b64 = await asyncio.to_thread(
                inpaint_mod.mask_from_polygons, request.polygons, request.width, request.height,
            )
        elif request.boxes:
            mask_b64 = await asyncio.to_thread(
                inpaint_mod.mask_from_boxes, request.boxes, request.width, request.height,
            )
        else:
            raise HTTPException(status_code=400, detail="supply `mask`, `polygons`, or `boxes`")

    log.info(f"/inpaint <- prompt={request.prompt!r} steps={request.steps} guidance={request.guidance}")
    try:
        result = await asyncio.to_thread(
            inpaint_mod.inpaint,
            request.image,
            mask_b64,
            request.prompt,
            request.negative_prompt,
            request.steps,
            request.guidance,
            request.max_size,
            request.feather,
        )
    except Exception as err:
        log.error(f"/inpaint !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err

    latency_ms = int((time.perf_counter() - t0) * 1000)
    log.info(f"/inpaint -> {latency_ms}ms timings={result['timings_ms']}")
    return InpaintResponse(**result, latency_ms=latency_ms)


async def _run_vision_op(label: str, response_cls, fn, *args, summary=None):
    """Common wrapper for short-lived vision/audio endpoints. Dispatches
    `fn(*args)` to a worker thread, converts exceptions to 500s, and logs
    a one-liner with latency + optional per-op summary.

    `summary` is a callable taking the raw result dict and returning a
    short trailing string (e.g. `lambda r: f"people={len(r['people'])}"`).
    Returns an instance of response_cls populated from the result dict."""
    try:
        res = await asyncio.to_thread(fn, *args)
    except HTTPException:
        raise
    except Exception as err:
        log.error(f"/{label} !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    extra = f" {summary(res)}" if summary else ""
    latency = res.get("latency_ms") if isinstance(res, dict) else None
    if latency is not None:
        log.info(f"/{label} -> {latency}ms{extra}")
    else:
        log.info(f"/{label} ->{extra}")
    return response_cls(**res)


@app.post("/pose", response_model=PoseResponse)
async def pose_endpoint(request: PoseRequest) -> PoseResponse:
    import vision
    return await _run_vision_op(
        "pose", PoseResponse, vision.pose_estimate,
        request.image, request.conf, request.imgsz,
        summary=lambda r: f"people={len(r['people'])}",
    )


@app.post("/depth", response_model=DepthResponse)
async def depth_endpoint(request: DepthRequest) -> DepthResponse:
    import vision
    return await _run_vision_op(
        "depth", DepthResponse, vision.estimate_depth,
        request.image, request.colormap,
        summary=lambda r: f"{r['width']}x{r['height']}",
    )


@app.post("/ocr", response_model=OcrResponse)
async def ocr_endpoint(request: ImageOnlyRequest) -> OcrResponse:
    import vision
    return await _run_vision_op(
        "ocr", OcrResponse, vision.ocr, request.image,
        summary=lambda r: f"items={len(r['items'])}",
    )


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_endpoint(request: TranscribeRequest) -> TranscribeResponse:
    import audio
    return await _run_vision_op(
        "transcribe", TranscribeResponse, audio.transcribe,
        request.audio, request.language,
        summary=lambda r: f"chars={len(r['text'])}",
    )


@app.post("/translate", response_model=TranslateResponse)
async def translate_endpoint(request: TranslateRequest) -> TranslateResponse:
    """Full speech-in → speech-out pipeline: Whisper STT → Gemma translate → Kokoro TTS."""
    import audio

    t0 = time.perf_counter()
    timings: dict[str, int] = {}

    # 1) Transcribe
    try:
        stt = await asyncio.to_thread(audio.transcribe, request.audio, request.source_language)
    except Exception as err:
        log.error(f"/translate stt !! {err}")
        raise HTTPException(status_code=500, detail=f"stt failed: {err}") from err
    timings["stt_ms"] = stt["latency_ms"]
    source_text = stt["text"].strip()
    if not source_text:
        raise HTTPException(status_code=400, detail="no speech detected")

    # 2) Translate via Gemma — terse prompt + JSON-ish output we can post-process.
    model = _STATE.emma
    backend = _dispatch(model)
    trans_prompt = (
        f"Translate the following sentence to {request.target_language}. "
        f"Return ONLY the translated sentence, no quotes, no explanations, no extra text.\n\n"
        f"Sentence: {source_text}"
    )
    t_trans = time.perf_counter()
    try:
        raw = await backend.chat(
            model=model,
            messages=[{"role": "user", "content": trans_prompt}],
            temperature=0.2,
            max_tokens=300,
            think=False,
        )
    except Exception as err:
        log.error(f"/translate llm !! {err}")
        raise HTTPException(status_code=502, detail=f"translation model failed: {err}") from err
    translated_text = (raw.get("message", {}).get("content") or "").strip().strip('"').strip("'")
    timings["translate_ms"] = int((time.perf_counter() - t_trans) * 1000)

    # 3) TTS (optional)
    audio_b64 = None
    sample_rate = None
    if request.speak and translated_text:
        try:
            tts = await asyncio.to_thread(audio.speak, translated_text[:900], request.voice, 1.0)
            audio_b64 = tts["audio"]
            sample_rate = tts["sample_rate"]
            timings["tts_ms"] = tts["latency_ms"]
        except Exception as err:
            log.warning(f"/translate tts failed (non-fatal): {err}")

    latency = int((time.perf_counter() - t0) * 1000)
    log.info(
        f"/translate -> {latency}ms src={stt.get('language')} tgt={request.target_language!r} "
        f"'{source_text[:40]}' -> '{translated_text[:40]}'"
    )
    return TranslateResponse(
        source_text=source_text,
        translated_text=translated_text,
        detected_language=stt.get("language"),
        target_language=request.target_language,
        audio=audio_b64,
        sample_rate=sample_rate,
        latency_ms=latency,
        timings_ms=timings,
    )


@app.post("/speak", response_model=SpeakResponse)
async def speak_endpoint(request: SpeakRequest) -> SpeakResponse:
    import audio
    return await _run_vision_op(
        "speak", SpeakResponse, audio.speak,
        request.text, request.voice, request.speed,
        summary=lambda r: f"samples={r['samples']}",
    )


@app.post("/voice-clone", response_model=SpeakResponse)
async def voice_clone_endpoint(request: CloneVoiceRequest) -> SpeakResponse:
    import audio as _audio
    return await _run_vision_op(
        "voice-clone", SpeakResponse, _audio.clone_voice,
        request.ref_audio, request.ref_text, request.gen_text,
        summary=lambda r: f"samples={r['samples']}",
    )


@app.get("/voices")
async def voices_endpoint() -> dict:
    import audio
    return {"voices": await asyncio.to_thread(audio.list_voices)}


@app.post("/segment-people", response_model=PeopleSegResponse)
async def people_endpoint(request: ImageOnlyRequest) -> PeopleSegResponse:
    import vision
    return await _run_vision_op(
        "segment-people", PeopleSegResponse, vision.people_segment,
        request.image,
        summary=lambda r: f"count={r['count']}",
    )


@app.post("/anime", response_model=AnimeResponse)
async def anime_endpoint(request: AnimeRequest) -> AnimeResponse:
    import vision
    return await _run_vision_op(
        "anime", AnimeResponse, vision.anime_stylize,
        request.image, request.style, request.size,
    )


@app.post("/bg-sub", response_model=BgSubResponse)
async def bg_sub_endpoint(request: BgSubRequest) -> BgSubResponse:
    import vision
    return await _run_vision_op(
        "bg-sub", BgSubResponse, vision.bg_subtract,
        request.image, request.reset,
    )


@app.post("/segment-all", response_model=SegmentAllResponse)
async def segment_all_endpoint(request: SegmentAllRequest) -> SegmentAllResponse:
    import vision
    return await _run_vision_op(
        "segment-all", SegmentAllResponse, vision.segment_all,
        request.image, request.imgsz, request.conf,
        summary=lambda r: f"count={r['count']}",
    )


@app.post("/face", response_model=FaceMeshResponse)
async def face_endpoint(request: FaceRequest) -> FaceMeshResponse:
    import vision
    return await _run_vision_op(
        "face", FaceMeshResponse, vision.face_mesh,
        request.image, request.emotion, request.head_pose,
        summary=lambda r: f"faces={len(r['faces'])} emotion={request.emotion}",
    )


@app.post("/remove-bg", response_model=RmbgResponse)
async def rmbg_endpoint(request: RmbgRequest) -> RmbgResponse:
    import vision
    return await _run_vision_op(
        "remove-bg", RmbgResponse, vision.remove_bg,
        request.image, request.return_mask,
        summary=lambda r: f"{r['width']}x{r['height']}",
    )


@app.post("/img2img", response_model=Img2ImgResponse)
async def img2img_endpoint(request: Img2ImgRequest) -> Img2ImgResponse:
    import inpaint as inpaint_mod

    log.info(f"/img2img <- prompt={request.prompt!r} strength={request.strength}")
    t0 = time.perf_counter()
    try:
        result = await asyncio.to_thread(
            inpaint_mod.img2img,
            request.image,
            request.prompt,
            request.negative_prompt,
            request.steps,
            request.guidance,
            request.strength,
            request.max_size,
        )
    except Exception as err:
        log.error(f"/img2img !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    latency_ms = int((time.perf_counter() - t0) * 1000)
    log.info(f"/img2img -> {latency_ms}ms timings={result['timings_ms']}")
    return Img2ImgResponse(**result, latency_ms=latency_ms)



_TOOL_EXEC_DENYLIST = (
    "rm -rf /",
    "rm -rf /*",
    "sudo rm",
    "sudo dd",
    "mkfs",
    ":(){:|:&};:",          # fork-bomb
    "> /dev/sda",
    "dd if=/dev/zero",
    "shutdown",
    "reboot",
    "halt",
    "killall -9 Finder",     # cosmetic UI-nuke
)


def _resolve_tool_cwd(cwd: str | None) -> str | None:
    """Expand ~ and require the resolved path to live inside $HOME.
    Returns None if no cwd was requested. Raises 400 on a hostile path."""
    import os
    if not cwd:
        return None
    home = os.path.expanduser("~")
    resolved = os.path.realpath(os.path.expanduser(cwd))
    if not (resolved == home or resolved.startswith(home + os.sep)):
        raise HTTPException(status_code=400, detail=f"cwd {cwd!r} must be inside {home}")
    return resolved


def _validate_tool_command(command: str) -> None:
    """Cheap safety gate for the `run_shell` tool. Auto-approve lets a
    confused model run commands without a human in the loop; this catches
    the obvious footguns. Not a security boundary — just a sanity check.

    Normalises the input before matching so trivial obfuscations (extra
    whitespace, quoted binary, /bin/ prefix, backslash escape) don't slip
    through the literal-substring denylist."""
    lowered = command.strip().lower()
    # Collapse whitespace runs so `rm   -rf   /` still matches `rm -rf /`.
    collapsed = re.sub(r"\s+", " ", lowered)
    # Strip quotes/backslashes around the first token and drop a leading
    # path prefix so "/bin/rm -rf /", '"rm" -rf /', '\rm -rf /' all match.
    stripped = re.sub(r"""[\\"']""", "", collapsed)
    stripped = re.sub(r"^\S*/(?=\S)", "", stripped)
    haystacks = (lowered, collapsed, stripped)
    for pat in _TOOL_EXEC_DENYLIST:
        if any(pat in h for h in haystacks):
            raise HTTPException(status_code=400, detail=f"command blocked by safety denylist ({pat!r})")


@app.post("/tools/exec", response_model=ToolExecResponse)
async def tools_exec(request: ToolExecRequest) -> ToolExecResponse:
    """Run an arbitrary shell command. Caller (frontend) MUST have already
    gotten explicit user approval for this exact command before invoking."""
    import asyncio
    import os

    _validate_tool_command(request.command)
    resolved_cwd = _resolve_tool_cwd(request.cwd) or os.getcwd()

    log.info(f"/tools/exec <- {request.command!r} cwd={resolved_cwd}")
    t0 = time.perf_counter()
    proc = await asyncio.create_subprocess_shell(
        request.command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=resolved_cwd,
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=request.timeout)
        exit_code = proc.returncode or 0
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        stdout_b, stderr_b = b"", f"[timeout after {request.timeout}s]".encode()
        exit_code = -1

    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    truncated = False
    if len(stdout) > MAX_TOOL_OUTPUT:
        stdout = stdout[:MAX_TOOL_OUTPUT] + f"\n[...truncated, {len(stdout)} bytes total]"
        truncated = True
    if len(stderr) > MAX_TOOL_OUTPUT:
        stderr = stderr[:MAX_TOOL_OUTPUT] + f"\n[...truncated, {len(stderr)} bytes total]"
        truncated = True

    latency_ms = int((time.perf_counter() - t0) * 1000)
    log.info(f"/tools/exec -> exit={exit_code} stdout={len(stdout)}c stderr={len(stderr)}c {latency_ms}ms")
    return ToolExecResponse(
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        duration_ms=latency_ms,
        truncated=truncated,
    )


@app.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest) -> GenerateResponse:
    model = request.model or _STATE.emma
    try:
        raw = await client.generate(
            model=model,
            prompt=request.prompt,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
    except OllamaError as err:
        raise HTTPException(status_code=502, detail=str(err)) from err
    return GenerateResponse(model=raw.get("model", model), response=raw.get("response", ""))
