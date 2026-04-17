import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import detect as detect_module
import logging_setup
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
    RmbgRequest,
    RmbgResponse,
    ScanRequest,
    ScanResponse,
    SetModelRequest,
    SpeakRequest,
    SpeakResponse,
    ToolExecRequest,
    ToolExecResponse,
    TranscribeRequest,
    TranscribeResponse,
)

logging_setup.configure()
log = logging.getLogger("gemma4")

# Mutable runtime state, swappable via /models/* endpoints.
_STATE: dict[str, str] = {
    "emma": settings.model_name,
    "scan": settings.model_name,
    "detector": "yolov8s-world.pt",
    "segmenter": "mobile_sam.pt",
    "inpaint": "sd15-lcm-fast",
}

MAX_LOCAL_MODEL_GB = 15.0  # hide 26B/31B variants from the dropdown


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info(f"startup · emma={_STATE['emma']} · scan={_STATE['scan']} · detector={_STATE['detector']} · segmenter={_STATE['segmenter']} · ollama={settings.ollama_host}")
    t0 = time.perf_counter()
    try:
        await client.generate(
            model=_STATE["emma"],
            prompt="ok",
            temperature=0.0,
            max_tokens=1,
        )
        log.info(f"warmup complete in {time.perf_counter() - t0:.2f}s")
    except Exception as err:
        log.warning(f"warmup failed: {err}")
    yield
    await client.close()


app = FastAPI(title="gemma4", version="0.1.0", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/stats")
async def stats_endpoint() -> dict:
    data = await asyncio.to_thread(sysstats.collect)
    current = _STATE["emma"]
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
    data["state"] = dict(_STATE)
    return data


@app.get("/health")
async def health() -> dict:
    try:
        models = await client.list_models()
    except OllamaError as err:
        raise HTTPException(status_code=503, detail=str(err)) from err
    except Exception as err:
        raise HTTPException(status_code=503, detail=f"ollama unreachable: {err}") from err
    return {"status": "ok", "default_model": _STATE["emma"], "models": models.get("models", [])}


def _prompt_stats(messages: list) -> tuple[int, int]:
    total_chars = sum(len(m.get("content", "")) for m in messages)
    return len(messages), total_chars


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    if request.stream:
        raise HTTPException(status_code=400, detail="Use /chat/stream for streaming")
    model = request.model or _STATE["emma"]
    msgs = [m.model_dump(exclude_none=True) for m in request.messages]
    n_msgs, n_chars = _prompt_stats(msgs)
    backend = _dispatch(model)
    log.info(f"/chat <- model={model} msgs={n_msgs} chars={n_chars} think={request.think} tools={bool(request.tools)} backend={'mlx' if backend is mlx_client else 'ollama'}")
    t0 = time.perf_counter()
    try:
        raw = await backend.chat(
            model=model,
            messages=msgs,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
            think=request.think,
            tools=request.tools,
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
    model = request.model or _STATE["emma"]
    msgs = [m.model_dump(exclude_none=True) for m in request.messages]
    n_msgs, n_chars = _prompt_stats(msgs)
    backend = _dispatch(model)
    log.info(f"/chat/stream <- model={model} msgs={n_msgs} chars={n_chars} think={request.think} backend={'mlx' if backend is mlx_client else 'ollama'}")

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
                tools=request.tools,
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
    scan_model = _STATE["scan"]
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
    return {
        "emma": {"current": _STATE["emma"], "available": available},
        "scan": {"current": _STATE["scan"], "available": available},
        "detector": {"current": _STATE["detector"], "presets": detectors},
        "segmenter": {"current": _STATE["segmenter"], "presets": segmenters},
        "inpaint": {"current": _STATE["inpaint"], "presets": inpaints},
    }


@app.post("/models/emma")
async def set_emma(req: SetModelRequest) -> dict:
    backend = _dispatch(req.name)
    try:
        await backend.generate(model=req.name, prompt="ok", temperature=0.0, max_tokens=1)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"model '{req.name}' unavailable: {err}") from err
    _STATE["emma"] = req.name
    log.info(f"/models/emma -> {req.name}")
    return {"current": _STATE["emma"]}


@app.post("/models/scan")
async def set_scan(req: SetModelRequest) -> dict:
    backend = _dispatch(req.name)
    try:
        await backend.generate(model=req.name, prompt="ok", temperature=0.0, max_tokens=1)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"model '{req.name}' unavailable: {err}") from err
    _STATE["scan"] = req.name
    log.info(f"/models/scan -> {req.name}")
    return {"current": _STATE["scan"]}


@app.post("/models/detector")
async def set_detector(req: SetModelRequest) -> dict:
    try:
        await asyncio.to_thread(detect_module.set_detector, req.name)
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"detector load failed: {err}") from err
    _STATE["detector"] = req.name
    log.info(f"/models/detector -> {req.name}")
    return {"current": req.name}


