/**
 * CEOVA CCTV // Supabase Integration Verification
 * test_db.js
 * 
 * Verifies Supabase connection and tests inserting a detection record
 * into the 'cctv_detections' table.
 */

const supabase = require('./supabaseClient');

async function testSupabaseConnection() {
  console.log('\n======================================================');
  console.log('  🔍 Testing Supabase Connection & Insertion...');
  console.log('======================================================');

  const testRecord = {
    camera_id: 'cam_test_01',
    detected_object: 'person',
    confidence: 0.95
  };

  console.log('Target Table: cctv_detections');
  console.log('Payload:', JSON.stringify(testRecord, null, 2));

  try {
    const { data, error } = await supabase
      .from('cctv_detections')
      .insert([testRecord])
      .select();

    if (error) {
      console.error('\n❌ Supabase Insert Failed!');
      console.error(`Error Code:    ${error.code || 'N/A'}`);
      console.error(`Error Message: ${error.message}`);
      if (error.details) console.error(`Details:       ${error.details}`);
      if (error.hint) console.error(`Hint:          ${error.hint}`);
      return false;
    }

    console.log('\n✅ Supabase Insert Succeeded!');
    console.log('Inserted Record:', JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('\n❌ Unexpected error during Supabase operation:');
    console.error(err.message || err);
    return false;
  }
}

// Execute the test function
testSupabaseConnection().then(success => {
  if (!success) {
    console.log('\n💡 Tip: Verify your SUPABASE_ANON_KEY in .env and ensure the "cctv_detections" table exists in your Supabase project.');
  }
});
