"""
CEOVA CCTV // High-Accuracy Vision & Body Recognition Service
vision/yolo_service.py

Ultralytics YOLOv8 Human Detection + OpenCV Multi-Zone Feature Extraction.
Runs as a local microservice on http://127.0.0.1:5055.
"""

import sys
import os
import time
import base64
import io
import math
from typing import List, Dict, Any, Optional

import cv2
import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from ultralytics import YOLO

# ─── Initialization ───────────────────────────────────────────────
app = FastAPI(title="CEOVA CCTV YOLO & Body Recognition Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Select optimal hardware accelerator: Apple Silicon MPS -> CUDA -> CPU
if torch.backends.mps.is_available():
    DEVICE = "mps"
elif torch.cuda.is_available():
    DEVICE = "cuda"
else:
    DEVICE = "cpu"

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "models", "yolov8n.pt")
MODEL_PATH = os.path.abspath(MODEL_PATH)

if not os.path.exists(MODEL_PATH):
    # Fallback to local working directory
    MODEL_PATH = "yolov8n.pt"

print(f"[YOLO_SERVICE] Loading YOLOv8 model from {MODEL_PATH} on {DEVICE}...")
try:
    yolo_model = YOLO(MODEL_PATH)
    # Warm up model
    dummy = np.zeros((320, 320, 3), dtype=np.uint8)
    _ = yolo_model(dummy, classes=[0], verbose=False, device=DEVICE)
    print(f"[YOLO_SERVICE] Model warmed up successfully on {DEVICE}!")
except Exception as e:
    print(f"[YOLO_SERVICE] Error loading model on {DEVICE}, falling back to CPU: {e}")
    DEVICE = "cpu"
    yolo_model = YOLO(MODEL_PATH)
    dummy = np.zeros((320, 320, 3), dtype=np.uint8)
    _ = yolo_model(dummy, classes=[0], verbose=False, device="cpu")


