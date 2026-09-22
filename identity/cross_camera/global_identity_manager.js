/**
 * CEOVA CCTV // Identity Engine
 * identity/cross_camera/global_identity_manager.js
 * 
 * Global Cross-Camera Identity Manager & Temporal Memory.
 * 
 * Tracks people across multiple cameras:
 * e.g. Camera 01 (Track 42) -> Camera 02 (Track 17) -> Camera 05 (Track 81)
 * Links them under a single GLOBAL_TRACK_ID: P-000183.
 * 
 * CRITICAL ARCHITECTURAL PRINCIPLE:
 * Global Track ID (P-000183) is stored strictly SEPARATELY from Staff ID (EMP-001).
 * Temporal memory maintains recent sightings with configurable retention (default: 2 hours).
 */

const { ReidExtractor } = require('../../vision/reid/reid_extractor');
const { TransitionEngine } = require('../../context/transitions/transition_engine');
const { getDatabase } = require('../../db/database');

class GlobalIdentityManager {
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.reidExtractor = new ReidExtractor();
    this.transitionEngine = new TransitionEngine(options.topology);

    // Active global persons in memory: globalTrackId -> GlobalPersonRecord
    this.activePersons = new Map();
    this.localToGlobalMap = new Map(); // "cameraId:localTrackId" -> globalTrackId
    this.retentionMs = options.retentionMs || 2 * 60 * 60 * 1000; // 2 hours active retention
    this.crossCameraReidThreshold = options.reidThreshold || 0.72;
    this.longTermReidThreshold = options.longTermReidThreshold || 0.76;

