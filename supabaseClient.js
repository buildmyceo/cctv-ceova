/**
 * CEOVA CCTV // Supabase Client Integration
 * supabaseClient.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = (process.env.SUPABASE_URL || 'https://cctv.supabase.co').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || 'mock-anon-key').trim();

let supabase;
try {
  supabase = createClient(supabaseUrl, supabaseKey);
} catch (_e) {
  supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        or: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
        maybeSingle: async () => ({ data: null, error: null })
      }),
      insert: () => ({ select: async () => ({ data: [], error: null }) }),
      upsert: () => ({ select: async () => ({ data: [], error: null }) })
    })
  };
}

module.exports = supabase;
module.exports.supabase = supabase;
module.exports.supabaseClient = supabase;
module.exports.createClient = createClient;
