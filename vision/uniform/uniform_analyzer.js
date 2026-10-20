/**
 * CEOVA CCTV // Vision Engine
 * vision/uniform/uniform_analyzer.js
 * 
 * Staff Uniform Detection & Clothing Analysis Module.
 * 
 * Analyzes torso clothing for color consistency, fabric patterns, and badges/vests.
 * 
 * CRITICAL ARCHITECTURAL RULE:
 * Uniform probability is STRICTLY supporting evidence.
 * Even uniform_probability = 0.99 NEVER automatically equals STAFF = TRUE!
 */

// Convert RGB to CIELAB for perceptual color difference (Delta-E)
function rgbToLab(r, g, b) {
  // 1. RGB to XYZ
  let rL = r / 255;
  let gL = g / 255;
  let bL = b / 255;

  rL = (rL > 0.04045) ? Math.pow((rL + 0.055) / 1.055, 2.4) : rL / 12.92;
  gL = (gL > 0.04045) ? Math.pow((gL + 0.055) / 1.055, 2.4) : gL / 12.92;
  bL = (bL > 0.04045) ? Math.pow((bL + 0.055) / 1.055, 2.4) : bL / 12.92;

  let x = (rL * 0.4124 + gL * 0.3576 + bL * 0.1805) / 0.95047;
  let y = (rL * 0.2126 + gL * 0.7152 + bL * 0.0722) / 1.00000;
  let z = (rL * 0.0193 + gL * 0.1192 + bL * 0.9505) / 1.08883;

  const f = (t) => (t > 0.008856) ? Math.cbrt(t) : (7.787 * t) + (16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);

  const L = (116 * fy) - 16;
  const a = 500 * (fx - fy);
  const bVal = 200 * (fy - fz);

  return [L, a, bVal];
}

