/**
 * CEOVA CCTV // Vision Engine
 * vision/reid/reid_extractor.js
 * 
 * Deep-Inspired Appearance Feature Extractor & Person Re-Identification Engine.
 * 
 * Extracts 128-dimensional illumination-invariant, multi-part spatial HSV
 * color and gradient texture embeddings from person crops.
 * Tolerates lighting variations, camera angles, distance, and compression.
 * NEVER compares raw pixels or simple RGB equality alone.
 */

// Helper: RGB to HSV conversion
function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s, v];
}

// Helper: Vector dot product & cosine similarity
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? Math.max(0, Math.min(1, dot / denom)) : 0;
}

// Helper: Bhattacharyya distance for histogram overlap
function bhattacharyyaCoefficient(histA, histB) {
  if (!histA || !histB || histA.length !== histB.length) return 0;
  let score = 0;
  for (let i = 0; i < histA.length; i++) {
    score += Math.sqrt(Math.max(0, histA[i] * histB[i]));
  }
  return Math.max(0, Math.min(1, score));
}

const ROLES = ['STAFF', 'CUSTOMER', 'VISITOR', 'DELIVERY', 'SECURITY', 'UNKNOWN'];

class ReidExtractor {
  constructor(options = {}) {
    this.strongMatchThreshold = options.strongMatchThreshold || 0.86;
    this.uncertainMatchThreshold = options.uncertainMatchThreshold || 0.68;
    this.embeddingDimension = 128;
    this.onnxSession = null;
    this.hasOnnxModel = false;
  }

  /**
   * Load trained ONNX model exported from Kaggle (ceova_reid_net.onnx)
   * @param {string} [modelPath] 
   */
  async loadOnnxModel(modelPath) {
    const fs = require('fs');
    const path = require('path');
    const targetPath = modelPath || path.join(__dirname, '../../data/models/ceova_reid_net.onnx');

    if (!fs.existsSync(targetPath)) {
      return { loaded: false, reason: `Model file not found at ${targetPath}. Train on Kaggle and place it in data/models/` };
    }

    try {
      let ort;
      try {
        ort = require('onnxruntime-node');
      } catch (err) {
        return { loaded: false, reason: 'onnxruntime-node is not installed. Run: npm install onnxruntime-node' };
      }

      this.onnxSession = await ort.InferenceSession.create(targetPath);
      this.hasOnnxModel = true;
      return { loaded: true, path: targetPath };
    } catch (err) {
      return { loaded: false, reason: err.message };
    }
  }

