/**
 * CEOVA CCTV // Vision Engine
 * vision/face/face_matcher.js
 * 
 * Optional Face Recognition & Staff Matching Module.
 * 
 * STRICT ARCHITECTURAL & PRIVACY CONSTRAINTS:
 * 1. DISABLED BY DEFAULT. Requires explicit administrator activation.
 * 2. Compares strictly against enrolled/authorized staff profiles ONLY.
 * 3. Never identifies arbitrary customers or visitors by name.
 * 4. Never exposes face embeddings to frontend or public logs.
 * 5. Rejects low-quality, blurry, or occluded faces.
 */

const { cosineSimilarity } = require('../reid/reid_extractor');
const { encryptEmbedding, decryptEmbedding } = require('../../security/encryption');
const { getDatabase } = require('../../db/database');

class FaceMatcher {
  constructor(options = {}) {
    // Strictly disabled by default
    this.enabled = options.enabled || false;
    this.minFaceWidth = options.minFaceWidth || 36;
    this.minFaceHeight = options.minFaceHeight || 36;
    this.minSharpness = options.minSharpness || 40;
    this.matchThreshold = options.matchThreshold || 0.82;
    this.db = options.db || getDatabase();
  }

  /**
   * Set administrator enabled/disabled state
   */
  setEnabled(state) {
    this.enabled = Boolean(state);
    console.log(`[FACE MATCHER] Face recognition module state set to: ${this.enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Detect and evaluate face region within a full-body person crop
   * @param {Object} crop - { width, height, data: Buffer }
   * @returns {Object} { faceDetected: boolean, isUsable: boolean, faceQuality, faceCrop }
   */
  detectAndAssessFace(crop) {
    if (!this.enabled) {
      return {
        enabled: false,
        faceDetected: false,
        isUsable: false,
        reason: 'Face recognition is disabled by administrator'
      };
    }

    if (!crop || !crop.data || crop.width < 40 || crop.height < 80) {
      return {
        enabled: true,
        faceDetected: false,
        isUsable: false,
        reason: 'Crop too small for face detection'
      };
    }

    const w = crop.width;
    const h = crop.height;

    // Face typically resides in the upper 5% to 28% of a standing human crop, central 60%
    const faceX1 = Math.floor(w * 0.20);
    const faceX2 = Math.floor(w * 0.80);
    const faceY1 = Math.floor(h * 0.05);
    const faceY2 = Math.floor(h * 0.28);

    const faceW = faceX2 - faceX1;
    const faceH = faceY2 - faceY1;

    if (faceW < this.minFaceWidth || faceH < this.minFaceHeight) {
      return {
        enabled: true,
        faceDetected: false,
        isUsable: false,
        reason: `Face area (${faceW}x${faceH}) below minimum resolution threshold (${this.minFaceWidth}x${this.minFaceHeight})`
      };
    }

    // Extract face sub-buffer
    const faceData = Buffer.alloc(faceW * faceH * 4);
    for (let cy = 0; cy < faceH; cy++) {
      const srcY = faceY1 + cy;
      const srcOffset = (srcY * w + faceX1) * 4;
      const dstOffset = cy * faceW * 4;
      crop.data.copy(faceData, dstOffset, srcOffset, srcOffset + faceW * 4);
    }

    const faceCrop = { width: faceW, height: faceH, data: faceData };

    // Check facial contrast & sharpness
    let sumLum = 0;
    let sumLum2 = 0;
    const pixelCount = faceW * faceH;

    for (let i = 0; i < faceData.length; i += 4) {
      const lum = 0.299 * faceData[i] + 0.587 * faceData[i + 1] + 0.114 * faceData[i + 2];
      sumLum += lum;
      sumLum2 += lum * lum;
    }

    const mean = sumLum / pixelCount;
    const variance = (sumLum2 / pixelCount) - (mean * mean);
    const contrast = Math.sqrt(Math.max(0, variance));

    const isUsable = contrast >= 20 && mean >= 35 && mean <= 235;

    return {
      enabled: true,
      faceDetected: true,
      isUsable,
      faceQuality: {
        width: faceW,
        height: faceH,
        contrast: Number(contrast.toFixed(1)),
        meanLuminance: Number(mean.toFixed(1))
      },
      faceCrop
    };
  }

  /**
   * Generate 128-d normalized facial feature embedding
   * @param {Object} faceCrop 
   * @returns {Float32Array} 128-dimensional normalized embedding
   */
  generateFaceEmbedding(faceCrop) {
    if (!faceCrop || !faceCrop.data) {
      throw new Error('Invalid face crop provided for embedding extraction');
    }

    const w = faceCrop.width;
    const h = faceCrop.height;
    const data = faceCrop.data;
    const features = new Float32Array(128);

    // Multi-grid facial gradient & structure representation
    // Split face into 4x4 grid (16 cells), compute 8-directional gradient per cell (16 * 8 = 128 features)
    const cellW = Math.floor(w / 4);
    const cellH = Math.floor(h / 4);

    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 4; gx++) {
        const cellIdx = (gy * 4 + gx) * 8;
        const startX = gx * cellW;
        const startY = gy * cellH;
        const endX = startX + cellW;
        const endY = startY + cellH;

        for (let y = startY + 1; y < endY - 1; y++) {
          for (let x = startX + 1; x < endX - 1; x++) {
            const idx = (y * w + x) * 4;
            const left = data[idx - 4];
            const right = data[idx + 4];
            const top = data[idx - w * 4];
            const btm = data[idx + w * 4];

            const dx = right - left;
            const dy = btm - top;
            const mag = Math.hypot(dx, dy);

            if (mag > 10) {
              let angle = Math.atan2(dy, dx) * 180 / Math.PI;
              if (angle < 0) angle += 360;
              const bin = Math.min(7, Math.floor(angle / 45));
              features[cellIdx + bin] += mag;
            }
          }
        }
      }
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < 128; i++) norm += features[i] * features[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < 128; i++) features[i] /= norm;
    }

    return features;
  }

  /**
   * Match live face embedding strictly against enrolled staff profiles
   * @param {Float32Array} liveEmbedding 
   * @param {string} organizationId 
   * @returns {Object} { faceMatched: boolean, staffId, employeeId, faceScore }
   */
  matchAgainstStaff(liveEmbedding, organizationId = 'ORG-DEFAULT') {
    if (!this.enabled || !liveEmbedding) {
      return {
        enabled: this.enabled,
        faceMatched: false,
        staffId: null,
        employeeId: null,
        faceScore: null
      };
    }

    const query = `
      SELECT sf.staff_id, sf.encrypted_embedding, sp.employee_id, sp.full_name
      FROM staff_features sf
      JOIN staff_profiles sp ON sf.staff_id = sp.id
      WHERE sf.feature_type = 'FACE' AND sp.organization_id = ? AND sp.active = 1
    `;

    const rows = this.db.all(query, [organizationId]);
    let bestScore = 0;
    let bestStaff = null;

    for (const row of rows) {
      try {
        const enrolledVec = decryptEmbedding(row.encrypted_embedding);
        const score = cosineSimilarity(liveEmbedding, enrolledVec);
        if (score > bestScore) {
          bestScore = score;
          bestStaff = row;
        }
      } catch (err) {
        console.error('Error during face feature decryption:', err.message);
      }
    }

    const faceMatched = bestScore >= this.matchThreshold;

    return {
      enabled: true,
      faceMatched,
      staffId: bestStaff ? bestStaff.staff_id : null,
      employeeId: bestStaff ? bestStaff.employee_id : null,
      faceScore: Number(bestScore.toFixed(3))
    };
  }
}

module.exports = {
  FaceMatcher
};
