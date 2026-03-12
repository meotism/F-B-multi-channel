// Supabase Client - Supabase client singleton
// Uses browser-native ES module import from CDN (no build step required)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export { supabase };