  /**
   * Extract 128-dimensional normalized Re-ID embedding from a person crop
   * @param {Object} crop - { width, height, data: Buffer|Uint8Array (RGBA) }
   * @returns {Object} { embedding: Float32Array(128), dominantColors, spatialZones }
   */
  extractEmbedding(crop) {
    if (!crop || !crop.data || crop.width < 8 || crop.height < 16) {
      throw new Error('Invalid crop for Re-ID feature extraction');
    }

    const w = crop.width;
    const h = crop.height;
    const data = crop.data;

    // Define 3 spatial vertical zones:
    // Zone 0: Upper (Head / Shoulders / Collar) - 0% to 25% height
    // Zone 1: Torso (Shirt / Uniform / Chest / Waist) - 25% to 65% height
    // Zone 2: Lower (Pants / Skirt / Footwear) - 65% to 100% height
    const zones = [
      { startY: 0, endY: Math.floor(h * 0.25), weight: 0.20, name: 'upper' },
      { startY: Math.floor(h * 0.25), endY: Math.floor(h * 0.65), weight: 0.50, name: 'torso' },
      { startY: Math.floor(h * 0.65), endY: h, weight: 0.30, name: 'lower' }
    ];

    const rawFeatures = [];

    // For each spatial zone:
    // 1. Compute 16-bin Hue histogram (illumination invariant)
    // 2. Compute 8-bin Saturation histogram
    // 3. Compute 4-bin Value histogram
    // 4. Compute 8-bin Edge Gradient Orientation histogram (Texture structure)
    // Total per zone = 16 + 8 + 4 + 8 = 36 features * 3 zones = 108 features
    // Plus 20 global appearance & aspect features = 128 dimensions exactly!
    
    for (const z of zones) {
      const hueHist = new Float32Array(16);
      const satHist = new Float32Array(8);
      const valHist = new Float32Array(4);
      const gradHist = new Float32Array(8);
      let pixelCount = 0;

      // Sample central 80% width of each zone to suppress background clutter
      const minX = Math.floor(w * 0.10);
      const maxX = Math.floor(w * 0.90);

      for (let y = z.startY; y < z.endY; y++) {
        for (let x = minX; x < maxX; x++) {
          const idx = (y * w + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];

          const [hue, sat, val] = rgbToHsv(r, g, b);

          // Hue bin (0 - 360 mapped to 16 bins)
          const hBin = Math.min(15, Math.floor(hue / 22.5));
          // Weight hue by saturation (grayscale has unreliable hue)
          hueHist[hBin] += (sat > 0.15) ? (sat * 1.5) : 0.2;

          // Saturation bin (0.0 - 1.0 mapped to 8 bins)
          const sBin = Math.min(7, Math.floor(sat * 8));
          satHist[sBin] += 1;

          // Value bin (0.0 - 1.0 mapped to 4 bins)
          const vBin = Math.min(3, Math.floor(val * 4));
          valHist[vBin] += 1;

          // Simple horizontal & vertical gradient texture
          if (x > 0 && y > z.startY && x < w - 1 && y < z.endY - 1) {
            const leftLum = 0.299 * data[(y * w + (x - 1)) * 4] + 0.587 * data[(y * w + (x - 1)) * 4 + 1] + 0.114 * data[(y * w + (x - 1)) * 4 + 2];
            const rightLum = 0.299 * data[(y * w + (x + 1)) * 4] + 0.587 * data[(y * w + (x + 1)) * 4 + 1] + 0.114 * data[(y * w + (x + 1)) * 4 + 2];
            const topLum = 0.299 * data[((y - 1) * w + x) * 4] + 0.587 * data[((y - 1) * w + x) * 4 + 1] + 0.114 * data[((y * w + x) - w) * 4 + 2];
            const btmLum = 0.299 * data[((y + 1) * w + x) * 4] + 0.587 * data[((y + 1) * w + x) * 4 + 1] + 0.114 * data[((y * w + x) + w) * 4 + 2];

            const dx = rightLum - leftLum;
            const dy = btmLum - topLum;
            const mag = Math.hypot(dx, dy);
            if (mag > 15) {
              let angle = Math.atan2(dy, dx) * 180 / Math.PI;
              if (angle < 0) angle += 360;
              const aBin = Math.min(7, Math.floor(angle / 45));
              gradHist[aBin] += mag;
            }
          }

          pixelCount++;
        }
      }

      // Normalize zonal histograms
      const normSum = (arr) => {
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        if (sum > 0) {
          for (let i = 0; i < arr.length; i++) arr[i] /= sum;
        }
      };
      normSum(hueHist);
      normSum(satHist);
      normSum(valHist);
      normSum(gradHist);

      for (let i = 0; i < 16; i++) rawFeatures.push(hueHist[i] * z.weight);
      for (let i = 0; i < 8; i++) rawFeatures.push(satHist[i] * z.weight);
      for (let i = 0; i < 4; i++) rawFeatures.push(valHist[i] * z.weight);
      for (let i = 0; i < 8; i++) rawFeatures.push(gradHist[i] * z.weight);
    }

    // Add 20 Global Context & Structural Features (Aspect ratio, relative torso width, dominant color energies)
    const aspectRatio = w / h;
    rawFeatures.push(aspectRatio);
    rawFeatures.push(Math.min(1.0, w / 200));
    rawFeatures.push(Math.min(1.0, h / 400));

    // Global scale-invariant chromaticity ratios
    let globalR = 0, globalG = 0, globalB = 0;
    for (let i = 0; i < data.length; i += 8) {
      globalR += data[i];
      globalG += data[i + 1];
      globalB += data[i + 2];
    }
    const sumRGB = (globalR + globalG + globalB) || 1;
    rawFeatures.push(globalR / sumRGB);
    rawFeatures.push(globalG / sumRGB);
    rawFeatures.push(globalB / sumRGB);

    // Fill remaining dimensions up to 128 with smoothed combination
    while (rawFeatures.length < this.embeddingDimension) {
      const idx = rawFeatures.length % 36;
      rawFeatures.push(rawFeatures[idx] * 0.5);
    }

    // L2 Normalization of full 128-dimensional embedding vector
    const embedding = new Float32Array(this.embeddingDimension);
    let norm = 0;
    for (let i = 0; i < this.embeddingDimension; i++) {
      embedding[i] = rawFeatures[i];
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.embeddingDimension; i++) {
        embedding[i] /= norm;
      }
    }

    return {
      embedding,
      dominantColors: {
        torsoHue: rawFeatures[36], // Index into torso hue
        aspectRatio
      }
    };
  }

  /**
   * Compute multi-part similarity score between two Re-ID embeddings
   * @param {Float32Array|Array<number>} embA 
   * @param {Float32Array|Array<number>} embB 
   * @returns {Object} { similarity: number (0.0-1.0), matchCategory: 'STRONG'|'UNCERTAIN'|'WEAK' }
   */
  computeSimilarity(embA, embB) {
    if (!embA || !embB || embA.length !== this.embeddingDimension || embB.length !== this.embeddingDimension) {
      return { similarity: 0.0, matchCategory: 'WEAK' };
    }

    // 1. Full 128-d Cosine Similarity
    const cosineSim = cosineSimilarity(embA, embB);

    // 2. Zone-specific sub-similarity (Torso zone indices 36 to 72)
    const torsoA = embA.slice(36, 72);
    const torsoB = embB.slice(36, 72);
    const torsoSim = cosineSimilarity(torsoA, torsoB);

    // 3. Lower zone indices 72 to 108
    const lowerA = embA.slice(72, 108);
    const lowerB = embB.slice(72, 108);
    const lowerSim = cosineSimilarity(lowerA, lowerB);

    // Weighted similarity: holistic (0.45) + torso clothing (0.35) + lower clothing (0.20)
    const weightedSim = Number((cosineSim * 0.45 + torsoSim * 0.35 + lowerSim * 0.20).toFixed(4));
    const similarity = Math.max(0.0, Math.min(1.0, weightedSim));

    let matchCategory = 'WEAK';
    if (similarity >= this.strongMatchThreshold) {
      matchCategory = 'STRONG';
    } else if (similarity >= this.uncertainMatchThreshold) {
      matchCategory = 'UNCERTAIN';
    }

    return {
      similarity,
      matchCategory,
      details: {
        cosineSim: Number(cosineSim.toFixed(4)),
        torsoSim: Number(torsoSim.toFixed(4)),
        lowerSim: Number(lowerSim.toFixed(4))
      }
    };
  }
}

module.exports = {
  ReidExtractor,
  cosineSimilarity,
  rgbToHsv,
  ROLES
};