# ─── Helper: Decode Base64 Image to OpenCV BGR ────────────────────
def decode_image_base64(b64_str: str) -> np.ndarray:
    if "," in b64_str:
        b64_str = b64_str.split(",", 1)[1]
    raw_bytes = base64.b64decode(b64_str)
    nparr = np.frombuffer(raw_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image from base64 string")
    return img


# ─── Helper: Multi-Zone Body Re-ID Embedding (128 Dimensions) ─────
def extract_body_reid_features(crop_bgr: np.ndarray) -> Dict[str, Any]:
    """
    Extracts 128-dimensional multi-part illumination-invariant spatial HSV + gradient
    texture features matching the CeovaReid architecture.
    """
    h, w = crop_bgr.shape[:2]
    if h < 16 or w < 8:
        raise ValueError("Crop too small for body recognition")

    # Apply CLAHE (Contrast Limited Adaptive Histogram Equalization) on L channel for illumination invariance
    lab = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2LAB)
    l, a, b_ch = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    cl = clahe.apply(l)
    enhanced_bgr = cv2.cvtColor(cv2.merge((cl, a, b_ch)), cv2.COLOR_LAB2BGR)
    hsv = cv2.cvtColor(enhanced_bgr, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(enhanced_bgr, cv2.COLOR_BGR2GRAY)

    # 3 Spatial vertical zones:
    # Upper (Head / Collar) : 0% - 25%
    # Torso (Shirt / Uniform) : 25% - 65%
    # Lower (Pants / Skirt) : 65% - 100%
    zones = [
        {"y1": 0, "y2": int(h * 0.25), "w": 0.20},
        {"y1": int(h * 0.25), "y2": int(h * 0.65), "w": 0.50},
        {"y1": int(h * 0.65), "y2": h, "w": 0.30},
    ]

    raw_features: List[float] = []

    for z in zones:
        y1, y2, zw = z["y1"], z["y2"], z["w"]
        # Inner 80% to filter background clutter
        x1, x2 = int(w * 0.10), max(int(w * 0.90), int(w * 0.10) + 1)
        
        zone_hsv = hsv[y1:y2, x1:x2]
        zone_gray = gray[y1:y2, x1:x2]

        if zone_hsv.size == 0:
            raw_features.extend([0.0] * 36)
            continue

        # 1. 16-bin Hue histogram (0-180 in OpenCV)
        h_hist = cv2.calcHist([zone_hsv], [0], None, [16], [0, 180])
        h_hist = h_hist.flatten()
        s_sum = np.sum(h_hist)
        if s_sum > 0:
            h_hist /= s_sum

        # 2. 8-bin Saturation histogram (0-256)
        s_hist = cv2.calcHist([zone_hsv], [1], None, [8], [0, 256])
        s_hist = s_hist.flatten()
        s_sum = np.sum(s_hist)
        if s_sum > 0:
            s_hist /= s_sum

        # 3. 4-bin Value histogram (0-256)
        v_hist = cv2.calcHist([zone_hsv], [2], None, [4], [0, 256])
        v_hist = v_hist.flatten()
        s_sum = np.sum(v_hist)
        if s_sum > 0:
            v_hist /= s_sum

        # 4. 8-bin Gradient orientation histogram (Sobel edge directions)
        gx = cv2.Sobel(zone_gray, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(zone_gray, cv2.CV_32F, 0, 1, ksize=3)
        mag, angle = cv2.cartToPolar(gx, gy, angleInDegrees=True)
        g_hist, _ = np.histogram(angle[mag > 15], bins=8, range=(0, 360))
        g_hist = g_hist.astype(np.float32)
        g_sum = np.sum(g_hist)
        if g_sum > 0:
            g_hist /= g_sum

        # Append weighted features (16 + 8 + 4 + 8 = 36 per zone * 3 = 108)
        for val in h_hist:
            raw_features.append(float(val * zw))
        for val in s_hist:
            raw_features.append(float(val * zw))
        for val in v_hist:
            raw_features.append(float(val * zw))
        for val in g_hist:
            raw_features.append(float(val * zw))

    # Add 20 Global Context & Structural Features
    aspect_ratio = float(w / max(1, h))
    raw_features.append(aspect_ratio)
    raw_features.append(min(1.0, float(w / 200.0)))
    raw_features.append(min(1.0, float(h / 400.0)))

    # Global chromaticity ratios
    mean_bgr = cv2.mean(enhanced_bgr)[:3]
    sum_bgr = sum(mean_bgr) or 1.0
    raw_features.append(mean_bgr[2] / sum_bgr)  # R ratio
    raw_features.append(mean_bgr[1] / sum_bgr)  # G ratio
    raw_features.append(mean_bgr[0] / sum_bgr)  # B ratio

    # Dominant torso RGB
    torso_crop = enhanced_bgr[int(h * 0.25):int(h * 0.65), int(w * 0.15):int(w * 0.85)]
    if torso_crop.size > 0:
        torso_mean = cv2.mean(torso_crop)[:3]
        color_sig = [int(torso_mean[2]), int(torso_mean[1]), int(torso_mean[0])]
    else:
        color_sig = [int(mean_bgr[2]), int(mean_bgr[1]), int(mean_bgr[0])]

    # Pad up to exactly 128 dimensions
    while len(raw_features) < 128:
        idx = len(raw_features) % 36
        raw_features.append(raw_features[idx] * 0.5)

    raw_features = raw_features[:128]

    # L2 normalize
    feat_arr = np.array(raw_features, dtype=np.float32)
    norm = np.linalg.norm(feat_arr)
    if norm > 0:
        feat_arr /= norm

    return {
        "embedding": feat_arr.tolist(),
        "color_signature": color_sig,
        "aspect_ratio": round(aspect_ratio, 4),
        "width": w,
        "height": h,
    }


# ─── Pydantic Request Models ──────────────────────────────────────
class DetectRequest(BaseModel):
    image: str
    conf: float = 0.35
    iou: float = 0.45


class FeatureRequest(BaseModel):
    image: str


class MatchRequest(BaseModel):
    embedding: List[float]
    gallery: List[Dict[str, Any]]
    threshold: float = 0.78


# ─── API Endpoints ────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ready",
        "service": "YOLOv8 & Body Recognition Engine",
        "device": DEVICE,
        "model": "yolov8n.pt",
        "version": "1.0.0",
    }


@app.post("/detect")
def detect_humans(req: DetectRequest):
    t0 = time.time()
    try:
        img = decode_image_base64(req.image)
        h, w = img.shape[:2]

        results = yolo_model(
            img,
            classes=[0],  # 0: person
            conf=req.conf,
            iou=req.iou,
            verbose=False,
            device=DEVICE,
        )

        detections = []
        for r in results:
            boxes = r.boxes
            for box in boxes:
                xyxy = box.xyxy[0].cpu().numpy().tolist()
                conf = float(box.conf[0].cpu().numpy())
                bx1, by1, bx2, by2 = xyxy
                bw = max(1.0, bx2 - bx1)
                bh = max(1.0, by2 - by1)

                # Validate geometry: must resemble human silhouette (height >= 6% frame, not 3x wider than tall)
                if bh < (h * 0.06) or bw > (bh * 2.2):
                    continue

                detections.append({
                    "bbox": [round(bx1, 1), round(by1, 1), round(bw, 1), round(bh, 1)],
                    "score": round(conf, 4),
                    "class": "person",
                })

        latency_ms = round((time.time() - t0) * 1000, 2)
        return {
            "success": True,
            "width": w,
            "height": h,
            "detections": detections,
            "count": len(detections),
            "inference_time_ms": latency_ms,
            "device": DEVICE,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/extract-features")
def extract_features(req: FeatureRequest):
    try:
        crop = decode_image_base64(req.image)
        feats = extract_body_reid_features(crop)
        return {"success": True, **feats}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/match-body")
def match_body(req: MatchRequest):
    query_emb = np.array(req.embedding, dtype=np.float32)
    q_norm = np.linalg.norm(query_emb)
    if q_norm > 0:
        query_emb /= q_norm

    best_match = None
    best_score = 0.0

    for cand in req.gallery:
        cand_emb_list = cand.get("embedding") or cand.get("feature_vector")
        if not cand_emb_list or len(cand_emb_list) != len(query_emb):
            continue

        cand_emb = np.array(cand_emb_list, dtype=np.float32)
        c_norm = np.linalg.norm(cand_emb)
        if c_norm > 0:
            cand_emb /= c_norm

        # 1. Holistic Cosine Similarity
        cosine_sim = float(np.dot(query_emb, cand_emb))

        # 2. Torso Sub-similarity (indices 36-72)
        torso_q = query_emb[36:72]
        torso_c = cand_emb[36:72]
        torso_sim = float(np.dot(torso_q, torso_c) / (np.linalg.norm(torso_q) * np.linalg.norm(torso_c) + 1e-6))

        # 3. Lower Body Sub-similarity (indices 72-108)
        lower_q = query_emb[72:108]
        lower_c = cand_emb[72:108]
        lower_sim = float(np.dot(lower_q, lower_c) / (np.linalg.norm(lower_q) * np.linalg.norm(lower_c) + 1e-6))

        # Weighted multi-zone similarity
        sim = float(0.45 * cosine_sim + 0.35 * torso_sim + 0.20 * lower_sim)
        sim = max(0.0, min(1.0, sim))

        if sim > best_score:
            best_score = sim
            best_match = {
                "id": cand.get("id"),
                "name": cand.get("name"),
                "role": cand.get("role"),
                "similarity": round(sim, 4),
            }

    matched = (best_score >= req.threshold) and (best_match is not None)
    return {
        "matched": matched,
        "best_score": round(best_score, 4),
        "threshold": req.threshold,
        "best_match": best_match if matched else None,
    }


if __name__ == "__main__":
    port = 5055
    print(f"[YOLO_SERVICE] Starting FastAPI server on http://127.0.0.1:{port}...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
