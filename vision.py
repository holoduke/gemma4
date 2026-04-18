"""Extra vision pipelines: pose, depth, background removal.

Each capability is lazy-loaded on first request. Everything runs on MPS
where safe; falls back to CPU otherwise.
"""
from __future__ import annotations

import base64
import io
import logging
import threading
import time
from typing import Any

import cv2
import numpy as np
from PIL import Image

log = logging.getLogger("gemma4.vision")

_lock = threading.Lock()
_pose_model: Any = None
_depth_pipe: Any = None
_rmbg_pipe: Any = None


# ---------------- POSE (YOLOv8 pose via ultralytics) ----------------

def _ensure_pose():
    global _pose_model
    if _pose_model is not None:
        return _pose_model
    from ultralytics import YOLO
    from ultralytics.utils.downloads import attempt_download_asset
    w = "yolov8n-pose.pt"
    attempt_download_asset(w)
    log.info(f"loading {w}...")
    _pose_model = YOLO(w)
    return _pose_model


def pose_estimate(image_b64: str, conf: float = 0.3, imgsz: int = 480, track: bool = True) -> dict:
    model = _ensure_pose()
    img_bytes = base64.b64decode(image_b64)
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    h, w = arr.shape[:2]

    with _lock:
        t0 = time.perf_counter()
        if track:
            r = model.track(arr, verbose=False, conf=conf, imgsz=imgsz, persist=True, tracker="bytetrack.yaml")[0]
        else:
            r = model.predict(arr, verbose=False, conf=conf, imgsz=imgsz)[0]
        dur = (time.perf_counter() - t0) * 1000

    if r.keypoints is None or len(r.keypoints) == 0:
        return {"w": w, "h": h, "people": [], "latency_ms": int(dur)}

    kps = r.keypoints.xy.cpu().numpy()  # (N, 17, 2)
    kps_conf = r.keypoints.conf.cpu().numpy() if r.keypoints.conf is not None else None
    boxes = r.boxes.xyxy.cpu().numpy() if r.boxes is not None else None
    confs = r.boxes.conf.cpu().numpy() if r.boxes is not None else None
    ids = r.boxes.id.cpu().numpy().astype(int) if (r.boxes is not None and r.boxes.id is not None) else None

    people = []
    for i in range(len(kps)):
        person = {
            "keypoints": [[float(x), float(y)] for x, y in kps[i]],
            "kp_conf": [float(c) for c in kps_conf[i]] if kps_conf is not None else None,
            "box": [int(v) for v in boxes[i]] if boxes is not None else None,
            "conf": float(confs[i]) if confs is not None else None,
            "id": int(ids[i]) if ids is not None else None,
        }
        people.append(person)
    return {"w": w, "h": h, "people": people, "latency_ms": int(dur)}


# ---------------- DEPTH (Depth Anything V2 Small via transformers) ----------------

def _ensure_depth():
    global _depth_pipe
    if _depth_pipe is not None:
        return _depth_pipe
    from transformers import pipeline
    import torch
    device = 0 if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else -1)
    log.info(f"loading Depth-Anything-V2-Small on device={device}...")
    _depth_pipe = pipeline(
        task="depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=device,
    )
    return _depth_pipe


def estimate_depth(image_b64: str, colormap: str = "inferno") -> dict:
    pipe = _ensure_depth()
    img_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")

    with _lock:
        t0 = time.perf_counter()
        result = pipe(img)
        dur = (time.perf_counter() - t0) * 1000

    depth_pil = result["depth"] if isinstance(result, dict) else result  # PIL Image
    depth_arr = np.array(depth_pil).astype(np.float32)
    if depth_arr.max() > 0:
        norm = (depth_arr - depth_arr.min()) / (depth_arr.max() - depth_arr.min())
    else:
        norm = depth_arr
    u8 = (norm * 255).astype(np.uint8)

    cmap = {
        "inferno": cv2.COLORMAP_INFERNO,
        "magma": cv2.COLORMAP_MAGMA,
        "viridis": cv2.COLORMAP_VIRIDIS,
        "turbo": cv2.COLORMAP_TURBO,
    }.get(colormap, cv2.COLORMAP_INFERNO)
    colored = cv2.applyColorMap(u8, cmap)  # BGR
    rgb = cv2.cvtColor(colored, cv2.COLOR_BGR2RGB)
    out_buf = io.BytesIO()
    Image.fromarray(rgb).save(out_buf, format="JPEG", quality=85)
    return {
        "image": base64.b64encode(out_buf.getvalue()).decode("ascii"),
        "width": rgb.shape[1],
        "height": rgb.shape[0],
        "latency_ms": int(dur),
    }


