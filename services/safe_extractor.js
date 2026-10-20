/**
 * CEOVA CCTV // Production Hardened Safe Archive Extractor
 * services/safe_extractor.js
 * 
 * Strict defense against Zip Slip, Path Traversal, Decompression Bombs,
 * Symlink Escapes, and Shell Injection attacks.
 * 
 * Enforces:
 * - Zero shell command construction.
 * - Absolute path rejection.
 * - Path traversal (..) entry rejection.
 * - Symlink destination confinement within staging boundary.
 * - Unsupported file type rejection (FIFOs, block/char devices, hardlinks).
 * - Bounded maximum decompressed size (Zip bomb defense).
 * - Duplicate & conflicting path rejection.
 * - Two-phase extraction (Staging -> Validation -> Atomic Activation).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_MAX_TOTAL_BYTES = 500 * 1024 * 1024; // 500 MB limit
const DEFAULT_MAX_FILE_COUNT = 10000;
const DEFAULT_MAX_SINGLE_FILE_BYTES = 250 * 1024 * 1024; // 250 MB per file

/**
 * Parses POSIX PAX extended attributes
 */
function parsePaxHeader(contentBuffer) {
  const attrs = {};
  const str = contentBuffer.toString('utf8');
  let pos = 0;
  while (pos < str.length) {
    const spaceIdx = str.indexOf(' ', pos);
    if (spaceIdx === -1) break;
    const lenStr = str.substring(pos, spaceIdx);
    const len = parseInt(lenStr, 10);
    if (isNaN(len) || len <= (spaceIdx - pos)) break;
    const record = str.substring(spaceIdx + 1, pos + len - (str[pos + len - 1] === '\n' ? 1 : 0));
    const eqIdx = record.indexOf('=');
    if (eqIdx !== -1) {
      const key = record.substring(0, eqIdx);
      const val = record.substring(eqIdx + 1);
      attrs[key] = val;
    }
    pos += len;
  }
  return attrs;
}

/**
 * Validates TAR header 512-byte block checksum
 */
function verifyTarHeaderChecksum(header) {
  const chksumStr = header.subarray(148, 156).toString('utf8').trim().replace(/\0.*$/, '');
  const expectedChksum = parseInt(chksumStr, 8);
  if (isNaN(expectedChksum)) return false;

  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      sum += 32; // tar treats checksum field as ASCII spaces
    } else {
      sum += header[i];
    }
  }
  return sum === expectedChksum;
}

/**
 * Safely extracts a .tar.gz archive buffer into targetDir
 */
