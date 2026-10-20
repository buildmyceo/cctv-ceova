/**
 * CEOVA CCTV // Vision Engine
 * vision/quality/quality_checker.js
 * 
 * Person Crop Extraction & Comprehensive Image Quality Assessor.
 * Evaluates resolution, aspect ratio, illumination, contrast, sharpness,
 * and boundary occlusion to filter out unusable crops before Re-ID.
 */

class QualityChecker {
  constructor(options = {}) {
    this.minWidth = options.minWidth || 48;
    this.minHeight = options.minHeight || 100;
    this.minArea = options.minArea || 4800; // 48 * 100
    this.minAspectRatio = options.minAspectRatio || 0.20;
    this.maxAspectRatio = options.maxAspectRatio || 0.85;
    this.minLuminance = options.minLuminance || 30;
    this.maxLuminance = options.maxLuminance || 230;
    this.minContrast = options.minContrast || 22;
    this.minSharpness = options.minSharpness || 45; // Laplacian variance threshold
  }

  /**
   * Extract person crop sub-image from a full frame pixel buffer
   * @param {Object} frame - { width, height, data: Buffer|Uint8Array (RGBA) }
   * @param {Array<number>} bbox - [x, y, width, height]
   * @param {number} paddingRatio - optional padding around person (default: 0.05)
   * @returns {Object} Crop object { width, height, data, bbox, isPadded }
   */
  extractPersonCrop(frame, bbox, paddingRatio = 0.05) {
    if (!frame || !frame.data || !frame.width || !frame.height) {
      throw new Error('Invalid frame provided for crop extraction');
    }

    const [bx, by, bw, bh] = bbox;
    const padX = Math.round(bw * paddingRatio);
    const padY = Math.round(bh * paddingRatio);

    const x1 = Math.max(0, Math.floor(bx - padX));
    const y1 = Math.max(0, Math.floor(by - padY));
    const x2 = Math.min(frame.width, Math.ceil(bx + bw + padX));
    const y2 = Math.min(frame.height, Math.ceil(by + bh + padY));

    const cropW = Math.max(1, x2 - x1);
    const cropH = Math.max(1, y2 - y1);
    const cropData = Buffer.alloc(cropW * cropH * 4);

    for (let cy = 0; cy < cropH; cy++) {
      const srcY = y1 + cy;
      const srcOffset = (srcY * frame.width + x1) * 4;
      const dstOffset = cy * cropW * 4;
      const rowBytes = cropW * 4;
      frame.data.copy(cropData, dstOffset, srcOffset, srcOffset + rowBytes);
    }

    return {
      width: cropW,
      height: cropH,
      data: cropData,
      originalBbox: bbox,
      cropBbox: [x1, y1, cropW, cropH]
    };
  }

