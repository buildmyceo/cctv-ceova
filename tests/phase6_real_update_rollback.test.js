/**
 * CEOVA CCTV // Phase 6: Real Update and Rollback Lifecycle Test
 * tests/phase6_real_update_rollback.test.js
 * 
 * Verifies the complete unmocked update lifecycle with genuine release packages:
 * 1. Install Release A (v1.0.0) with genuine package & live background agent.
 * 2. Probe background agent on port 8085 (no mocked health checks).
 * 3. Create persistent local database records (cameras & settings).
 * 4. Update to Release B (v1.0.1) with genuine package.
 * 5. Verify background agent health and verify local data preservation.
 * 6. Simulate a failed update to v1.0.2 (agent health failure).
 * 7. Verify atomic rollback restores Release B (v1.0.1) and service resumes.
 * 8. Verify database records survive both update and rollback.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Services from ceova-window-app
const APP_SERVICES = '/Users/chintukumar/ceova-window-app/src/services';
const { appRegistry } = await import(path.join(APP_SERVICES, 'appRegistryService.js'));
const { installerService } = await import(path.join(APP_SERVICES, 'installerService.js'));
const { cctvAgent } = await import(path.join(APP_SERVICES, 'cctvAgentService.js'));
const { verifyManifest } = await import(path.join(APP_SERVICES, 'updateManifest.js'));

// Database
const { getDatabase, resolveDataDir } = await import(path.join(ROOT_DIR, 'db', 'database.js'));

// Helper to probe port 8085 with retry
async function probeAgentHealth(maxRetries = 15, delayMs = 600) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const token = cctvAgent.getAuthToken();
      const res = await fetch('http://127.0.0.1:8085/api/status', {
        headers: { 
          'X-Ceova-Client': 'ceova-main-app',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });
      if (res.ok) {
        const body = await res.json();
        if (body.running) return body;
      }
    } catch (_e) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Agent port 8085 health probe timed out');
}

describe('PHASE 6: Real Update and Rollback Lifecycle', { concurrency: false }, () => {
  const manifestsDir = path.join(ROOT_DIR, 'releases', 'dist');
  let manifestA;
  let manifestB;
  let db;
  const testCamId = `cam-p6-${Date.now()}`;

  before(async () => {
    // Reset app registry for clean test
    appRegistry.resetApplication('ceova-cctv');

    manifestA = JSON.parse(fs.readFileSync(path.join(manifestsDir, 'manifest-1.0.0.json'), 'utf8'));
    manifestB = JSON.parse(fs.readFileSync(path.join(manifestsDir, 'manifest-1.0.1.json'), 'utf8'));

    // Authenticate manifests cryptographically before testing
    const authA = await verifyManifest(manifestA);
    assert.equal(authA.valid, true, `Manifest A must be valid: ${authA.errors?.join(', ')}`);

    const authB = await verifyManifest(manifestB);
    assert.equal(authB.valid, true, `Manifest B must be valid: ${authB.errors?.join(', ')}`);

    db = getDatabase();
  });

  after(async () => {
    // Clean up test camera
    try {
      db.removeCamera('ORG-DEFAULT', testCamId);
    } catch (_e) {}
  });

  // STEP 1: Install Release A (v1.0.0) without any mock flags
  it('Step 1: Installs Release A (v1.0.0) with genuine package and live agent startup', async () => {
    console.log('[TEST] Installing genuine Release A (v1.0.0)...');
    const result = await installerService.installApplication('ceova-cctv', manifestA, {
      mockInstall: false,
      mockHealth: false
    });

    assert.equal(result.success, true);
    assert.equal(result.version, '1.0.0');

    // Confirm registry state
    const app = appRegistry.getApplication('ceova-cctv');
    assert.equal(app.installationStatus, 'installed');
    assert.equal(app.installedVersion, '1.0.0');

    // Verify disk files
    const home = process.env.HOME || '/tmp';
    const v100Dir = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'releases', 'v1.0.0');
    assert.ok(fs.existsSync(v100Dir), 'Release v1.0.0 directory must exist');
    assert.ok(fs.existsSync(path.join(v100Dir, 'server.js')), 'server.js must exist');
    assert.ok(fs.existsSync(path.join(v100Dir, 'runtime', 'bin', 'node')), 'Bundled Node must exist');

    // Verify current symlink
    const currentLink = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'current');
    assert.ok(fs.existsSync(currentLink), 'current symlink must exist');
    const resolvedLink = fs.realpathSync(currentLink);
    assert.equal(resolvedLink, v100Dir, 'current symlink must resolve to v1.0.0');

    // Verify live agent health on port 8085
    const status = await probeAgentHealth();
    assert.equal(status.running, true);
    console.log('[TEST] Release A installed successfully. Agent active on port 8085.');
  });

  // STEP 2: Create local database records
  it('Step 2: Creates local SQLite database records that must survive updates', async () => {
    console.log('[TEST] Creating camera record in SQLite...');
    db.registerCamera('ORG-DEFAULT', {
      id: testCamId,
      name: 'Phase 6 Secure Entrance Cam',
      stream_url: 'rtsp://192.168.1.100/ch0',
      zone_name: 'ENTRANCE'
    });

    const cameras = db.getCameras('ORG-DEFAULT');
    const found = cameras.find(c => c.id === testCamId);
    assert.ok(found, 'Created camera record must exist in SQLite database');
    assert.equal(found.name, 'Phase 6 Secure Entrance Cam');
    console.log('[TEST] SQLite record created successfully in persistent data directory.');
  });

  // STEP 3: Update to Release B (v1.0.1)
  it('Step 3: Updates to Release B (v1.0.1) and verifies health & data preservation', async () => {
    console.log('[TEST] Updating to genuine Release B (v1.0.1)...');
    const result = await installerService.updateApplication('ceova-cctv', manifestB, {
      mockInstall: false,
      mockHealth: false
    });

    assert.equal(result.success, true);
    assert.equal(result.version, '1.0.1');

    // Verify registry updated
    const app = appRegistry.getApplication('ceova-cctv');
    assert.equal(app.installationStatus, 'installed');
    assert.equal(app.installedVersion, '1.0.1');

    // Verify v1.0.1 directory exists and v1.0.0 directory preserved
    const home = process.env.HOME || '/tmp';
    const v100Dir = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'releases', 'v1.0.0');
    const v101Dir = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'releases', 'v1.0.1');
    assert.ok(fs.existsSync(v100Dir), 'Previous release v1.0.0 must be preserved for rollback');
    assert.ok(fs.existsSync(v101Dir), 'New release v1.0.1 must be extracted');

    // Verify current symlink now points to v1.0.1
    const currentLink = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'current');
    const resolvedLink = fs.realpathSync(currentLink);
    assert.equal(resolvedLink, v101Dir, 'current symlink must point to v1.0.1');

    // Verify agent is healthy and running on port 8085
    const status = await probeAgentHealth();
    assert.equal(status.running, true);

    // CRITICAL: Verify local SQLite database record is preserved
    const cameras = db.getCameras('ORG-DEFAULT');
    const found = cameras.find(c => c.id === testCamId);
    assert.ok(found, 'Database camera record MUST survive release update');
    assert.equal(found.name, 'Phase 6 Secure Entrance Cam');
    console.log('[TEST] Release B active. Local data 100% preserved across update.');
  });

  // STEP 4: Simulate a failed update and verify automatic rollback
  it('Step 4: Simulates failed update to v1.0.2 and verifies automatic rollback to v1.0.1', async () => {
    console.log('[TEST] Simulating failed update to v1.0.2...');
    
    // Create a broken release package that fails runtime health check
    const { execSync } = await import('node:child_process');
    const { calculateSha256, signPayload, signManifest } = await import(path.join(ROOT_DIR, 'scripts', 'sign_release.js'));
    const tmpFailDir = path.join(ROOT_DIR, 'releases', 'dist', 'fail_pkg_tmp');
    if (fs.existsSync(tmpFailDir)) fs.rmSync(tmpFailDir, { recursive: true, force: true });
    fs.mkdirSync(tmpFailDir, { recursive: true });

    // Intentionally broken server.js that crashes immediately
    fs.writeFileSync(path.join(tmpFailDir, 'package.json'), JSON.stringify({ name: 'ceova-cctv', version: '1.0.2' }));
    fs.writeFileSync(path.join(tmpFailDir, 'server.js'), 'console.error("SIMULATED FATAL ERROR"); process.exit(1);');
    fs.mkdirSync(path.join(tmpFailDir, 'services'), { recursive: true });
    // Minimal supervisor that immediately fails
    fs.writeFileSync(path.join(tmpFailDir, 'services', 'supervisor.js'), 'process.exit(1);');

    const failTar = path.join(ROOT_DIR, 'releases', 'dist', 'ceova-cctv-1.0.2-fail.tar.gz');
    execSync(`tar -czf "${failTar}" -C "${tmpFailDir}" .`);
    fs.rmSync(tmpFailDir, { recursive: true, force: true });

    const failBuf = fs.readFileSync(failTar);
    const failSha = calculateSha256(failBuf);
    const failSig = signPayload(failBuf);
    const failStat = fs.statSync(failTar);

    const manifestFail = {
      appId: 'ceova-cctv',
      version: '1.0.2',
      minSupportedVersion: '1.0.0',
      platforms: {
        'macos-aarch64': {
          packageUrl: `file://${failTar}`,
          localPath: failTar,
          sha256: failSha,
          signature: failSig,
          size: failStat.size
        },
        'macos-aarch64': {
          packageUrl: `file://${failTar}`,
          localPath: failTar,
          sha256: failSha,
          signature: failSig,
          size: failStat.size
        }
      },
      releaseNotes: 'Test failing update',
      releasedAt: new Date().toISOString()
    };
    signManifest(manifestFail);

    // Attempt update to broken v1.0.2
    let updateError = null;
    try {
      await installerService.updateApplication('ceova-cctv', manifestFail, {
        mockInstall: false,
        mockHealth: false
      });
    } catch (err) {
      updateError = err;
    }

    assert.ok(updateError, 'Broken update must throw error');
    assert.match(updateError.message, /Update verification failed/);

    // Verify rollback restored v1.0.1
    const app = appRegistry.getApplication('ceova-cctv');
    assert.equal(app.installedVersion, '1.0.1', 'Rollback must restore version 1.0.1');
    assert.equal(app.installationStatus, 'installed');

    // Verify current symlink points back to v1.0.1
    const home = process.env.HOME || '/tmp';
    const currentLink = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'current');
    const resolvedLink = fs.realpathSync(currentLink);
    const v101Dir = path.join(home, '.ceova', 'apps', 'ceova-cctv', 'releases', 'v1.0.1');
    assert.equal(resolvedLink, v101Dir, 'Symlink must be rolled back to v1.0.1');

    // Verify live agent resumed and healthy on port 8085
    const status = await probeAgentHealth();
    assert.equal(status.running, true);

    // CRITICAL: Verify local SQLite database record is STILL intact after rollback
    const cameras = db.getCameras('ORG-DEFAULT');
    const found = cameras.find(c => c.id === testCamId);
    assert.ok(found, 'Database record must be preserved across failed update and rollback');
    assert.equal(found.name, 'Phase 6 Secure Entrance Cam');

    // Clean up temporary fail tarball
    if (fs.existsSync(failTar)) fs.unlinkSync(failTar);
    console.log('[TEST] Rollback successfully verified! Service restored & database preserved.');
  });
});
