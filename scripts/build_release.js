/**
 * CEOVA CCTV // Official Release Packager & Signing Pipeline
 * scripts/build_release.js
 * 
 * Bundles the standalone CCTV application into signed release packages with:
 * - Bundled Node.js runtime (standalone Mach-O binary)
 * - Bundled production node_modules
 * - Bundled YOLOv8 AI models
 * - Runtime bootstrap components
 * - Strictly excluded private keys and operational databases
 * - SHA-256 Checksums
 * - Package Ed25519 Cryptographic Signatures
 * - Authenticated & Cryptographically Bound Manifests
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { 
  calculateSha256, 
  signPayload, 
  verifySignature, 
  signManifest, 
  verifyManifestSignature 
} = require('./sign_release');

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASES_DIR = path.join(ROOT_DIR, 'releases', 'dist');
const WINDOWS_APP_RELEASES_DIR = '/Users/chintukumar/ceova-window-app/public/releases/cctv';

for (const dir of [RELEASES_DIR, WINDOWS_APP_RELEASES_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function createArchive(version, outputFilename) {
  const archivePath = path.join(RELEASES_DIR, outputFilename);
  if (fs.existsSync(archivePath)) {
    fs.unlinkSync(archivePath);
  }

  console.log(`[PACKAGER] Packaging Standalone CCTV v${version} into ${outputFilename}...`);

  // Explicitly ensure runtime/bin/node is present and executable
  const runtimeNode = path.join(ROOT_DIR, 'runtime', 'bin', 'node');
  if (!fs.existsSync(runtimeNode)) {
    fs.mkdirSync(path.join(ROOT_DIR, 'runtime', 'bin'), { recursive: true });
    fs.copyFileSync(process.execPath, runtimeNode);
    fs.chmodSync(runtimeNode, 0o755);
  }

  // Validate that bundled node binary matches target architecture (arm64 Apple Silicon)
  const archCheck = execSync(`file "${runtimeNode}"`).toString();
  if (!archCheck.includes('arm64')) {
    throw new Error(`CRITICAL PACKAGING FAILURE: Bundled binary is not arm64: ${archCheck.trim()}`);
  }

  // Items to bundle in the standalone package
  const includeItems = [
    'package.json',
    'server.js',
    'api',
    'bots',
    'context',
    'db',
    'events',
    'hardware',
    'identity',
    'public',
    'security',
    'services',
    'vision',
    'runtime',
    'node_modules',
    'keys/release_public_key.pem',
    'data/models'
  ];

  const itemsStr = includeItems
    .filter(item => fs.existsSync(path.join(ROOT_DIR, item)))
    .join(' ');

  // Strict exclusions protecting keys, operational data, logs, and git
  const excludeFlags = [
    "--exclude='*private*.pem'",
    "--exclude='*.private.*'",
    "--exclude='*private*.key'",
    "--exclude='keys/release_private_key.pem'",
    "--exclude='.git'",
    "--exclude='data/*.db*'",
    "--exclude='data/config'",
    "--exclude='data/run'",
    "--exclude='data/logs'",
    "--exclude='data/ssl'",
    "--exclude='*.DS_Store'",
    "--exclude='*.log'",
    "--exclude='*.pid'",
    "--exclude='__pycache__'",
    "--exclude='*.pyc'"
  ].join(' ');

  const tarCmd = `tar -czf "${archivePath}" ${excludeFlags} ${itemsStr}`;
  execSync(tarCmd, { cwd: ROOT_DIR });

  const stat = fs.statSync(archivePath);
  console.log(`[PACKAGER] Created ${outputFilename} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);

  // Verify private key was NEVER packaged
  const checkPrivateKeyCmd = `tar -tzf "${archivePath}" | grep -E "(release_private_key|private.*\\.pem|private.*\\.key)" || true`;
  const leakedKeys = execSync(checkPrivateKeyCmd).toString().trim();
  if (leakedKeys) {
    fs.unlinkSync(archivePath);
    throw new Error(`CRITICAL SECURITY FAILURE: Private key found in archive: ${leakedKeys}`);
  }

  const fileData = fs.readFileSync(archivePath);
  const sha256 = calculateSha256(fileData);
  const signature = signPayload(fileData);
  const isValid = verifySignature(fileData, signature);

  if (!isValid) {
    throw new Error(`Package self-signature verification failed for ${outputFilename}`);
  }

  return {
    filename: outputFilename,
    path: archivePath,
    size: stat.size,
    sha256,
    signature
  };
}

function buildRelease(version = '1.0.0') {
  console.log(`\n======================================================`);
  console.log(`  BUILDING AUTHENTICATED CEOVA CCTV RELEASE v${version}`);
  console.log(`======================================================`);

  // Temporarily ensure package.json has the exact release version
  const pkgJsonPath = path.join(ROOT_DIR, 'package.json');
  const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const prevVersion = pkgData.version;
  pkgData.version = version;
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgData, null, 2) + '\n', 'utf8');

  let macArm;
  try {
    // Genuine validated macOS Apple Silicon (ARM64) Standalone Archive
    macArm = createArchive(version, `ceova-cctv-${version}-macos-aarch64.tar.gz`);
  } finally {
    pkgData.version = prevVersion;
    fs.writeFileSync(pkgJsonPath, JSON.stringify(pkgData, null, 2) + '\n', 'utf8');
  }

  const baseUrl = `file://${RELEASES_DIR}`;

  // Only advertise platforms that have genuine built & validated artifacts
  const manifest = {
    appId: 'ceova-cctv',
    version: version,
    minSupportedVersion: '1.0.0',
    platforms: {
      'macos-aarch64': {
        packageUrl: `${baseUrl}/${macArm.filename}`,
        localPath: macArm.path,
        sha256: macArm.sha256,
        signature: macArm.signature,
        size: macArm.size
      },
      'macos': {
        packageUrl: `${baseUrl}/${macArm.filename}`,
        localPath: macArm.path,
        sha256: macArm.sha256,
        signature: macArm.signature,
        size: macArm.size
      }
    },
    releaseNotes: version === '1.0.0'
      ? 'Initial standalone verified release of CEOVA CCTV for macOS Apple Silicon (arm64).'
      : `CEOVA CCTV v${version} update for macOS Apple Silicon with security hardening.`,
    releasedAt: new Date().toISOString()
  };

  // Sign and bind the complete manifest
  signManifest(manifest);

  const manifestAuth = verifyManifestSignature(manifest);
  if (!manifestAuth.valid) {
    throw new Error(`Manifest signature verification failed: ${manifestAuth.error}`);
  }

  const manifestPath = path.join(RELEASES_DIR, `manifest-${version}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[PACKAGER] Authenticated release manifest signed & saved to ${manifestPath}`);

  // Deploy to ceova-window-app public releases
  const deployedManifestPath = path.join(WINDOWS_APP_RELEASES_DIR, `manifest-${version}.json`);
  fs.writeFileSync(deployedManifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.copyFileSync(macArm.path, path.join(WINDOWS_APP_RELEASES_DIR, macArm.filename));

  return manifest;
}

if (require.main === module) {
  const v1 = buildRelease('1.0.0');
  const v2 = buildRelease('1.0.1');

  // Corrupted manifest for security testing
  const corruptManifestPath = path.join(RELEASES_DIR, 'manifest-1.0.2-corrupt.json');
  const corruptManifest = JSON.parse(JSON.stringify(v2));
  corruptManifest.version = '1.0.2';
  corruptManifest.platforms['macos-aarch64'].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';
  fs.writeFileSync(corruptManifestPath, JSON.stringify(corruptManifest, null, 2), 'utf8');
  fs.copyFileSync(corruptManifestPath, path.join(WINDOWS_APP_RELEASES_DIR, 'manifest-1.0.2-corrupt.json'));

  console.log('\n[PACKAGER] Packaging and authenticated manifest generation complete!');
}

module.exports = {
  buildRelease
};
