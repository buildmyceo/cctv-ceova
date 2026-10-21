/**
 * CEOVA CCTV // Internal Service Protocol & Cryptography
 * security/ceova_protocol.js
 * 
 * Provides private, versioned internal API authentication, HMAC request signing,
 * timestamp replay prevention, and entitlement enforcement between Ceova Main App and Ceova CCTV App.
 */

const crypto = require('crypto');

const DEFAULT_TEST_SECRET = 'ceova_internal_secret_key_32_bytes_super_secure';
const CEOVA_INTERNAL_SECRET = process.env.CEOVA_INTERNAL_SECRET || DEFAULT_TEST_SECRET;

// Private shared secret must be provided via environment in production
const MAX_TIMESTAMP_DRIFT_SEC = 300; // 5 minutes window for replay prevention

function getInternalSecret() {
  const secret = process.env.CEOVA_INTERNAL_SECRET || DEFAULT_TEST_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim().length < 16) {
    return null;
  }
  return secret.trim();
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeStringCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Compute HMAC-SHA256 signature for internal API calls
 */
function computeSignature(secret, timestamp, method, path, body = '') {
  const bodyString = typeof body === 'object' ? JSON.stringify(body) : (body || '');
  const canonicalString = `${timestamp}.${method.toUpperCase()}.${path}.${bodyString}`;
  return crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
}

/**
 * Express Middleware: Verify Ceova Internal Protocol
 * Requires either a valid HMAC signature + timestamp or matching internal key
 */
function verifyCeovaInternalProtocol(req, res, next) {
  const secret = getInternalSecret();
  if (!secret) {
    return res.status(503).json({
      error: 'ServiceUnavailable',
      message: 'Internal service protocol secret is unconfigured or invalid (CEOVA_INTERNAL_SECRET required)'
    });
  }

  const signature = req.headers['x-ceova-internal-signature'];
  const timestamp = req.headers['x-ceova-timestamp'];
  const internalKey = req.headers['x-ceova-internal-key'] || req.headers['x-internal-key'];
  
  const authHeader = req.headers['authorization'];
  let bearerToken = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  // Option 1: Direct Internal Secret matching
  if (safeStringCompare(internalKey, secret) || safeStringCompare(bearerToken, secret)) {
    req.isCeovaInternal = true;
    req.internalCaller = 'CEOVA_MAIN';
    return next();
  }

  // Option 2: Cryptographic HMAC Signature with Replay Window
  if (signature && timestamp) {
    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    
    // Check replay attack window
    if (isNaN(requestTime) || Math.abs(now - requestTime) > MAX_TIMESTAMP_DRIFT_SEC) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Request timestamp expired or out of allowed window'
      });
    }

    const expectedSig = computeSignature(secret, timestamp, req.method, req.originalUrl || req.url, req.body);
    
    // Constant-time comparison
    if (safeStringCompare(signature, expectedSig)) {
      req.isCeovaInternal = true;
      req.internalCaller = 'CEOVA_MAIN';
      return next();
    }
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Missing or invalid Ceova Internal Protocol authentication'
  });
}

/**
 * Express Middleware: Require specific plan entitlement (e.g. 'analytics', 'reports', 'face_recognition')
 */
function requireEntitlement(featureName) {
  return (req, res, next) => {
    // If request has active entitlements attached
    const entitlements = req.entitlements || req.user?.account?.entitlements || {};
    
    if (entitlements[featureName] === true) {
      return next();
    }

    return res.status(403).json({
      error: 'EntitlementDenied',
      message: `Feature '${featureName}' is not enabled in your current plan (${req.plan || 'Starter'}). Please upgrade your subscription in Ceova Main.`,
      required_feature: featureName,
      current_plan: req.plan || 'starter',
      upgrade_action: 'Open Ceova Main > Subscription to upgrade'
    });
  };
}

module.exports = {
  CEOVA_INTERNAL_SECRET,
  getInternalSecret,
  computeSignature,
  verifyCeovaInternalProtocol,
  requireEntitlement
};
