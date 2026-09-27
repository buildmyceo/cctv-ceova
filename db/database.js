/**
 * CEOVA CCTV // Database Engine
 * db/database.js
 * 
 * Persistent SQLite Database using Node.js 24 native node:sqlite.
 * Manages tables for staff profiles, encrypted features, uniform profiles,
 * global tracks, camera tracks, identity matches, roles, and audit events.
 */

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.warn('node:sqlite not available, falling back to simulated memory SQLite');
}

class CeovaDatabase {
  constructor(dbPath = null) {
    if (!dbPath) {
      const dataDir = path.join(__dirname, '..', 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      this.dbPath = path.join(dataDir, 'ceova_cctv.db');
    } else {
      this.dbPath = dbPath;
    }

    this._initDatabase();
  }

  _initDatabase() {
    if (DatabaseSync) {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
    } else {
      throw new Error('Native SQLite engine not available');
    }

    this._createSchema();
  }

  _createSchema() {
    const schemaSql = `
      -- 1. Staff Profiles
      CREATE TABLE IF NOT EXISTS staff_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        employee_id TEXT NOT NULL UNIQUE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'STAFF',
        department TEXT,
        schedule_id TEXT,
        authorized_zones TEXT, -- JSON Array: ["ZONE_SALES_FLOOR", "ZONE_STOCK_ROOM"]
        thumbnail_url TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 2. Staff Biometric / Appearance Features (Encrypted at rest)
      CREATE TABLE IF NOT EXISTS staff_features (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        feature_type TEXT NOT NULL, -- 'BODY_REID_FRONT', 'BODY_REID_SIDE', 'BODY_REID_BACK', 'FACE'
        encrypted_embedding TEXT NOT NULL, -- AES-256-GCM ciphertext
        version TEXT NOT NULL DEFAULT '1.0',
        created_at TEXT NOT NULL,
        FOREIGN KEY (staff_id) REFERENCES staff_profiles(id) ON DELETE CASCADE
      );

      -- 3. Staff Uniform Profiles
      CREATE TABLE IF NOT EXISTS staff_uniform_profiles (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        name TEXT NOT NULL,
        shirt_type TEXT NOT NULL, -- 'POLO', 'VEST', 'JACKET', 'SHIRT'
        primary_color_hex TEXT NOT NULL,
        secondary_color_hex TEXT,
        badge_required INTEGER NOT NULL DEFAULT 0,
        pattern_type TEXT NOT NULL DEFAULT 'SOLID',
        created_at TEXT NOT NULL
      );

      -- 4. Global Tracks (Cross-Camera Identity)
      CREATE TABLE IF NOT EXISTS global_tracks (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        global_track_id TEXT NOT NULL UNIQUE, -- e.g. 'P-000183'
        staff_id TEXT, -- e.g. 'EMP-001' (Stored separately from global_track_id!)
        assigned_role TEXT NOT NULL DEFAULT 'UNKNOWN',
        confidence REAL NOT NULL DEFAULT 0.0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'RETIRED'
        FOREIGN KEY (staff_id) REFERENCES staff_profiles(id) ON DELETE SET NULL
      );

      -- 5. Camera Tracks (Local Camera Sightings)
      CREATE TABLE IF NOT EXISTS camera_tracks (
        id TEXT PRIMARY KEY,
        global_track_id TEXT NOT NULL,
        camera_id TEXT NOT NULL,
        local_track_id INTEGER NOT NULL,
        bbox_json TEXT, -- [x, y, w, h]
        quality_score REAL NOT NULL DEFAULT 1.0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (global_track_id) REFERENCES global_tracks(global_track_id) ON DELETE CASCADE
      );

      -- 6. Identity Matches (Cross-Camera & Staff Associations)
      CREATE TABLE IF NOT EXISTS identity_matches (
        id TEXT PRIMARY KEY,
        global_track_id TEXT NOT NULL,
        staff_id TEXT,
        match_type TEXT NOT NULL, -- 'REID', 'FACE', 'FUSED'
        match_score REAL NOT NULL,
        evidence_json TEXT,
        created_at TEXT NOT NULL
      );

      -- 7. Role Assignments
      CREATE TABLE IF NOT EXISTS role_assignments (
        id TEXT PRIMARY KEY,
        global_track_id TEXT NOT NULL,
        role TEXT NOT NULL, -- 'STAFF', 'CUSTOMER', 'VISITOR', 'DELIVERY', 'SECURITY', 'UNKNOWN'
        confidence REAL NOT NULL,
        reasoning TEXT,
        created_at TEXT NOT NULL
      );

      -- 8. Structured Identity Events
      CREATE TABLE IF NOT EXISTS identity_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        event_type TEXT NOT NULL, -- 'staff_detected', 'unknown_person', 'cross_camera_handover', etc.
        global_track_id TEXT NOT NULL,
        staff_id TEXT,
        camera_id TEXT NOT NULL,
        role TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_json TEXT,
        created_at TEXT NOT NULL
      );

      -- 9. Audit Logs
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );

      -- 10. Known Persons Gallery (Long-Term Human Memory)
      CREATE TABLE IF NOT EXISTS known_persons (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL DEFAULT 'ORG-DEFAULT',
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'VISITOR',
        thumbnail_data TEXT,
        feature_vector TEXT NOT NULL,
        color_signature TEXT,
        aspect_ratio REAL DEFAULT 0.5,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1,
        total_dwell_ms INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 11. Hourly People Occupancy by Day of Week ("Popular Times")
      CREATE TABLE IF NOT EXISTS hourly_people_occupancy (
        id TEXT PRIMARY KEY,
        day_of_week INTEGER NOT NULL, -- 0 = Sunday, 1 = Monday, ..., 6 = Saturday
        hour_of_day INTEGER NOT NULL, -- 0 to 23
        avg_people REAL NOT NULL DEFAULT 0.0,
        peak_people INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        total_people_sum INTEGER NOT NULL DEFAULT 0,
        last_updated_at TEXT NOT NULL,
        UNIQUE(day_of_week, hour_of_day)
      );

      -- 12. Ceova Ecosystem Paired Accounts & Entitlements
      CREATE TABLE IF NOT EXISTS cctv_accounts (
        organization_id TEXT PRIMARY KEY,
        ceova_user_id TEXT NOT NULL,
        cctv_account_id TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL DEFAULT 'starter', -- 'starter', 'professional', 'enterprise'
        entitlements_json TEXT NOT NULL, -- {"max_cameras": 16, "analytics": true, "reports": true}
        status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'SUSPENDED', 'REVOKED'
        main_webhook_url TEXT,
        paired_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 13. SSO Launch Tokens (Single-use exchange tokens from Ceova Main)
      CREATE TABLE IF NOT EXISTS cctv_launch_tokens (
        token TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ceova_user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'OPERATOR',
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES cctv_accounts(organization_id) ON DELETE CASCADE
      );

      -- 14. Active CCTV Sessions (User logged in via Main SSO or credentials)
      CREATE TABLE IF NOT EXISTS cctv_sessions (
        session_token TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        ceova_user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'OPERATOR',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES cctv_accounts(organization_id) ON DELETE CASCADE
      );

      -- 15. Registered CCTV Cameras (Subject to plan entitlement quotas)
      CREATE TABLE IF NOT EXISTS cctv_cameras (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stream_url TEXT,
        zone_name TEXT,
        status TEXT NOT NULL DEFAULT 'ONLINE', -- 'ONLINE', 'OFFLINE', 'ERROR'
        last_active_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (organization_id) REFERENCES cctv_accounts(organization_id) ON DELETE CASCADE
      );

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_staff_emp_id ON staff_profiles(employee_id);
      CREATE INDEX IF NOT EXISTS idx_staff_feat_id ON staff_features(staff_id);
      CREATE INDEX IF NOT EXISTS idx_global_tracks_id ON global_tracks(global_track_id);
      CREATE INDEX IF NOT EXISTS idx_events_time ON identity_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_known_persons_id ON known_persons(id);
      CREATE INDEX IF NOT EXISTS idx_known_persons_role ON known_persons(role);
      CREATE INDEX IF NOT EXISTS idx_known_persons_last_seen ON known_persons(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_hourly_occupancy_day ON hourly_people_occupancy(day_of_week);
      CREATE INDEX IF NOT EXISTS idx_cctv_accounts_user ON cctv_accounts(ceova_user_id);
      CREATE INDEX IF NOT EXISTS idx_cctv_sessions_org ON cctv_sessions(organization_id);
      CREATE INDEX IF NOT EXISTS idx_cctv_cameras_org ON cctv_cameras(organization_id);
    `;

    this.db.exec(schemaSql);

    // Migration for REMIND Multi-Prototype Memory Engine
    try {
      this.db.exec('ALTER TABLE known_persons ADD COLUMN prototypes_json TEXT;');
    } catch (_err) {
      // Column already exists
    }

    // Auto-seed Popular Times baseline if empty
    try {
      this.seedHourlyOccupancyIfEmpty();
    } catch (_e) {}
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  // -------------------------------------------------------------
  // Known Persons (Long-Term Memory) Methods
  // -------------------------------------------------------------

  createKnownPerson(person) {
    const now = new Date().toISOString();
    const prototypes = person.prototypes || (person.feature_vector ? [person.feature_vector] : []);
    const sql = `
      INSERT INTO known_persons (
        id, organization_id, name, role, thumbnail_data, feature_vector,
        color_signature, aspect_ratio, first_seen_at, last_seen_at,
        visit_count, total_dwell_ms, is_active, notes, prototypes_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    this.run(sql, [
      person.id,
      person.organization_id || 'ORG-DEFAULT',
      person.name || `Human #${person.id}`,
      person.role || 'VISITOR',
      person.thumbnail_data || null,
      typeof person.feature_vector === 'string' ? person.feature_vector : JSON.stringify(person.feature_vector || []),
      typeof person.color_signature === 'string' ? person.color_signature : JSON.stringify(person.color_signature || [128, 128, 128]),
      person.aspect_ratio || 0.5,
      person.first_seen_at || now,
      person.last_seen_at || now,
      person.visit_count || 1,
      person.total_dwell_ms || 0,
      person.is_active ? 1 : 0,
      person.notes || null,
      JSON.stringify(prototypes),
      now,
      now
    ]);
    return this.getKnownPerson(person.id);
  }

