/**
 * CEOVA CCTV // Supabase Client Integration
 * supabaseClient.js
 * 
 * Initializes and exports the Supabase client using @supabase/supabase-js and dotenv.
 */

const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env in project root
dotenv.config({ path: path.resolve(__dirname, '.env') });

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://duxrreqtrnwfflmbnxuj.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

if (!supabaseAnonKey || supabaseAnonKey.includes('placeholder') || supabaseAnonKey.includes('your-supabase-anon-key')) {
  console.warn('[SUPABASE] Notice: SUPABASE_ANON_KEY is not configured or using placeholder in .env');
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

module.exports = supabase;
module.exports.supabase = supabase;
