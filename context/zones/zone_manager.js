/**
 * CEOVA CCTV // Context Engine
 * context/zones/zone_manager.js
 * 
 * CCTV Zone & Access Policy Management.
 * Maps cameras and areas into functional security zones (Staff-Only, Public, Entrance, Loading).
 */

class ZoneManager {
  constructor() {
    this.zones = new Map();
    this.cameraZoneMap = new Map();

    this._initializeDefaultZones();
  }

  _initializeDefaultZones() {
    this.addZone({
      id: 'ZONE_ENTRANCE',
      name: 'Main Public Entrance',
      type: 'PUBLIC',
      requiresStaffBadge: false
    });

    this.addZone({
      id: 'ZONE_SALES_FLOOR',
      name: 'Customer Sales & Display Floor',
      type: 'PUBLIC',
      requiresStaffBadge: false
    });

    this.addZone({
      id: 'ZONE_STOCK_ROOM',
      name: 'Staff-Only Inventory & Stock Room',
      type: 'STAFF_ONLY',
      requiresStaffBadge: true
    });

    this.addZone({
      id: 'ZONE_LOADING_BAY',
      name: 'Delivery & Loading Bay',
      type: 'RESTRICTED',
      requiresStaffBadge: false,
      deliveryAllowed: true
    });

    // Camera mappings
    this.assignCameraToZone('CAM-01', 'ZONE_ENTRANCE');
    this.assignCameraToZone('CAM-02', 'ZONE_SALES_FLOOR');
    this.assignCameraToZone('CAM-03', 'ZONE_STOCK_ROOM');
    this.assignCameraToZone('CAM-04', 'ZONE_LOADING_BAY');
  }

  addZone(zone) {
    this.zones.set(zone.id, zone);
  }

  assignCameraToZone(cameraId, zoneId) {
    this.cameraZoneMap.set(cameraId, zoneId);
  }

  getZoneForCamera(cameraId) {
    const zoneId = this.cameraZoneMap.get(cameraId);
    return zoneId ? this.zones.get(zoneId) : null;
  }

  /**
   * Evaluate whether a staff member is authorized for the zone covered by a camera
   * @param {string} cameraId 
   * @param {Array<string>} staffAuthorizedZones 
   * @returns {number} Score: 1.0 (authorized), 0.7 (public zone), 0.2 (restricted/unauthorized)
   */
  evaluateZoneScore(cameraId, staffAuthorizedZones = []) {
    const zone = this.getZoneForCamera(cameraId);
    if (!zone) return 0.5;

    if (zone.type === 'PUBLIC') {
      return 0.8; // Public zone (sales floor, entrance) is accessible to staff and others
    }

    if (zone.type === 'STAFF_ONLY' || zone.type === 'RESTRICTED') {
      if (staffAuthorizedZones.includes(zone.id) || staffAuthorizedZones.includes('*')) {
        return 1.0; // Enrolled staff authorized for this secure zone
      }
      return 0.2; // Unauthorized presence in staff-only zone
    }

    return 0.5;
  }
}

module.exports = {
  ZoneManager
};
