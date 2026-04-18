"""Audio I/O: speech-to-text (Whisper) and text-to-speech (Kokoro).

Both are lazy-loaded. STT uses mlx-whisper (Apple Silicon native) and runs
faster than Ollama-hosted Whisper variants. TTS uses Kokoro-82M ONNX.
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import subprocess
import tempfile
import time
from typing import Any

import numpy as np

log = logging.getLogger("gemma4.audio")

_whisper_ready: bool = False
_whisper_model_id: str = "mlx-community/whisper-small.en-mlx"  # ~150MB, fast

_kokoro: Any = None
_kokoro_model_path = "kokoro-v0_19.onnx"
_kokoro_voices_path = "voices-v1.0.bin"
_KOKORO_MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files/kokoro-v0_19.onnx"
_KOKORO_VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


# ---------------- STT (Whisper via MLX) ----------------

def _decode_audio_to_wav(raw_bytes: bytes) -> str:
    """Decode any audio (WebM, MP3, WAV) to 16kHz mono WAV using ffmpeg.
    Returns a temp file path; caller must delete."""
    in_path = tempfile.NamedTemporaryFile(suffix=".bin", delete=False).name
    out_path = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    with open(in_path, "wb") as f:
        f.write(raw_bytes)
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", in_path,
        "-ac", "1", "-ar", "16000", "-f", "wav",
        out_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    os.unlink(in_path)
    return out_path


def transcribe(audio_b64: str, language: str | None = None) -> dict:
    global _whisper_ready
    import mlx_whisper

    raw = base64.b64decode(audio_b64)
    wav_path = _decode_audio_to_wav(raw)
    try:
        t0 = time.perf_counter()
        kwargs: dict = {"path_or_hf_repo": _whisper_model_id, "verbose": False}
        if language:
            kwargs["language"] = language
        if not _whisper_ready:
            log.info(f"loading Whisper model {_whisper_model_id} (first call)...")
        result = mlx_whisper.transcribe(wav_path, **kwargs)
        dur = (time.perf_counter() - t0) * 1000
        _whisper_ready = True
    finally:
        try:
            os.unlink(wav_path)
        except Exception:
            pass

    return {
        "text": (result.get("text") or "").strip(),
        "language": result.get("language"),
        "latency_ms": int(dur),
    }


# ---------------- TTS (Kokoro-82M) ----------------

def _download(url: str, dest: str) -> None:
    import urllib.request
    log.info(f"downloading {url} -> {dest}")
    urllib.request.urlretrieve(url, dest)


def _ensure_kokoro():
    global _kokoro
    if _kokoro is not None:
        return _kokoro
    if not os.path.exists(_kokoro_model_path):
        _download(_KOKORO_MODEL_URL, _kokoro_model_path)
    if not os.path.exists(_kokoro_voices_path):
        _download(_KOKORO_VOICES_URL, _kokoro_voices_path)
    from kokoro_onnx import Kokoro
    log.info("initialising Kokoro TTS...")
    _kokoro = Kokoro(_kokoro_model_path, _kokoro_voices_path)
    return _kokoro


def speak(text: str, voice: str = "af_bella", speed: float = 1.0) -> dict:
    kokoro = _ensure_kokoro()
    t0 = time.perf_counter()
    samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
    dur = (time.perf_counter() - t0) * 1000

    # Encode as WAV so the browser can play it via <audio src="data:audio/wav;base64,...">.
    import struct, wave
    pcm16 = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm16.tobytes())

    return {
        "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
        "sample_rate": sample_rate,
        "samples": len(samples),
        "latency_ms": int(dur),
    }


_f5: Any = None


def _ensure_f5():
    global _f5
    if _f5 is not None:
        return _f5
    from f5_tts.api import F5TTS
    log.info("loading F5-TTS (first call downloads ~1.3GB of weights)...")
    t0 = time.perf_counter()
    _f5 = F5TTS()
    log.info(f"F5-TTS ready in {time.perf_counter() - t0:.1f}s")
    return _f5


def clone_voice(ref_audio_b64: str, ref_text: str, gen_text: str) -> dict:
    """F5-TTS voice cloning: takes ~5-15 s of reference audio + its transcript,
    produces synthetic speech of ``gen_text`` in the same voice."""
    f5 = _ensure_f5()
    raw = base64.b64decode(ref_audio_b64)
    ref_wav = _decode_audio_to_wav(raw)  # normalises to 16kHz mono WAV
    try:
        t0 = time.perf_counter()
        wav, sr, _spec = f5.infer(
            ref_file=ref_wav,
            ref_text=ref_text.strip(),
            gen_text=gen_text.strip(),
            remove_silence=True,
            file_wave=None,
        )
        dur = (time.perf_counter() - t0) * 1000
    finally:
        try:
            os.unlink(ref_wav)
        except Exception:
            pass

    import wave
    pcm16 = (np.clip(wav, -1.0, 1.0) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm16.tobytes())
    return {
        "audio": base64.b64encode(buf.getvalue()).decode("ascii"),
        "sample_rate": int(sr),
        "samples": int(len(wav)),
        "latency_ms": int(dur),
    }


def list_voices() -> list[str]:
    """Return the voices the current Kokoro model knows about."""
    try:
        kokoro = _ensure_kokoro()
        return sorted(kokoro.get_voices())
    except Exception as err:
        log.warning(f"list_voices failed: {err}")
        return []
