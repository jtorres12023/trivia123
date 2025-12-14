"use server";

import { logGameEvent } from "@/app/actions/events";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

type ActionResult =
  | { success: true; message?: string; game?: Record<string, unknown> | null; play?: Record<string, unknown> | null }
  | { success: false; error: string };

const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const rollByDifficulty = (difficulty: string) => {
  switch (difficulty) {
    case "easy":
      return randomInt(1, 4);
    case "medium":
      return randomInt(1, 4) + randomInt(1, 4);
    case "hard":
      return randomInt(1, 10);
    case "hail_mary":
      return randomInt(1, 20);
    default:
      return randomInt(1, 4);
  }
};

const matchupMod = (offense: string, defense: string, offenseCorrect: boolean) => {
  const o = offense.toLowerCase();
  const d = defense.toLowerCase();
  let mod = 0;
  let turnoverChance = false;

  if (o.includes("run")) {
    if (d.includes("run stop")) mod = randomInt(-3, -1);
    else if (d.includes("pass")) mod = randomInt(2, 4);
    else if (d.includes("blitz")) mod = offenseCorrect ? randomInt(3, 5) : randomInt(-3, -1);
  } else if (o.includes("screen")) {
    if (d.includes("blitz")) mod = offenseCorrect ? randomInt(4, 6) : randomInt(-2, 0);
    else mod = randomInt(0, 2);
  } else if (o.includes("deep") || o.includes("hail")) {
    if (d.includes("pass")) mod = randomInt(-5, -2);
    else if (d.includes("blitz")) mod = offenseCorrect ? randomInt(4, 7) : randomInt(-6, -3);
    turnoverChance = true;
  } else if (o.includes("pass")) {
    if (d.includes("pass")) mod = randomInt(-3, -1);
    else if (d.includes("run")) mod = randomInt(2, 4);
    else if (d.includes("blitz")) mod = offenseCorrect ? randomInt(3, 5) : randomInt(-4, -2);
  } else if (o.includes("trick")) {
    mod = randomInt(-2, 6);
  }

  return { mod, turnoverChance };
};

export async function submitPlayCallAction(
  gameId: string,
  playerId: string,
  role: "offense" | "defense",
  playCall: string,
  difficulty: string,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select("phase, play_subphase, offense_side, defense_side, current_play_seq")
    .eq("id", gameId)
    .single();
  if (gameError || !game) return { success: false, error: "Game not found." };
  // Allow late submissions if we're still in drive and question phase but this side hasn't submitted yet.
  if (game.phase !== "drive" || !["play_call", "question", null].includes(game.play_subphase ?? "")) {
    return { success: false, error: "Not accepting play calls right now." };
  }

  const { data: player } = await supabase
    .from("players")
    .select("id, side")
    .eq("id", playerId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!player) return { success: false, error: "Player not found." };

  const expectedSide = role === "offense" ? game.offense_side : game.defense_side;
  if (player.side !== expectedSide) {
    return { success: false, error: "You are not on this side for the current play." };
  }

  const currentSeq = game.current_play_seq ?? 1;

  const { error: upsertError } = await supabase.from("play_calls").upsert(
    {
      game_id: gameId,
      player_id: playerId,
      side: player.side,
      role,
      play_call: playCall,
      difficulty,
      seq: currentSeq,
    },
    { onConflict: "game_id,player_id,seq" },
  );

  if (upsertError) {
    return { success: false, error: upsertError.message };
  }

  // Check if both sides submitted
  const { data: calls } = await supabase
    .from("play_calls")
    .select("role")
    .eq("game_id", gameId)
    .eq("seq", currentSeq);

  const offenseDone = calls?.some((c) => c.role === "offense");
  const defenseDone = calls?.some((c) => c.role === "defense");

  // Move to question once both are in
  let updatedGame: Record<string, unknown> | null = null;

  if (offenseDone && defenseDone) {
    const { data: gameRow } = await supabase
      .from("games")
      .update({ play_subphase: "question" })
      .eq("id", gameId)
      .select()
      .single();
    updatedGame = gameRow;
    await logGameEvent(gameId, "play_calls_locked", {
      seq: currentSeq,
      offense_ready: offenseDone,
      defense_ready: defenseDone,
    });
  } else {
    await logGameEvent(gameId, "play_call_submitted", {
      seq: currentSeq,
      offense_ready: offenseDone,
      defense_ready: defenseDone,
    });
    const { data: gameRow } = await supabase
      .from("games")
      .update({ play_subphase: "play_call" })
      .eq("id", gameId)
      .select()
      .single();
    updatedGame = gameRow;
  }

  return { success: true, game: updatedGame };
}

