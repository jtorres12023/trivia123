"use server";

import { randomBytes } from "crypto";

import { createSupabaseServerClient } from "@/lib/supabaseServer";

type ActionResult =
  | { success: true; gameId: string; code: string; playerId: string }
  | { success: false; error: string };

const GAME_CODE_LENGTH = 6;

const generateCode = () =>
  randomBytes(GAME_CODE_LENGTH)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, GAME_CODE_LENGTH);

export async function createLobbyAction(displayName: string): Promise<ActionResult> {
  if (!displayName?.trim()) {
    return { success: false, error: "Display name is required." };
  }

  const supabase = createSupabaseServerClient();

  let code = generateCode();
  // Best-effort collision avoidance: try a few times if the code already exists.
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const { error: codeCheckError } = await supabase
      .from("games")
      .select("id")
      .eq("code", code)
      .eq("status", "lobby_open")
      .maybeSingle();

    if (!codeCheckError) break;
    code = generateCode();
  }

  const { data: game, error: gameError } = await supabase
    .from("games")
    .insert({
      code,
      status: "lobby_open",
      mode: "trivia",
    })
    .select("id, code")
    .single();

  if (gameError || !game) {
    return {
      success: false,
      error: gameError?.message || "Could not create lobby.",
    };
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({
      game_id: game.id,
      display_name: displayName.trim(),
      role: "ref",
      side: null,
      ready: true,
    })
    .select("id")
    .single();

  if (playerError || !player) {
    const isDuplicateName = (playerError?.message || "").includes("unique_game_display_name");
    return {
      success: false,
      error: isDuplicateName ? "Name already taken in this lobby." : playerError?.message || "Could not create host player.",
    };
  }

  // Set host id on the game
  await supabase.from("games").update({ host_player_id: player.id }).eq("id", game.id);

  return { success: true, gameId: game.id, code: game.code, playerId: player.id };
}

export async function joinLobbyAction(
  displayName: string,
  code: string,
): Promise<ActionResult> {
  if (!displayName?.trim()) {
    return { success: false, error: "Display name is required." };
  }
  if (!code?.trim()) {
    return { success: false, error: "Game code is required." };
  }

  const supabase = createSupabaseServerClient();
  const normalizedCode = code.trim().toUpperCase();

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("id, code, status, lobby_locked")
    .eq("code", normalizedCode)
    .eq("status", "lobby_open")
    .single();

  if (gameError || !game) {
    return { success: false, error: gameError?.message || "Lobby not found." };
  }

  if (game.lobby_locked) {
    return { success: false, error: "Lobby is locked." };
  }

  const { data: player, error: playerError } = await supabase
    .from("players")
    .insert({
      game_id: game.id,
      display_name: displayName.trim(),
      role: "player",
      ready: false,
    })
    .select("id")
    .single();

  if (playerError || !player) {
    const isDuplicateName = (playerError?.message || "").includes("unique_game_display_name");
    return {
      success: false,
      error: isDuplicateName ? "Name already taken in this lobby." : playerError?.message || "Could not join lobby.",
    };
  }

  return { success: true, gameId: game.id, code: game.code, playerId: player.id };
}

export async function updatePlayerSideAction(
  playerId: string,
  gameId: string,
  requesterId: string,
  side: "home" | "away" | null,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: host } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .eq("role", "ref")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!host || host.id !== requesterId) {
    return { success: false, error: "Host not found for this lobby." };
  }

  const { error } = await supabase
    .from("players")
    .update({ side })
    .eq("id", playerId)
    .eq("game_id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, gameId, code: "", playerId };
}

export async function updateTeamNamesAction(
  gameId: string,
  requesterId: string,
  homeName: string,
  awayName: string,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: host } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .eq("role", "ref")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!host || host.id !== requesterId) {
    return { success: false, error: "Only the host can rename teams." };
  }

  const { error } = await supabase
    .from("games")
    .update({
      home_team_name: homeName || "Home",
      away_team_name: awayName || "Away",
    })
    .eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, gameId, code: "", playerId: "" };
}

export async function startGameAction(gameId: string, requesterId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: gameRow } = await supabase
    .from("games")
    .select("id, mode")
    .eq("id", gameId)
    .single();

  const { data: host } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .eq("role", "ref")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!host || host.id !== requesterId) {
    return { success: false, error: "Only the ref can start the game." };
  }

  // Gate start: ensure ready players based on mode
  const { data: players, error: playersError } = await supabase
    .from("players")
    .select("id, side, ready, role")
    .eq("game_id", gameId);

  if (playersError) {
    return { success: false, error: playersError.message };
  }

  if (gameRow?.mode === "trivia") {
    const participants = (players ?? []).filter((p) => p.role !== "ref");
    const allReady = participants.length > 0 && participants.every((p) => p.ready);
    if (participants.length === 0) {
      return { success: false, error: "Need at least one player to start." };
    }
    if (!allReady) {
      return { success: false, error: "All players must be ready to start." };
    }
  } else {
    const participants = (players ?? []).filter((p) => p.side === "home" || p.side === "away");
    const homeCount = participants.filter((p) => p.side === "home").length;
    const awayCount = participants.filter((p) => p.side === "away").length;
    const allReady = participants.every((p) => p.ready);

    if (homeCount === 0 || awayCount === 0) {
      return { success: false, error: "Both teams need at least one player before starting." };
    }

    if (!allReady) {
      return { success: false, error: "All players must be ready to start." };
    }
  }

  const { error } = await supabase
    .from("games")
    .update({ status: "in_progress" })
    .eq("id", gameId)
    .eq("status", "lobby_open");

  if (error) {
    return { success: false, error: error.message };
  }

  // Clear ready flags for next phase
  await supabase.from("players").update({ ready: false }).eq("game_id", gameId);

  return { success: true, gameId, code: "", playerId: "" };
}

export async function leaveLobbyAction(playerId: string, gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: player } = await supabase.from("players").select("role").eq("id", playerId).eq("game_id", gameId).single();

  const { error } = await supabase.from("players").delete().eq("id", playerId).eq("game_id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  // If host left, assign next earliest player as host.
  if (player?.role === "ref") {
    const { data: nextHost } = await supabase
      .from("players")
      .select("id")
      .eq("game_id", gameId)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (nextHost?.id) {
      await supabase.from("players").update({ role: "ref" }).eq("id", nextHost.id);
      await supabase.from("games").update({ host_player_id: nextHost.id }).eq("id", gameId);
    }
  }

  return { success: true, gameId, code: "", playerId };
}

export async function setReadyAction(playerId: string, gameId: string, ready: boolean): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { error } = await supabase.from("players").update({ ready }).eq("id", playerId).eq("game_id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, gameId, code: "", playerId };
}

export async function kickPlayerAction(
  requesterId: string,
  playerId: string,
  gameId: string,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: host } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .eq("role", "ref")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!host || host.id !== requesterId) {
    return { success: false, error: "Only the ref can kick players." };
  }

  const { error } = await supabase.from("players").delete().eq("id", playerId).eq("game_id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, gameId, code: "", playerId };
}

export async function setLobbyLockedAction(
  requesterId: string,
  gameId: string,
  locked: boolean,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: host } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .eq("role", "ref")
    .order("created_at", { ascending: true })
    .limit(1)
    .single();

  if (!host || host.id !== requesterId) {
    return { success: false, error: "Only the ref can lock or unlock the lobby." };
  }

  const { error } = await supabase.from("games").update({ lobby_locked: locked }).eq("id", gameId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, gameId, code: "", playerId: "" };
}
