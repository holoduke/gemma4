"""Detector + Segmenter pipeline with swappable backends.

Detectors implement `detect(image, prompts, conf) -> (boxes, cls_idx, scores)`
Segmenters implement `segment(image, boxes) -> masks (HxW bool arrays)`

The active pair is chosen via set_detector() / set_segmenter() and cached;
models load lazily on first use and stay resident.
"""
from __future__ import annotations

import base64
import io
import logging
import threading
import time
from typing import Any, Protocol

import cv2
import numpy as np
from PIL import Image

log = logging.getLogger("emma4.detect")

_lock = threading.Lock()


def _pick_device() -> str:
    """Prefer CUDA, then MPS, then CPU. GroundingDINO and OWLv2 (transformers)
    stay on CPU for MPS because several ops fall back and mixed-device runs
    are slower than pure CPU; CUDA gets a full speedup."""
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if torch.backends.mps.is_available():
            return "cpu"  # see docstring
    except Exception:
        pass
    return "cpu"


# ---------- Detectors ----------

DETECTOR_PRESETS: dict[str, dict] = {
    "yolov8s-world.pt":     {"kind": "yolo_world", "weights": "yolov8s-world.pt",     "label": "YOLO-World S"},
    "yolov8s-worldv2.pt":   {"kind": "yolo_world", "weights": "yolov8s-worldv2.pt",   "label": "YOLO-World S v2"},
    "yolov8m-world.pt":     {"kind": "yolo_world", "weights": "yolov8m-world.pt",     "label": "YOLO-World M"},
    "yolov8l-world.pt":     {"kind": "yolo_world", "weights": "yolov8l-world.pt",     "label": "YOLO-World L"},
    "yolov8x-world.pt":     {"kind": "yolo_world", "weights": "yolov8x-world.pt",     "label": "YOLO-World X"},
    "grounding-dino-tiny":  {"kind": "grounding_dino", "model_id": "IDEA-Research/grounding-dino-tiny", "label": "Grounding DINO tiny"},
    "grounding-dino-base":  {"kind": "grounding_dino", "model_id": "IDEA-Research/grounding-dino-base", "label": "Grounding DINO base"},
    "owlv2-base":           {"kind": "owlv2",       "model_id": "google/owlv2-base-patch16-ensemble",   "label": "OWLv2 base"},
}

SEGMENTER_PRESETS: dict[str, dict] = {
    "mobile_sam.pt":  {"kind": "sam", "weights": "mobile_sam.pt",  "label": "MobileSAM (fast)"},
    "FastSAM-s.pt":   {"kind": "fast_sam", "weights": "FastSAM-s.pt", "label": "FastSAM s"},
    "FastSAM-x.pt":   {"kind": "fast_sam", "weights": "FastSAM-x.pt", "label": "FastSAM x"},
    "sam2_t.pt":      {"kind": "sam", "weights": "sam2_t.pt", "label": "SAM2 tiny"},
    "sam2_s.pt":      {"kind": "sam", "weights": "sam2_s.pt", "label": "SAM2 small"},
}


class Detector(Protocol):
    name: str
    def detect(self, image: np.ndarray, prompts: list[str], conf: float, imgsz: int
               ) -> tuple[np.ndarray, np.ndarray, np.ndarray]: ...


class Segmenter(Protocol):
    name: str
    def segment(self, image: np.ndarray, boxes: np.ndarray) -> np.ndarray: ...


class YoloWorldDetector:
    def __init__(self, weights: str):
        from ultralytics import YOLOWorld
        from ultralytics.utils.downloads import attempt_download_asset
        attempt_download_asset(weights)
        self.name = weights
        self._model = YOLOWorld(weights)
        self._last_classes: tuple[str, ...] | None = None

    def detect(self, image, prompts, conf, imgsz):
        targets = tuple(prompts)
        if self._last_classes != targets:
            self._model.set_classes(list(targets))
            self._last_classes = targets
        res = self._model.predict(image, verbose=False, conf=conf, imgsz=imgsz)[0]
        if res.boxes is None or len(res.boxes) == 0:
            return np.empty((0, 4)), np.empty((0,), dtype=int), np.empty((0,))
        boxes = res.boxes.xyxy.cpu().numpy()
        cls_idx = res.boxes.cls.cpu().numpy().astype(int)
        confs = res.boxes.conf.cpu().numpy()
        return boxes, cls_idx, confs


