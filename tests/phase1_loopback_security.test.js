import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { LoopbackAgent } from '/Users/chintukumar/cctv-ceova/services/loopback_agent.js';

describe('PHASE 1: Secure Loopback Agent & Control Endpoint Protection', () => {
  const TEST_PORT = 8092;
  const agent = new LoopbackAgent({ port: TEST_PORT });
  let validToken;

  before(async () => {
    await agent.start();
    validToken = agent.token;
    assert.ok(validToken, 'Agent must generate a valid token');
    assert.ok(validToken.length >= 32, 'Token must be at least 32 characters (high entropy)');
  });

  after(() => {
    agent.stop();
  });

  function makeRequest(options) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: TEST_PORT,
        ...options
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      });
      req.on('error', reject);
      if (options.data) {
        req.write(typeof options.data === 'string' ? options.data : JSON.stringify(options.data));
      }
      req.end();
    });
  }

  it('1. Rejects request without Authorization header with HTTP 401', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: { 'Host': `127.0.0.1:${TEST_PORT}` }
    });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Unauthorized/i);
  });

  it('2. Rejects request with invalid Bearer token with HTTP 401', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `127.0.0.1:${TEST_PORT}`,
        'Authorization': 'Bearer bad_invalid_token_1234567890123456'
      }
    });
    assert.equal(res.status, 401);
    assert.match(res.json.error, /Unauthorized/i);
  });

  it('3. Rejects sensitive control endpoint POST /api/service/stop without auth with HTTP 401', async () => {
    const res = await makeRequest({
      path: '/api/service/stop',
      method: 'POST',
      headers: { 'Host': `127.0.0.1:${TEST_PORT}` }
    });
    assert.equal(res.status, 401);
  });

  it('4. Rejects sensitive control endpoint POST /api/monitoring/pause without auth with HTTP 401', async () => {
    const res = await makeRequest({
      path: '/api/monitoring/pause',
      method: 'POST',
      headers: { 'Host': `127.0.0.1:${TEST_PORT}` }
    });
    assert.equal(res.status, 401);
  });

  it('5. Rejects untrusted browser Origin header with HTTP 403', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `127.0.0.1:${TEST_PORT}`,
        'Origin': 'https://evil-attacker.com',
        'Authorization': `Bearer ${validToken}`
      }
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /Untrusted Origin/i);
  });

  it('6. Rejects unexpected Host header (DNS rebinding) with HTTP 403', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `attacker-rebinding-host.com:${TEST_PORT}`,
        'Authorization': `Bearer ${validToken}`
      }
    });
    assert.equal(res.status, 403);
    assert.match(res.json.error, /Invalid Host header/i);
  });

  it('7. Accepts legitimate request with valid Bearer token and valid Host with HTTP 200', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `127.0.0.1:${TEST_PORT}`,
        'Authorization': `Bearer ${validToken}`,
        'X-Ceova-Client': 'ceova-main-app'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.running, true);
    assert.equal(res.json.service, 'ceova-cctv-agent');
    // Ensure CORS is not wild-carded
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });

  it('8. Accepts legitimate request with allowed Origin (tauri://localhost)', async () => {
    const res = await makeRequest({
      path: '/api/status',
      method: 'GET',
      headers: {
        'Host': `127.0.0.1:${TEST_PORT}`,
        'Origin': 'tauri://localhost',
        'Authorization': `Bearer ${validToken}`,
        'X-Ceova-Client': 'ceova-main-app'
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], 'tauri://localhost');
  });
});