  getKnownPerson(id) {
    const row = this.get('SELECT * FROM known_persons WHERE id = ?', [id]);
    if (!row) return null;
    try {
      row.feature_vector = JSON.parse(row.feature_vector);
      row.color_signature = JSON.parse(row.color_signature);
    } catch (e) {}
    try {
      row.prototypes = row.prototypes_json ? JSON.parse(row.prototypes_json) : (row.feature_vector ? [row.feature_vector] : []);
    } catch (e) {
      row.prototypes = row.feature_vector ? [row.feature_vector] : [];
    }
    row.is_active = Boolean(row.is_active);
    return row;
  }

  updateKnownPerson(id, updates = {}) {
    const now = new Date().toISOString();
    const existing = this.getKnownPerson(id);
    if (!existing) return null;

    const fields = [];
    const values = [];

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.role !== undefined) { fields.push('role = ?'); values.push(updates.role); }
    if (updates.thumbnail_data !== undefined && updates.thumbnail_data) { fields.push('thumbnail_data = ?'); values.push(updates.thumbnail_data); }
    if (updates.feature_vector !== undefined) {
      fields.push('feature_vector = ?');
      values.push(typeof updates.feature_vector === 'string' ? updates.feature_vector : JSON.stringify(updates.feature_vector));
    }
    if (updates.color_signature !== undefined) {
      fields.push('color_signature = ?');
      values.push(typeof updates.color_signature === 'string' ? updates.color_signature : JSON.stringify(updates.color_signature));
    }
    if (updates.aspect_ratio !== undefined) { fields.push('aspect_ratio = ?'); values.push(updates.aspect_ratio); }
    if (updates.last_seen_at !== undefined) { fields.push('last_seen_at = ?'); values.push(updates.last_seen_at); }
    if (updates.visit_count !== undefined) { fields.push('visit_count = ?'); values.push(updates.visit_count); }
    if (updates.total_dwell_ms !== undefined) { fields.push('total_dwell_ms = ?'); values.push(updates.total_dwell_ms); }
    if (updates.is_active !== undefined) { fields.push('is_active = ?'); values.push(updates.is_active ? 1 : 0); }
    if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
    if (updates.prototypes !== undefined) {
      fields.push('prototypes_json = ?');
      values.push(typeof updates.prototypes === 'string' ? updates.prototypes : JSON.stringify(updates.prototypes));
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const sql = `UPDATE known_persons SET ${fields.join(', ')} WHERE id = ?`;
    this.run(sql, values);
    return this.getKnownPerson(id);
  }

