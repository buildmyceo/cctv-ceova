/**
 * CEOVA CCTV // Standalone Runtime Resolver
 * services/runtime_resolver.js
 * 
 * Dynamically resolves standalone bundled Node.js and Python runtimes,
 * ensuring the application operates reproducibly on clean macOS systems
 * without relying on development-machine global configurations.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function resolveNodeBinary(rootDir = null) {
  const base = rootDir || path.resolve(__dirname, '..');
  const bundledNode = path.join(base, 'runtime', 'bin', 'node');

  // 1. Check bundled standalone Node binary
  if (fs.existsSync(bundledNode)) {
    try {
      fs.accessSync(bundledNode, fs.constants.X_OK);
      return bundledNode;
    } catch (_e) {
      try {
        fs.chmodSync(bundledNode, 0o755);
        return bundledNode;
      } catch (_e2) {}
    }
  }

  // 2. Check current process execution path
  if (process.execPath && fs.existsSync(process.execPath)) {
    return process.execPath;
  }

  // 3. Fallback to system node
  return 'node';
}

function resolvePythonBinary(rootDir = null, dataDir = null) {
  const base = rootDir || path.resolve(__dirname, '..');

  // Candidate paths in order of standalone priority:
  const candidatePaths = [
    // 1. Bundled application venv
    path.join(base, 'runtime', 'venv', 'bin', 'python3'),
    path.join(base, 'runtime', 'python', 'bin', 'python3'),
    // 2. User data directory isolated venv
    dataDir ? path.join(dataDir, 'runtime', 'venv', 'bin', 'python3') : null,
    // 3. System Homebrew or Apple Silicon Python
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3'
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch (_e) {}
    }
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

module.exports = {
  resolveNodeBinary,
  resolvePythonBinary
};
