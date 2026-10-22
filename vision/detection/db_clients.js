const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

function initClient(url, key, fallbackUrl) {
  const targetUrl = (url || '').trim() || fallbackUrl;
  const targetKey = (key || '').trim() || 'mock-anon-key';
  try {
    return createClient(targetUrl, targetKey);
  } catch (_e) {
    return {
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
}

const cctvDb = initClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, 'https://cctv.supabase.co');
const coreDb = initClient(process.env.CEOVA_CORE_URL, process.env.CEOVA_CORE_ANON_KEY, 'https://core.supabase.co');

module.exports = { cctvDb, coreDb };
