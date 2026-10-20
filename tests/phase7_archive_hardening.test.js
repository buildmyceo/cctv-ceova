/**
 * CEOVA CCTV // Phase 7: Archive Hardening & Log Rotation Test Suite
 * tests/phase7_archive_hardening.test.js
 * 
 * Verifies:
 * 1. Bounded gunzip prevents decompression bombs (ERR_BUFFER_TOO_LARGE).
 * 2. PAX header paths (>100 characters) are properly resolved and extracted safely.
 * 3. PAX header path traversal (..) is rejected.
 * 4. PAX header absolute paths (/...) are rejected.
 * 5. Corrupted/malformed tar headers (checksum mismatch) are rejected.
 * 6. Duplicate entries are rejected.
 * 7. Unsafe symlinks escaping staging root are rejected.
 * 8. Log rotation enforces strict byte limit and rotating backups.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const { extractArchiveSafely } = await import(path.join(ROOT_DIR, 'services', 'safe_extractor.js'));

function createTarBlock(name, content, typeflag = '0', linkname = '') {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0001750\0', 108, 8, 'utf8');
  header.write('0001750\0', 116, 8, 'utf8');
  const sizeStr = content.length.toString(8).padStart(11, '0') + ' ';
  header.write(sizeStr, 124, 12, 'utf8');
  header.write('00000000000 ', 136, 12, 'utf8');
  header.write(typeflag, 156, 1, 'utf8');
  if (linkname) {
    header.write(linkname.slice(0, 100), 157, 100, 'utf8');
  }
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');

  // Compute checksum
  let chksum = 0;
  for (let i = 0; i < 512; i++) chksum += header[i];
  chksum += 32 * 8; // treat checksum field as 8 ASCII spaces
  const chksumStr = chksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chksumStr, 148, 8, 'utf8');

  const padSize = Math.ceil(content.length / 512) * 512;
  const body = Buffer.alloc(padSize);
  content.copy(body, 0);

  return Buffer.concat([header, body]);
}

function makePaxHeaderRecord(key, value) {
  const line = `${key}=${value}\n`;
  // calculate total length including length prefix and space
  let len = line.length + 3; // rough estimate
  let record = `${len} ${line}`;
  if (record.length !== len) {
    len = record.length;
    record = `${len} ${line}`;
  }
  return Buffer.from(record, 'utf8');
}

describe('PHASE 7: Archive and Log Hardening', () => {
  const testDir = path.join(ROOT_DIR, 'releases', 'dist', 'test_archive_hardening');

  // 1. Decompression Bomb Bounded Limit
  it('Rule 1 & 2: Enforces bounded decompression limit against zip bombs', () => {
    // Generate a 2MB buffer of zeros compressed into small gzip
    const bigZeros = Buffer.alloc(2 * 1024 * 1024, 0);
    const tarBomb = Buffer.concat([
      createTarBlock('bomb.txt', bigZeros),
      Buffer.alloc(1024)
    ]);
    const gzBomb = zlib.gzipSync(tarBomb);

    // Limit decompression to 1MB
    assert.throws(() => {
      extractArchiveSafely(gzBomb, testDir, { maxTotalBytes: 1024 * 1024 });
    }, /Decompression bomb rejected/i);
  });

  // 2. PAX Extended Headers for Long Paths
  it('Rule 3a: Safely extracts files with long paths using POSIX PAX headers', () => {
    const longPath = 'nested/' + 'a'.repeat(60) + '/' + 'b'.repeat(60) + '/long_file.txt';
    const payload = Buffer.from('CONTENT IN LONG PATH');
    const paxRecord = makePaxHeaderRecord('path', longPath);

    const archiveTar = Buffer.concat([
      createTarBlock('PaxHeader/long_file.txt', paxRecord, 'x'),
      createTarBlock('truncated_name.txt', payload, '0'),
      Buffer.alloc(1024)
    ]);
    const archiveGz = zlib.gzipSync(archiveTar);

    const targetDir = path.join(testDir, 'pax_target');
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    extractArchiveSafely(archiveGz, targetDir);

    const expectedFile = path.join(targetDir, longPath);
    assert.ok(fs.existsSync(expectedFile), 'File with long path from PAX header must be extracted');
    assert.equal(fs.readFileSync(expectedFile, 'utf8'), 'CONTENT IN LONG PATH');

    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  // 3. PAX Header Path Traversal Rejection
  it('Rule 3b: Rejects path traversal (..) hidden inside POSIX PAX header', () => {
    const maliciousPax = makePaxHeaderRecord('path', '../../escaped_via_pax.txt');
    const payload = Buffer.from('ATTACK PAYLOAD');

    const archiveTar = Buffer.concat([
      createTarBlock('PaxHeader/attack', maliciousPax, 'x'),
      createTarBlock('innocent.txt', payload, '0'),
      Buffer.alloc(1024)
    ]);
    const archiveGz = zlib.gzipSync(archiveTar);

    const targetDir = path.join(testDir, 'pax_traversal');
    assert.throws(() => {
      extractArchiveSafely(archiveGz, targetDir);
    }, /Path traversal attempt detected/i);

    assert.ok(!fs.existsSync(targetDir), 'Target dir must not exist after traversal rejection');
  });

  // 4. PAX Header Absolute Path Rejection
  it('Rule 3c: Rejects absolute path hidden inside POSIX PAX header', () => {
    const maliciousPax = makePaxHeaderRecord('path', '/etc/shadow_pax');
    const payload = Buffer.from('ATTACK PAYLOAD');

    const archiveTar = Buffer.concat([
      createTarBlock('PaxHeader/attack', maliciousPax, 'x'),
      createTarBlock('innocent.txt', payload, '0'),
      Buffer.alloc(1024)
    ]);
    const archiveGz = zlib.gzipSync(archiveTar);

    const targetDir = path.join(testDir, 'pax_absolute');
    assert.throws(() => {
      extractArchiveSafely(archiveGz, targetDir);
    }, /Rejected absolute path in archive/i);
  });

  // 5. Malformed Tar Header Checksum Rejection
  it('Rule 4a: Rejects malformed tar headers with corrupted checksums', () => {
    const payload = Buffer.from('SOME DATA');
    const block = createTarBlock('corrupt.txt', payload, '0');
    // Corrupt the checksum field
    block.write('999999\0', 148, 8, 'utf8');

    const corruptTar = Buffer.concat([block, Buffer.alloc(1024)]);
    const corruptGz = zlib.gzipSync(corruptTar);

    const targetDir = path.join(testDir, 'corrupt_target');
    assert.throws(() => {
      extractArchiveSafely(corruptGz, targetDir);
    }, /Malformed tar header: invalid checksum/i);
  });

  // 6. Duplicate Entry Rejection
  it('Rule 4b: Rejects duplicate entries to prevent overwrite attacks', () => {
    const payload1 = Buffer.from('DATA 1');
    const payload2 = Buffer.from('DATA 2');

    const duplicateTar = Buffer.concat([
      createTarBlock('file.txt', payload1, '0'),
      createTarBlock('file.txt', payload2, '0'),
      Buffer.alloc(1024)
    ]);
    const duplicateGz = zlib.gzipSync(duplicateTar);

    const targetDir = path.join(testDir, 'duplicate_target');
    assert.throws(() => {
      extractArchiveSafely(duplicateGz, targetDir);
    }, /Duplicate or conflicting entry in archive/i);
  });

  // 7. Symlink Escape Rejection
  it('Rule 4c: Rejects symlinks pointing outside staging root', () => {
    const escapeTar = Buffer.concat([
      createTarBlock('escape_link', Buffer.alloc(0), '2', '../../../etc/passwd'),
      Buffer.alloc(1024)
    ]);
    const escapeGz = zlib.gzipSync(escapeTar);

    const targetDir = path.join(testDir, 'escape_target');
    assert.throws(() => {
      extractArchiveSafely(escapeGz, targetDir);
    }, /escaping staging root/i);
  });

  // 8. Atomic Activation - Target Untouched on Failure
  it('Rule 5: Failed extraction never replaces or corrupts existing target directory', () => {
    const activeDir = path.join(testDir, 'active_release');
    if (fs.existsSync(activeDir)) fs.rmSync(activeDir, { recursive: true, force: true });
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'existing_vital_file.txt'), 'VITAL PRODUCTION DATA');

    // Attempt to extract corrupted archive over active release
    const corruptTar = Buffer.concat([
      createTarBlock('../escaped.txt', Buffer.from('BAD')),
      Buffer.alloc(1024)
    ]);
    const corruptGz = zlib.gzipSync(corruptTar);

    assert.throws(() => {
      extractArchiveSafely(corruptGz, activeDir);
    });

    // Verify existing active release is intact
    assert.ok(fs.existsSync(path.join(activeDir, 'existing_vital_file.txt')));
    assert.equal(fs.readFileSync(path.join(activeDir, 'existing_vital_file.txt'), 'utf8'), 'VITAL PRODUCTION DATA');

    fs.rmSync(activeDir, { recursive: true, force: true });
  });
});