# ---------------- BACKGROUND REMOVAL (rembg / U2Net) ----------------

_rmbg_session: Any = None
_ocr_reader: Any = None
_face_mesh: Any = None
_emotion_pipe: Any = None
_selfie_seg: Any = None
_fastsam_auto: Any = None
_bgsub: Any = None
_bgsub_frames: int = 0
_anime_model: Any = None
_anime_device: str = "cpu"


def _ensure_rmbg():
    global _rmbg_session
    if _rmbg_session is not None:
        return _rmbg_session
    from rembg import new_session
    log.info("loading rembg U2Net session...")
    _rmbg_session = new_session("u2net")
    return _rmbg_session


def remove_bg(image_b64: str, return_mask: bool = False) -> dict:
    from rembg import remove

    session = _ensure_rmbg()
    img_bytes = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")

    with _lock:
        t0 = time.perf_counter()
        if return_mask:
            out = remove(img, session=session, only_mask=True)
        else:
            out = remove(img, session=session)
        dur = (time.perf_counter() - t0) * 1000

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return {
        "image": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": img.size[0],
        "height": img.size[1],
        "latency_ms": int(dur),
    }


# ---------------- OCR (EasyOCR) ----------------

def _ensure_ocr(lang: tuple[str, ...] = ("en",)):
    global _ocr_reader
    if _ocr_reader is not None:
        return _ocr_reader
    import easyocr
    log.info(f"loading easyocr langs={lang}...")
    _ocr_reader = easyocr.Reader(list(lang), gpu=False, verbose=False)
    return _ocr_reader


def ocr(image_b64: str) -> dict:
    reader = _ensure_ocr()
    img_bytes = base64.b64decode(image_b64)
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    h, w = arr.shape[:2]

    with _lock:
        t0 = time.perf_counter()
        raw = reader.readtext(arr)
        dur = (time.perf_counter() - t0) * 1000

    items = []
    for entry in raw:
        box_pts, text, score = entry
        xs = [p[0] for p in box_pts]
        ys = [p[1] for p in box_pts]
        items.append({
            "text": text,
            "polygon": [[int(x), int(y)] for x, y in box_pts],
            "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
            "confidence": round(float(score), 3),
        })
    return {"w": w, "h": h, "items": items, "latency_ms": int(dur)}


# ---------------- FACE MESH (MediaPipe) ----------------

_FACE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)
_FACE_MODEL_PATH = "face_landmarker.task"


def _ensure_face_mesh():
    global _face_mesh
    if _face_mesh is not None:
        return _face_mesh
    import os
    import urllib.request
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision as mp_vision

    if not os.path.exists(_FACE_MODEL_PATH):
        log.info(f"downloading face_landmarker.task from {_FACE_MODEL_URL}")
        urllib.request.urlretrieve(_FACE_MODEL_URL, _FACE_MODEL_PATH)

    log.info("loading mediapipe FaceLandmarker...")
    base_opts = python.BaseOptions(model_asset_path=_FACE_MODEL_PATH)
    opts = mp_vision.FaceLandmarkerOptions(
        base_options=base_opts,
        output_face_blendshapes=False,
        output_facial_transformation_matrixes=False,
        num_faces=5,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    _face_mesh = mp_vision.FaceLandmarker.create_from_options(opts)
    return _face_mesh


def _ensure_emotion():
    global _emotion_pipe
    if _emotion_pipe is not None:
        return _emotion_pipe
    from transformers import pipeline
    import torch
    device = 0 if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else -1)
    log.info(f"loading face-emotion classifier on device={device}...")
    _emotion_pipe = pipeline(
        "image-classification",
        model="trpakov/vit-face-expression",
        device=device,
    )
    return _emotion_pipe


