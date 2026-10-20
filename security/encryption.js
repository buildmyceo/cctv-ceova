/**
 * CEOVA CCTV // Security & Privacy Engine
 * security/encryption.js
 * 
 * AES-256-GCM Encryption for biometric reference data and sensitive feature vectors.
 * Complies with enterprise privacy standards: embeddings are never stored in plaintext.
 */

const crypto = require('crypto');

// Master encryption key (in production, sourced from secure HSM/vault or env)
const MASTER_KEY_HEX = process.env.CEOVA_MASTER_KEY || crypto.createHash('sha256').update('CEOVA_CCTV_MASTER_ENCRYPTION_KEY_2026').digest('hex');
const KEY = Buffer.from(MASTER_KEY_HEX, 'hex');

/**
 * Encrypt a numeric embedding vector or JSON object
 * @param {Float32Array|Array<number>|Object} data 
 * @returns {string} Encrypted payload format: "ivHex:authTagHex:encryptedHex"
 */
function encryptEmbedding(data) {
  const plaintext = (data instanceof Float32Array || Array.isArray(data))
    ? Buffer.from(new Float32Array(data).buffer).toString('base64')
    : JSON.stringify(data);

  const iv = crypto.randomBytes(12); // Standard 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted embedding payload
 * @param {string} encryptedPayload 
 * @returns {Float32Array|Object}
 */
function decryptEmbedding(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('Invalid encrypted payload');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload format');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  // If base64 binary buffer (Float32Array)
  try {
    const buf = Buffer.from(decrypted, 'base64');
    if (buf.length % 4 === 0) {
      return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    }
  } catch (e) {}

  // Fallback to JSON parse
  try {
    return JSON.parse(decrypted);
  } catch (e) {
    return decrypted;
  }
}

module.exports = {
  encryptEmbedding,
  decryptEmbedding
};
