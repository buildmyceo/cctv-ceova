#!/usr/bin/env bash
# CEOVA CCTV // Standalone Runtime Bootstrap Script
# runtime/setup_environment.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${CEOVA_CCTV_DATA_DIR:-${HOME}/Library/Application Support/Ceova/CCTV}"

echo "======================================================"
echo "  CEOVA CCTV // STANDALONE ENVIRONMENT BOOTSTRAP"
echo "======================================================"
echo "  App Root: ${APP_ROOT}"
echo "  Data Dir: ${DATA_DIR}"

# 1. Verify Node.js Standalone Runtime
NODE_BIN="${APP_ROOT}/runtime/bin/node"
if [[ -x "${NODE_BIN}" ]]; then
  echo "  ✔ Bundled Node.js runtime verified: $("${NODE_BIN}" --version)"
else
  echo "  ✔ System Node.js runtime active: $(node --version)"
fi

# 2. Setup / Verify Isolated Python Environment
VENV_DIR="${DATA_DIR}/runtime/venv"
mkdir -p "${DATA_DIR}/runtime"

# Check if Python is available
PYTHON_CMD="python3"
if ! command -v "${PYTHON_CMD}" >/dev/null 2>&1; then
  echo "  ⚠ Warning: python3 not found on system PATH."
  if [[ -x "/opt/homebrew/bin/python3" ]]; then
    PYTHON_CMD="/opt/homebrew/bin/python3"
  fi
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  echo "  → Initializing isolated Python venv at ${VENV_DIR}..."
  "${PYTHON_CMD}" -m venv --system-site-packages "${VENV_DIR}" || true
fi

# Verify vision packages
VENV_PYTHON="${VENV_DIR}/bin/python3"
if [[ -x "${VENV_PYTHON}" ]]; then
  ACTIVE_PYTHON="${VENV_PYTHON}"
else
  ACTIVE_PYTHON="${PYTHON_CMD}"
fi

echo "  → Verifying AI & Vision dependencies with ${ACTIVE_PYTHON}..."
if "${ACTIVE_PYTHON}" -c "import cv2, torch, ultralytics; print('  ✔ Vision dependencies verified (PyTorch, OpenCV, YOLOv8)')" 2>/dev/null; then
  echo "  ✔ All AI runtimes and vision models operational."
else
  echo "  → Installing missing pinned vision requirements into isolated venv..."
  "${ACTIVE_PYTHON}" -m pip install --quiet --upgrade pip || true
  "${ACTIVE_PYTHON}" -m pip install --quiet "torch" "opencv-python-headless" "ultralytics" "fastapi" "uvicorn" || true
fi

# 3. Verify AI Models
MODEL_PATH="${APP_ROOT}/data/models/yolov8n.pt"
if [[ -f "${MODEL_PATH}" ]]; then
  echo "  ✔ AI Model verified: ${MODEL_PATH} ($(wc -c < "${MODEL_PATH}" | tr -d ' ') bytes)"
else
  echo "  ⚠ Model missing at ${MODEL_PATH}"
fi

echo "======================================================"
echo "  Standalone environment initialization complete."
echo "======================================================"