  listKnownPersons(options = {}) {
    let sql = 'SELECT * FROM known_persons';
    const conditions = [];
    const params = [];

    if (options.role) {
      conditions.push('role = ?');
      params.push(options.role);
    }
    if (options.activeOnly) {
      conditions.push('is_active = 1');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY last_seen_at DESC';

    if (options.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = this.all(sql, params);
    return rows.map(r => {
      try {
        r.feature_vector = JSON.parse(r.feature_vector);
        r.color_signature = JSON.parse(r.color_signature);
      } catch (e) {}
      try {
        r.prototypes = r.prototypes_json ? JSON.parse(r.prototypes_json) : (r.feature_vector ? [r.feature_vector] : []);
      } catch (e) {
        r.prototypes = r.feature_vector ? [r.feature_vector] : [];
      }
      r.is_active = Boolean(r.is_active);
      return r;
    });
  }

  deleteKnownPerson(id) {
    const res = this.run('DELETE FROM known_persons WHERE id = ?', [id]);
    return res.changes > 0;
  }

  // -------------------------------------------------------------
  // Popular Times & Hourly Occupancy Analytics
  // -------------------------------------------------------------

  recordHourlyOccupancy(dayOfWeek, hourOfDay, currentCount) {
    const id = `H_${dayOfWeek}_${hourOfDay}`;
    const now = new Date().toISOString();
    const existing = this.get('SELECT * FROM hourly_people_occupancy WHERE day_of_week = ? AND hour_of_day = ?', [dayOfWeek, hourOfDay]);
    
    if (existing && existing.sample_count > 0) {
      const newSamples = existing.sample_count + 1;
      const newSum = existing.total_people_sum + currentCount;
      const newAvg = parseFloat((newSum / newSamples).toFixed(1));
      const newPeak = Math.max(existing.peak_people, currentCount);
      this.run(`
        UPDATE hourly_people_occupancy 
        SET avg_people = ?, peak_people = ?, sample_count = ?, total_people_sum = ?, last_updated_at = ?
        WHERE id = ?
      `, [newAvg, newPeak, newSamples, newSum, now, id]);
    } else {
      this.run(`
        INSERT INTO hourly_people_occupancy (id, day_of_week, hour_of_day, avg_people, peak_people, sample_count, total_people_sum, last_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          avg_people = excluded.avg_people,
          peak_people = excluded.peak_people,
          sample_count = excluded.sample_count,
          total_people_sum = excluded.total_people_sum,
          last_updated_at = excluded.last_updated_at
      `, [id, dayOfWeek, hourOfDay, currentCount, currentCount, 1, currentCount, now]);
    }
  }

  getHourlyOccupancy(dayOfWeek = null) {
    if (dayOfWeek !== null && dayOfWeek !== undefined) {
      return this.all('SELECT * FROM hourly_people_occupancy WHERE day_of_week = ? ORDER BY hour_of_day ASC', [dayOfWeek]);
    }
    return this.all('SELECT * FROM hourly_people_occupancy ORDER BY day_of_week ASC, hour_of_day ASC');
  }

  clearHourlyOccupancy() {
    this.run('DELETE FROM hourly_people_occupancy');
    this.seedHourlyOccupancyIfEmpty();
  }

  seedHourlyOccupancyIfEmpty() {
    const count = this.get('SELECT COUNT(*) as cnt FROM hourly_people_occupancy');
    if (count && count.cnt > 0) return;

    // Clean initialization: all hours set to 0 (no fake/mock data)
    // Only real detections from CCTV vision will populate these hours
    const now = new Date().toISOString();
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const id = `H_${day}_${hour}`;
        this.run(`
          INSERT INTO hourly_people_occupancy (id, day_of_week, hour_of_day, avg_people, peak_people, sample_count, total_people_sum, last_updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [id, day, hour, 0, 0, 0, 0, now]);
      }
    }
  }

  // -------------------------------------------------------------
  // Ceova Main Ecosystem Pairing & Entitlement Methods
  // -------------------------------------------------------------

  upsertCctvAccount(account) {
    const now = new Date().toISOString();
    const entitlementsStr = typeof account.entitlements === 'string' 
      ? account.entitlements 
      : JSON.stringify(account.entitlements || { max_cameras: 5, analytics: false, reports: false });

    const existing = this.get('SELECT * FROM cctv_accounts WHERE organization_id = ?', [account.organization_id]);
    if (existing) {
      this.run(`
        UPDATE cctv_accounts 
        SET ceova_user_id = ?, cctv_account_id = ?, plan = ?, entitlements_json = ?, status = ?, main_webhook_url = ?, updated_at = ?
        WHERE organization_id = ?
      `, [
        account.ceova_user_id || existing.ceova_user_id,
        account.cctv_account_id || existing.cctv_account_id,
        account.plan || existing.plan,
        entitlementsStr,
        account.status || 'ACTIVE',
        account.main_webhook_url !== undefined ? account.main_webhook_url : existing.main_webhook_url,
        now,
        account.organization_id
      ]);
    } else {
      this.run(`
        INSERT INTO cctv_accounts (
          organization_id, ceova_user_id, cctv_account_id, plan, entitlements_json, status, main_webhook_url, paired_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        account.organization_id,
        account.ceova_user_id,
        account.cctv_account_id,
        account.plan || 'starter',
        entitlementsStr,
        account.status || 'ACTIVE',
        account.main_webhook_url || null,
        now,
        now
      ]);
    }

    return this.getCctvAccount(account.organization_id);
  }

  getCctvAccount(organizationId) {
    const row = this.get('SELECT * FROM cctv_accounts WHERE organization_id = ?', [organizationId]);
    if (!row) return null;
    return {
      ...row,
      entitlements: JSON.parse(row.entitlements_json || '{}')
    };
  }

  getActiveAccount() {
    const row = this.get("SELECT * FROM cctv_accounts WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1");
    if (!row) return null;
    return {
      ...row,
      entitlements: JSON.parse(row.entitlements_json || '{}')
    };
  }

  updateAccountEntitlements(organizationId, plan, entitlements) {
    const now = new Date().toISOString();
    const entitlementsStr = typeof entitlements === 'string' ? entitlements : JSON.stringify(entitlements || {});
    this.run(`
      UPDATE cctv_accounts
      SET plan = COALESCE(?, plan), entitlements_json = ?, updated_at = ?
      WHERE organization_id = ?
    `, [plan, entitlementsStr, now, organizationId]);
    return this.getCctvAccount(organizationId);
  }

  revokeCctvAccount(organizationId) {
    const now = new Date().toISOString();
    this.run(`
      UPDATE cctv_accounts
      SET status = 'REVOKED', updated_at = ?
      WHERE organization_id = ?
    `, [now, organizationId]);
    this.run('DELETE FROM cctv_sessions WHERE organization_id = ?', [organizationId]);
    return true;
  }

  // -------------------------------------------------------------
  // SSO Launch Tokens & Sessions
  // -------------------------------------------------------------

  createLaunchToken(organizationId, ceovaUserId, role = 'OPERATOR', expiresInSeconds = 300) {
    const crypto = require('crypto');
    const token = 'lnch_' + crypto.randomBytes(24).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();

    this.run(`
      INSERT INTO cctv_launch_tokens (token, organization_id, ceova_user_id, role, expires_at, used, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `, [token, organizationId, ceovaUserId, role, expiresAt, now.toISOString()]);

    return {
      token,
      organization_id: organizationId,
      ceova_user_id: ceovaUserId,
      role,
      expires_at: expiresAt
    };
  }

  consumeLaunchToken(token) {
    const record = this.get('SELECT * FROM cctv_launch_tokens WHERE token = ?', [token]);
    if (!record) {
      return { valid: false, error: 'Invalid launch token' };
    }
    if (record.used === 1) {
      return { valid: false, error: 'Launch token has already been used' };
    }
    if (new Date(record.expires_at).getTime() < Date.now()) {
      return { valid: false, error: 'Launch token has expired' };
    }

    // Mark as used
    this.run('UPDATE cctv_launch_tokens SET used = 1 WHERE token = ?', [token]);

    // Check account status
    const account = this.getCctvAccount(record.organization_id);
    if (!account || account.status !== 'ACTIVE') {
      return { valid: false, error: 'Organization account is inactive or not paired' };
    }

    // Create session
    const session = this.createSession(record.organization_id, record.ceova_user_id, record.role);
    return {
      valid: true,
      session,
      account
    };
  }

  createSession(organizationId, ceovaUserId, role = 'OPERATOR', expiresInDays = 7) {
    const crypto = require('crypto');
    const sessionToken = 'cctv_sess_' + crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    this.run(`
      INSERT INTO cctv_sessions (session_token, organization_id, ceova_user_id, role, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [sessionToken, organizationId, ceovaUserId, role, expiresAt, now.toISOString()]);

    return {
      session_token: sessionToken,
      organization_id: organizationId,
      ceova_user_id: ceovaUserId,
      role,
      expires_at: expiresAt
    };
  }

  getSession(sessionToken) {
    if (!sessionToken) return null;
    const session = this.get('SELECT * FROM cctv_sessions WHERE session_token = ?', [sessionToken]);
    if (!session) return null;

    if (new Date(session.expires_at).getTime() < Date.now()) {
      this.deleteSession(sessionToken);
      return null;
    }

    const account = this.getCctvAccount(session.organization_id);
    return {
      ...session,
      account
    };
  }

  deleteSession(sessionToken) {
    this.run('DELETE FROM cctv_sessions WHERE session_token = ?', [sessionToken]);
    return true;
  }

  // -------------------------------------------------------------
  // Camera Management & Entitlement Quota Enforcement
  // -------------------------------------------------------------

  registerCamera(organizationId = 'ORG-DEFAULT', camera) {
    let account = this.getCctvAccount(organizationId);
    if (!account) {
      if (organizationId === 'ORG-DEFAULT') {
        account = this.upsertCctvAccount({
          organization_id: 'ORG-DEFAULT',
          ceova_user_id: 'local-admin',
          cctv_account_id: 'cctv_default',
          plan: 'professional',
          entitlements: { max_cameras: 16, analytics: true, reports: true }
        });
      } else {
        throw new Error(`Organization ${organizationId} not found`);
      }
    }

    const maxCameras = account.entitlements?.max_cameras || 5;
    const currentCount = this.getCameraCount(organizationId);

    if (currentCount >= maxCameras) {
      const err = new Error(`Camera quota exceeded: current plan '${account.plan}' allows a maximum of ${maxCameras} cameras. Please upgrade in Ceova Main.`);
      err.code = 'QUOTA_EXCEEDED';
      err.current_count = currentCount;
      err.max_cameras = maxCameras;
      throw err;
    }

    const id = camera.id || `CAM_${Date.now()}`;
    const now = new Date().toISOString();

    this.run(`
      INSERT INTO cctv_cameras (id, organization_id, name, stream_url, zone_name, status, last_active_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        stream_url = excluded.stream_url,
        zone_name = excluded.zone_name,
        status = excluded.status,
        last_active_at = excluded.last_active_at
    `, [
      id,
      organizationId,
      camera.name || `Camera ${id}`,
      camera.stream_url || null,
      camera.zone_name || 'DEFAULT',
      camera.status || 'ONLINE',
      now,
      now
    ]);

    return this.get('SELECT * FROM cctv_cameras WHERE id = ?', [id]);
  }

  getCamera(cameraId) {
    return this.get('SELECT * FROM cctv_cameras WHERE id = ?', [cameraId]);
  }

  getCameras(organizationId) {
    return this.all('SELECT * FROM cctv_cameras WHERE organization_id = ? ORDER BY created_at DESC', [organizationId]);
  }

  getCameraCount(organizationId) {
    const row = this.get('SELECT COUNT(*) as cnt FROM cctv_cameras WHERE organization_id = ?', [organizationId]);
    return row ? row.cnt : 0;
  }

  updateCameraStatus(organizationId, cameraId, status) {
    const now = new Date().toISOString();
    this.run(`
      UPDATE cctv_cameras
      SET status = ?, last_active_at = ?
      WHERE id = ? AND organization_id = ?
    `, [status, now, cameraId, organizationId]);
    return this.get('SELECT * FROM cctv_cameras WHERE id = ?', [cameraId]);
  }

  removeCamera(organizationId, cameraId) {
    return this.run(`
      DELETE FROM cctv_cameras
      WHERE id = ? AND organization_id = ?
    `, [cameraId, organizationId]);
  }

  close() {
    if (this.db) {
      this.db.close();
    }
  }
}

// Singleton database instance
let instance = null;

function getDatabase(customPath = null) {
  if (!instance || customPath) {
    instance = new CeovaDatabase(customPath);
  }
  return instance;
}

module.exports = {
  CeovaDatabase,
  getDatabase
};
