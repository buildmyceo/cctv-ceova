/**
 * CEOVA CCTV // Identity Engine
 * identity/roles/role_engine.js
 * 
 * Enterprise Multi-Role Inference Engine.
 * 
 * Supported Role States:
 * - STAFF
 * - CUSTOMER
 * - VISITOR
 * - DELIVERY
 * - SECURITY
 * - UNKNOWN
 * 
 * CRITICAL ARCHITECTURAL CONSTRAINT:
 * Strictly prohibits the naive assumption: "Not staff = customer".
 * If evidence is insufficient or ambiguous, the role MUST remain UNKNOWN.
 */

class RoleEngine {
  constructor(options = {}) {
    this.staffConfidenceThreshold = options.staffThreshold || 0.78;
    this.customerConfidenceThreshold = options.customerThreshold || 0.72;
    this.deliveryConfidenceThreshold = options.deliveryThreshold || 0.70;
    this.securityConfidenceThreshold = options.securityThreshold || 0.75;
  }

  /**
   * Infer role based on multi-modal evidence from all vision and context engines
   * @param {Object} input - { fusedStaffResult, uniformResult, zone, scheduleScore, dwellMs, currentCameraId }
   * @returns {Object} { role: string, confidence: number, reasoning: string }
   */
  inferRole(input) {
    const {
      fusedStaffResult = {},
      uniformResult = {},
      zone = null,
      scheduleScore = 0.5,
      dwellMs = 0,
      currentCameraId = 'CAM-01'
    } = input;

    const {
      isStaff = false,
      finalStaffConfidence = 0.0,
      bestCandidate = null
    } = fusedStaffResult;

    // 1. Check for Enrolled Staff Match
    if (isStaff && finalStaffConfidence >= this.staffConfidenceThreshold) {
      // Check if employee's specific profile designates SECURITY
      if (bestCandidate && bestCandidate.role === 'SECURITY') {
        return {
          role: 'SECURITY',
          confidence: finalStaffConfidence,
          reasoning: `Enrolled security staff member (${bestCandidate.employeeId}) recognized with high confidence (${(finalStaffConfidence * 100).toFixed(0)}%).`
        };
      }
      return {
        role: 'STAFF',
        confidence: finalStaffConfidence,
        reasoning: `Enrolled staff member (${bestCandidate ? bestCandidate.employeeId : 'STAFF'}) verified with high confidence (${(finalStaffConfidence * 100).toFixed(0)}%).`
      };
    }

    // 2. Check for SECURITY (Uniform vest + security context)
    if (uniformResult.profileId === 'UNIFORM-SECURITY' && uniformResult.uniformProbability >= 0.75) {
      return {
        role: 'SECURITY',
        confidence: Number((uniformResult.uniformProbability * 0.85).toFixed(2)),
        reasoning: `Security guard attire detected with badge in camera ${currentCameraId}.`
      };
    }

    // 3. Check for DELIVERY (Loading bay zone + brief dwell + courier pattern)
    if (zone && (zone.id === 'ZONE_LOADING_BAY' || zone.deliveryAllowed)) {
      const dwellMinutes = dwellMs / 60000;
      // Delivery personnel typically stay < 15 minutes at loading dock
      if (dwellMinutes < 20) {
        return {
          role: 'DELIVERY',
          confidence: 0.78,
          reasoning: `Person observed in designated loading bay with short dwell time (${Math.round(dwellMinutes)}m).`
        };
      }
    }

    // 4. Check for CUSTOMER
    // Only classified as customer if observed in public customer area during business hours
    // AND evidence demonstrates standard customer behavior (NOT ambiguous staff similarity!)
    const isPublicZone = zone && zone.type === 'PUBLIC';
    const isBusinessHours = scheduleScore >= 0.8;

    if (isPublicZone && isBusinessHours && !isStaff) {
      // If the person has ambiguous staff similarity (bodyReid >= 0.68),
      // we must NOT jump to classifying them as a customer! They remain safely UNKNOWN.
      const bodyReid = (fusedStaffResult.evidenceSummary && typeof fusedStaffResult.evidenceSummary.bodyReid === 'number')
        ? fusedStaffResult.evidenceSummary.bodyReid
        : 0;
      if (bodyReid >= 0.68) {
        return {
          role: 'UNKNOWN',
          confidence: 0.65,
          reasoning: 'Ambiguous appearance similarity to staff. Maintained in safe UNKNOWN category.'
        };
      }

      // If badge is detected on someone not enrolled as staff -> suspicious -> UNKNOWN
      if (uniformResult.badgeDetected) {
        return {
          role: 'UNKNOWN',
          confidence: 0.65,
          reasoning: 'Person wearing badge but not recognized as enrolled staff. Defaulted to UNKNOWN.'
        };
      }

      return {
        role: 'CUSTOMER',
        confidence: this.customerConfidenceThreshold,
        reasoning: `Person observed on public sales floor during operating hours without staff verification.`
      };
    }

    // 5. Check for VISITOR (Entrance reception area)
    if (zone && zone.id === 'ZONE_ENTRANCE' && isBusinessHours) {
      return {
        role: 'VISITOR',
        confidence: 0.70,
        reasoning: 'Visitor present in reception / entrance area during business hours.'
      };
    }

    // 6. Insufficient evidence / Ambiguous / Off-hours / Restricted zone -> UNKNOWN
    return {
      role: 'UNKNOWN',
      confidence: 0.60,
      reasoning: 'Insufficient or ambiguous evidence to establish verified role. Maintained in safe UNKNOWN category.'
    };
  }
}

module.exports = {
  RoleEngine
};
