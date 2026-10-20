/**
 * CEOVA Official Release Signing & Manifest Authentication Utility
 * scripts/sign_release.js
 * 
 * Provides:
 * - SHA-256 calculation for packages and manifests.
 * - Ed25519 cryptographic signing using private release key.
 * - Canonical payload binding for release manifests.
 * - Manifest and package signature verification against trusted public key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'keys', 'release_private_key.pem');
const PUBLIC_KEY_PATH = path.join(__dirname, '..', 'keys', 'release_public_key.pem');

function getPrivateKey() {
  if (process.env.CEOVA_RELEASE_PRIVATE_KEY) {
    return process.env.CEOVA_RELEASE_PRIVATE_KEY;
  }
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    throw new Error(`Private release key not found. Ensure CEOVA_RELEASE_PRIVATE_KEY is set in secure environment or ${PRIVATE_KEY_PATH} exists.`);
  }
  return fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
}

function getPublicKey() {
  if (process.env.CEOVA_RELEASE_PUBLIC_KEY) {
    return process.env.CEOVA_RELEASE_PUBLIC_KEY;
  }
  if (!fs.existsSync(PUBLIC_KEY_PATH)) {
    throw new Error(`Public key not found at ${PUBLIC_KEY_PATH}`);
  }
  return fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
}

function calculateSha256(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function signPayload(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const privateKey = getPrivateKey();
  const signature = crypto.sign(null, buffer, privateKey);
  return signature.toString('base64');
}

function verifySignature(data, signatureBase64, publicKeyPem = null) {
  if (!signatureBase64) return false;
  try {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const sigBuffer = Buffer.from(signatureBase64, 'base64');
    const pubKey = publicKeyPem || getPublicKey();
    return crypto.verify(null, buffer, pubKey, sigBuffer);
  } catch (_e) {
    return false;
  }
}

/**
 * Constructs canonical payload binding:
 * - Application ID
 * - Version
 * - Minimum Supported Version
 * - Each platform's Key, Package URL, Package SHA-256, Package Size
 */
function getCanonicalManifestPayload(manifest) {
  if (!manifest || !manifest.appId || !manifest.version || !manifest.platforms) {
    throw new Error('Manifest missing required fields for canonical binding (appId, version, platforms)');
  }

  const sortedPlatformKeys = Object.keys(manifest.platforms).sort();
  const platformsBound = sortedPlatformKeys.map(key => {
    const p = manifest.platforms[key];
    if (!p.packageUrl || !p.sha256 || typeof p.size !== 'number') {
      throw new Error(`Platform ${key} missing packageUrl, sha256, or valid size`);
    }
    return `${key}:${p.packageUrl}:${p.sha256.toLowerCase()}:${p.size}`;
  }).join('|');

  return [
    `appId:${manifest.appId}`,
    `version:${manifest.version}`,
    `minSupportedVersion:${manifest.minSupportedVersion || ''}`,
    `platforms:${platformsBound}`
  ].join('\n');
}

function signManifest(manifest) {
  const canonical = getCanonicalManifestPayload(manifest);
  manifest.manifestSignature = signPayload(canonical);
  manifest.canonicalPayload = canonical;
  return manifest;
}

function verifyManifestSignature(manifest, publicKeyPem = null) {
  if (!manifest || !manifest.manifestSignature) {
    return { valid: false, error: 'Manifest signature missing' };
  }
  try {
    const canonical = getCanonicalManifestPayload(manifest);
    const valid = verifySignature(canonical, manifest.manifestSignature, publicKeyPem);
    return { valid, error: valid ? null : 'Manifest cryptographic signature verification failed: signature mismatch' };
  } catch (err) {
    return { valid: false, error: `Manifest validation error: ${err.message}` };
  }
}

module.exports = {
  calculateSha256,
  signPayload,
  verifySignature,
  getPublicKey,
  getPrivateKey,
  getCanonicalManifestPayload,
  signManifest,
  verifyManifestSignature
};

if (require.main === module) {
  const targetFile = process.argv[2];
  if (!targetFile) {
    console.log('Usage: node scripts/sign_release.js <file_or_manifest.json>');
    process.exit(1);
  }
  const content = fs.readFileSync(path.resolve(targetFile));
  try {
    const json = JSON.parse(content.toString('utf8'));
    if (json.appId && json.platforms) {
      signManifest(json);
      fs.writeFileSync(path.resolve(targetFile), JSON.stringify(json, null, 2), 'utf8');
      console.log('Successfully authenticated and signed manifest:', targetFile);
      process.exit(0);
    }
  } catch (_e) {}

  const sha256 = calculateSha256(content);
  const signature = signPayload(content);
  console.log('SHA-256:', sha256);
  console.log('Signature:', signature);
}