export async function submitQuestionAnswerAction(
  gameId: string,
  playerId: string,
  isCorrect: boolean,
  forSide?: "offense" | "defense", // allow ref to answer on behalf
  manualRoll?: number,
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: game, error: gameError } = await supabase
    .from("games")
    .select(
      "phase, play_subphase, offense_side, defense_side, down, distance, yard_line, score_home, score_away, current_play_seq",
    )
    .eq("id", gameId)
    .single();
  if (gameError || !game) return { success: false, error: "Game not found." };
  if (game.phase !== "drive" || game.play_subphase !== "question") {
    return { success: false, error: "Not accepting answers right now." };
  }

  const { data: player } = await supabase
    .from("players")
    .select("id, side, role")
    .eq("id", playerId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!player) return { success: false, error: "Player not found." };
  const isRef = player.role === "ref";
  if (!isRef && player.side !== game.offense_side && player.side !== game.defense_side) {
    return { success: false, error: "Not part of this play." };
  }

  // Get play calls for current seq
  const seq = game.current_play_seq ?? 1;
  const { data: calls } = await supabase
    .from("play_calls")
    .select("id, role, play_call, difficulty, answer, roll, ready_after_roll")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offenseCall = calls?.find((c) => c.role === "offense");
  const defenseCall = calls?.find((c) => c.role === "defense");
  const offensePlay = offenseCall?.play_call ?? "Run";
  const offenseDiff = offenseCall?.difficulty ?? "easy";
  const defensePlay = defenseCall?.play_call ?? "Pass D";

  // Determine target role (allow ref to answer for either side)
  const targetRole =
    forSide ??
    (player.side === game.offense_side ? "offense" : player.side === game.defense_side ? "defense" : "offense");

  const existing = calls?.find((c) => c.role === targetRole);

  // Upsert the answer (roll handled later during roll phase)
  await supabase.from("play_calls").upsert(
    {
      game_id: gameId,
      player_id: playerId,
      side: player.side,
      role: targetRole,
      play_call: targetRole === "offense" ? offensePlay : defensePlay,
      difficulty: targetRole === "offense" ? offenseDiff : "n/a",
      seq,
      answer: isCorrect,
      roll: existing?.roll ?? null,
      ready_after_roll: existing?.ready_after_roll ?? false,
    },
    { onConflict: "game_id,player_id,seq" },
  );

  const { data: answers } = await supabase
    .from("play_calls")
    .select("role, answer, roll")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offenseAnswer = answers?.find((a) => a.role === "offense");
  const defenseAnswer = answers?.find((a) => a.role === "defense");

  // Only resolve when both answered
  if (
    !offenseAnswer ||
    offenseAnswer.answer === null ||
    offenseAnswer.answer === undefined ||
    !defenseAnswer ||
    defenseAnswer.answer === null ||
    defenseAnswer.answer === undefined
  ) {
    await logGameEvent(gameId, "answer_submitted", {
      seq,
      offense_answered: !!offenseAnswer?.answer,
      defense_answered: !!defenseAnswer?.answer,
    });
    return { success: true, message: "Answer recorded. Waiting for other side." };
  }

  // Move to rolls phase and emit event (rolls happen via separate action)
  await supabase
    .from("games")
    .update({ play_subphase: "rolls" })
    .eq("id", gameId);
  await logGameEvent(gameId, "rolls_started", { seq });

  return { success: true, message: "Answers locked. Proceed to roll." };
}

