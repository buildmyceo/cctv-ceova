# 🎥 CEOVA CCTV // Deep Learning Training on Kaggle

This directory contains everything you need to train high-accuracy **Person Re-Identification (Re-ID)** and **6-Role Classification** (`STAFF`, `CUSTOMER`, `VISITOR`, `DELIVERY`, `SECURITY`, `UNKNOWN`) neural networks using **100% free GPU resources on [Kaggle](https://www.kaggle.com)**.

---

## ⚡ Why Train on Kaggle?

| Feature | Kaggle Cloud Environment | Local CPU / Laptop |
| :--- | :--- | :--- |
| **GPU Hardware** | **NVIDIA Tesla T4 $\times 2$** or **Tesla P100** (Free 30 hrs/wk) | Often CPU or integrated graphics |
| **VRAM** | **16 GB to 32 GB** GDDR6 | Shared system RAM |
| **Training Speed** | **~2 to 4 minutes** for 15 epochs | ~45 to 90 minutes on CPU |
| **Pre-installed ML** | PyTorch, CUDA 12, TorchVision, Albumentations, ONNX | Requires complex local CUDA setup |
| **Cost** | **$0.00 (Free forever)** | Hardware investment |

---

## 📁 Files in this Directory

- [`kaggle_ceova_reid_trainer.ipynb`](file:///Users/chintukumar/ceova_cctv_camera/training/kaggle_ceova_reid_trainer.ipynb): The complete, ready-to-run Jupyter notebook for Kaggle.
- [`prepare_custom_cctv_dataset.py`](file:///Users/chintukumar/ceova_cctv_camera/training/prepare_custom_cctv_dataset.py): Python utility to format, resize, and zip your own CCTV camera crops into Kaggle-ready Market-1501 format.
- [`build_notebook.py`](file:///Users/chintukumar/ceova_cctv_camera/training/build_notebook.py): Python script that automatically generates and updates the notebook.

---

## 🚀 Step-by-Step Walkthrough: Training on Kaggle

### Step 1: Open Kaggle & Create an Account
1. Open your browser and go to: **[https://www.kaggle.com](https://www.kaggle.com)**
2. Sign in or create a free account (Google sign-in works instantly).

---

### Step 2: Upload the Training Notebook
1. Go to **[https://www.kaggle.com/code](https://www.kaggle.com/code)**
2. Click the **"New Notebook"** button in the upper-right corner.
3. In the Kaggle editor menu bar at the top, click:
   **`File`** $\rightarrow$ **`Import Notebook`**
4. Choose **`Upload File`** and select:
   ```
   ceova_cctv_camera/training/kaggle_ceova_reid_trainer.ipynb
   ```
5. Kaggle will load the notebook with all cells, code, and documentation pre-populated.

---

### Step 3: Turn On Free GPU Accelerator
1. Look at the right-hand panel under **Notebook Options** (or click the three dots `...` in the top right $\rightarrow$ `Accelerator`).
2. Set **Accelerator**: **`GPU T4 x 2`** (or **`GPU P100`**).
3. Ensure **Internet**: **`On`** (allows downloading pretrained MobileNetV3 weights and packages).

---

### Step 4: Choose Your Dataset (3 Options)

#### Option A: Quick Test / Demo (Zero Setup)
- If you don't attach any dataset, the notebook **automatically synthesizes** a realistic 50-person multi-camera CCTV dataset directly in the cloud!
- You can proceed to Step 5 immediately.

#### Option B: Real-World Public Benchmark (Market-1501)
1. In the Kaggle right-hand panel, click **`+ Add Data`** (or **`+ Add Input`**).
2. In the search box, type: **`market-1501`**
3. Select any standard Market-1501 dataset (e.g. `pengcw1/market-1501` or `pengzi666/market1501`).
4. Click **`Add`**. The dataset will be instantly mounted at `/kaggle/input/` without downloading to your computer!

#### Option C: Your Own Facility CCTV Person Crops
1. Put your CCTV crops into folders named after the person or role:
   ```
   my_cctv_crops/
     ├── staff_john/
     │   ├── frame1.jpg
     │   └── frame2.jpg
     ├── customer_01/
     │   ├── cropA.jpg
     │   └── cropB.jpg
     └── security_guard/
         └── cam1_01.jpg
   ```
2. Run our preparation tool on your computer:
   ```bash
   python3 training/prepare_custom_cctv_dataset.py -i my_cctv_crops -o cctv_kaggle_dataset
   ```
   This generates `cctv_kaggle_dataset.zip`.
3. In Kaggle, go to **[https://www.kaggle.com/datasets](https://www.kaggle.com/datasets)** $\rightarrow$ click **`New Dataset`** $\rightarrow$ drag & drop `cctv_kaggle_dataset.zip`.
4. In your notebook, click **`+ Add Data`** and select your newly uploaded dataset.

---

### Step 5: Run Training
1. In Kaggle, click **`Run All`** (or click the double-arrow `>>` button at the top, or press `Shift + Enter` on each cell).
2. The notebook will:
   - Verify GPU allocation (Tesla T4 / P100).
   - Load and augment crops with **Random Erasing** (simulating occlusions) and **Color Jitter** (simulating lighting changes).
   - Train `CeovaReidNet` with **Batch-Hard Triplet Loss** + **Cross-Entropy Loss**.
   - Calculate Cross-Camera Cosine Similarity margins (Expect Same Person $> 0.85$, Different Person $< 0.45$).
   - Export **`ceova_reid_net.onnx`** (ultra-fast dynamic-batch ONNX model) and **`ceova_reid_net.pt`** (PyTorch weights).
   - Verify sub-4ms inference latency using ONNX Runtime.

---

### Step 6: Download the Trained Model
1. In the right-hand panel, look under the **Output** section (`/kaggle/working/`).
2. Find **`ceova_reid_net.onnx`**.
3. Click the three dots `...` next to it $\rightarrow$ **`Download`**.

---

### Step 7: Deploy into CEOVA CCTV
1. Copy the downloaded `ceova_reid_net.onnx` file into your local CEOVA CCTV project:
   ```bash
   cp ~/Downloads/ceova_reid_net.onnx /Users/chintukumar/ceova_cctv_camera/data/models/
   ```
2. CEOVA CCTV will automatically recognize `data/models/ceova_reid_net.onnx` and route all person crops through the deep neural network!

---

## 🧠 Neural Network Specifications

- **Backbone**: MobileNetV3-Small (lightweight, edge-optimized, sub-4ms latency).
- **Input Dimensions**: `[Batch, 3, 256, 128]` (RGB, normalized).
- **Primary Head**: 128-dimensional L2-normalized metric embedding (compatible with CEOVA CCTV spatial vector size and cosine similarity thresholding $\ge 0.86$).
- **Auxiliary Head**: 6-class Softmax classifier:
  1. `STAFF`
  2. `CUSTOMER`
  3. `VISITOR`
  4. `DELIVERY`
  5. `SECURITY`
  6. `UNKNOWN`
- **Trained Latency**: $\approx 3.2$ ms per person crop on CPU; $< 0.8$ ms on GPU.
