// Shared Supabase client + auth helpers, used by index.html, accedi.html,
// registrati.html, and assistente-frigo.html. SUPABASE_URL and
// SUPABASE_ANON_KEY are public by design (access is enforced server-side by
// Row Level Security), so it's fine for them to live in shipped client JS.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://vkcsaqxcbfxccdrhnakv.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_voZR4kUr0R5cTcA6EBmWbg_ekMcyK1r";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function getTier(userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("tier")
    .eq("id", userId)
    .single();
  if (error || !data) return "pilot";
  return data.tier;
}

export async function signOut() {
  await supabase.auth.signOut();
}
