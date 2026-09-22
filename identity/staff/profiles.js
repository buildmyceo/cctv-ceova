/**
 * CEOVA CCTV // Identity Engine
 * identity/staff/profiles.js
 * 
 * Staff Profile CRUD & Management.
 * Manages employee records, authorized zones, and working schedule assignments.
 */

const crypto = require('crypto');
const { getDatabase } = require('../../db/database');

class StaffProfiles {
  constructor(db = null) {
    this.db = db || getDatabase();
  }

  /**
   * Create a new staff profile
   */
  createProfile(profileData) {
    const {
      organizationId = 'ORG-DEFAULT',
      employeeId,
      fullName,
      role = 'STAFF',
      department = '',
      scheduleId = 'SCH-DEFAULT',
      authorizedZones = ['ZONE_SALES_FLOOR'],
      thumbnailUrl = ''
    } = profileData;

    if (!employeeId || !fullName) {
      throw new Error('Employee ID and Full Name are mandatory fields');
    }

    const id = `STAFF-${crypto.randomBytes(6).toString('hex')}`;
    const now = new Date().toISOString();

    const zonesJson = JSON.stringify(Array.isArray(authorizedZones) ? authorizedZones : [authorizedZones]);

    this.db.run(
      `INSERT INTO staff_profiles (
        id, organization_id, employee_id, full_name, role,
        department, schedule_id, authorized_zones, thumbnail_url,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, organizationId, employeeId, fullName, role, department, scheduleId, zonesJson, thumbnailUrl, now, now]
    );

    return this.getProfileById(id);
  }

  /**
   * Get profile by internal staff ID
   */
  getProfileById(id) {
    const row = this.db.get('SELECT * FROM staff_profiles WHERE id = ?', [id]);
    if (!row) return null;
    return this._formatProfile(row);
  }

  /**
   * Get profile by employee ID (e.g. 'EMP-001')
   */
  getProfileByEmployeeId(employeeId, organizationId = 'ORG-DEFAULT') {
    const row = this.db.get(
      'SELECT * FROM staff_profiles WHERE employee_id = ? AND organization_id = ?',
      [employeeId, organizationId]
    );
    if (!row) return null;
    return this._formatProfile(row);
  }

  /**
   * List all staff profiles for an organization
   */
  listProfiles(organizationId = 'ORG-DEFAULT', activeOnly = true) {
    let sql = 'SELECT * FROM staff_profiles WHERE organization_id = ?';
    const params = [organizationId];
    if (activeOnly) {
      sql += ' AND active = 1';
    }
    sql += ' ORDER BY employee_id ASC';

    const rows = this.db.all(sql, params);
    return rows.map(r => this._formatProfile(r));
  }

  /**
   * Delete staff profile (cascade deletes features)
   */
  deleteProfile(id, organizationId = 'ORG-DEFAULT') {
    const profile = this.getProfileById(id);
    if (!profile) return false;

    this.db.run('DELETE FROM staff_features WHERE staff_id = ?', [id]);
    this.db.run('DELETE FROM staff_profiles WHERE id = ? AND organization_id = ?', [id, organizationId]);
    return true;
  }

  _formatProfile(row) {
    let authorizedZones = [];
    try {
      authorizedZones = JSON.parse(row.authorized_zones || '[]');
    } catch (e) {
      authorizedZones = [];
    }

    return {
      id: row.id,
      organizationId: row.organization_id,
      employeeId: row.employee_id,
      fullName: row.full_name,
      role: row.role,
      department: row.department,
      scheduleId: row.schedule_id,
      authorizedZones,
      thumbnailUrl: row.thumbnail_url,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}

module.exports = {
  StaffProfiles
};