_face_id_state: dict = {"tracks": [], "next_id": 1}  # {id, box, ttl}


def _iou(a: list[int], b: list[int]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1); iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2); iy2 = min(ay2, by2)
    iw = max(0, ix2 - ix1); ih = max(0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(1, (ax2 - ax1)) * max(1, (ay2 - ay1))
    area_b = max(1, (bx2 - bx1)) * max(1, (by2 - by1))
    return inter / (area_a + area_b - inter)


def _assign_face_ids(faces: list[dict]) -> None:
    """Greedy IoU matcher against previous frame's tracks. Mutates faces
    in-place, adding an 'id' key. Unmatched faces get a new ID; tracks
    without a match drop after 10 frames (TTL)."""
    prev = _face_id_state["tracks"]
    used_prev: set[int] = set()
    assigned = [False] * len(faces)
    # Greedy best-IoU matching.
    for i, f in enumerate(faces):
        best_j, best_iou = -1, 0.2  # require IoU >= 0.2 for a match
        for j, t in enumerate(prev):
            if j in used_prev:
                continue
            iou = _iou(f["box"], t["box"])
            if iou > best_iou:
                best_iou = iou
                best_j = j
        if best_j >= 0:
            f["id"] = prev[best_j]["id"]
            used_prev.add(best_j)
            assigned[i] = True
    # Unmatched → new IDs.
    for i, f in enumerate(faces):
        if not assigned[i]:
            f["id"] = _face_id_state["next_id"]
            _face_id_state["next_id"] += 1
    # Carry forward: keep matched, decrement TTL for unseen tracks, drop ≤0.
    new_tracks = [{"id": f["id"], "box": f["box"], "ttl": 10} for f in faces]
    for j, t in enumerate(prev):
        if j not in used_prev and t["ttl"] > 1:
            new_tracks.append({"id": t["id"], "box": t["box"], "ttl": t["ttl"] - 1})
    _face_id_state["tracks"] = new_tracks


def _head_pose_from_landmarks(lms: list[list[float]], w: int, h: int) -> dict | None:
    """Estimate yaw/pitch/roll (degrees) from a MediaPipe 468-landmark mesh
    using classical solvePnP against a canonical 3D face model.
    Returns {'yaw', 'pitch', 'roll', 'translation_cm'}."""
    if len(lms) < 468:
        return None
    # 6 canonical 3D model points (millimetres) — matches common references.
    model_pts = np.array([
        [0.0,    0.0,    0.0],    # nose tip (index 1)
        [0.0,   -63.6,  -12.5],   # chin (152)
        [-43.3,  32.7,  -26.0],   # left eye outer corner (33)
        [43.3,   32.7,  -26.0],   # right eye outer corner (263)
        [-28.9, -28.9,  -24.1],   # left mouth corner (61)
        [28.9,  -28.9,  -24.1],   # right mouth corner (291)
    ], dtype=np.float64)
    indices = [1, 152, 33, 263, 61, 291]
    image_pts = np.array([lms[i] for i in indices], dtype=np.float64)

    focal = float(w)
    center = (w / 2.0, h / 2.0)
    camera_matrix = np.array([
        [focal, 0,     center[0]],
        [0,     focal, center[1]],
        [0,     0,     1],
    ], dtype=np.float64)
    dist = np.zeros((4, 1))
    ok, rvec, tvec = cv2.solvePnP(
        model_pts, image_pts, camera_matrix, dist,
        flags=cv2.SOLVEPNP_ITERATIVE,
    )
    if not ok:
        return None
    rmat, _ = cv2.Rodrigues(rvec)
    # Decompose rotation matrix → Euler angles (yaw=Y, pitch=X, roll=Z).
    sy = float(np.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2))
    if sy > 1e-6:
        pitch = np.arctan2(rmat[2, 1], rmat[2, 2])
        yaw = np.arctan2(-rmat[2, 0], sy)
        roll = np.arctan2(rmat[1, 0], rmat[0, 0])
    else:
        pitch = np.arctan2(-rmat[1, 2], rmat[1, 1])
        yaw = np.arctan2(-rmat[2, 0], sy)
        roll = 0.0
    return {
        "yaw":   round(float(np.degrees(yaw)),   1),
        "pitch": round(float(np.degrees(pitch)), 1),
        "roll":  round(float(np.degrees(roll)),  1),
        "translation_cm": [round(float(v) / 10.0, 1) for v in tvec.flatten()],
    }