    this._initSequence();
  }

  _initSequence() {
    try {
      const maxRow = this.db.get('SELECT MAX(CAST(SUBSTR(id, 3) AS INTEGER)) as maxSeq FROM known_persons');
      this.nextGlobalSeq = (maxRow && maxRow.maxSeq) ? (maxRow.maxSeq + 1) : 1;
    } catch (e) {
      this.nextGlobalSeq = 1;
    }
  }

  /**
   * Generate next global track ID (e.g. 'P-000001')
   */
  _generateGlobalTrackId() {
    const id = `P-${String(this.nextGlobalSeq++).padStart(6, '0')}`;
    return id;
  }

  /**
   * Process a camera track observation and assign/associate with global person
   * Checks:
   * 1. Active local track
   * 2. Active cross-camera track (short-term)
   * 3. Persistent Known Persons Gallery (long-term Re-ID memory)
   * 4. If new, registers in long-term memory
   * @param {Object} observation - { cameraId, localTrackId, bbox, embedding, cropImage, timestamp }
   * @returns {Object} Global person record
   */
  processObservation(observation) {
    const {
      cameraId,
      localTrackId,
      bbox = [0, 0, 0, 0],
      embedding = null,
      cropImage = null,
      timestamp = Date.now()
    } = observation;

    const lookupKey = `${cameraId}:${localTrackId}`;

    // 1. If this local track is already associated with an active global person, update it
    if (this.localToGlobalMap.has(lookupKey)) {
      const existingGlobalId = this.localToGlobalMap.get(lookupKey);
      const person = this.activePersons.get(existingGlobalId);
      if (person) {
        person.lastSeenAt = timestamp;
        person.currentCameraId = cameraId;
        person.currentLocalTrackId = localTrackId;
        person.sightings.push({
          timestamp,
          cameraId,
          localTrackId,
          bbox
        });
        if (embedding) {
          person.latestEmbedding = embedding;
        }
        if (cropImage && (!person.thumbnail || cropImage.length > (person.thumbnail.length || 0))) {
          person.thumbnail = cropImage;
        }
        return person;
      }
    }

    // 2. Look for active person seen recently on another camera
    let bestMatchPerson = null;
    let bestMatchScore = 0;

    if (embedding) {
      for (const person of this.activePersons.values()) {
        const transition = this.transitionEngine.evaluateTransition(
          person.currentCameraId,
          person.lastSeenAt,
          cameraId,
          timestamp
        );

        if (!transition.plausible) continue;

        if (person.latestEmbedding) {
          const simResult = this.reidExtractor.computeSimilarity(embedding, person.latestEmbedding);
          const combinedScore = (simResult.similarity * 0.70) + (transition.score * 0.30);

          if (simResult.similarity >= this.crossCameraReidThreshold && combinedScore > bestMatchScore) {
            bestMatchScore = combinedScore;
            bestMatchPerson = person;
          }
        }
      }
    }

    if (bestMatchPerson) {
      const targetPerson = bestMatchPerson;
      targetPerson.lastSeenAt = timestamp;
      targetPerson.currentCameraId = cameraId;
      targetPerson.currentLocalTrackId = localTrackId;
      targetPerson.sightings.push({
        timestamp,
        cameraId,
        localTrackId,
        bbox,
        transitionScore: bestMatchScore
      });
      if (embedding) {
        targetPerson.latestEmbedding = embedding;
      }
      this.localToGlobalMap.set(lookupKey, targetPerson.globalTrackId);
      return targetPerson;
    }

    // 3. Persistent Long-Term Memory (Known Persons Gallery Match)
    let bestKnownMatch = null;
    let bestKnownScore = 0;

    if (embedding && this.db && typeof this.db.listKnownPersons === 'function') {
      try {
        const knownList = this.db.listKnownPersons();
        for (const known of knownList) {
          if (!known.feature_vector || known.feature_vector.length !== 128) continue;

          const simResult = this.reidExtractor.computeSimilarity(embedding, known.feature_vector);
          let score = simResult.similarity;

          // Aspect ratio gating check
          const obsAspect = bbox[3] > 0 ? (bbox[2] / bbox[3]) : 0.5;
          const aspectDiff = Math.abs(obsAspect - (known.aspect_ratio || 0.5));
          if (aspectDiff < 0.15) {
            score += 0.03; // Small bonus for matching body silhouette
          }

          if (score >= this.longTermReidThreshold && score > bestKnownScore) {
            bestKnownScore = score;
            bestKnownMatch = known;
          }
        }
      } catch (err) {
        console.warn('[GLOBAL_ID] Error querying known_persons:', err);
      }
    }

    let targetPerson;

    if (bestKnownMatch) {
      // Recognised a returning human from long-term memory!
      const isRevisit = (timestamp - new Date(bestKnownMatch.last_seen_at).getTime()) > (60 * 1000);
      const newVisitCount = (bestKnownMatch.visit_count || 1) + (isRevisit ? 1 : 0);

      // Adaptively blend body feature vector (0.85 existing + 0.15 current)
      let blendedEmbedding = embedding;
      if (bestKnownMatch.feature_vector && bestKnownMatch.feature_vector.length === 128) {
        const blended = new Float32Array(128);
        let norm = 0;
        for (let i = 0; i < 128; i++) {
          blended[i] = (bestKnownMatch.feature_vector[i] * 0.85) + (embedding[i] * 0.15);
          norm += blended[i] * blended[i];
        }
        norm = Math.sqrt(norm);
        if (norm > 0) {
          for (let i = 0; i < 128; i++) blended[i] /= norm;
        }
        blendedEmbedding = Array.from(blended);
      }

      // Update database profile
      try {
        this.db.updateKnownPerson(bestKnownMatch.id, {
          last_seen_at: new Date(timestamp).toISOString(),
          visit_count: newVisitCount,
          is_active: 1,
          feature_vector: blendedEmbedding,
          thumbnail_data: cropImage || bestKnownMatch.thumbnail_data
        });
      } catch (e) {}

      targetPerson = {
        globalTrackId: bestKnownMatch.id,
        name: bestKnownMatch.name,
        role: bestKnownMatch.role,
        assignedRole: bestKnownMatch.role,
        roleConfidence: bestKnownScore,
        matchScore: bestKnownScore,
        isRecognized: true,
        visitCount: newVisitCount,
        thumbnail: cropImage || bestKnownMatch.thumbnail_data,
        firstSeenAt: new Date(bestKnownMatch.first_seen_at).getTime(),
        lastSeenAt: timestamp,
        currentCameraId: cameraId,
        currentLocalTrackId: localTrackId,
        latestEmbedding: blendedEmbedding,
        sightings: [{ timestamp, cameraId, localTrackId, bbox }]
      };

      console.log(`[GLOBAL_ID] RECOGNIZED returning human: ${targetPerson.name} (${targetPerson.globalTrackId}) [${Math.round(bestKnownScore * 100)}% match, Visit #${newVisitCount}]`);
    } else {
      // 4. Register a brand new distinct person in long-term memory
      const globalTrackId = this._generateGlobalTrackId();
      const defaultName = `Human #${this.nextGlobalSeq - 1}`;
      const obsAspect = bbox[3] > 0 ? Number((bbox[2] / bbox[3]).toFixed(4)) : 0.5;

      targetPerson = {
        globalTrackId,
        name: defaultName,
        role: 'VISITOR',
        assignedRole: 'VISITOR',
        roleConfidence: 0.70,
        matchScore: 1.0,
        isRecognized: false,
        visitCount: 1,
        thumbnail: cropImage || null,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        currentCameraId: cameraId,
        currentLocalTrackId: localTrackId,
        latestEmbedding: embedding,
        sightings: [{ timestamp, cameraId, localTrackId, bbox }]
      };

      // Persist in known_persons database
      if (embedding && this.db && typeof this.db.createKnownPerson === 'function') {
        try {
          this.db.createKnownPerson({
            id: globalTrackId,
            name: defaultName,
            role: 'VISITOR',
            thumbnail_data: cropImage,
            feature_vector: Array.from(embedding),
            aspect_ratio: obsAspect,
            first_seen_at: new Date(timestamp).toISOString(),
            last_seen_at: new Date(timestamp).toISOString(),
            visit_count: 1,
            total_dwell_ms: 0,
            is_active: 1
          });
          console.log(`[GLOBAL_ID] Registered NEW human profile: ${defaultName} (${globalTrackId})`);
        } catch (err) {
          console.warn('[GLOBAL_ID] Error creating known_person:', err);
        }
      }
    }

    this.activePersons.set(targetPerson.globalTrackId, targetPerson);
    this.localToGlobalMap.set(lookupKey, targetPerson.globalTrackId);

    // Save camera track sighting in database
    try {
      this.db.run(
        `INSERT INTO camera_tracks (
          id, global_track_id, camera_id, local_track_id, bbox_json,
          quality_score, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, 1.0, ?, ?)`,
        [
          `CT-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          targetPerson.globalTrackId,
          cameraId,
          localTrackId,
          JSON.stringify(bbox),
          new Date(timestamp).toISOString(),
          new Date(timestamp).toISOString()
        ]
      );
    } catch (e) {}

    return targetPerson;
  }

  /**
   * Associate an enrolled staff ID with a global track
   * Separates global_track_id (P-000183) from staff_id (EMP-001)
   */
  assignStaffIdentity(globalTrackId, staffId, employeeId, confidence = 0.95) {
    const person = this.activePersons.get(globalTrackId);
    if (person) {
      person.staffId = employeeId; // e.g. EMP-001
      person.assignedRole = 'STAFF';
      person.roleConfidence = confidence;

      try {
        this.db.run(
          `UPDATE global_tracks
           SET staff_id = ?, assigned_role = 'STAFF', confidence = ?
           WHERE global_track_id = ?`,
          [staffId, confidence, globalTrackId]
        );
      } catch (e) {}
    }
  }

  /**
   * Assign a role (e.g. CUSTOMER, VISITOR, UNKNOWN) to a global track
   */
  assignRole(globalTrackId, role, confidence = 0.80) {
    const person = this.activePersons.get(globalTrackId);
    if (person) {
      person.assignedRole = role;
      person.roleConfidence = confidence;

      try {
        this.db.run(
          `UPDATE global_tracks
           SET assigned_role = ?, confidence = ?
           WHERE global_track_id = ?`,
          [role, confidence, globalTrackId]
        );
      } catch (e) {}
    }
  }

  /**
   * Get all active global persons
   */
  getActivePersons() {
    this.cleanupExpiredTracks();
    return Array.from(this.activePersons.values());
  }

  /**
   * Get a specific global person by ID
   */
  getPerson(globalTrackId) {
    return this.activePersons.get(globalTrackId) || null;
  }

  /**
   * Purge tracks exceeding retention period
   */
  cleanupExpiredTracks(now = Date.now()) {
    const expiryCutoff = now - this.retentionMs;

    for (const [globalId, person] of this.activePersons.entries()) {
      if (person.lastSeenAt < expiryCutoff) {
        // Remove local mappings
        for (const [key, gId] of this.localToGlobalMap.entries()) {
          if (gId === globalId) {
            this.localToGlobalMap.delete(key);
          }
        }
        this.activePersons.delete(globalId);
      }
    }
  }

  /**
   * List all remembered humans from persistent gallery
   */
  getKnownGallery(options = {}) {
    if (this.db && typeof this.db.listKnownPersons === 'function') {
      return this.db.listKnownPersons(options);
    }
    return [];
  }

  /**
   * Update remembered person profile (e.g. rename or change role)
   */
  updatePersonProfile(id, updates = {}) {
    // Update memory if active
    const active = this.activePersons.get(id);
    if (active) {
      if (updates.name) active.name = updates.name;
      if (updates.role) {
        active.role = updates.role;
        active.assignedRole = updates.role;
      }
    }

    if (this.db && typeof this.db.updateKnownPerson === 'function') {
      return this.db.updateKnownPerson(id, updates);
    }
    return null;
  }

  /**
   * Delete remembered person from memory & database
   */
  deletePerson(id) {
    this.activePersons.delete(id);
    for (const [key, gId] of this.localToGlobalMap.entries()) {
      if (gId === id) this.localToGlobalMap.delete(key);
    }
    if (this.db && typeof this.db.deleteKnownPerson === 'function') {
      return this.db.deleteKnownPerson(id);
    }
    return false;
  }
}

module.exports = {
  GlobalIdentityManager
};
