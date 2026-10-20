/**
 * CEOVA CCTV // Event Engine
 * events/identity_events/event_manager.js
 * 
 * Structured Identity Event Generator, Debouncer & WebSocket Dispatcher.
 * 
 * Generates meaningful, structured events on state transitions:
 * - staff_detected
 * - unknown_person
 * - cross_camera_handover
 * - role_assigned
 * - zone_violation
 * 
 * CRITICAL RULE:
 * Does NOT generate events for every video frame.
 * Emits strictly on state/role changes, cross-camera transitions, or rate-limited intervals.
 */

const crypto = require('crypto');
const { getDatabase } = require('../../db/database');

class IdentityEventManager {
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.broadcastCallback = options.broadcastCallback || null;
    this.lastEventTimes = new Map(); // "globalTrackId:eventType" -> timestamp
    this.personStateCache = new Map(); // globalTrackId -> { role, cameraId, lastSeen }
    this.debounceIntervalMs = options.debounceIntervalMs || 10000; // 10s cooldown for repeat alerts
  }

  setBroadcastCallback(fn) {
    this.broadcastCallback = fn;
  }

  /**
   * Process live identity determination and generate events if meaningful state change occurred
   * @param {Object} eventParams 
   * @returns {Object|null} Emitted event or null if debounced
   */
  recordIdentityState(eventParams) {
    const {
      globalTrackId,
      staffId = null,
      cameraId,
      role = 'UNKNOWN',
      confidence = 0.0,
      evidence = {},
      zone = null,
      timestamp = new Date().toISOString()
    } = eventParams;

    const prevState = this.personStateCache.get(globalTrackId) || null;
    let eventType = null;
    let triggerReason = '';

    // 1. Check for cross-camera handover
    if (prevState && prevState.cameraId !== cameraId) {
      eventType = 'cross_camera_handover';
      triggerReason = `Person ${globalTrackId} moved from ${prevState.cameraId} to ${cameraId}`;
    }
    // 2. Check for role transition (e.g. UNKNOWN -> STAFF)
    else if (!prevState || prevState.role !== role) {
      if (role === 'STAFF') {
        eventType = 'staff_detected';
        triggerReason = `Staff member ${staffId || 'STAFF'} identified`;
      } else if (role === 'UNKNOWN') {
        eventType = 'unknown_person';
        triggerReason = `Unrecognized person detected in ${cameraId}`;
      } else {
        eventType = 'role_assigned';
        triggerReason = `Role assigned: ${role}`;
      }
    }
    // 3. Periodic refresh of staff presence (after cooldown)
    else if (role === 'STAFF') {
      const lastStaffEvent = this.lastEventTimes.get(`${globalTrackId}:staff_detected`) || 0;
      if (Date.now() - lastStaffEvent > this.debounceIntervalMs * 3) {
        eventType = 'staff_detected';
        triggerReason = `Staff member ${staffId} still active`;
      }
    }

    // If no meaningful transition occurred, suppress duplicate frame event
    if (!eventType) {
      if (prevState) prevState.lastSeen = Date.now();
      return null;
    }

    // Check cooldown for this specific event type
    const cooldownKey = `${globalTrackId}:${eventType}`;
    const lastEmitted = this.lastEventTimes.get(cooldownKey) || 0;
    if (Date.now() - lastEmitted < this.debounceIntervalMs) {
      return null;
    }

    // Update state cache
    this.personStateCache.set(globalTrackId, {
      role,
      staffId,
      cameraId,
      lastSeen: Date.now()
    });
    this.lastEventTimes.set(cooldownKey, Date.now());

    // Build structured event payload
    const eventPayload = {
      event_type: eventType,
      global_track_id: globalTrackId,
      staff_id: staffId,
      camera_id: cameraId,
      role,
      confidence: Number(confidence.toFixed(2)),
      timestamp,
      reason: triggerReason,
      evidence: {
        body_reid: evidence.bodyReid !== undefined ? Number(evidence.bodyReid.toFixed(2)) : undefined,
        face: (evidence.face !== undefined && evidence.face !== null && evidence.face !== 'UNAVAILABLE') 
          ? Number(Number(evidence.face).toFixed(2)) 
          : undefined,
        uniform: evidence.uniform !== undefined ? Number(evidence.uniform.toFixed(2)) : undefined,
        zone: zone ? zone.id : undefined
      }
    };

    // Persist into SQLite DB
    try {
      const eventId = `EVT-${crypto.randomBytes(6).toString('hex')}`;
      this.db.run(
        `INSERT INTO identity_events (
          id, organization_id, event_type, global_track_id, staff_id,
          camera_id, role, confidence, evidence_json, created_at
        ) VALUES (?, 'ORG-DEFAULT', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          eventId,
          eventType,
          globalTrackId,
          staffId,
          cameraId,
          role,
          confidence,
          JSON.stringify(eventPayload.evidence),
          timestamp
        ]
      );
    } catch (err) {
      console.error('Failed to persist identity event:', err.message);
    }

    // Broadcast over WebSockets if listener registered
    if (this.broadcastCallback) {
      try {
        this.broadcastCallback(eventPayload);
      } catch (err) {}
    }

    return eventPayload;
  }

  /**
   * Get recent identity events from database
   */
  getRecentEvents(limit = 50, organizationId = 'ORG-DEFAULT') {
    const rows = this.db.all(
      `SELECT * FROM identity_events
       WHERE organization_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [organizationId, limit]
    );

    return rows.map(r => ({
      id: r.id,
      event_type: r.event_type,
      global_track_id: r.global_track_id,
      staff_id: r.staff_id,
      camera_id: r.camera_id,
      role: r.role,
      confidence: r.confidence,
      evidence: JSON.parse(r.evidence_json || '{}'),
      timestamp: r.created_at
    }));
  }
}

module.exports = {
  IdentityEventManager
};