function extractArchiveSafely(archiveBuffer, targetDir, options = {}) {
  const maxTotalBytes = options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES;
  const maxFileCount = options.maxFileCount || DEFAULT_MAX_FILE_COUNT;
  const maxSingleFileBytes = options.maxSingleFileBytes || DEFAULT_MAX_SINGLE_FILE_BYTES;

  if (!Buffer.isBuffer(archiveBuffer) && !(archiveBuffer instanceof Uint8Array)) {
    throw new Error('SafeExtractor: Invalid archive buffer');
  }

  // Enforce bounded decompression to protect against zip bomb exhaustion
  let rawTarBuffer;
  try {
    rawTarBuffer = zlib.gunzipSync(archiveBuffer, { maxOutputLength: maxTotalBytes });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`SafeExtractor: Cumulative decompressed size exceeded limit (${maxTotalBytes} bytes) - Decompression bomb rejected`);
    }
    throw new Error(`SafeExtractor: Decompression failed: ${err.message}`);
  }

  // Staging directory setup
  const resolvedTarget = path.resolve(targetDir);
  const stagingDir = path.join(resolvedTarget, `..`, `.staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });

  let offset = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let longName = null;
  let paxAttributes = null;
  const seenPaths = new Set();
  const deferredSymlinks = [];

  try {
    while (offset + 512 <= rawTarBuffer.length) {
      const header = rawTarBuffer.subarray(offset, offset + 512);
      
      // Two consecutive 512-byte zero blocks signify end of archive
      if (header.every(b => b === 0)) {
        break;
      }

      // Validate header block checksum to reject malformed/corrupted archives
      if (!verifyTarHeaderChecksum(header)) {
        throw new Error(`SafeExtractor: Malformed tar header: invalid checksum at block offset ${offset}`);
      }

      let entryName = (paxAttributes && paxAttributes.path) || longName || header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
      const paxLink = (paxAttributes && paxAttributes.linkpath) || null;
      longName = null;
      paxAttributes = null;

      const sizeOctal = header.subarray(124, 136).toString('utf8').trim().replace(/\0.*$/, '');
      const size = parseInt(sizeOctal, 8);
      if (isNaN(size) || size < 0) {
        throw new Error(`SafeExtractor: Malformed header: invalid file size '${sizeOctal}'`);
      }
      const typeflag = String.fromCharCode(header[156]);

      // Read ustar prefix if present and not already using GNU long name or PAX
      const magic = header.subarray(257, 263).toString('utf8');
      if (!entryName.includes('/') && magic.startsWith('ustar')) {
        const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
        if (prefix) {
          entryName = prefix + '/' + entryName;
        }
      }

      const modeOctal = header.subarray(100, 108).toString('utf8').trim().replace(/\0.*$/, '');
      const mode = (parseInt(modeOctal, 8) || 0o644) & 0o777;

      offset += 512;
      const contentEnd = offset + size;
      const content = rawTarBuffer.subarray(offset, contentEnd);
      offset += Math.ceil(size / 512) * 512;

      // Handle GNU LongLink / LongName extension
      if (typeflag === 'L') {
        longName = content.toString('utf8').replace(/\0.*$/, '').trim();
        continue;
      }

      // Handle POSIX PaxHeader extended metadata headers
      if (typeflag === 'x') {
        paxAttributes = parsePaxHeader(content);
        continue;
      }
      if (typeflag === 'g' || entryName.startsWith('PaxHeader/')) {
        continue;
      }

      if (!entryName) continue;

      entryCount++;
      if (entryCount > maxFileCount) {
        throw new Error(`SafeExtractor: File count limit (${maxFileCount}) exceeded in archive`);
      }

      // ─── 1. Absolute Path Rejection ─────────────────────────────
      if (
        entryName.startsWith('/') || 
        entryName.startsWith('\\') || 
        /^[a-zA-Z]:/.test(entryName)
      ) {
        throw new Error(`SafeExtractor: Rejected absolute path in archive: ${entryName}`);
      }

      // ─── 2. Path Traversal Rejection ────────────────────────────
      const normalizedRelative = path.normalize(entryName).replace(/^(\.\/)+/, '');
      if (normalizedRelative.startsWith('..') || path.isAbsolute(normalizedRelative)) {
        throw new Error(`SafeExtractor: Path traversal attempt detected: ${entryName}`);
      }

      const destPath = path.resolve(stagingDir, normalizedRelative);
      const stagingBoundary = path.resolve(stagingDir) + path.sep;
      if (!destPath.startsWith(stagingBoundary) && destPath !== path.resolve(stagingDir)) {
        throw new Error(`SafeExtractor: Entry escapes staging root boundary: ${entryName}`);
      }

      // ─── 3. Duplicate / Conflicting Path Rejection ──────────────
      if (seenPaths.has(destPath)) {
        throw new Error(`SafeExtractor: Duplicate or conflicting entry in archive: ${entryName}`);
      }
      seenPaths.add(destPath);

      // ─── 4. Decompression Size Limit ────────────────────────────
      if (size > maxSingleFileBytes) {
        throw new Error(`SafeExtractor: Single file size (${size}) exceeds limit (${maxSingleFileBytes}) for ${entryName}`);
      }
      totalBytes += size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`SafeExtractor: Cumulative decompressed size exceeded limit (${maxTotalBytes} bytes) - Decompression bomb rejected`);
      }

      // ─── 5. File Type Validation ────────────────────────────────
      // '5' = Directory
      if (typeflag === '5' || entryName.endsWith('/')) {
        fs.mkdirSync(destPath, { recursive: true, mode: mode || 0o755 });
        continue;
      }

      // '2' = Symbolic Link
      if (typeflag === '2') {
        const rawLinkName = paxLink || header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '').trim();
        if (!rawLinkName) {
          throw new Error(`SafeExtractor: Empty symlink target for ${entryName}`);
        }

        // Rejection of absolute symlinks
        if (rawLinkName.startsWith('/') || rawLinkName.startsWith('\\') || /^[a-zA-Z]:/.test(rawLinkName)) {
          throw new Error(`SafeExtractor: Rejected absolute symlink target '${rawLinkName}' in ${entryName}`);
        }

        // Validate resolved link does not escape staging root
        const targetResolved = path.resolve(path.dirname(destPath), rawLinkName);
        if (!targetResolved.startsWith(stagingBoundary) && targetResolved !== path.resolve(stagingDir)) {
          throw new Error(`SafeExtractor: Rejected symlink '${entryName}' -> '${rawLinkName}' escaping staging root`);
        }

        // Defer creating symlink until files are written
        deferredSymlinks.push({ destPath, linkTarget: rawLinkName });
        continue;
      }

      // Regular File: '0' or '\0'
      if (typeflag === '0' || typeflag === '\0') {
        const parentDir = path.dirname(destPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        fs.writeFileSync(destPath, content, { mode });
        continue;
      }

      // Reject all other types (hard links '1', char devices '3', block devices '4', FIFOs '6')
      throw new Error(`SafeExtractor: Unsupported/dangerous file type flag '${typeflag}' for entry: ${entryName}`);
    }

    // Process safe relative symlinks after files exist
    for (const { destPath, linkTarget } of deferredSymlinks) {
      const parentDir = path.dirname(destPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
      }
      fs.symlinkSync(linkTarget, destPath);
    }

    // ─── 6. Validate Staging Contents ───────────────────────────
    if (options.requiredFiles && Array.isArray(options.requiredFiles)) {
      for (const reqFile of options.requiredFiles) {
        const checkPath = path.join(stagingDir, reqFile);
        if (!fs.existsSync(checkPath)) {
          throw new Error(`SafeExtractor: Missing required verified component: ${reqFile}`);
        }
      }
    }

    // ─── 7. Final Atomic Activation ─────────────────────────────
    if (fs.existsSync(resolvedTarget)) {
      fs.rmSync(resolvedTarget, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, resolvedTarget);

    return {
      success: true,
      entriesExtracted: entryCount,
      totalBytesExtracted: totalBytes,
      targetDir: resolvedTarget
    };
  } catch (err) {
    // Cleanup staging directory on any failure
    if (fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch (_e) {}
    }
    throw err;
  }
}

module.exports = {
  extractArchiveSafely
};
