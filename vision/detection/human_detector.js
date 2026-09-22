/**
 * CEOVA CCTV // Vision Engine
 * vision/detection/human_detector.js
 * 
 * Multi-Scale Human Detection specification & utilities.
 * Preserves existing multi-scale COCO-SSD detection logic while providing
 * a unified interface for both browser canvas and server-side processing.
 */

function calculateIoU(boxA, boxB) {
  const [ax, ay, aw, ah] = boxA;
  const [bx, by, bw, bh] = boxB;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (aw * ah) + (bw * bh) - inter;
  return union > 0 ? inter / union : 0;
}

function applyNMS(detections = [], iouThreshold = 0.38, minScore = 0.25) {
  const filtered = detections.filter(d => d.score >= minScore);
  filtered.sort((a, b) => b.score - a.score);
  const results = [];

  for (const item of filtered) {
    let duplicate = false;
    for (const kept of results) {
      if (calculateIoU(item.bbox, kept.bbox) > iouThreshold) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) {
      results.push(item);
    }
  }
  return results;
}

module.exports = {
  calculateIoU,
  applyNMS
};
