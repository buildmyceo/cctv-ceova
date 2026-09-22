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

      -- Indexes for performance
      CREATE INDEX IF NOT EXISTS idx_staff_emp_id ON staff_profiles(employee_id);
      CREATE INDEX IF NOT EXISTS idx_staff_feat_id ON staff_features(staff_id);
      CREATE INDEX IF NOT EXISTS idx_global_tracks_id ON global_tracks(global_track_id);
      CREATE INDEX IF NOT EXISTS idx_events_time ON identity_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_known_persons_id ON known_persons(id);
      CREATE INDEX IF NOT EXISTS idx_known_persons_role ON known_persons(role);
      CREATE INDEX IF NOT EXISTS idx_known_persons_last_seen ON known_persons(last_seen_at);
    `;

    this.db.exec(schemaSql);
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
    const sql = `
      INSERT INTO known_persons (
        id, organization_id, name, role, thumbnail_data, feature_vector,
        color_signature, aspect_ratio, first_seen_at, last_seen_at,
        visit_count, total_dwell_ms, is_active, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      r.is_active = Boolean(r.is_active);
      return r;
    });
  }

  deleteKnownPerson(id) {
    const res = this.run('DELETE FROM known_persons WHERE id = ?', [id]);
    return res.changes > 0;
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