def face_mesh(image_b64: str, emotion: bool = False, head_pose: bool = False) -> dict:
    import mediapipe as mp

    detector = _ensure_face_mesh()
    img_bytes = base64.b64decode(image_b64)
    pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = pil.size
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(pil))

    with _lock:
        t0 = time.perf_counter()
        result = detector.detect(mp_image)
        dur_mesh = (time.perf_counter() - t0) * 1000

    faces = []
    for fl in result.face_landmarks:
        pts = [[lm.x * w, lm.y * h] for lm in fl]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        face_entry = {
            "landmarks": [[round(x, 1), round(y, 1)] for x, y in pts],
            "box": [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))],
        }
        if head_pose:
            hp = _head_pose_from_landmarks(pts, w, h)
            if hp:
                face_entry.update(hp)
        faces.append(face_entry)

    # Cross-frame IDs via simple IoU greedy match.
    _assign_face_ids(faces)

    dur_emo = 0.0
    if emotion and faces:
        emo = _ensure_emotion()
        te = time.perf_counter()
        for f in faces:
            x1, y1, x2, y2 = f["box"]
            # Pad a little — the ViT expects a framed face, not a tight mesh bbox.
            pad = int(max(x2 - x1, y2 - y1) * 0.15)
            cx1 = max(0, x1 - pad); cy1 = max(0, y1 - pad)
            cx2 = min(w, x2 + pad); cy2 = min(h, y2 + pad)
            crop = pil.crop((cx1, cy1, cx2, cy2))
            try:
                preds = emo(crop, top_k=1)
                if preds:
                    f["emotion"] = preds[0]["label"]
                    f["emotion_score"] = round(float(preds[0]["score"]), 3)
            except Exception as err:
                log.warning(f"emotion classify failed: {err}")
        dur_emo = (time.perf_counter() - te) * 1000

    return {
        "w": w,
        "h": h,
        "faces": faces,
        "latency_ms": int(dur_mesh + dur_emo),
        "timings_ms": {"mesh": round(dur_mesh, 1), "emotion": round(dur_emo, 1)},
    }


# ---------------- SELFIE SEGMENTATION (MediaPipe ImageSegmenter) ----------------

_SELFIE_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/"
    "selfie_segmenter/float16/latest/selfie_segmenter.tflite"
)
_SELFIE_MODEL_PATH = "selfie_segmenter.tflite"


def _ensure_selfie_seg():
    global _selfie_seg
    if _selfie_seg is not None:
        return _selfie_seg
    import os
    import urllib.request
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision as mp_vision

    if not os.path.exists(_SELFIE_MODEL_PATH):
        log.info(f"downloading {_SELFIE_MODEL_URL}")
        urllib.request.urlretrieve(_SELFIE_MODEL_URL, _SELFIE_MODEL_PATH)

    log.info("loading mediapipe SelfieSegmenter...")
    base_opts = python.BaseOptions(model_asset_path=_SELFIE_MODEL_PATH)
    opts = mp_vision.ImageSegmenterOptions(
        base_options=base_opts,
        output_category_mask=True,
        output_confidence_masks=False,
        running_mode=mp_vision.RunningMode.IMAGE,
    )
    _selfie_seg = mp_vision.ImageSegmenter.create_from_options(opts)
    return _selfie_seg


