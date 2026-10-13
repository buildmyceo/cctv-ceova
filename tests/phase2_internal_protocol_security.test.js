import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';

const { 
  verifyCeovaInternalProtocol, 
  computeSignature 
} = await import('/Users/chintukumar/cctv-ceova/security/ceova_protocol.js');

describe('PHASE 2: Ceova Internal Protocol Security & Secret Hardening', () => {
  const TEST_SECRET = 'valid-production-shared-secret-key-32chars!';
  let server;
  let baseUrl;
  let port;

  before(async () => {
    const app = express();
    app.use(express.json());

    app.post('/api/v1/internal/test-endpoint', verifyCeovaInternalProtocol, (req, res) => {
      res.json({
        success: true,
        caller: req.internalCaller,
        isInternal: req.isCeovaInternal
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(() => {
    delete process.env.CEOVA_INTERNAL_SECRET;
    server.close();
  });

  function makePost(headers, body = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = http.request(`${baseUrl}/api/v1/internal/test-endpoint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      }, (res) => {
        let resBody = '';
        res.on('data', c => resBody += c);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resBody); } catch (_) {}
          resolve({ status: res.statusCode, body: resBody, json });
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  it('1. Fails securely with HTTP 503 when CEOVA_INTERNAL_SECRET is unconfigured', async () => {
    delete process.env.CEOVA_INTERNAL_SECRET;
    const res = await makePost({ 'x-ceova-internal-key': 'any-key' });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /ServiceUnavailable/);
    assert.match(res.json.message, /unconfigured or invalid/);
  });

  it('2. Fails securely with HTTP 503 when CEOVA_INTERNAL_SECRET is too short (< 16 chars)', async () => {
    process.env.CEOVA_INTERNAL_SECRET = 'short-key';
    const res = await makePost({ 'x-ceova-internal-key': 'short-key' });
    assert.equal(res.status, 503);
    assert.match(res.json.error, /ServiceUnavailable/);
  });

  it('3. Rejects requests without authentication with HTTP 401', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const res = await makePost({});
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Unauthorized/);
  });

  it('4. Rejects requests with invalid internal key with HTTP 401', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const res = await makePost({ 'x-ceova-internal-key': 'wrong-internal-key-value!' });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Unauthorized/);
  });

  it('5. Rejects HMAC request with expired timestamp (> 300s drift)', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const expiredTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const sig = computeSignature(TEST_SECRET, expiredTimestamp, 'POST', '/api/v1/internal/test-endpoint', {});
    const res = await makePost({
      'x-ceova-internal-signature': sig,
      'x-ceova-timestamp': String(expiredTimestamp)
    });
    assert.equal(res.status, 401);
    assert.match(res.json.message, /timestamp expired/);
  });

  it('6. Rejects HMAC request with tampered body or forged signature', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const res = await makePost({
      'x-ceova-internal-signature': '0'.repeat(64),
      'x-ceova-timestamp': String(now)
    }, { action: 'malicious' });
    assert.equal(res.status, 401);
  });

  it('7. Accepts valid direct secret in x-ceova-internal-key header', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const res = await makePost({ 'x-ceova-internal-key': TEST_SECRET });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.caller, 'CEOVA_MAIN');
  });

  it('8. Accepts valid HMAC-SHA256 signature and fresh timestamp', async () => {
    process.env.CEOVA_INTERNAL_SECRET = TEST_SECRET;
    const now = Math.floor(Date.now() / 1000);
    const body = { test: 'payload-data' };
    const sig = computeSignature(TEST_SECRET, now, 'POST', '/api/v1/internal/test-endpoint', body);
    const res = await makePost({
      'x-ceova-internal-signature': sig,
      'x-ceova-timestamp': String(now)
    }, body);
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.equal(res.json.caller, 'CEOVA_MAIN');
  });
});
