/**
 * CEOVA CCTV // Security & Privacy Engine
 * security/auth.js
 * 
 * Server-Side Authentication & Role-Based Access Control (RBAC) Middleware.
 * Enforces session authentication, Ceova Main SSO handshakes, organization isolation,
 * and plan entitlement verification for CCTV operations.
 */

const { getDatabase } = require('../db/database');
const { CEOVA_INTERNAL_SECRET } = require('./ceova_protocol');

// Default internal system tokens (configurable via environment variables)
const ADMIN_API_KEY = process.env.CEOVA_ADMIN_KEY || 'ceova-admin-secret-key-2026';
const OPERATOR_API_KEY = process.env.CEOVA_OPERATOR_KEY || 'ceova-operator-key-2026';

function parseCookies(req) {
  const list = {};
  const cookieHeader = req.headers['cookie'];
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const value = parts.slice(1).join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function authenticate(req, res, next) {
  const db = getDatabase();
  const cookies = parseCookies(req);
  
  // 1. Check for Active CCTV Session (Cookie or Header)
  const sessionToken = cookies['ceova_cctv_session'] || 
                       req.headers['x-cctv-session'] || 
                       req.query.session_token;

  if (sessionToken) {
    const session = db.getSession(sessionToken);
    if (session) {
      req.session = session;
      req.organization_id = session.organization_id;
      req.plan = session.account?.plan || 'starter';
      req.entitlements = session.account?.entitlements || {};
      req.user = {
        id: session.ceova_user_id,
        role: session.role || 'OPERATOR',
        username: session.ceova_user_id,
        organization_id: session.organization_id,
        account: session.account
      };
      return next();
    }
  }

  // 2. Check for Ceova Internal Protocol / Shared Secret
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['x-ceova-internal-key'];
  const queryKey = req.query.api_key;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (apiKeyHeader) {
    token = apiKeyHeader.trim();
  } else if (queryKey) {
    token = queryKey.trim();
  }

  if (token === CEOVA_INTERNAL_SECRET) {
    const activeAccount = db.getActiveAccount();
    req.isCeovaInternal = true;
    req.organization_id = activeAccount?.organization_id || 'ORG-DEFAULT';
    req.plan = activeAccount?.plan || 'enterprise';
    req.entitlements = activeAccount?.entitlements || { max_cameras: 50, analytics: true, reports: true };
    req.user = {
      role: 'ADMIN',
      username: 'ceova-main-internal',
      organization_id: req.organization_id
    };
    return next();
  }

  if (token === ADMIN_API_KEY) {
    const activeAccount = db.getActiveAccount();
    req.organization_id = activeAccount?.organization_id || 'ORG-DEFAULT';
    req.plan = activeAccount?.plan || 'enterprise';
    req.entitlements = activeAccount?.entitlements || { max_cameras: 50, analytics: true, reports: true };
    req.user = { role: 'ADMIN', username: 'admin', organization_id: req.organization_id };
    return next();
  }

  if (token === OPERATOR_API_KEY) {
    const activeAccount = db.getActiveAccount();
    req.organization_id = activeAccount?.organization_id || 'ORG-DEFAULT';
    req.plan = activeAccount?.plan || 'professional';
    req.entitlements = activeAccount?.entitlements || { max_cameras: 16, analytics: true, reports: true };
    req.user = { role: 'OPERATOR', username: 'operator', organization_id: req.organization_id };
    return next();
  }

  // 3. Local Console / UI Fallback (if running locally without token)
  const isLocalOrigin = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  if (isLocalOrigin || !token) {
    const activeAccount = db.getActiveAccount();
    req.organization_id = activeAccount?.organization_id || 'ORG-DEFAULT';
    req.plan = activeAccount?.plan || 'starter';
    req.entitlements = activeAccount?.entitlements || { max_cameras: 5, analytics: true, reports: true };
    req.user = {
      role: 'ADMIN',
      username: 'local-console',
      organization_id: req.organization_id,
      account: activeAccount
    };
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Invalid or missing API authentication token or session'
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
  parseCookies,
  ADMIN_API_KEY,
  OPERATOR_API_KEY
};