// CIELAB Euclidean Delta-E
function deltaE(lab1, lab2) {
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Hex color to RGB
function hexToRgb(hex) {
  const cleaned = hex.replace('#', '');
  const num = parseInt(cleaned, 16);
  return [
    (num >> 16) & 255,
    (num >> 8) & 255,
    num & 255
  ];
}

class UniformAnalyzer {
  constructor(options = {}) {
    // Default uniform profile (Ceova Standard: Navy Blue Polo with optional badge)
    this.uniformProfiles = options.profiles || [
      {
        id: 'UNIFORM-DEFAULT',
        name: 'CEOVA Standard Navy Staff Uniform',
        shirtType: 'POLO',
        primaryColorHex: '#10223D', // Deep Navy Blue
        secondaryColorHex: '#1B3A6B',
        badgeRequired: false,
        patternType: 'SOLID'
      },
      {
        id: 'UNIFORM-SECURITY',
        name: 'CEOVA Security High-Vis / Black Uniform',
        shirtType: 'VEST',
        primaryColorHex: '#1A1A1A', // Tactical Black / Dark Grey
        secondaryColorHex: '#FFFF00', // Yellow High-Vis
        badgeRequired: true,
        patternType: 'SOLID'
      }
    ];
  }

  /**
   * Add or update a uniform profile
   */
  setUniformProfile(profile) {
    const idx = this.uniformProfiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      this.uniformProfiles[idx] = profile;
    } else {
      this.uniformProfiles.push(profile);
    }
  }

  /**
   * Analyze clothing in a person crop against uniform profiles
   * @param {Object} crop - { width, height, data: Buffer }
   * @param {string} profileId - optional profile to test against (or all)
   * @returns {Object} { uniformProbability: number, bestProfile, badgeDetected, isSupportingEvidenceOnly: true }
   */
  analyzeUniform(crop, profileId = null) {
    if (!crop || !crop.data || crop.width < 16 || crop.height < 32) {
      return {
        uniformProbability: 0.0,
        bestProfile: null,
        badgeDetected: false,
        isSupportingEvidenceOnly: true
      };
    }

    const w = crop.width;
    const h = crop.height;
    const data = crop.data;

    // Isolate torso region (y: 25% to 65% height, central 70% width)
    const torsoY1 = Math.floor(h * 0.25);
    const torsoY2 = Math.floor(h * 0.65);
    const torsoX1 = Math.floor(w * 0.15);
    const torsoX2 = Math.floor(w * 0.85);

    // Compute average and dominant color in torso in Lab space
    let sumL = 0, sumA = 0, sumB = 0;
    let sampleCount = 0;

    for (let y = torsoY1; y < torsoY2; y += 2) {
      for (let x = torsoX1; x < torsoX2; x += 2) {
        const idx = (y * w + x) * 4;
        const [L, a, bVal] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
        sumL += L;
        sumA += a;
        sumB += bVal;
        sampleCount++;
      }
    }

    if (sampleCount === 0) {
      return { uniformProbability: 0.0, bestProfile: null, badgeDetected: false, isSupportingEvidenceOnly: true };
    }

    const torsoLab = [sumL / sampleCount, sumA / sampleCount, sumB / sampleCount];

    // Badge / Chest patch detection (Upper chest area x: 18%-42%, y: 28%-42%)
    const badgeX1 = Math.floor(w * 0.18);
    const badgeX2 = Math.floor(w * 0.42);
    const badgeY1 = Math.floor(h * 0.28);
    const badgeY2 = Math.floor(h * 0.42);

    let badgeContrastSum = 0;
    let badgePixels = 0;

    for (let y = badgeY1; y < badgeY2; y++) {
      for (let x = badgeX1; x < badgeX2; x++) {
        const idx = (y * w + x) * 4;
        const [L] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
        const diff = Math.abs(L - torsoLab[0]);
        if (diff > 25) {
          badgeContrastSum++;
        }
        badgePixels++;
      }
    }

    const badgeRatio = badgePixels > 0 ? (badgeContrastSum / badgePixels) : 0;
    const badgeDetected = badgeRatio > 0.08 && badgeRatio < 0.45; // Localized patch, not entire chest

    // Evaluate match against uniform profiles
    const profilesToTest = profileId 
      ? this.uniformProfiles.filter(p => p.id === profileId)
      : this.uniformProfiles;

    let bestProbability = 0.0;
    let bestMatchedProfile = null;

    for (const prof of profilesToTest) {
      const targetRgb = hexToRgb(prof.primaryColorHex);
      const targetLab = rgbToLab(targetRgb[0], targetRgb[1], targetRgb[2]);

      const dist = deltaE(torsoLab, targetLab);

      // Delta-E interpretation:
      // < 15: Very close match
      // 15 - 35: Plausible match under lighting/shadows
      // > 45: Dissimilar color
      let colorScore = 0.0;
      if (dist < 15) {
        colorScore = 1.0 - (dist / 30);
      } else if (dist < 38) {
        colorScore = Math.max(0.2, 1.0 - (dist / 45));
      } else {
        colorScore = Math.max(0.0, 0.4 - (dist / 100));
      }

      // Badge bonus/penalty
      let badgeScore = 0.5;
      if (prof.badgeRequired) {
        badgeScore = badgeDetected ? 1.0 : 0.3;
      } else if (badgeDetected) {
        badgeScore = 0.9;
      }

      const probability = Number((colorScore * 0.70 + badgeScore * 0.30).toFixed(3));

      if (probability > bestProbability) {
        bestProbability = probability;
        bestMatchedProfile = prof;
      }
    }

    return {
      uniformProbability: bestProbability,
      matchedProfile: bestMatchedProfile ? bestMatchedProfile.name : null,
      profileId: bestMatchedProfile ? bestMatchedProfile.id : null,
      badgeDetected,
      torsoLab: [Number(torsoLab[0].toFixed(1)), Number(torsoLab[1].toFixed(1)), Number(torsoLab[2].toFixed(1))],
      // Explicit architectural enforcement:
      isSupportingEvidenceOnly: true,
      note: 'Uniform probability is strictly supporting evidence and NEVER equals STAFF independently.'
    };
  }
}

module.exports = {
  UniformAnalyzer,
  rgbToLab,
  deltaE
};
