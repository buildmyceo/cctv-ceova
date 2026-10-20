/**
 * CEOVA CCTV // Identity Engine
 * identity/staff/enrollment.js
 * 
 * Staff Photo Enrollment Workflow with Strict Quality & Security Validation.
 * 
 * Validates uploaded images:
 * - Rejects corrupted files
 * - Rejects unsupported formats (only JPEG/PNG/WebP allowed)
 * - Rejects oversized files (>10MB)
 * - Rejects images without a usable person or with poor quality
 * - Encrypts extracted embeddings at rest (AES-256-GCM)
 * - Does NOT store unnecessary raw high-res images indefinitely
 * - Face recognition remains optional and disabled by default
 */

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');
const { StaffProfiles } = require('./profiles');
const { StaffFeatureExtractor } = require('./feature_extraction');
const { encryptEmbedding } = require('../../security/encryption');
const { AuditLogger } = require('../../security/audit_logger');
const { getDatabase } = require('../../db/database');
const crypto = require('crypto');

class StaffEnrollment {
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.profiles = new StaffProfiles(this.db);
    this.extractor = new StaffFeatureExtractor();
    this.auditLogger = new AuditLogger(this.db);
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB limit
    this.faceRecognitionEnabled = options.faceRecognitionEnabled || false;
  }

  /**
   * Parse and validate image buffer
   * @param {Buffer|string} input - Buffer or Base64 Data URL
   * @returns {Object} { width, height, data: Buffer (RGBA) }
   */
  decodeAndValidateImage(input) {
    let buf;
    if (typeof input === 'string') {
      const matches = input.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
      if (matches) {
        buf = Buffer.from(matches[2], 'base64');
      } else {
        buf = Buffer.from(input, 'base64');
      }
    } else if (Buffer.isBuffer(input)) {
      buf = input;
    } else {
      throw new Error('Unsupported image input format: expected Buffer or Base64 string');
    }

    // 1. Check file size
    if (buf.length > this.maxFileSize) {
      throw new Error(`File size ${(buf.length / 1024 / 1024).toFixed(2)}MB exceeds maximum allowed limit (10MB)`);
    }
    if (buf.length < 128) {
      throw new Error('Corrupted or empty image file buffer');
    }

    // 2. Format validation by magic bytes
    const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;

    if (!isJpeg && !isPng) {
      throw new Error('Unsupported image format: only JPEG and PNG formats are supported');
    }

    // 3. Decode image to raw RGBA buffer
    try {
      if (isJpeg) {
        const decoded = jpeg.decode(buf, { useTArray: false });
        return {
          width: decoded.width,
          height: decoded.height,
          data: decoded.data
        };
      } else {
        const png = PNG.sync.read(buf);
        return {
          width: png.width,
          height: png.height,
          data: png.data
        };
      }
    } catch (err) {
      throw new Error(`Corrupted or unreadable image file: ${err.message}`);
    }
  }

  /**
   * Enroll a new staff member with photos and profile metadata
   * @param {Object} enrollmentData 
   * @param {string} actor - administrator identifier
   * @returns {Object} Enrolled profile and summary of extracted features
   */
  async enrollStaff(enrollmentData, actor = 'ADMIN') {
    const {
      organizationId = 'ORG-DEFAULT',
      employeeId,
      fullName,
      role = 'STAFF',
      department = '',
      scheduleId = 'SCH-DEFAULT',
      authorizedZones = ['ZONE_SALES_FLOOR'],
      photos = {} // { frontImage: base64|Buffer, sideImage?: base64, backImage?: base64, faceImage?: base64 }
    } = enrollmentData;

    if (!photos.frontImage) {
      throw new Error('Full-body front image is mandatory for staff enrollment');
    }

    // 1. Process & Validate Front Image
    const frontCrop = this.decodeAndValidateImage(photos.frontImage);
    const frontFeatures = this.extractor.extractStaffBodyFeatures(frontCrop, 'FRONT');
    if (!frontFeatures.success) {
      throw new Error(`Front photo rejected: ${frontFeatures.error}`);
    }

    // 2. Process Optional Side Image
    let sideFeatures = null;
    if (photos.sideImage) {
      const sideCrop = this.decodeAndValidateImage(photos.sideImage);
      sideFeatures = this.extractor.extractStaffBodyFeatures(sideCrop, 'SIDE');
      if (!sideFeatures.success) {
        console.warn(`Optional side photo rejected: ${sideFeatures.error}`);
      }
    }

    // 3. Process Optional Back Image
    let backFeatures = null;
    if (photos.backImage) {
      const backCrop = this.decodeAndValidateImage(photos.backImage);
      backFeatures = this.extractor.extractStaffBodyFeatures(backCrop, 'BACK');
      if (!backFeatures.success) {
        console.warn(`Optional back photo rejected: ${backFeatures.error}`);
      }
    }

    // 4. Create Staff Profile in DB
    const profile = this.profiles.createProfile({
      organizationId,
      employeeId,
      fullName,
      role,
      department,
      scheduleId,
      authorizedZones
    });

    const now = new Date().toISOString();

    // 5. Store Encrypted Re-ID Features (AES-256-GCM)
    const storeFeature = (type, embedding) => {
      const featureId = `FEAT-${crypto.randomBytes(6).toString('hex')}`;
      const encrypted = encryptEmbedding(embedding);
      this.db.run(
        `INSERT INTO staff_features (id, staff_id, feature_type, encrypted_embedding, version, created_at)
         VALUES (?, ?, ?, ?, '1.0', ?)`,
        [featureId, profile.id, type, encrypted, now]
      );
    };

    storeFeature('BODY_REID_FRONT', frontFeatures.embedding);
    if (sideFeatures && sideFeatures.success) {
      storeFeature('BODY_REID_SIDE', sideFeatures.embedding);
    }
    if (backFeatures && backFeatures.success) {
      storeFeature('BODY_REID_BACK', backFeatures.embedding);
    }

    // 6. Audit Log (Never logs raw photos or embeddings)
    this.auditLogger.log(
      'STAFF_ENROLLED',
      actor,
      {
        employeeId: profile.employeeId,
        fullName: profile.fullName,
        role: profile.role,
        department: profile.department,
        hasSideImage: Boolean(sideFeatures && sideFeatures.success),
        hasBackImage: Boolean(backFeatures && backFeatures.success)
      },
      organizationId
    );

    return {
      success: true,
      profile,
      featuresExtracted: {
        frontReid: true,
        sideReid: Boolean(sideFeatures && sideFeatures.success),
        backReid: Boolean(backFeatures && backFeatures.success),
        frontQuality: frontFeatures.quality.metrics
      }
    };
  }
}

module.exports = {
  StaffEnrollment
};
