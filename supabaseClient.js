/**
 * CEOVA CCTV // Supabase Client Integration
 * supabaseClient.js
 * 
 * Initializes and exports the Supabase client using @supabase/supabase-js and dotenv.
 * Supports both legacy anon JWT keys and new Supabase publishable keys (sb_publishable_...).
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();

if (!supabaseUrl || !supabaseKey) {
  console.warn('[SUPABASE] Warning: SUPABASE_URL or SUPABASE_ANON_KEY is missing in environment variables.');
}

// Initialize Supabase client directly with URL and key without extra wrappers or parsing
const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
module.exports.supabase = supabase;
module.exports.supabaseClient = supabase;
module.exports.createClient = createClient;
