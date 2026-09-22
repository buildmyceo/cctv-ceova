# CEOVA CCTV // Deep Learning Models Directory
`data/models/`

Place your trained neural network models here:

1. **`ceova_reid_net.onnx`**
   - Output from the Kaggle training notebook (`training/kaggle_ceova_reid_trainer.ipynb`).
   - Deep Person Re-Identification & 6-Role classification network.
   - Input: `[batch, 3, 256, 128]` RGB person crop
   - Output: `[batch, 128]` L2-normalized embedding + `[batch, 6]` role logits

2. **`ceova_reid_net.pt`**
   - PyTorch model checkpoint / state dictionary.

When `ceova_reid_net.onnx` is present in this directory, CEOVA CCTV automatically boots the deep neural network engine for sub-millisecond, illumination-invariant Re-ID.
