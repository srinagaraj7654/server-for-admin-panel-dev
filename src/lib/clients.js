import { createClient } from '@supabase/supabase-js'
import axios from 'axios'

/** Supabase client with the SERVICE ROLE key (bypasses RLS). Server-side only. */
export function createSupabase(config) {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return null
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** Client for the existing MockTest API — the admin key stays on this server. */
export function createMainApi(config) {
  if (!config.mainApiUrl) return null
  return axios.create({
    baseURL: config.mainApiUrl,
    timeout: 120_000,
    headers: { 'x-admin-key': config.mainApiAdminKey },
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 50 * 1024 * 1024,
  })
}