export async function submitRollAction(
  gameId: string,
  playerId: string,
  manualRoll?: number,
  forSide?: "offense" | "defense",
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: game } = await supabase
    .from("games")
    .select("phase, play_subphase, offense_side, defense_side, current_play_seq")
    .eq("id", gameId)
    .single();
  if (!game) return { success: false, error: "Game not found." };
  if (game.phase !== "drive" || game.play_subphase !== "rolls") {
    return { success: false, error: "Not accepting rolls right now." };
  }

  const { data: player } = await supabase
    .from("players")
    .select("id, side, role")
    .eq("id", playerId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!player) return { success: false, error: "Player not found." };
  const seq = game.current_play_seq ?? 1;

  const { data: calls } = await supabase
    .from("play_calls")
    .select("id, role, play_call, difficulty, answer, roll, ready_after_roll, side, player_id")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offenseCall = calls?.find((c) => c.role === "offense");
  const defenseCall = calls?.find((c) => c.role === "defense");

  const targetRole =
    forSide ??
    (player.side === game.offense_side ? "offense" : player.side === game.defense_side ? "defense" : "offense");
  const existing = calls?.find((c) => c.role === targetRole);

  if (existing?.roll != null) {
    return { success: false, error: "Roll already submitted for this side." };
  }

  const offenseDiff = offenseCall?.difficulty ?? "easy";
  const offensePlay = offenseCall?.play_call ?? "Run";
  const defensePlay = defenseCall?.play_call ?? "Pass D";

  const rollVal =
    manualRoll ??
    (targetRole === "offense" ? rollByDifficulty(offenseDiff) : randomInt(1, 4));

  await supabase.from("play_calls").upsert(
    {
      game_id: gameId,
      player_id: playerId,
      side: player.side,
      role: targetRole,
      play_call: targetRole === "offense" ? offensePlay : defensePlay,
      difficulty: targetRole === "offense" ? offenseDiff : "n/a",
      seq,
      answer: existing?.answer ?? null,
      roll: rollVal,
      ready_after_roll: existing?.ready_after_roll ?? false,
    },
    { onConflict: "game_id,player_id,seq" },
  );

  const { data: updatedCalls } = await supabase
    .from("play_calls")
    .select("role, roll")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offenseRoll = updatedCalls?.find((c) => c.role === "offense")?.roll ?? null;
  const defenseRoll = updatedCalls?.find((c) => c.role === "defense")?.roll ?? null;

  await logGameEvent(gameId, "roll_submitted", {
    seq,
    offense_roll: offenseRoll,
    defense_roll: defenseRoll,
  });

  if (offenseRoll != null && defenseRoll != null) {
    await supabase.from("games").update({ play_subphase: "rolls_done" }).eq("id", gameId);
    await logGameEvent(gameId, "rolls_completed", {
      seq,
      offense_roll: offenseRoll,
      defense_roll: defenseRoll,
    });
  }

  return { success: true, message: "Roll recorded." };
}

