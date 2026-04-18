from typing import Any, Literal

from pydantic import BaseModel, Field


class Message(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str
    images: list[str] | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_name: str | None = None


class ChatRequest(BaseModel):
    messages: list[Message] = Field(..., min_length=1)
    model: str | None = None
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(None, ge=1, le=8192)
    stream: bool = False
    think: bool = False
    tools: list[dict[str, Any]] | None = None


class InpaintRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG of the original frame")
    prompt: str = Field(..., min_length=1, max_length=500)
    negative_prompt: str | None = Field(None, max_length=300)
    # Caller supplies either a pre-rendered mask PNG, or the detect output
    # (targets + polygons) which we rasterise server-side. At least one required.
    mask: str | None = Field(None, description="Base64 PNG binary mask (white=replace)")
    polygons: list[list[list[int]]] | None = Field(None, description="Per-region polygon coords in image pixel space")
    boxes: list[list[int]] | None = Field(None, description="Per-region xyxy boxes (fallback when no polygons)")
    width: int | None = Field(None, ge=64, le=2048)
    height: int | None = Field(None, ge=64, le=2048)
    steps: int = Field(4, ge=1, le=30)
    guidance: float = Field(4.0, ge=0.0, le=15.0)
    max_size: int = Field(640, ge=128, le=1024)
    feather: int = Field(9, ge=0, le=40)


class InpaintResponse(BaseModel):
    image: str
    width: int
    height: int
    steps: int
    guidance: float
    latency_ms: int
    timings_ms: dict[str, float]


class Img2ImgRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG of the source frame")
    prompt: str = Field(..., min_length=1, max_length=500)
    negative_prompt: str | None = Field(None, max_length=300)
    strength: float = Field(0.7, ge=0.1, le=1.0, description="How much to deviate from the source")
    steps: int | None = Field(None, ge=1, le=30)
    guidance: float | None = Field(None, ge=0.0, le=15.0)
    max_size: int = Field(640, ge=128, le=1024)


class Img2ImgResponse(BaseModel):
    image: str
    width: int
    height: int
    steps: int
    guidance: float
    strength: float
    latency_ms: int
    timings_ms: dict[str, float]


class PoseRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    conf: float = Field(0.3, ge=0.05, le=0.95)
    imgsz: int = Field(480, ge=128, le=1024)


class PoseResponse(BaseModel):
    w: int
    h: int
    people: list[dict]
    latency_ms: int


class DepthRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    colormap: str = Field("inferno", description="inferno|magma|viridis|turbo")


class DepthResponse(BaseModel):
    image: str
    width: int
    height: int
    latency_ms: int


class RmbgRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    return_mask: bool = Field(False, description="true=binary mask PNG; false=RGBA cutout")


class RmbgResponse(BaseModel):
    image: str
    width: int
    height: int
    latency_ms: int


class ImageOnlyRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")


class FaceRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    emotion: bool = Field(False, description="Run emotion classifier on each face (adds ~50-100ms per face)")
    head_pose: bool = Field(False, description="Estimate yaw/pitch/roll via solvePnP against a canonical face model")


class OcrResponse(BaseModel):
    w: int
    h: int
    items: list[dict]
    latency_ms: int


class FaceMeshResponse(BaseModel):
    w: int
    h: int
    faces: list[dict]
    latency_ms: int
    timings_ms: dict[str, float] = Field(default_factory=dict)


class PeopleSegResponse(BaseModel):
    w: int
    h: int
    polygons: list[list[list[int]]]
    count: int
    latency_ms: int


class SegmentAllRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    imgsz: int = Field(480, ge=128, le=1024)
    conf: float = Field(0.4, ge=0.05, le=0.95)


class SegmentAllResponse(BaseModel):
    w: int
    h: int
    polygons: list[list[list[int]]]
    count: int
    latency_ms: int


class AnimeRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    style: str = Field("face_paint_512_v2", description="AnimeGANv2 style checkpoint")
    size: int = Field(384, ge=128, le=768)


class AnimeResponse(BaseModel):
    image: str
    width: int
    height: int
    style: str
    latency_ms: int


class BgSubRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG")
    reset: bool = Field(False, description="Reset the learned background model")


class BgSubResponse(BaseModel):
    w: int
    h: int
    polygons: list[list[list[int]]]
    count: int
    frames_learned: int
    latency_ms: int


class TranscribeRequest(BaseModel):
    audio: str = Field(..., description="Base64 of any audio container ffmpeg can read (WebM, MP3, WAV)")
    language: str | None = Field(None, max_length=8, description="ISO language code hint, e.g. 'en'")


class TranscribeResponse(BaseModel):
    text: str
    language: str | None = None
    latency_ms: int


class TranslateRequest(BaseModel):
    audio: str = Field(..., description="Base64 audio (same formats as /transcribe)")
    target_language: str = Field(..., min_length=2, max_length=30, description="Target language in plain English, e.g. 'Japanese', 'Spanish'")
    source_language: str | None = Field(None, description="Source language hint for Whisper; auto-detect when None")
    voice: str = Field("af_bella", max_length=60, description="Kokoro voice to speak the translation")
    speak: bool = Field(True, description="Return TTS audio of the translation")


class TranslateResponse(BaseModel):
    source_text: str
    translated_text: str
    detected_language: str | None = None
    target_language: str
    audio: str | None = None
    sample_rate: int | None = None
    latency_ms: int
    timings_ms: dict[str, int]


class SpeakRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)
    voice: str = Field("af_bella", max_length=60)
    speed: float = Field(1.0, ge=0.5, le=2.0)


class SpeakResponse(BaseModel):
    audio: str  # base64 WAV
    sample_rate: int
    samples: int
    latency_ms: int


class ToolExecRequest(BaseModel):
    command: str = Field(..., min_length=1, max_length=4000)
    cwd: str | None = Field(None, max_length=500)
    timeout: int = Field(30, ge=1, le=300)


class ToolExecResponse(BaseModel):
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    truncated: bool


class ChatResponse(BaseModel):
    model: str
    message: Message
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_duration_ms: int | None = None


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    model: str | None = None
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int | None = Field(None, ge=1, le=8192)


class GenerateResponse(BaseModel):
    model: str
    response: str


class ScanRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG (no data-url prefix)")
    max_objects: int = Field(10, ge=1, le=30)
    prompt: str | None = Field(None, max_length=500, description="Optional custom prompt. If set, JSON schema still enforced.")


class ScanResponse(BaseModel):
    description: str
    objects: list[str]
    latency_ms: int


class DetectRequest(BaseModel):
    image: str = Field(..., description="Base64 JPEG/PNG (no data-url prefix)")
    prompt: str = Field(..., min_length=1)
    conf: float = Field(0.08, ge=0.01, le=0.9)
    masks: bool = True
    imgsz: int = Field(480, ge=128, le=1024)
    track: bool = Field(False, description="ByteTrack stable IDs across frames")


class SetModelRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class DetectResponse(BaseModel):
    targets: list[str]
    polygons: list[list[list[int]]]
    boxes: list[list[int]]
    labels: list[str]
    confidences: list[float]
    ids: list[int] = Field(default_factory=list)
    w: int
    h: int
    latency_ms: int
    timings_ms: dict[str, float]
