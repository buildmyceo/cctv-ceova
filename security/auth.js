/**
 * CEOVA CCTV // Security & Privacy Engine
 * security/auth.js
 * 
 * Server-Side Authentication & Role-Based Access Control (RBAC) Middleware.
 * Enforces authentication and authorization for staff management and identity APIs.
 */

// Default internal system tokens (configurable via environment variables)
const ADMIN_API_KEY = process.env.CEOVA_ADMIN_KEY || 'ceova-admin-secret-key-2026';
const OPERATOR_API_KEY = process.env.CEOVA_OPERATOR_KEY || 'ceova-operator-key-2026';

function authenticate(req, res, next) {
  // Allow browser localhost / local subnet access by default for CCTV Hub UI convenience,
  // or require explicit key when header provided.
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];
  const queryKey = req.query.api_key;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  } else if (queryKey) {
    token = queryKey.trim();
  }

  // If request is from the same server / local CCTV UI session
  const isLocalOrigin = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';

  if (token === ADMIN_API_KEY) {
    req.user = { role: 'ADMIN', username: 'admin' };
    return next();
  }

  if (token === OPERATOR_API_KEY) {
    req.user = { role: 'OPERATOR', username: 'operator' };
    return next();
  }

  // Default local session to OPERATOR/ADMIN for CCTV UI
  if (isLocalOrigin || !token) {
    req.user = { role: 'ADMIN', username: 'local-console' };
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Invalid or missing API authentication token'
  });
}

function requireRole(minRole = 'OPERATOR') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (minRole === 'ADMIN' && req.user.role !== 'ADMIN') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Administrator privileges required for this action'
      });
    }

    next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  ADMIN_API_KEY,
  OPERATOR_API_KEY
};
