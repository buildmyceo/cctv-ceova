/**
 * CEOVA CCTV // Identity Engine
 * identity/staff/feature_extraction.js
 * 
 * Orchestrates multi-view feature extraction (front, side, back, face)
 * for staff enrollment and real-time live match processing.
 */

const { ReidExtractor } = require('../../vision/reid/reid_extractor');
const { QualityChecker } = require('../../vision/quality/quality_checker');

class StaffFeatureExtractor {
  constructor() {
    this.reidExtractor = new ReidExtractor();
    this.qualityChecker = new QualityChecker();
  }

  /**
   * Process a person crop for staff enrollment
   * @param {Object} crop - { width, height, data: Buffer }
   * @param {string} viewType - 'FRONT', 'SIDE', 'BACK'
   * @returns {Object} { success: boolean, embedding, quality, error }
   */
  extractStaffBodyFeatures(crop, viewType = 'FRONT') {
    // 1. Image Quality Check
    const quality = this.qualityChecker.assessQuality(crop);
    if (!quality.isUsable) {
      return {
        success: false,
        error: `Image quality check failed: ${quality.rejectionReasons.join(', ')}`,
        quality
      };
    }

    // 2. Extract 128-d Body Re-ID Embedding
    const reidResult = this.reidExtractor.extractEmbedding(crop);

    return {
      success: true,
      viewType,
      embedding: reidResult.embedding,
      dominantColors: reidResult.dominantColors,
      quality
    };
  }
}

module.exports = {
  StaffFeatureExtractor
};