class GroundingDinoDetector:
    """HuggingFace GroundingDINO. Slower than YOLO-World but much better on
    bare nouns and phrase prompts ("person wearing a hat", "background")."""

    def __init__(self, model_id: str):
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
        import torch

        self.name = model_id
        self._torch = torch
        self._device = _pick_device()
        self._dtype = torch.float16 if self._device == "cuda" else torch.float32
        self._processor = AutoProcessor.from_pretrained(model_id)
        self._model = AutoModelForZeroShotObjectDetection.from_pretrained(
            model_id, torch_dtype=self._dtype
        ).to(self._device)
        self._model.eval()

    def detect(self, image, prompts, conf, imgsz):
        pil = Image.fromarray(image)
        text = ". ".join(prompts) + "."
        inputs = self._processor(images=pil, text=text, return_tensors="pt").to(self._device)
        with self._torch.no_grad():
            outputs = self._model(**inputs)
        target_sizes = self._torch.tensor([pil.size[::-1]])
        # Newer transformers renamed ``box_threshold`` to ``threshold``; keep
        # both paths to work across versions.
        kwargs = dict(input_ids=inputs.input_ids, text_threshold=conf, target_sizes=target_sizes)
        try:
            results = self._processor.post_process_grounded_object_detection(
                outputs, threshold=conf, **kwargs,
            )[0]
        except TypeError:
            results = self._processor.post_process_grounded_object_detection(
                outputs, box_threshold=conf, **kwargs,
            )[0]
        boxes = results["boxes"].cpu().numpy() if len(results["boxes"]) else np.empty((0, 4))
        scores = results["scores"].cpu().numpy() if len(results["scores"]) else np.empty((0,))
        labels = results["labels"]  # list of strings
        # Map each label string to its prompt index (best-match substring).
        cls_idx = []
        lower_prompts = [p.lower() for p in prompts]
        for lab in labels:
            low = lab.lower().strip()
            best = 0
            for i, p in enumerate(lower_prompts):
                if p in low or low in p:
                    best = i
                    break
            cls_idx.append(best)
        return boxes, np.asarray(cls_idx, dtype=int), scores


class Owlv2Detector:
    def __init__(self, model_id: str):
        from transformers import Owlv2ForObjectDetection, Owlv2Processor
        import torch

        self.name = model_id
        self._torch = torch
        self._device = _pick_device()
        self._dtype = torch.float16 if self._device == "cuda" else torch.float32
        self._processor = Owlv2Processor.from_pretrained(model_id)
        self._model = Owlv2ForObjectDetection.from_pretrained(
            model_id, torch_dtype=self._dtype
        ).to(self._device)
        self._model.eval()

    def detect(self, image, prompts, conf, imgsz):
        pil = Image.fromarray(image)
        texts = [[f"a photo of a {p}" for p in prompts]]
        inputs = self._processor(text=texts, images=pil, return_tensors="pt").to(self._device)
        with self._torch.no_grad():
            outputs = self._model(**inputs)
        target_sizes = self._torch.tensor([pil.size[::-1]])
        results = self._processor.post_process_object_detection(
            outputs, target_sizes=target_sizes, threshold=conf,
        )[0]
        boxes = results["boxes"].cpu().numpy() if len(results["boxes"]) else np.empty((0, 4))
        scores = results["scores"].cpu().numpy() if len(results["scores"]) else np.empty((0,))
        cls_idx = results["labels"].cpu().numpy().astype(int) if len(results["labels"]) else np.empty((0,), dtype=int)
        return boxes, cls_idx, scores


class UltralyticsSegmenter:
    """MobileSAM, SAM1, SAM2 — all via ultralytics.SAM."""

    def __init__(self, weights: str):
        from ultralytics import SAM
        from ultralytics.utils.downloads import attempt_download_asset
        attempt_download_asset(weights)
        self.name = weights
        self._model = SAM(weights)

    def segment(self, image, boxes):
        if len(boxes) == 0:
            return np.empty((0,) + image.shape[:2], dtype=bool)
        res = self._model.predict(image, bboxes=boxes, verbose=False)[0]
        if res.masks is None:
            return np.empty((0,) + image.shape[:2], dtype=bool)
        return res.masks.data.cpu().numpy()


class FastSAMSegmenter:
    def __init__(self, weights: str):
        from ultralytics import FastSAM
        from ultralytics.utils.downloads import attempt_download_asset
        attempt_download_asset(weights)
        self.name = weights
        self._model = FastSAM(weights)

    def segment(self, image, boxes):
        if len(boxes) == 0:
            return np.empty((0,) + image.shape[:2], dtype=bool)
        res = self._model.predict(image, bboxes=boxes, verbose=False)[0]
        if res.masks is None:
            return np.empty((0,) + image.shape[:2], dtype=bool)
        return res.masks.data.cpu().numpy()


def _build_detector(name: str) -> Detector:
    p = DETECTOR_PRESETS.get(name)
    if p is None:
        # fallback: assume raw YOLO-World weight path
        return YoloWorldDetector(name)
    kind = p["kind"]
    if kind == "yolo_world":
        return YoloWorldDetector(p["weights"])
    if kind == "grounding_dino":
        return GroundingDinoDetector(p["model_id"])
    if kind == "owlv2":
        return Owlv2Detector(p["model_id"])
    raise ValueError(f"unknown detector kind: {kind}")


