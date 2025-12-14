"use server";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

export type GameEvent = {
  id: string;
  game_id: string;
  type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export async function logGameEvent(gameId: string, type: string, payload?: Record<string, unknown>) {
  const supabase = createSupabaseServerClient();
  await supabase.from("game_events").insert({
    game_id: gameId,
    type,
    payload: payload ?? null,
  });
}

export async function getRecentEvents(gameId: string, limit = 50): Promise<GameEvent[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("game_events")
    .select("*")
    .eq("game_id", gameId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data.reverse(); // oldest first
}
