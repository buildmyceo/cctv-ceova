/**
 * CEOVA CCTV // Identity & Recognition API Routes
 * api/identity_routes.js
 * 
 * REST API Endpoints for Staff Management, Live People Tracking,
 * Multi-Role Inference, Hardware Diagnostics, and Security Controls.
 */

const express = require('express');
const { StaffProfiles } = require('../identity/staff/profiles');
const { StaffEnrollment } = require('../identity/staff/enrollment');
const { StaffMatcher } = require('../identity/staff/matching');
const { GlobalIdentityManager } = require('../identity/cross_camera/global_identity_manager');
const { UniformAnalyzer } = require('../vision/uniform/uniform_analyzer');
const { FaceMatcher } = require('../vision/face/face_matcher');
const { ConfidenceFusion } = require('../identity/confidence/confidence_fusion');
const { RoleEngine } = require('../identity/roles/role_engine');
const { ZoneManager } = require('../context/zones/zone_manager');
const { ScheduleManager } = require('../context/schedules/schedule_manager');
const { IdentityEventManager } = require('../events/identity_events/event_manager');
const { HardwareDetector } = require('../hardware/hardware_detector');
const { QualityChecker } = require('../vision/quality/quality_checker');
const { ReidExtractor } = require('../vision/reid/reid_extractor');
const { getYoloBridge } = require('../vision/detection/yolo_bridge');
const { authenticate, requireRole } = require('../security/auth');
const { getDatabase } = require('../db/database');

