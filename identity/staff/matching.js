/**
 * CEOVA CCTV // Identity Engine
 * identity/staff/matching.js
 * 
 * Staff Matching Engine.
 * Compares live person Re-ID appearance embeddings against enrolled staff profiles.
 * Utilizes in-memory decrypted feature caching for sub-millisecond match evaluation.
 */

const { ReidExtractor } = require('../../vision/reid/reid_extractor');
const { decryptEmbedding } = require('../../security/encryption');
const { getDatabase } = require('../../db/database');

class StaffMatcher {
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.reidExtractor = new ReidExtractor(options);
    this.staffFeaturesCache = new Map(); // staffId -> Array<{ type, embedding }>
    this.cacheTimestamp = 0;
    this.cacheTtlMs = 60000; // 1 minute cache TTL
  }

  /**
   * Invalidate and reload feature cache from database
   */
  reloadCache(organizationId = 'ORG-DEFAULT') {
    this.staffFeaturesCache.clear();

    const query = `
      SELECT sf.staff_id, sf.feature_type, sf.encrypted_embedding, sp.employee_id, sp.full_name, sp.role, sp.authorized_zones
      FROM staff_features sf
      JOIN staff_profiles sp ON sf.staff_id = sp.id
      WHERE sp.organization_id = ? AND sp.active = 1
    `;

    const rows = this.db.all(query, [organizationId]);

    for (const row of rows) {
      if (!this.staffFeaturesCache.has(row.staff_id)) {
        this.staffFeaturesCache.set(row.staff_id, {
          staffId: row.staff_id,
          employeeId: row.employee_id,
          fullName: row.full_name,
          role: row.role,
          authorizedZones: JSON.parse(row.authorized_zones || '[]'),
          features: []
        });
      }

      try {
        const decryptedVec = decryptEmbedding(row.encrypted_embedding);
        this.staffFeaturesCache.get(row.staff_id).features.push({
          type: row.feature_type,
          embedding: decryptedVec
        });
      } catch (err) {
        console.error(`Failed to decrypt feature for staff ${row.employee_id}:`, err.message);
      }
    }

    this.cacheTimestamp = Date.now();
  }

  /**
   * Compare a detected person's Re-ID embedding against all enrolled staff
   * @param {Float32Array|Array<number>} personEmbedding 
   * @param {string} organizationId 
   * @returns {Object} { matched: boolean, bestCandidate, candidates: Array }
   */
  matchStaff(personEmbedding, organizationId = 'ORG-DEFAULT') {
    if (!personEmbedding) {
      return { matched: false, bestCandidate: null, candidates: [] };
    }

    if (Date.now() - this.cacheTimestamp > this.cacheTtlMs || this.staffFeaturesCache.size === 0) {
      this.reloadCache(organizationId);
    }

    const candidates = [];

    for (const [staffId, staffData] of this.staffFeaturesCache.entries()) {
      let maxSim = 0;
      let bestView = null;

      for (const feat of staffData.features) {
        const result = this.reidExtractor.computeSimilarity(personEmbedding, feat.embedding);
        if (result.similarity > maxSim) {
          maxSim = result.similarity;
          bestView = feat.type;
        }
      }

      candidates.push({
        staffId,
        employeeId: staffData.employeeId,
        fullName: staffData.fullName,
        role: staffData.role,
        authorizedZones: staffData.authorizedZones,
        bestView,
        score: maxSim
      });
    }

    // Sort descending by similarity score
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0] || null;
    const isStrongMatch = best && best.score >= this.reidExtractor.strongMatchThreshold;

    return {
      matched: isStrongMatch,
      bestCandidate: best,
      candidates: candidates.slice(0, 5) // Return top 5 candidates
    };
  }
}

module.exports = {
  StaffMatcher
};
