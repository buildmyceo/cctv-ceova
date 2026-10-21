/**
 * CEOVA CCTV // Database Verification Script
 * test_db.js
 * 
 * Verifies Supabase connection and tests inserting a detection record
 * with camera_id, detected_object, confidence, and uid.
 */

const supabase = require('./supabaseClient');

async function testSupabaseConnection(mockUid = 'CEOVA-MOCK-UID-TEST-001') {
  const url = process.env.SUPABASE_URL || 'Not specified';
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
  const maskedKey = key.length > 10 ? `${key.substring(0, 15)}...${key.substring(key.length - 4)}` : '(none)';

  console.log('[TEST_DB] ---------------------------------------------');
  console.log('[TEST_DB] Supabase URL:', url);
  console.log('[TEST_DB] Key in use:   ', maskedKey);
  console.log('[TEST_DB] Target Table:  cctv_detections');
  console.log('[TEST_DB] Testing UID:  ', mockUid);
  console.log('[TEST_DB] ---------------------------------------------');

  const testPayload = {
    camera_id: 'cam_test_01',
    detected_object: 'person',
    confidence: 0.95,
    uid: mockUid
  };

  try {
    let { data, error } = await supabase
      .from('cctv_detections')
      .insert([testPayload]);

    if (error && error.code === 'PGRST204' && String(error.message).includes("'uid'")) {
      console.warn('[TEST_DB] ⚠️ Supabase schema notice: "uid" column is not yet present on "cctv_detections".');
      console.warn('[TEST_DB] To persist UIDs in PostgreSQL, run:');
      console.warn('[TEST_DB]   ALTER TABLE cctv_detections ADD COLUMN IF NOT EXISTS uid TEXT;');
      console.warn('[TEST_DB] Retrying insert with standard CCTV edge fields...');
      
      const legacyPayload = { ...testPayload };
      delete legacyPayload.uid;
      const res = await supabase.from('cctv_detections').insert([legacyPayload]);
      if (!res.error) {
        console.log('[TEST_DB] ✅ Test detection record inserted successfully (edge fallback)!');
        console.log('[TEST_DB] Payload:', legacyPayload);
        return { success: true, data: res.data, fallback: true };
      }
      error = res.error;
    }

    if (error) {
      console.error('[TEST_DB] ❌ Supabase insert failed:');
      console.error('Error Message:', error.message);
      if (error.code) console.error('Error Code:   ', error.code);
      if (error.hint) console.error('Hint:         ', error.hint);
      if (error.details) console.error('Details:      ', error.details);
      return { success: false, error };
    }

    console.log('[TEST_DB] ✅ Test detection record with UID inserted successfully!');
    console.log('[TEST_DB] Payload:', testPayload);
    return { success: true, data };
  } catch (err) {
    console.error('[TEST_DB] ❌ Unexpected error communicating with Supabase:', err.message);
    return { success: false, error: err };
  }
}

// Invoke the verification test
testSupabaseConnection();

module.exports = { testSupabaseConnection };