# ---------------- ANIME STYLIZATION (AnimeGANv2 via torch.hub, MPS ~110ms) ----------------

ANIME_STYLES = {
    "face_paint_512_v2": "Studio Ghibli / face paint (portraits)",
    "face_paint_512_v1": "Face paint v1",
    "celeba_distill":    "CelebA distilled (softer)",
    "paprika":           "Paprika (vivid)",
}


def _ensure_anime(style: str = "face_paint_512_v2"):
    global _anime_model, _anime_device
    # Cache keyed on style so switching reloads the right weights.
    if isinstance(_anime_model, tuple) and _anime_model[0] == style:
        return _anime_model[1]
    import torch
    _anime_device = (
        "mps" if torch.backends.mps.is_available()
        else "cuda" if torch.cuda.is_available()
        else "cpu"
    )
    log.info(f"loading AnimeGANv2 ({style}) on {_anime_device}...")
    m = torch.hub.load(
        "bryandlee/animegan2-pytorch:main",
        "generator",
        pretrained=style,
        verbose=False,
        trust_repo=True,
    ).eval().to(_anime_device)
    _anime_model = (style, m)
    return m


def anime_stylize(image_b64: str, style: str = "face_paint_512_v2", size: int = 384) -> dict:
    import torch

    model = _ensure_anime(style)
    img_bytes = base64.b64decode(image_b64)
    pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    orig_w, orig_h = pil.size
    # Model wants a square-ish input; preserve aspect via resize.
    pil_resized = pil.resize((size, size), Image.LANCZOS)

    arr = np.array(pil_resized).astype(np.float32)
    tensor = (torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0) / 127.5 - 1.0).to(_anime_device)

    with _lock:
        t0 = time.perf_counter()
        with torch.no_grad():
            out = model(tensor)
        if _anime_device == "mps":
            torch.mps.synchronize()
        dur = (time.perf_counter() - t0) * 1000

    out = (out.squeeze(0).clamp(-1, 1).add(1).div(2).mul(255).byte()
           .permute(1, 2, 0).cpu().numpy())
    out_pil = Image.fromarray(out).resize((orig_w, orig_h), Image.LANCZOS)
    buf = io.BytesIO()
    out_pil.save(buf, format="JPEG", quality=85)
    return {
        "image": base64.b64encode(buf.getvalue()).decode("ascii"),
        "width": orig_w,
        "height": orig_h,
        "style": style,
        "latency_ms": int(dur),
    }


# ---------------- BACKGROUND SUBTRACTION (OpenCV MOG2, non-AI, ~5ms) ----------------

def bg_subtract(image_b64: str, reset: bool = False, min_area_frac: float = 0.005) -> dict:
    """Classical CV background subtraction. Learns the static background
    frame-by-frame and returns polygons of the moving foreground.
    Assumes the camera is still. ~3-8 ms per frame."""
    global _bgsub, _bgsub_frames

    img_bytes = base64.b64decode(image_b64)
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    h, w = arr.shape[:2]
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)

    with _lock:
        if _bgsub is None or reset:
            _bgsub = cv2.createBackgroundSubtractorMOG2(
                history=500, varThreshold=32, detectShadows=False
            )
            _bgsub_frames = 0
        t0 = time.perf_counter()
        fg = _bgsub.apply(bgr)
        _bgsub_frames += 1
        # Morphological cleanup: erode noise, close small gaps.
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, kernel)
        fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, kernel)
        dur = (time.perf_counter() - t0) * 1000
        frames_learned = _bgsub_frames

    contours, _h = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = (w * h) * min_area_frac
    polygons: list[list[list[int]]] = []
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        eps = max(1.0, 0.002 * cv2.arcLength(c, True))
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(int).tolist()
        if len(approx) >= 3:
            polygons.append(approx)

    return {
        "w": w,
        "h": h,
        "polygons": polygons,
        "count": len(polygons),
        "frames_learned": frames_learned,
        "latency_ms": int(dur),
    }


