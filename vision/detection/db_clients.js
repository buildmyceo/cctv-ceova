const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

const cctvDb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const coreDb = createClient(
  process.env.CEOVA_CORE_URL,
  process.env.CEOVA_CORE_ANON_KEY
);

module.exports = { cctvDb, coreDb };
