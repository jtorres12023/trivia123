"use server";

import { logGameEvent } from "@/app/actions/events";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export type GameState = {
  id: string;
  code: string;
  status: string;
  phase: string;
  quarter: number;
  clock_seconds: number;
  play_clock_seconds: number;
  possession_side: "home" | "away" | null;
  down: number;
  distance: number;
  yard_line: number;
  score_home: number;
  score_away: number;
  home_team_name: string;
  away_team_name: string;
  lobby_locked: boolean | null;
  host_player_id: string | null;
  toss_result: string | null;
  toss_winner_side: "home" | "away" | null;
  toss_choice: "receive" | "kick" | "defer" | null;
  play_subphase: string | null;
  offense_side: "home" | "away" | null;
  defense_side: "home" | "away" | null;
  second_half_kickoff_side: "home" | "away" | null;
  current_play_seq?: number | null;
};

export async function getGameByCode(code: string): Promise<GameState | null> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("games")
    .select(
      "id, code, status, phase, play_subphase, quarter, clock_seconds, play_clock_seconds, possession_side, offense_side, defense_side, down, distance, yard_line, score_home, score_away, home_team_name, away_team_name, lobby_locked, host_player_id, toss_result, toss_winner_side, toss_choice, second_half_kickoff_side, current_play_seq",
    )
    .eq("code", code.toUpperCase())
    .single();

  if (error) {
    console.error("getGameByCode error", error.message);
    return null;
  }

  return data as GameState;
}

export async function startCoinToss(gameId: string): Promise<boolean> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from("games")
    .update({
      phase: "coin_toss",
      clock_seconds: 900,
      play_clock_seconds: 40,
      down: 1,
      distance: 10,
      yard_line: 25,
      possession_side: null,
      offense_side: null,
      defense_side: null,
      play_subphase: null,
      toss_result: null,
      toss_winner_side: null,
      toss_choice: null,
    })
    .eq("id", gameId);

  if (error) {
    console.error("startCoinToss error", error.message);
    return false;
  }
  await logGameEvent(gameId, "coin_toss_started", {});
  return true;
}