  /**
   * Assess the visual and structural quality of a person crop
   * @param {Object} crop - { width, height, data: Buffer|Uint8Array (RGBA) }
   * @param {Object} frameDimensions - optional full frame { width, height } for boundary check
   * @returns {Object} Quality result { isUsable, qualityScore, metrics, rejectionReasons }
   */
  assessQuality(crop, frameDimensions = null) {
    const reasons = [];
    if (!crop || !crop.data || crop.width <= 0 || crop.height <= 0) {
      return {
        isUsable: false,
        qualityScore: 0,
        rejectionReasons: ['Invalid or empty crop buffer'],
        metrics: {}
      };
    }

    const w = crop.width;
    const h = crop.height;
    const area = w * h;
    const aspectRatio = w / h;

    // 1. Resolution & Area check
    let resScore = 1.0;
    if (w < this.minWidth || h < this.minHeight || area < this.minArea) {
      resScore = Math.max(0.1, (area / this.minArea));
      reasons.push(`Low resolution (${w}x${h} < ${this.minWidth}x${this.minHeight})`);
    }

    // 2. Aspect Ratio check (Human proportions)
    let aspectScore = 1.0;
    if (aspectRatio < this.minAspectRatio || aspectRatio > this.maxAspectRatio) {
      aspectScore = 0.4;
      reasons.push(`Abnormal human aspect ratio (${aspectRatio.toFixed(2)})`);
    }

    // 3. Luminance (Brightness) & Contrast (Standard Deviation)
    let sumL = 0;
    let sumL2 = 0;
    const pixelCount = w * h;
    const step = pixelCount > 40000 ? Math.floor(pixelCount / 20000) : 1;
    let sampledCount = 0;

    // Fast luminance calculation: Y = 0.299*R + 0.587*G + 0.114*B
    for (let i = 0; i < crop.data.length; i += 4 * step) {
      const r = crop.data[i];
      const g = crop.data[i + 1];
      const b = crop.data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumL += lum;
      sumL2 += lum * lum;
      sampledCount++;
    }

    const meanLuminance = sumL / sampledCount;
    const variance = (sumL2 / sampledCount) - (meanLuminance * meanLuminance);
    const contrast = Math.sqrt(Math.max(0, variance));

    let brightnessScore = 1.0;
    if (meanLuminance < this.minLuminance) {
      brightnessScore = Math.max(0.1, meanLuminance / this.minLuminance);
      reasons.push(`Underexposed/Too dark (luminance: ${meanLuminance.toFixed(1)})`);
    } else if (meanLuminance > this.maxLuminance) {
      brightnessScore = Math.max(0.1, (255 - meanLuminance) / (255 - this.maxLuminance));
      reasons.push(`Overexposed/Washed out (luminance: ${meanLuminance.toFixed(1)})`);
    }

    let contrastScore = 1.0;
    if (contrast < this.minContrast) {
      contrastScore = Math.max(0.1, contrast / this.minContrast);
      reasons.push(`Low contrast/Flat image (contrast: ${contrast.toFixed(1)})`);
    }

    // 4. Sharpness / Blur Detection (Laplacian Gradient Variance)
    let laplacianVar = this._computeLaplacianVariance(crop, step);
    let sharpnessScore = 1.0;
    if (laplacianVar < this.minSharpness) {
      sharpnessScore = Math.max(0.15, laplacianVar / this.minSharpness);
      reasons.push(`Excessive blur or motion blur (sharpness: ${laplacianVar.toFixed(1)})`);
    }

    // 5. Boundary Occlusion / Truncation Check
    let occlusionScore = 1.0;
    if (crop.cropBbox && frameDimensions) {
      const [cx, cy, cw, ch] = crop.cropBbox;
      const margin = 4;
      const atEdge = (
        cx <= margin ||
        cy <= margin ||
        (cx + cw) >= (frameDimensions.width - margin) ||
        (cy + ch) >= (frameDimensions.height - margin)
      );
      if (atEdge) {
        occlusionScore = 0.75; // Penalize truncated border crops
      }
    }

    // Composite Quality Score [0.0 - 1.0]
    const overallQuality = Number((
      resScore * 0.25 +
      aspectScore * 0.15 +
      brightnessScore * 0.20 +
      contrastScore * 0.15 +
      sharpnessScore * 0.20 +
      occlusionScore * 0.05
    ).toFixed(3));

    const isUsable = (
      overallQuality >= 0.50 &&
      w >= this.minWidth &&
      h >= this.minHeight &&
      meanLuminance >= this.minLuminance * 0.75 &&
      meanLuminance <= this.maxLuminance * 1.08 &&
      contrast >= this.minContrast * 0.70
    );

    return {
      isUsable,
      qualityScore: overallQuality,
      rejectionReasons: reasons,
      metrics: {
        width: w,
        height: h,
        aspectRatio: Number(aspectRatio.toFixed(2)),
        meanLuminance: Number(meanLuminance.toFixed(1)),
        contrast: Number(contrast.toFixed(1)),
        sharpness: Number(laplacianVar.toFixed(1)),
        occlusionScore
      }
    };
  }

  /**
   * Internal fast Laplacian variance approximation on grayscale luminance
   */
  _computeLaplacianVariance(crop, step = 1) {
    const w = crop.width;
    const h = crop.height;
    if (w < 8 || h < 8) return 0;

    let lapSum = 0;
    let lapSum2 = 0;
    let count = 0;

    // Sample inner 80% to avoid border artifacts
    const startX = Math.floor(w * 0.1);
    const endX = Math.floor(w * 0.9);
    const startY = Math.floor(h * 0.1);
    const endY = Math.floor(h * 0.9);

    const data = crop.data;
    const getLum = (x, y) => {
      const idx = (y * w + x) * 4;
      return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    };

    for (let y = startY; y < endY; y += step * 2) {
      for (let x = startX; x < endX; x += step * 2) {
        // Discrete Laplacian kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]]
        const c = getLum(x, y);
        const top = getLum(x, y - 1);
        const btm = getLum(x, y + 1);
        const left = getLum(x - 1, y);
        const right = getLum(x + 1, y);

        const lap = top + btm + left + right - (4 * c);
        lapSum += lap;
        lapSum2 += lap * lap;
        count++;
      }
    }

    if (count === 0) return 0;
    const mean = lapSum / count;
    const variance = (lapSum2 / count) - (mean * mean);
    return Math.max(0, variance);
  }
}

module.exports = {
  QualityChecker
};
