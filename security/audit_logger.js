/**
 * CEOVA CCTV // Security & Privacy Engine
 * security/audit_logger.js
 * 
 * Immutable audit logger for security, privacy, enrollment, and deletion events.
 * Never logs raw biometric embeddings or plaintext credentials.
 */

class AuditLogger {
  constructor(db) {
    this.db = db;
  }

  log(action, actor = 'SYSTEM', details = {}, organizationId = 'ORG-DEFAULT') {
    const timestamp = new Date().toISOString();
    const safeDetails = { ...details };
    // Redact any sensitive biometric vectors or raw images if passed accidentally
    delete safeDetails.rawImage;
    delete safeDetails.faceEmbedding;
    delete safeDetails.reidEmbedding;
    delete safeDetails.password;

    try {
      if (this.db) {
        this.db.run(
          `INSERT INTO audit_logs (organization_id, action, actor, details, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [organizationId, action, actor, JSON.stringify(safeDetails), timestamp]
        );
      }
    } catch (err) {
      console.error('[AUDIT LOG ERROR]', err.message);
    }

    console.log(`[AUDIT] [${timestamp}] [${organizationId}] ${action} by ${actor}`);
  }
}

module.exports = {
  AuditLogger
};