def _ensure_fastsam_auto():
    global _fastsam_auto
    if _fastsam_auto is not None:
        return _fastsam_auto
    from ultralytics import FastSAM
    from ultralytics.utils.downloads import attempt_download_asset
    attempt_download_asset("FastSAM-s.pt")
    log.info("loading FastSAM-s for auto-segmentation...")
    _fastsam_auto = FastSAM("FastSAM-s.pt")
    return _fastsam_auto


def segment_all(image_b64: str, imgsz: int = 480, conf: float = 0.4) -> dict:
    """Automatic scene segmentation — no prompt needed. Returns every mask
    FastSAM finds as a polygon contour + a class-less random colour index.
    ~150-400ms per frame on M3 Pro CPU depending on complexity."""
    model = _ensure_fastsam_auto()
    img_bytes = base64.b64decode(image_b64)
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    h, w = arr.shape[:2]

    with _lock:
        t0 = time.perf_counter()
        r = model.predict(arr, imgsz=imgsz, conf=conf, verbose=False)[0]
        dur = (time.perf_counter() - t0) * 1000

    polygons: list[list[list[int]]] = []
    areas: list[int] = []
    if r.masks is None:
        return {"w": w, "h": h, "polygons": [], "count": 0, "latency_ms": int(dur)}

    masks = r.masks.data.cpu().numpy()
    for mask in masks:
        mask8 = (mask.astype(np.uint8) * 255)
        if mask8.shape[:2] != (h, w):
            mask8 = cv2.resize(mask8, (w, h), interpolation=cv2.INTER_NEAREST)
        contours, _h = cv2.findContours(mask8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            continue
        c = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(c)
        if area < (w * h) * 0.002:  # drop specks
            continue
        eps = max(1.0, 0.003 * cv2.arcLength(c, True))
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(int).tolist()
        if len(approx) >= 3:
            polygons.append(approx)
            areas.append(int(area))

    # Sort largest-first so the overlay draws big regions under small ones.
    order = sorted(range(len(polygons)), key=lambda i: -areas[i])
    polygons = [polygons[i] for i in order]
    return {
        "w": w,
        "h": h,
        "polygons": polygons,
        "count": len(polygons),
        "latency_ms": int(dur),
    }


def people_segment(image_b64: str, threshold: float = 0.5) -> dict:
    """Segment all visible people via MediaPipe Selfie Segmenter. Returns
    polygon contours (compact for client overlay). ~5-15ms on M3 Pro."""
    import mediapipe as mp

    segmenter = _ensure_selfie_seg()
    img_bytes = base64.b64decode(image_b64)
    pil = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    arr = np.asarray(pil)
    h, w = arr.shape[:2]
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=arr)

    with _lock:
        t0 = time.perf_counter()
        result = segmenter.segment(mp_image)
        dur = (time.perf_counter() - t0) * 1000

    mask = result.category_mask.numpy_view()  # 0 = background, 1 = person
    # category_mask in selfie_segmenter is {0,1}; threshold is a no-op here but
    # kept so a confidence-mask variant can slot in later without API change.
    _ = threshold
    person_mask = (mask == 0).astype(np.uint8) * 255  # inverted: selfie=0 in this model
    # Some selfie_segmenter builds reverse labels; detect dominant region.
    if person_mask.sum() < mask.size * 0.01:
        person_mask = (mask == 1).astype(np.uint8) * 255

    contours, _hier = cv2.findContours(person_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    polygons: list[list[list[int]]] = []
    for c in contours:
        if cv2.contourArea(c) < (w * h) * 0.003:  # drop specks
            continue
        eps = max(1.0, 0.002 * cv2.arcLength(c, True))
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(int).tolist()
        if len(approx) >= 3:
            polygons.append(approx)

    return {
        "w": w,
        "h": h,
        "polygons": polygons,
        "count": len(polygons),
        "latency_ms": int(dur),
    }