async function finalizePlayResolution(gameId: string, seq: number): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: game } = await supabase
    .from("games")
    .select(
      "id, phase, play_subphase, offense_side, defense_side, down, distance, yard_line, score_home, score_away, current_play_seq",
    )
    .eq("id", gameId)
    .single();
  if (!game) return { success: false, error: "Game not found." };

  const { data: calls } = await supabase
    .from("play_calls")
    .select("role, play_call, difficulty, answer, roll")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offense = calls?.find((c) => c.role === "offense");
  const defense = calls?.find((c) => c.role === "defense");
  if (!offense || !defense) return { success: false, error: "Missing play data." };

  const offensePlay = offense.play_call ?? "Run";
  const offenseDiff = offense.difficulty ?? "easy";
  const defensePlay = defense.play_call ?? "Pass D";
  const dieOffense = offense.roll ?? rollByDifficulty(offenseDiff);
  const dieDefense = defense.roll ?? randomInt(1, 4);
  const finalOffenseCorrect = offense.answer ?? false;
  const finalDefenseCorrect = defense.answer ?? false;

  const playLower = offensePlay.toLowerCase();
  const isPassLike = playLower.includes("pass") || playLower.includes("screen") || playLower.includes("hail");
  const isHail = playLower.includes("hail");
  const rollDiff = dieDefense - dieOffense;

  let yards: number;

  if (isHail) {
    // Hail Mary: big upside, modest downside unless defense dominates.
    if (finalOffenseCorrect) {
      yards = dieOffense >= 17 ? randomInt(30, 50) : randomInt(12, 24);
    } else {
      yards = 0; // treat as incomplete unless defense wins big below.
    }
  } else if (isPassLike) {
    if (finalOffenseCorrect) {
      yards = dieOffense + (offenseDiff === "hard" ? 3 : 1);
    } else {
      yards = 0; // incomplete by default
    }
  } else if (playLower.includes("run")) {
    yards = finalOffenseCorrect ? dieOffense + 1 : -randomInt(1, 3);
  } else {
    yards = finalOffenseCorrect ? dieOffense : -randomInt(1, 2);
  }

  const { mod, turnoverChance } = matchupMod(offensePlay, defensePlay, finalOffenseCorrect);

  // Soften negative mods on failed passes unless defense is correct
  let appliedMod = mod;
  if (isPassLike && !finalOffenseCorrect && !finalDefenseCorrect) {
    appliedMod = Math.max(0, mod);
  }
  yards += appliedMod;

  if (finalDefenseCorrect) {
    // Defense halves gains; if offense also wrong, allow small losses
    yards = Math.floor(yards / 2);
    if (!finalOffenseCorrect) {
      yards -= randomInt(1, 3);
      if (isPassLike && rollDiff > 2) {
        yards -= randomInt(0, 2); // sack/tackle for loss only when defense wins big
      }
    }
  } else if (finalOffenseCorrect) {
    yards += 2;
  }

  if (isHail && !finalOffenseCorrect && dieOffense <= 3 && turnoverChance) {
    yards = -randomInt(5, 12);
  }

  yards = Math.max(-20, Math.min(60, yards));

  const newYardLine = Math.min(100, Math.max(0, game.yard_line + (game.offense_side === "home" ? yards : -yards)));
  const gained = game.offense_side === "home" ? newYardLine - game.yard_line : game.yard_line - newYardLine;
  const remaining = game.distance - gained;

  let nextDown = game.down;
  let nextDistance = remaining > 0 ? remaining : 10;
  let nextYardLine = newYardLine;
  let possession = game.offense_side;
  let offenseSide = game.offense_side;
  let defenseSide = game.defense_side;
  let turnover = false;

  if (remaining <= 0) {
    // First down achieved
    nextDown = 1;
    nextDistance = 10;
  } else {
    nextDown = game.down + 1;
  }

  if (nextDown > 4) {
    turnover = true;
    nextDown = 1;
    nextDistance = 10;
    possession = game.defense_side;
    offenseSide = game.defense_side;
    defenseSide = game.offense_side;
    // flip field position: keep same yard line but perspective flips
  }

  // Simple scoring: if offense reaches 100 yard line, touchdown
  let scoreHome = game.score_home;
  let scoreAway = game.score_away;
  let phase = game.phase;
  if (game.offense_side === "home" && newYardLine >= 100) {
    scoreHome += 7;
    phase = "kickoff";
    possession = "away";
    offenseSide = "away";
    defenseSide = "home";
    nextDown = 1;
    nextDistance = 10;
    nextYardLine = 25;
  } else if (game.offense_side === "away" && newYardLine <= 0) {
    scoreAway += 7;
    phase = "kickoff";
    possession = "home";
    offenseSide = "home";
    defenseSide = "away";
    nextDown = 1;
    nextDistance = 10;
    nextYardLine = 25;
  }

  const nextSeq = (game.current_play_seq ?? 1) + 1;
  const { data: updatedGame, error: gameUpdateError } = await supabase
    .from("games")
    .update({
      play_subphase: phase === "kickoff" ? null : "play_call",
      phase,
      down: nextDown,
      distance: nextDistance,
      yard_line: nextYardLine,
      possession_side: possession,
      offense_side: offenseSide,
      defense_side: defenseSide,
      score_home: scoreHome,
      score_away: scoreAway,
      current_play_seq: nextSeq,
    })
    .eq("id", gameId)
    .select()
    .single();

  if (gameUpdateError) {
    return { success: false, error: gameUpdateError.message };
  }

  // Clear out any play calls for the next sequence to avoid stale submissions carrying over.
  await supabase.from("play_calls").delete().eq("game_id", gameId).eq("seq", nextSeq);

  const { data: playRow } = await supabase.from("plays").insert({
    game_id: gameId,
    seq,
    offense_side: game.offense_side,
    defense_side: game.defense_side,
    call_offense: offensePlay,
    call_defense: defensePlay,
    difficulty: offenseDiff,
    offense_roll: dieOffense,
    defense_roll: dieDefense,
    offense_correct: finalOffenseCorrect,
    defense_correct: finalDefenseCorrect,
    yards: gained,
    turnover,
    result_text: turnover ? "Turnover on downs" : `Gained ${gained} yards`,
  });

  await logGameEvent(gameId, "play_resolved", {
    seq,
    yards: gained,
    turnover,
    touchdown: phase === "kickoff",
    call_offense: offensePlay,
    call_defense: defensePlay,
    offense_correct: finalOffenseCorrect,
    defense_correct: finalDefenseCorrect,
    offense_roll: dieOffense,
    defense_roll: dieDefense,
  });

  return { success: true, game: updatedGame, play: playRow?.[0] };
}

