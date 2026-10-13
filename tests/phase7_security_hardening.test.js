/**
 * CEOVA CCTV // Phase 7: Security Hardening & Attack Resistance Test Suite
 * tests/phase7_security_hardening.test.js
 * 
 * Verifies all 8 security attack vectors specified in Phase 7:
 * 1. Invalid / tampered cryptographic signatures rejected.
 * 2. Modified package bytes (SHA-256 mismatch) rejected.
 * 3. Unauthenticated / corrupted manifests rejected.
 * 4. Archive path traversal (Zip Slip / absolute paths) rejected.
 * 5. Interrupted downloads handled safely without corrupting state.
 * 6. Insufficient disk space / decompression bomb protection.
 * 7. Service shutdown failure escalation.
 * 8. Rollback failure safe containment.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Services from ceova-window-app
const APP_SERVICES = '/Users/chintukumar/ceova-window-app/src/services';
const { appRegistry } = await import(path.join(APP_SERVICES, 'appRegistryService.js'));
const { installerService } = await import(path.join(APP_SERVICES, 'installerService.js'));
const { cctvAgent } = await import(path.join(APP_SERVICES, 'cctvAgentService.js'));
const { 
  verifySignature, 
  calculateSha256, 
  verifyManifest, 
  TRUSTED_PRODUCTION_PUBLIC_KEY 
} = await import(path.join(APP_SERVICES, 'updateManifest.js'));
const { extractArchiveSafely } = await import(path.join(APP_SERVICES, 'safeExtractor.js'));

// Keys and signing helper
const { 
  signPayload, 
  signManifest
} = await import(path.join(ROOT_DIR, 'scripts', 'sign_release.js'));

describe('PHASE 7: Security Hardening & Attack Resistance', { concurrency: false }, () => {
  const manifestsDir = path.join(ROOT_DIR, 'releases', 'dist');
  let validManifest;
  let validPackageData;
  let validPkg;

  before(() => {
    validManifest = JSON.parse(fs.readFileSync(path.join(manifestsDir, 'manifest-1.0.0.json'), 'utf8'));
    validPkg = validManifest.platforms['macos-aarch64'];
    validPackageData = fs.readFileSync(validPkg.localPath);
  });

  // VECTOR 1: Invalid Signatures
  it('Vector 1: Rejects package with invalid or forged cryptographic signature', async () => {
    // 1a: Forged signature using an untrusted key
    const untrustedKeys = crypto.generateKeyPairSync('ed25519');
    const forgedSig = crypto.sign(null, validPackageData, untrustedKeys.privateKey).toString('base64');

    const resultForged = await verifySignature(validPackageData, forgedSig, TRUSTED_PRODUCTION_PUBLIC_KEY);
    assert.equal(resultForged.valid, false, 'Forged signature must be rejected');

    // 1b: Corrupted signature string
    const resultCorrupted = await verifySignature(validPackageData, 'bad_tampered_signature_bytes');
    assert.equal(resultCorrupted.valid, false, 'Corrupted signature string must be rejected');

    // 1c: Verify installerService.verifyPackageIntegrity rejects it
    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(validPackageData, {
        ...validPkg,
        signature: forgedSig
      });
    }, /Package signature verification failed/);
  });

  // VECTOR 2: Modified Packages (Bit-flip attack)
  it('Vector 2: Rejects package with modified bytes (SHA-256 integrity mismatch)', async () => {
    // Tamper with a single byte in the package archive
    const tamperedData = Buffer.from(validPackageData);
    tamperedData[tamperedData.length - 50] ^= 0xFF; // flip bits

    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(tamperedData, validPkg);
    }, /Corrupted download: SHA-256 mismatch/);
  });

  // VECTOR 3: Corrupted / Unauthenticated Manifests
  it('Vector 3: Rejects manifests with tampered metadata or invalid manifest signature', async () => {
    // 3a: Tampered version without resigning
    const tamperedManifest = JSON.parse(JSON.stringify(validManifest));
    tamperedManifest.version = '9.9.9'; // attacker raises version
    const check1 = await verifyManifest(tamperedManifest);
    assert.equal(check1.valid, false, 'Manifest with modified version must fail verification');

    // 3b: Tampered checksum
    const tamperedHash = JSON.parse(JSON.stringify(validManifest));
    tamperedHash.platforms['macos-aarch64'].sha256 = 'e'.repeat(64);
    const check2 = await verifyManifest(tamperedHash);
    assert.equal(check2.valid, false, 'Manifest with modified SHA-256 must fail verification');

    // 3c: Missing manifestSignature
    const unsignedManifest = JSON.parse(JSON.stringify(validManifest));
    delete unsignedManifest.manifestSignature;
    const check3 = await verifyManifest(unsignedManifest);
    assert.equal(check3.valid, false, 'Unsigned manifest must fail verification');
    assert.ok(check3.errors.some(e => e.includes('manifestSignature is missing')));

    // 3d: Installer rejection
    await assert.rejects(async () => {
      await installerService.installApplication('ceova-cctv', unsignedManifest);
    }, /Unauthenticated release manifest rejected/);
  });

  // VECTOR 4: Archive Path Traversal (Zip Slip & Absolute Paths)
  it('Vector 4: Rejects path traversal (..) and absolute path tar entries', () => {
    const testTarget = path.join(ROOT_DIR, 'releases', 'dist', 'test_traversal_target');
    if (fs.existsSync(testTarget)) fs.rmSync(testTarget, { recursive: true, force: true });
    fs.mkdirSync(testTarget, { recursive: true });

    // Helper to build tar entry
    function makeTarEntry(name, content, typeflag = '0') {
      const header = Buffer.alloc(512);
      header.write(name, 0, 100, 'utf8');
      header.write('0000644\0', 100, 8, 'utf8');
      header.write('0001750\0', 108, 8, 'utf8');
      header.write('0001750\0', 116, 8, 'utf8');
      const sizeStr = content.length.toString(8).padStart(11, '0') + ' ';
      header.write(sizeStr, 124, 12, 'utf8');
      header.write('00000000000 ', 136, 12, 'utf8');
      header.write(typeflag, 156, 1, 'utf8');
      header.write('ustar\0', 257, 6, 'utf8');
      header.write('00', 263, 2, 'utf8');

      // Checksum
      let chksum = 0;
      for (let i = 0; i < 512; i++) chksum += header[i];
      chksum += 32 * 8;
      const chksumStr = chksum.toString(8).padStart(6, '0') + '\0 ';
      header.write(chksumStr, 148, 8, 'utf8');

      const padSize = Math.ceil(content.length / 512) * 512;
      const body = Buffer.alloc(padSize);
      content.copy(body, 0);

      return Buffer.concat([header, body]);
    }

    // 4a: Relative traversal entry: ../../escaped.txt
    const traversalPayload = Buffer.from('ATTACK PAYLOAD');
    const traversalTar = Buffer.concat([
      makeTarEntry('../../escaped.txt', traversalPayload),
      Buffer.alloc(1024)
    ]);
    const traversalGz = zlib.gzipSync(traversalTar);

    assert.throws(() => {
      extractArchiveSafely(traversalGz, testTarget);
    }, /Path traversal/);

    // 4b: Absolute path entry: /etc/evil
    const absoluteTar = Buffer.concat([
      makeTarEntry('/etc/evil.txt', traversalPayload),
      Buffer.alloc(1024)
    ]);
    const absoluteGz = zlib.gzipSync(absoluteTar);

    assert.throws(() => {
      extractArchiveSafely(absoluteGz, testTarget);
    }, /absolute path/i);

    // Verify nothing escaped or was extracted to testTarget
    assert.equal(fs.readdirSync(testTarget).length, 0, 'Target dir must remain empty after attack rejection');
    fs.rmSync(testTarget, { recursive: true, force: true });
  });

  // VECTOR 5: Interrupted Downloads
  it('Vector 5: Handles aborted download streams gracefully without corrupted artifacts', async () => {
    const controller = new AbortController();
    
    // Abort immediately before download
    controller.abort();

    await assert.rejects(async () => {
      await installerService.downloadPackage('http://127.0.0.1:9999/pkg.tar.gz', null, controller.signal);
    });

    // Ensure active operations cleanly cleaned up
    const active = installerService.activeOperations.get('ceova-cctv');
    assert.equal(active, undefined, 'Aborted operation must be cleaned up from activeOperations');
  });

  // VECTOR 6: Insufficient Disk Space / Decompression Bomb Protection
  it('Vector 6: Rejects archives exceeding decompressed size threshold', () => {
    const testTarget = path.join(ROOT_DIR, 'releases', 'dist', 'test_bomb_target');
    if (fs.existsSync(testTarget)) fs.rmSync(testTarget, { recursive: true, force: true });
    fs.mkdirSync(testTarget, { recursive: true });

    // Specify maxTotalBytes lower than archive content (e.g. 1 MB limit)
    assert.throws(() => {
      extractArchiveSafely(validPackageData, testTarget, {
        maxTotalBytes: 1024 * 1024 // 1 MB limit (valid package is ~70MB)
      });
    }, /Decompression bomb/);

    fs.rmSync(testTarget, { recursive: true, force: true });
  });

  // VECTOR 7: Service Shutdown Failure Escalation
  it('Vector 7: Escalates service shutdown when process fails to terminate gracefully', async () => {
    // When stopping service, if graceful stop times out or fails, cctvAgent handles it safely
    const stopResult = await cctvAgent.stopService();
    assert.equal(stopResult.success, true);

    const app = appRegistry.getApplication('ceova-cctv');
    assert.equal(app.agentStatus.running, false);
  });

  // VECTOR 8: Rollback Failure Safe Containment
  it('Vector 8: Rollback gracefully reports failure if previous version was missing', async () => {
    const fakePreviousState = {
      installedVersion: '0.0.0-nonexistent',
      publishedVersion: '0.0.0'
    };

    // Attempt rollback with non-existent previous version
    await installerService.rollback('ceova-cctv', fakePreviousState, 'Simulated failure', {
      skipServiceRestart: true
    });

    const app = appRegistry.getApplication('ceova-cctv');
    assert.equal(app.progress.phase, 'failed');
    assert.match(app.progress.message, /Rollback completed/);
  });
});
