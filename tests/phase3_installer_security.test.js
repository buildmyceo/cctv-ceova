/**
 * CEOVA CCTV // Phase 3: Installer Verification Bypasses Remediation Test Suite
 * tests/phase3_installer_security.test.js
 * 
 * Verifies that all installation security bypasses have been eradicated:
 * 1. Manifest-supplied pkg.publicKey override is strictly ignored/rejected.
 * 2. Invalid package signatures fail.
 * 3. Incorrect SHA-256 checksums fail.
 * 4. Incorrect package byte length fails.
 * 5. Test flags (mockInstall, mockHealth, mockData) cannot bypass verification.
 * 6. Malformed manifests fail closed.
 * 7. Unsupported platform identifiers fail closed.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Services from ceova-window-app
const APP_SERVICES = '/Users/chintukumar/ceova-window-app/src/services';
const { installerService } = await import(path.join(APP_SERVICES, 'installerService.js'));
const { 
  verifySignature, 
  calculateSha256, 
  verifyManifest, 
  TRUSTED_PRODUCTION_PUBLIC_KEY 
} = await import(path.join(APP_SERVICES, 'updateManifest.js'));

// Release signing helper
const { signPayload } = await import(path.join(ROOT_DIR, 'scripts', 'sign_release.js'));

describe('PHASE 3: Installer Security & Verification Bypasses Remediation', { concurrency: false }, () => {
  const manifestsDir = path.join(ROOT_DIR, 'releases', 'dist');
  let genuineManifest;
  let genuinePkg;
  let genuinePackageData;

  before(() => {
    genuineManifest = JSON.parse(fs.readFileSync(path.join(manifestsDir, 'manifest-1.0.0.json'), 'utf8'));
    genuinePkg = genuineManifest.platforms['macos-aarch64'];
    assert.ok(genuinePkg, 'Manifest must contain macos-aarch64 package');
    genuinePackageData = fs.readFileSync(genuinePkg.localPath);
  });

  // TEST 1: Manifest pkg.publicKey Override Rejection
  it('Rule 2 & 3: Ignores attacker-supplied pkg.publicKey in manifest and verifies strictly against pinned key', async () => {
    // Generate an attacker keypair
    const attackerKeypair = crypto.generateKeyPairSync('ed25519');
    const attackerPrivateKeyPem = attackerKeypair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const attackerPublicKeyPem = attackerKeypair.publicKey.export({ type: 'spki', format: 'pem' });

    // Attacker signs package using attacker key
    const maliciousPayload = Buffer.from('ATTACKER TAMPERED PACKAGE CONTENT');
    const attackerSignature = crypto.sign(null, maliciousPayload, attackerPrivateKeyPem).toString('base64');
    const attackerSha256 = crypto.createHash('sha256').update(maliciousPayload).digest('hex');

    // Create a forged package descriptor claiming the attacker public key
    const forgedPkg = {
      ...genuinePkg,
      size: maliciousPayload.length,
      sha256: attackerSha256,
      signature: attackerSignature,
      publicKey: attackerPublicKeyPem // Attacker attempt to override trusted key
    };

    // Attempt verification: Must FAIL because pinned key is used
    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(maliciousPayload, forgedPkg);
    }, /signature verification failed|Invalid signature/i);
  });

  // TEST 2: Invalid Cryptographic Signatures Fail
  it('Rule 5a: Invalid or corrupted cryptographic signature causes verification to fail', async () => {
    const corruptedPkg = {
      ...genuinePkg,
      signature: 'ZHVtbXlfaW52YWxpZF9zaWduYXR1cmVfZm9yX3Rlc3RpbmdfcHVycG9zZXM='
    };

    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(genuinePackageData, corruptedPkg);
    }, /signature verification failed/i);
  });

  // TEST 3: Incorrect Checksums Fail
  it('Rule 5b: Incorrect SHA-256 checksum causes verification to fail', async () => {
    const tamperedData = Buffer.from(genuinePackageData);
    tamperedData[tamperedData.length - 1] ^= 0xff; // Flip a bit

    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(tamperedData, genuinePkg);
    }, /SHA-256 mismatch/i);
  });

  // TEST 4: Incorrect Package Sizes Fail
  it('Rule 5c: Package size mismatch fails verification', async () => {
    const wrongSizePkg = {
      ...genuinePkg,
      size: genuinePackageData.length + 1024 // Size mismatch
    };

    await assert.rejects(async () => {
      await installerService.verifyPackageIntegrity(genuinePackageData, wrongSizePkg);
    }, /Package size mismatch/i);
  });

  // TEST 5: Test Flags Cannot Bypass Installation Security
  it('Rule 1: mockInstall, mockHealth, or mockData flags cannot bypass signature verification', async () => {
    const badSignatureManifest = JSON.parse(JSON.stringify(genuineManifest));
    badSignatureManifest.platforms['macos-aarch64'].signature = 'ZmFrZXNpZ25hdHVyZQ==';

    // Attempt install passing all conceivable bypass flags
    await assert.rejects(async () => {
      await installerService.installApplication('ceova-cctv', badSignatureManifest, {
        mockInstall: true,
        mockHealth: true,
        mockData: true,
        bypassVerification: true
      });
    }, /signature verification failed/i);
  });

  // TEST 6: Malformed Manifest Fails Closed
  it('Rule 4 & 6: Malformed manifest with forged metadata fails closed', async () => {
    const forgedManifest = {
      appId: 'ceova-cctv',
      version: '1.0.0',
      platforms: {
        'macos-aarch64': {
          ...genuinePkg,
          sha256: '0000000000000000000000000000000000000000000000000000000000000000'
        }
      },
      signature: genuineManifest.signature // Reusing signature on modified payload
    };

    const authResult = await verifyManifest(forgedManifest);
    assert.equal(authResult.valid, false, 'Forged manifest must fail cryptographic validation');
    assert.ok(authResult.errors.length > 0, 'Must report manifest errors');
  });

  // TEST 7: Unsupported Platform Identifier Fails Closed
  it('Rule 6: Unexpected or unsupported platform identifier fails closed', async () => {
    const foreignPlatformManifest = {
      appId: 'ceova-cctv',
      version: '1.0.0',
      platforms: {
        'freebsd-mips': {
          packageUrl: 'http://example.com/cctv.tar.gz',
          sha256: 'abc',
          size: 100,
          signature: 'sig'
        }
      }
    };

    await assert.rejects(async () => {
      await installerService.installApplication('ceova-cctv', foreignPlatformManifest);
    });
  });
});