@app.post("/models/segmenter")
async def set_segmenter(req: SetModelRequest) -> dict:
    try:
        await asyncio.to_thread(detect_module.set_segmenter, req.name)
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"segmenter load failed: {err}") from err
    _STATE["segmenter"] = req.name
    log.info(f"/models/segmenter -> {req.name}")
    return {"current": req.name}


@app.post("/models/inpaint")
async def set_inpaint(req: SetModelRequest) -> dict:
    import inpaint as inpaint_mod
    try:
        await asyncio.to_thread(inpaint_mod.set_preset, req.name)
    except Exception as err:
        raise HTTPException(status_code=400, detail=f"inpaint preset failed: {err}") from err
    _STATE["inpaint"] = req.name
    log.info(f"/models/inpaint -> {req.name}")
    return {"current": req.name}


# Back-compat alias so old frontends still work during a refresh.
@app.post("/models/yolo")
async def set_yolo_alias(req: SetModelRequest) -> dict:
    return await set_detector(req)


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


@app.post("/pose", response_model=PoseResponse)
async def pose_endpoint(request: PoseRequest) -> PoseResponse:
    import vision
    t0 = time.perf_counter()
    try:
        res = await asyncio.to_thread(vision.pose_estimate, request.image, request.conf, request.imgsz)
    except Exception as err:
        log.error(f"/pose !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/pose -> {int((time.perf_counter()-t0)*1000)}ms people={len(res['people'])}")
    return PoseResponse(**res)


@app.post("/depth", response_model=DepthResponse)
async def depth_endpoint(request: DepthRequest) -> DepthResponse:
    import vision
    try:
        res = await asyncio.to_thread(vision.estimate_depth, request.image, request.colormap)
    except Exception as err:
        log.error(f"/depth !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/depth -> {res['latency_ms']}ms {res['width']}x{res['height']}")
    return DepthResponse(**res)


@app.post("/ocr", response_model=OcrResponse)
async def ocr_endpoint(request: ImageOnlyRequest) -> OcrResponse:
    import vision
    try:
        res = await asyncio.to_thread(vision.ocr, request.image)
    except Exception as err:
        log.error(f"/ocr !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/ocr -> {res['latency_ms']}ms items={len(res['items'])}")
    return OcrResponse(**res)


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe_endpoint(request: TranscribeRequest) -> TranscribeResponse:
    import audio
    try:
        res = await asyncio.to_thread(audio.transcribe, request.audio, request.language)
    except Exception as err:
        log.error(f"/transcribe !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/transcribe -> {res['latency_ms']}ms chars={len(res['text'])}")
    return TranscribeResponse(**res)


@app.post("/speak", response_model=SpeakResponse)
async def speak_endpoint(request: SpeakRequest) -> SpeakResponse:
    import audio
    try:
        res = await asyncio.to_thread(audio.speak, request.text, request.voice, request.speed)
    except Exception as err:
        log.error(f"/speak !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/speak -> {res['latency_ms']}ms samples={res['samples']}")
    return SpeakResponse(**res)


@app.get("/voices")
async def voices_endpoint() -> dict:
    import audio
    return {"voices": await asyncio.to_thread(audio.list_voices)}


@app.post("/segment-people", response_model=PeopleSegResponse)
async def people_endpoint(request: ImageOnlyRequest) -> PeopleSegResponse:
    import vision
    try:
        res = await asyncio.to_thread(vision.people_segment, request.image)
    except Exception as err:
        log.error(f"/segment-people !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/segment-people -> {res['latency_ms']}ms count={res['count']}")
    return PeopleSegResponse(**res)


@app.post("/face", response_model=FaceMeshResponse)
async def face_endpoint(request: FaceRequest) -> FaceMeshResponse:
    import vision
    try:
        res = await asyncio.to_thread(vision.face_mesh, request.image, request.emotion)
    except Exception as err:
        log.error(f"/face !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/face -> {res['latency_ms']}ms faces={len(res['faces'])} emotion={request.emotion}")
    return FaceMeshResponse(**res)


@app.post("/remove-bg", response_model=RmbgResponse)
async def rmbg_endpoint(request: RmbgRequest) -> RmbgResponse:
    import vision
    try:
        res = await asyncio.to_thread(vision.remove_bg, request.image, request.return_mask)
    except Exception as err:
        log.error(f"/remove-bg !! {err}")
        raise HTTPException(status_code=500, detail=str(err)) from err
    log.info(f"/remove-bg -> {res['latency_ms']}ms {res['width']}x{res['height']}")
    return RmbgResponse(**res)


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



@app.post("/tools/exec", response_model=ToolExecResponse)
async def tools_exec(request: ToolExecRequest) -> ToolExecResponse:
    """Run an arbitrary shell command. Caller (frontend) MUST have already
    gotten explicit user approval for this exact command before invoking."""
    import asyncio
    import os

    log.info(f"/tools/exec <- {request.command!r} cwd={request.cwd or '.'}")
    t0 = time.perf_counter()
    proc = await asyncio.create_subprocess_shell(
        request.command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=request.cwd or os.getcwd(),
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
    model = request.model or _STATE["emma"]
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