function createIdentityRouter(options = {}) {
  const router = express.Router();
  const db = options.db || getDatabase();
  const yoloBridge = getYoloBridge();

  const profiles = new StaffProfiles(db);
  const enrollment = new StaffEnrollment({ db });
  const matcher = new StaffMatcher({ db });
  const globalManager = new GlobalIdentityManager({ db });
  const uniformAnalyzer = new UniformAnalyzer();
  const faceMatcher = new FaceMatcher({ db, enabled: false }); // Disabled by default!
  const fusion = new ConfidenceFusion();
  const roleEngine = new RoleEngine();
  const zoneManager = new ZoneManager();
  const scheduleManager = new ScheduleManager();
  const eventManager = new IdentityEventManager({
    db,
    broadcastCallback: options.broadcastCallback
  });
  const qualityChecker = new QualityChecker();
  const reidExtractor = new ReidExtractor();

  // Middleware: Authenticate all API requests
  router.use(authenticate);

  // -------------------------------------------------------------
  // 1. Staff Management APIs
  // -------------------------------------------------------------

  /**
   * POST /api/staff/enroll
   * Enroll a new staff member with photo validation and encrypted feature storage
   */
  router.post('/staff/enroll', requireRole('ADMIN'), async (req, res) => {
    try {
      const result = await enrollment.enrollStaff(req.body, req.user.username);
      // Invalidate feature cache so matcher immediately recognizes newly enrolled staff
      matcher.reloadCache();
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/staff
   * List enrolled staff profiles (never exposes raw biometric embeddings)
   */
  router.get('/staff', (req, res) => {
    try {
      const staffList = profiles.listProfiles();
      res.json({
        total: staffList.length,
        staff: staffList
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/staff/:id
   * Remove staff member and cascade delete encrypted biometric features
   */
  router.delete('/staff/:id', requireRole('ADMIN'), (req, res) => {
    try {
      const success = profiles.deleteProfile(req.params.id);
      if (!success) {
        return res.status(404).json({ error: 'Staff profile not found' });
      }
      matcher.reloadCache();
      res.json({ success: true, message: `Staff profile ${req.params.id} deleted` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 2. Live People & Role Status APIs
  // -------------------------------------------------------------

  /**
   * GET /api/people/live
   * Live count of detected people across all roles and active staff list
   */
  router.get('/people/live', (req, res) => {
    try {
      const activePersons = globalManager.getActivePersons();

      // Aggregate counts by role
      const counts = {
        STAFF: 0,
        CUSTOMER: 0,
        VISITOR: 0,
        DELIVERY: 0,
        SECURITY: 0,
        UNKNOWN: 0
      };

      const activeStaffMembers = [];

      for (const p of activePersons) {
        const r = p.assignedRole || 'UNKNOWN';
        counts[r] = (counts[r] || 0) + 1;
        if (p.assignedRole === 'STAFF' && p.staffId) {
          if (!activeStaffMembers.includes(p.staffId)) {
            activeStaffMembers.push(p.staffId);
          }
        }
      }

      const liveTable = activePersons.map(p => ({
        globalTrackId: p.globalTrackId,
        staffId: p.staffId,
        name: p.name || (p.staffId ? `Staff ${p.staffId}` : `Human #${p.globalTrackId}`),
        role: p.assignedRole || p.role,
        confidence: p.roleConfidence,
        camera: p.currentCameraId,
        firstSeen: new Date(p.firstSeenAt).toLocaleTimeString(),
        lastSeen: new Date(p.lastSeenAt).toLocaleTimeString(),
        sightingCount: p.sightings.length,
        visitCount: p.visitCount || 1,
        thumbnail: p.thumbnail || null
      }));

      res.json({
        summary: {
          totalTracked: activePersons.length,
          staffCount: counts.STAFF,
          staffMembers: activeStaffMembers,
          unknownCount: counts.UNKNOWN,
          customerCount: counts.CUSTOMER,
          visitorCount: counts.VISITOR,
          deliveryCount: counts.DELIVERY,
          securityCount: counts.SECURITY
        },
        livePeople: liveTable
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/people/:globalTrackId
   * Retrieve timeline and cross-camera sightings of a specific person
   */
  router.get('/people/:globalTrackId', (req, res) => {
    try {
      const person = globalManager.getPerson(req.params.globalTrackId);
      if (!person) {
        return res.status(404).json({ error: 'Person not found or track expired' });
      }

      // Sanitize: Do not return raw embedding vectors to frontend
      const safePerson = { ...person };
      delete safePerson.latestEmbedding;

      res.json(safePerson);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 3. Identity Events & System Status
  // -------------------------------------------------------------

  /**
   * GET /api/identity/events
   * Retrieve recent structured identity events
   */
  router.get('/identity/events', (req, res) => {
    try {
      const limit = parseInt(req.query.limit || '50', 10);
      const events = eventManager.getRecentEvents(limit);
      res.json({ events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/identity/status
   * Recognition module health & configuration status
   */
  router.get('/identity/status', (req, res) => {
    try {
      const enrolledStaff = profiles.listProfiles();
      res.json({
        status: 'OPERATIONAL',
        faceRecognitionEnabled: faceMatcher.enabled,
        activeGlobalTracks: globalManager.getActivePersons().length,
        enrolledStaffCount: enrolledStaff.length,
        retentionHours: globalManager.retentionMs / (3600 * 1000)
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/identity/config
   * Enable/disable optional face recognition or adjust thresholds
   */
  router.post('/identity/config', requireRole('ADMIN'), (req, res) => {
    try {
      if (req.body.faceRecognitionEnabled !== undefined) {
        faceMatcher.setEnabled(req.body.faceRecognitionEnabled);
      }
      res.json({
        success: true,
        faceRecognitionEnabled: faceMatcher.enabled
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/hardware/status
   * Runtime hardware detection and processing recommendations
   */
  router.get('/hardware/status', (req, res) => {
    try {
      const diagnostics = HardwareDetector.detect();
      res.json(diagnostics);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 4. YOLOv8 Deep Detection & Vision Engine APIs
  // -------------------------------------------------------------

  /**
   * GET /api/vision/yolo/status
   * Health and hardware acceleration status for YOLOv8 service
   */
  router.get('/vision/yolo/status', async (req, res) => {
    try {
      const health = await yoloBridge.checkHealth();
      const status = yoloBridge.getStatus();
      res.json({
        ...status,
        healthy: health.ok,
        details: health.info || health.error
      });
    } catch (err) {
      res.status(500).json({ error: err.message, available: false });
    }
  });

  /**
   * POST /api/vision/yolo/detect
   * High-accuracy human detection on video frame via YOLOv8 & OpenCV
   */
  router.post('/vision/yolo/detect', async (req, res) => {
    try {
      const { image, conf = 0.35, iou = 0.45 } = req.body;
      if (!image) {
        return res.status(400).json({ error: 'Missing frame image (base64)' });
      }

      const result = await yoloBridge.detectHumans(image, { conf, iou });
      res.json(result);
    } catch (err) {
      // Return graceful response indicating fallback
      res.status(503).json({
        success: false,
        error: err.message,
        fallbackToClient: true,
        detections: []
      });
    }
  });

  // -------------------------------------------------------------
  // 5. Known Persons (Long-Term Human Memory Gallery) APIs
  // -------------------------------------------------------------

  /**
   * GET /api/persons
   * Retrieve all remembered humans in the persistent gallery
   */
  router.get('/persons', (req, res) => {
    try {
      const gallery = globalManager.getKnownGallery(req.query);
      res.json({
        total: gallery.length,
        persons: gallery
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/persons/:id
   * Retrieve full details of a specific remembered person
   */
  router.get('/persons/:id', (req, res) => {
    try {
      const person = db.getKnownPerson(req.params.id);
      if (!person) {
        return res.status(404).json({ error: 'Person profile not found' });
      }
      res.json(person);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/persons/:id
   * Update person name/label or role
   */
  router.patch('/persons/:id', (req, res) => {
    try {
      const updated = globalManager.updatePersonProfile(req.params.id, req.body);
      if (!updated) {
        return res.status(404).json({ error: 'Person profile not found' });
      }
      res.json({ success: true, person: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/persons/:id
   * Forget a person from the memory gallery
   */
  router.delete('/persons/:id', (req, res) => {
    try {
      const success = globalManager.deletePerson(req.params.id);
      res.json({ success, message: success ? 'Person removed from memory' : 'Person not found' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------------------------------------------------------------
  // 6. Live Person Crop Processing Pipeline
  // -------------------------------------------------------------

  /**
   * POST /api/vision/process-track
   * Complete end-to-end recognition pipeline for a single detected person crop:
   * Crop -> Quality -> Re-ID -> Uniform -> Optional Face -> Staff Match -> Context -> Fusion -> Global ID -> Role Engine -> Events
   */
  router.post('/vision/process-track', async (req, res) => {
    try {
      const {
        cameraId = 'CAM-01',
        bbox = [0, 0, 100, 200],
        dwellMs = 0
      } = req.body;

      const localTrackId = req.body.localTrackId !== undefined ? req.body.localTrackId : req.body.cameraTrackId;
      const cropImage = req.body.cropImage || req.body.cropBase64;

      if (!cropImage || localTrackId === undefined) {
        return res.status(400).json({ error: 'Missing localTrackId (or cameraTrackId) or cropImage (or cropBase64)' });
      }

      // Step 1: Decode image crop
      const crop = enrollment.decodeAndValidateImage(cropImage);

      // Step 2: Quality Assessment
      const quality = qualityChecker.assessQuality(crop);
      if (!quality.isUsable) {
        return res.json({
          processed: false,
          reason: 'Low image quality',
          quality: quality.metrics,
          assignedRole: 'UNKNOWN'
        });
      }

      // Step 3: Body Re-ID Embedding
      const reidResult = reidExtractor.extractEmbedding(crop);
      const personEmbedding = reidResult.embedding;

      // Step 4: Uniform Analysis
      const uniformResult = uniformAnalyzer.analyzeUniform(crop);

      // Step 5: Optional Face Recognition
      let faceResult = { faceMatched: false, staffId: null, employeeId: null, faceScore: null };
      if (faceMatcher.enabled) {
        const faceAssessment = faceMatcher.detectAndAssessFace(crop);
        if (faceAssessment.faceDetected && faceAssessment.isUsable) {
          const faceEmbedding = faceMatcher.generateFaceEmbedding(faceAssessment.faceCrop);
          faceResult = faceMatcher.matchAgainstStaff(faceEmbedding);
        }
      }

      // Step 6: Staff Candidate Matching
      const staffMatchResult = matcher.matchStaff(personEmbedding);
      const bestStaff = staffMatchResult.bestCandidate;
      const bodyReidScore = bestStaff ? bestStaff.score : 0.0;

      // Step 7: Context & Rule Engine
      const zone = zoneManager.getZoneForCamera(cameraId);
      const staffZoneScore = zoneManager.evaluateZoneScore(
        cameraId,
        bestStaff ? bestStaff.authorizedZones : []
      );
      const scheduleScore = scheduleManager.evaluateScheduleScore('SCH-DEFAULT', Date.now());

      // Step 8: Multi-Signal Confidence Fusion
      const fusedResult = fusion.fuseEvidence({
        bodyReidScore,
        faceScore: faceResult.faceScore,
        uniformScore: uniformResult.uniformProbability,
        staffZoneScore,
        scheduleScore,
        trackingConsistency: Math.min(1.0, dwellMs / 10000 + 0.5),
        imageQuality: quality.qualityScore
      });

      // Step 9: Cross-Camera & Long-Term Body Identity Association
      const globalPerson = globalManager.processObservation({
        cameraId,
        localTrackId,
        bbox,
        embedding: personEmbedding,
        cropImage,
        timestamp: Date.now()
      });

      // Step 10: Role Engine
      const roleDecision = roleEngine.inferRole({
        fusedStaffResult: {
          ...fusedResult,
          bestCandidate: bestStaff
        },
        uniformResult,
        zone,
        scheduleScore,
        dwellMs,
        currentCameraId: cameraId
      });

      // Update global person with final role & staff identity
      if (roleDecision.role === 'STAFF' && bestStaff) {
        globalManager.assignStaffIdentity(
          globalPerson.globalTrackId,
          bestStaff.staffId,
          bestStaff.employeeId,
          roleDecision.confidence
        );
      } else if (!globalPerson.isRecognized || globalPerson.role === 'VISITOR' || globalPerson.role === 'UNKNOWN') {
        globalManager.assignRole(
          globalPerson.globalTrackId,
          roleDecision.role,
          roleDecision.confidence
        );
      }

      // Step 11: Structured Identity Event Dispatch
      const emittedEvent = eventManager.recordIdentityState({
        globalTrackId: globalPerson.globalTrackId,
        staffId: (roleDecision.role === 'STAFF' && bestStaff) ? bestStaff.employeeId : null,
        cameraId,
        role: globalPerson.role || roleDecision.role,
        confidence: globalPerson.roleConfidence || roleDecision.confidence,
        evidence: {
          bodyReid: bodyReidScore,
          face: faceResult.faceScore,
          uniform: uniformResult.uniformProbability
        },
        zone
      });

      res.json({
        processed: true,
        globalTrackId: globalPerson.globalTrackId,
        name: globalPerson.name || `Human #${globalPerson.globalTrackId}`,
        isRecognized: Boolean(globalPerson.isRecognized),
        matchScore: globalPerson.matchScore || 1.0,
        visitCount: globalPerson.visitCount || 1,
        thumbnail: globalPerson.thumbnail || cropImage,
        staffId: globalPerson.staffId,
        role: globalPerson.role || roleDecision.role,
        confidence: globalPerson.roleConfidence || roleDecision.confidence,
        reasoning: roleDecision.reasoning,
        evidence: {
          bodyReidScore,
          uniformScore: uniformResult.uniformProbability,
          faceScore: faceResult.faceScore,
          staffZoneScore,
          scheduleScore,
          qualityScore: quality.qualityScore
        },
        emittedEvent: emittedEvent ? emittedEvent.event_type : null
      });

    } catch (err) {
      console.error('Error in process-track:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return {
    router,
    components: {
      profiles,
      enrollment,
      matcher,
      globalManager,
      uniformAnalyzer,
      faceMatcher,
      fusion,
      roleEngine,
      zoneManager,
      scheduleManager,
      eventManager,
      qualityChecker,
      reidExtractor
    }
  };
}

module.exports = {
  createIdentityRouter
};