export async function resolveCoinTossAction(
  gameId: string,
  awayCall: "heads" | "tails",
  winnerChoice: "receive" | "kick" | "defer",
): Promise<{ success: boolean; error?: string; result?: { coin: string; winner: "home" | "away"; choice: string } }> {
  const supabase = createSupabaseServerClient();
  const coin = Math.random() < 0.5 ? "heads" : "tails";
  const winner = coin === awayCall ? "away" : "home"; // visiting team (away) calls it
  const other = winner === "home" ? "away" : "home";
  const possession =
    winnerChoice === "receive" ? winner : winnerChoice === "kick" ? other : other; // defer -> other side receives
  const offense_side = possession;
  const defense_side = offense_side === "home" ? "away" : "home";
  const second_half_kickoff_side = winnerChoice === "defer" ? winner : other;

  const { error } = await supabase
    .from("games")
    .update({
      toss_result: coin,
      toss_winner_side: winner,
      toss_choice: winnerChoice,
      possession_side: possession,
      offense_side,
      defense_side,
      phase: "kickoff",
      down: 1,
      distance: 10,
      yard_line: 25,
      clock_seconds: 900,
      play_clock_seconds: 40,
      play_subphase: null,
      last_play_id: null,
      second_half_kickoff_side,
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  await logGameEvent(gameId, "coin_toss_result", {
    coin,
    winner,
    choice: winnerChoice,
    possession_side: possession,
  });

  // Auto kickoff touchback event; ball already at 25
  return { success: true, result: { coin, winner, choice: winnerChoice } };
}

export async function flipCoinAction(
  gameId: string,
  requesterId: string,
  awayCall: "heads" | "tails",
): Promise<{ success: boolean; error?: string; coin?: string; winner?: "home" | "away" }> {
  const supabase = createSupabaseServerClient();

  const { data: player } = await supabase
    .from("players")
    .select("id, side, role")
    .eq("id", requesterId)
    .eq("game_id", gameId)
    .maybeSingle();

  if (!player) {
    return { success: false, error: "Player not found." };
  }

  const isAllowed = player.side === "away" || player.role === "ref";
  if (!isAllowed) {
    return { success: false, error: "Only away side (or ref) can call the toss." };
  }

  const coin = Math.random() < 0.5 ? "heads" : "tails";
  const winner = coin === awayCall ? "away" : "home";

  const { error } = await supabase
    .from("games")
    .update({
      toss_result: coin,
      toss_winner_side: winner,
      toss_choice: null,
      phase: "coin_toss_choice",
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  await logGameEvent(gameId, "coin_toss_flipped", {
    coin,
    winner,
    call: awayCall,
  });

  return { success: true, coin, winner };
}

export async function chooseTossOptionAction(
  gameId: string,
  requesterId: string,
  choice: "receive" | "kick" | "defer",
): Promise<{ success: boolean; error?: string }> {
  const supabase = createSupabaseServerClient();

  const { data: game } = await supabase
    .from("games")
    .select("toss_winner_side, toss_result")
    .eq("id", gameId)
    .single();

  if (!game?.toss_winner_side) {
    return { success: false, error: "Toss not resolved yet." };
  }

  const { data: player } = await supabase
    .from("players")
    .select("id, side, role")
    .eq("id", requesterId)
    .eq("game_id", gameId)
    .maybeSingle();

  if (!player) {
    return { success: false, error: "Player not found." };
  }

  const isAllowed = player.role === "ref" || player.side === game.toss_winner_side;
  if (!isAllowed) {
    return { success: false, error: "Only the toss winner (or ref) can choose." };
  }

  const winner = game.toss_winner_side as "home" | "away";
  const other = winner === "home" ? "away" : "home";
  const possession = choice === "receive" ? winner : choice === "kick" ? other : other; // defer -> other receives
  const offense_side = possession;
  const defense_side = offense_side === "home" ? "away" : "home";
  const second_half_kickoff_side = choice === "defer" ? winner : other;

  const { error } = await supabase
    .from("games")
    .update({
      toss_choice: choice,
      possession_side: possession,
      offense_side,
      defense_side,
      second_half_kickoff_side,
      phase: "kickoff",
      down: 1,
      distance: 10,
      yard_line: 25,
      clock_seconds: 900,
      play_clock_seconds: 40,
      play_subphase: null,
      last_play_id: null,
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  await logGameEvent(gameId, "coin_toss_choice", {
    choice,
    possession_side: possession,
    offense_side,
    defense_side,
    second_half_kickoff_side,
  });

  return { success: true };
}

export async function resolveKickoffTouchbackAction(gameId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createSupabaseServerClient();

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id, phase, possession_side")
    .eq("id", gameId)
    .single();

  if (gameError || !game) {
    return { success: false, error: gameError?.message || "Game not found." };
  }

  if (game.phase !== "kickoff") {
    return { success: false, error: "Not in kickoff phase." };
  }

  const possession = game.possession_side ?? "home";
  const offense_side = possession;
  const defense_side = offense_side === "home" ? "away" : "home";

  const { error } = await supabase
    .from("games")
    .update({
      phase: "drive",
      offense_side,
      defense_side,
      down: 1,
      distance: 10,
      yard_line: 25,
      play_subphase: "play_call",
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  await logGameEvent(gameId, "kickoff_touchback", { possession_side: possession, yard_line: 25 });

  return { success: true };
}

export async function resetDriveAction(
  gameId: string,
  requesterId: string,
  opts?: { possession?: "home" | "away"; yardLine?: number },
): Promise<{ success: boolean; error?: string; game?: GameState }> {
  const supabase = createSupabaseServerClient();

  const { data: requester } = await supabase
    .from("players")
    .select("id, role")
    .eq("id", requesterId)
    .eq("game_id", gameId)
    .maybeSingle();

  if (!requester || requester.role !== "ref") {
    return { success: false, error: "Only the ref can reset the drive." };
  }

  const { data: game } = await supabase
    .from("games")
    .select("offense_side, defense_side, possession_side")
    .eq("id", gameId)
    .maybeSingle();

  const possession = opts?.possession ?? game?.possession_side ?? "home";
  const offense_side = possession;
  const defense_side = offense_side === "home" ? "away" : "home";
  const yard_line = opts?.yardLine ?? 25;

  const { error } = await supabase
    .from("games")
    .update({
      phase: "drive",
      play_subphase: "play_call",
      down: 1,
      distance: 10,
      yard_line,
      possession_side: possession,
      offense_side,
      defense_side,
      current_play_seq: 1,
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  // Clear any existing play calls for a clean drive start
  await supabase.from("play_calls").delete().eq("game_id", gameId);

  await logGameEvent(gameId, "drive_reset", {
    possession_side: possession,
    yard_line,
  });

  const { data: updatedGame } = await supabase
    .from("games")
    .select(
      "id, code, status, phase, play_subphase, quarter, clock_seconds, play_clock_seconds, possession_side, offense_side, defense_side, down, distance, yard_line, score_home, score_away, home_team_name, away_team_name, lobby_locked, host_player_id, toss_result, toss_winner_side, toss_choice, second_half_kickoff_side, current_play_seq",
    )
    .eq("id", gameId)
    .single();

  return { success: true, game: updatedGame as GameState };
}
