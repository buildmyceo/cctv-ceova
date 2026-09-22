/**
 * CEOVA CCTV // Context Engine
 * context/camera_topology/topology_graph.js
 * 
 * Spatial Camera Adjacency Graph with Physical Travel Constraints.
 * Defines physical connections between cameras and min/max plausible travel times.
 */

class TopologyGraph {
  constructor() {
    this.cameras = new Map(); // cameraId -> { name, zoneId, locationDescription }
    this.edges = new Map(); // "fromCam:toCam" -> { minSeconds, maxSeconds, plausible: boolean }

    this._initializeDefaultTopology();
  }

  _initializeDefaultTopology() {
    // Standard 4-camera deployment layout
    this.addCamera('CAM-01', { name: 'Main Entrance Gate', zoneId: 'ZONE_ENTRANCE' });
    this.addCamera('CAM-02', { name: 'Central Sales Floor', zoneId: 'ZONE_SALES_FLOOR' });
    this.addCamera('CAM-03', { name: 'Restricted Stock Room', zoneId: 'ZONE_STOCK_ROOM' });
    this.addCamera('CAM-04', { name: 'Back Loading Exit', zoneId: 'ZONE_LOADING_BAY' });

    // Connections with plausible transit times (seconds)
    // Entrance <-> Sales Floor (takes 3s to 90s)
    this.addConnection('CAM-01', 'CAM-02', 3, 90);
    // Sales Floor <-> Stock Room (takes 6s to 120s)
    this.addConnection('CAM-02', 'CAM-03', 6, 120);
    // Stock Room <-> Loading Exit (takes 4s to 80s)
    this.addConnection('CAM-03', 'CAM-04', 4, 80);
    // Sales Floor <-> Loading Exit (takes 8s to 150s)
    this.addConnection('CAM-02', 'CAM-04', 8, 150);
  }

  addCamera(id, meta) {
    this.cameras.set(id, { id, ...meta });
  }

  addConnection(fromCam, toCam, minSeconds, maxSeconds) {
    const edge = { minSeconds, maxSeconds, plausible: true };
    this.edges.set(`${fromCam}:${toCam}`, edge);
    this.edges.set(`${toCam}:${fromCam}`, edge); // Bidirectional
  }

  getConnection(fromCam, toCam) {
    if (fromCam === toCam) {
      return { minSeconds: 0, maxSeconds: 3600, plausible: true };
    }
    const key = `${fromCam}:${toCam}`;
    return this.edges.get(key) || null;
  }
}

module.exports = {
  TopologyGraph
};