def _build_segmenter(name: str) -> Segmenter:
    p = SEGMENTER_PRESETS.get(name)
    if p is None:
        return UltralyticsSegmenter(name)
    kind = p["kind"]
    if kind == "sam":
        return UltralyticsSegmenter(p["weights"])
    if kind == "fast_sam":
        return FastSAMSegmenter(p["weights"])
    raise ValueError(f"unknown segmenter kind: {kind}")


# ---------- Active state ----------

_detector: Detector | None = None
_segmenter: Segmenter | None = None
_detector_name: str = "yolov8s-world.pt"
_segmenter_name: str = "mobile_sam.pt"


def _ensure_detector() -> Detector:
    global _detector
    if _detector is None or _detector.name not in (_detector_name, DETECTOR_PRESETS.get(_detector_name, {}).get("weights"), DETECTOR_PRESETS.get(_detector_name, {}).get("model_id")):
        t0 = time.perf_counter()
        log.info(f"loading detector: {_detector_name}")
        _detector = _build_detector(_detector_name)
        log.info(f"detector ready in {time.perf_counter() - t0:.1f}s")
    return _detector


def _ensure_segmenter() -> Segmenter:
    global _segmenter
    if _segmenter is None or _segmenter.name not in (_segmenter_name, SEGMENTER_PRESETS.get(_segmenter_name, {}).get("weights")):
        t0 = time.perf_counter()
        log.info(f"loading segmenter: {_segmenter_name}")
        _segmenter = _build_segmenter(_segmenter_name)
        log.info(f"segmenter ready in {time.perf_counter() - t0:.1f}s")
    return _segmenter


def set_detector(name: str) -> None:
    global _detector_name, _detector
    with _lock:
        _detector_name = name
        _detector = None  # force reload on next detect
        _ensure_detector()


def set_segmenter(name: str) -> None:
    global _segmenter_name, _segmenter
    with _lock:
        _segmenter_name = name
        _segmenter = None
        _ensure_segmenter()


def current_detector() -> str:
    return _detector_name


def current_segmenter() -> str:
    return _segmenter_name


# ---------- public API used by /detect ----------

def _parse_targets(prompt: str) -> list[str]:
    raw = prompt.replace(";", ",").split(",")
    return [p.strip().lower() for p in raw if p.strip()]


def detect_and_segment(
    image_b64: str,
    prompt: str,
    conf: float = 0.08,
    masks_on: bool = True,
    imgsz: int = 480,
) -> dict:
    targets = _parse_targets(prompt)
    if not targets:
        return {
            "targets": [],
            "polygons": [],
            "boxes": [],
            "labels": [],
            "confidences": [],
            "w": 0,
            "h": 0,
            "timings_ms": {},
        }

    t0 = time.perf_counter()
    img_bytes = base64.b64decode(image_b64)
    arr = np.array(Image.open(io.BytesIO(img_bytes)).convert("RGB"))
    h, w = arr.shape[:2]
    timings = {"decode": round((time.perf_counter() - t0) * 1000, 1)}

    with _lock:
        det = _ensure_detector()
        td = time.perf_counter()
        boxes, cls_idx, confs = det.detect(arr, targets, conf, imgsz)
        timings["detect"] = round((time.perf_counter() - td) * 1000, 1)

        if len(boxes) == 0:
            return {
                "targets": targets,
                "polygons": [],
                "boxes": [],
                "labels": [],
                "confidences": [],
                "w": w,
                "h": h,
                "timings_ms": timings,
            }

        box_list = [[int(v) for v in b] for b in boxes]

        masks = np.empty((0,) + arr.shape[:2])
        if masks_on:
            seg = _ensure_segmenter()
            ts = time.perf_counter()
            masks = seg.segment(arr, boxes)
            timings["segment"] = round((time.perf_counter() - ts) * 1000, 1)

    polygons: list[list[list[int]]] = []
    if masks_on:
        tp = time.perf_counter()
        for mask in masks:
            mask8 = (np.asarray(mask).astype(np.uint8) * 255)
            if mask8.shape[:2] != (h, w):
                mask8 = cv2.resize(mask8, (w, h), interpolation=cv2.INTER_NEAREST)
            contours, _ = cv2.findContours(mask8, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                polygons.append([])
                continue
            c = max(contours, key=cv2.contourArea)
            eps = max(1.0, 0.003 * cv2.arcLength(c, True))
            approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2).astype(int).tolist()
            polygons.append(approx)
        timings["contour"] = round((time.perf_counter() - tp) * 1000, 1)

    labels = [targets[i] if 0 <= i < len(targets) else "?" for i in cls_idx]

    return {
        "targets": targets,
        "polygons": polygons,
        "boxes": box_list,
        "labels": labels,
        "confidences": [round(float(c), 3) for c in confs],
        "w": w,
        "h": h,
        "timings_ms": timings,
    }


# Back-compat shim used by main.py
def set_yolo_weights(weights: str) -> None:
    set_detector(weights)
