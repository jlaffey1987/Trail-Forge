import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("Supabase environment variables not set — running in offline mode");
}

export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder"
);

export interface Trail {
  id: string;
  user_id: string | null;
  name: string;
  type: string | null;
  difficulty: number | null;
  distance_km: number | null;
  terrain: string | null;
  legal_status: string | null;
  gpx_data: unknown | null;
  is_public: boolean;
  created_at: string;
}

export async function fetchCommunityTrails(): Promise<Trail[]> {
  const { data, error } = await supabase
    .from("trails")
    .select("*")
    .eq("is_public", true)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch trails:", error.message);
    return [];
  }
  return data || [];
}

export async function searchTrails(opts: {
  difficulties?: number[];
  trailTypes?: string[];
  minDistance?: number;
  maxDistance?: number;
}): Promise<Trail[]> {
  let query = supabase.from("trails").select("*").eq("is_public", true);

  if (opts.difficulties && opts.difficulties.length > 0) {
    query = query.in("difficulty", opts.difficulties);
  }

  if (opts.trailTypes && opts.trailTypes.length > 0) {
    query = query.in("legal_status", opts.trailTypes);
  }

  const { data, error } = await query.order("difficulty", { ascending: true }).limit(20);
  if (error) {
    console.error("Search error:", error.message);
    return [];
  }
  return data || [];
}

export async function saveTrail(trailId: string, sessionId: string): Promise<boolean> {
  const { error } = await supabase.from("saved_trails").upsert({
    trail_id: trailId,
    session_id: sessionId,
    status: "planned",
  });
  if (error) {
    console.error("Save trail error:", error.message);
    return false;
  }
  return true;
}

export async function fetchSavedTrails(sessionId: string): Promise<Trail[]> {
  const { data, error } = await supabase
    .from("saved_trails")
    .select("trail_id, status, saved_at, trails(*)")
    .eq("session_id", sessionId)
    .order("saved_at", { ascending: false });

  if (error) {
    console.error("Fetch saved trails error:", error.message);
    return [];
  }
  return (data || []).map((row: { trails: Trail }) => row.trails).filter(Boolean);
}

export async function addTrail(trail: Omit<Trail, "id" | "created_at">): Promise<Trail | null> {
  const { data, error } = await supabase.from("trails").insert(trail).select().single();
  if (error) {
    console.error("Add trail error:", error.message);
    return null;
  }
  return data;
}

export async function likeTrail(trailId: string): Promise<void> {
  await supabase.rpc("increment_likes", { trail_id: trailId });
}

const SESSION_KEY = "trailforge_session_id";
export function getSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}