export async function continueAfterRollAction(
  gameId: string,
  playerId: string,
  forSide?: "offense" | "defense",
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: game } = await supabase
    .from("games")
    .select("play_subphase, offense_side, defense_side, current_play_seq, phase")
    .eq("id", gameId)
    .single();
  if (!game) return { success: false, error: "Game not found." };
  if (game.phase !== "drive" || game.play_subphase !== "rolls_done") {
    return { success: false, error: "Not ready to resolve yet." };
  }

  const { data: player } = await supabase
    .from("players")
    .select("id, side, role")
    .eq("id", playerId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!player) return { success: false, error: "Player not found." };
  const seq = game.current_play_seq ?? 1;

  const targetRole =
    forSide ??
    (player.side === game.offense_side ? "offense" : player.side === game.defense_side ? "defense" : "offense");

  await supabase
    .from("play_calls")
    .update({ ready_after_roll: true })
    .eq("game_id", gameId)
    .eq("seq", seq)
    .eq("role", targetRole);

  const { data: readiness } = await supabase
    .from("play_calls")
    .select("role, ready_after_roll")
    .eq("game_id", gameId)
    .eq("seq", seq);

  const offenseReady = readiness?.some((r) => r.role === "offense" && r.ready_after_roll) ?? false;
  const defenseReady = readiness?.some((r) => r.role === "defense" && r.ready_after_roll) ?? false;

  await logGameEvent(gameId, "ready_after_roll", { seq, offense_ready: offenseReady, defense_ready: defenseReady });

  if (offenseReady && defenseReady) {
    return finalizePlayResolution(gameId, seq);
  }

  return { success: true, message: "Continue recorded. Waiting for other side." };
}
