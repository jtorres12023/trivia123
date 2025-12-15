"use server";

import { createSupabaseServerClient } from "@/lib/supabaseServer";
import { logGameEvent } from "@/app/actions/events";

type ActionResult =
  | { success: true; message?: string; game?: Record<string, unknown> | null }
  | { success: false; error: string };

type OtdbQuestion = {
  category: string;
  type: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
};

const OTDB_CATEGORY_MAP: Record<string, number> = {
  "general knowledge": 9,
  books: 10,
  film: 11,
  music: 12,
  "musicals & theatres": 13,
  "television": 14,
  "video games": 15,
  "board games": 16,
  "science & nature": 17,
  "computers": 18,
  "mathematics": 19,
  mythology: 20,
  sports: 21,
  geography: 22,
  history: 23,
  politics: 24,
  art: 25,
  celebrities: 26,
  animals: 27,
  vehicles: 28,
  comics: 29,
  "science: gadgets": 30,
  "japanese anime & manga": 31,
  cartoon: 32,
  cartoons: 32,
  "cartoon & animations": 32,
};

const decodeHtml = (input: string) =>
  input
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&eacute;/g, "é");

const shuffle = <T,>(arr: T[]) => {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

export async function startTriviaRound(gameId: string, hostId: string, questionId: string, seq: number): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: game } = await supabase.from("games").select("id, host_player_id, mode").eq("id", gameId).single();
  if (!game) return { success: false, error: "Game not found." };
  if (game.mode !== "trivia") return { success: false, error: "Not a trivia game." };
  if (game.host_player_id && game.host_player_id !== hostId) return { success: false, error: "Only host can start rounds." };

  const { error } = await supabase.from("rounds").upsert(
    {
      game_id: gameId,
      seq,
      question_id: questionId,
      status: "live",
      starts_at: new Date().toISOString(),
      ends_at: null,
    },
    { onConflict: "game_id,seq" },
  );
  if (error) return { success: false, error: error.message };

  await logGameEvent(gameId, "trivia_round_started", { seq, question_id: questionId });
  return { success: true };
}

export async function submitTriviaAnswer(roundId: string, gameId: string, playerId: string, choiceIndex: number): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: round } = await supabase.from("rounds").select("status").eq("id", roundId).single();
  if (!round || round.status !== "live") return { success: false, error: "Round not accepting answers." };

  const { error } = await supabase.from("answers").upsert(
    {
      round_id: roundId,
      game_id: gameId,
      player_id: playerId,
      choice_index: choiceIndex,
    },
    { onConflict: "round_id,player_id" },
  );
  if (error) return { success: false, error: error.message };
  await logGameEvent(gameId, "trivia_answer_submitted", { round_id: roundId, player_id: playerId });

  // Auto-lock and score when all non-ref players have answered
  const { count: totalPlayers } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .neq("role", "ref");
  const { count: totalAnswers } = await supabase
    .from("answers")
    .select("id", { count: "exact", head: true })
    .eq("round_id", roundId);
  if ((totalPlayers ?? 0) > 0 && (totalAnswers ?? 0) >= (totalPlayers ?? 0)) {
    await lockAndScoreRound(roundId, gameId);
  }

  return { success: true };
}

export async function lockAndScoreRound(roundId: string, gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { data: round } = await supabase
    .from("rounds")
    .select("id, question_id, status, seq, block")
    .eq("id", roundId)
    .single();
  if (!round) return { success: false, error: "Round not found." };

  const { data: question } = await supabase
    .from("questions")
    .select("correct_index, difficulty")
    .eq("id", round.question_id)
    .single();
  if (!question) return { success: false, error: "Question missing." };

  const basePoints = question.difficulty === "hard" ? 300 : question.difficulty === "easy" ? 100 : 200;

  const { data: answers } = await supabase
    .from("answers")
    .select("id, player_id, choice_index, correct, points")
    .eq("round_id", roundId);
  if (!answers) return { success: false, error: "No answers." };

  const updates = answers.map((a) => {
    const alreadyScored = a.correct !== null && a.correct !== undefined;
    const correctFlag = a.choice_index === question.correct_index;
    const pointsAwarded = correctFlag ? basePoints : 0;
    return {
      id: a.id,
      player_id: a.player_id,
      shouldScore: !alreadyScored,
      correct: correctFlag,
      points: pointsAwarded,
    };
  });

  for (const u of updates) {
    // Update answer correctness/points (idempotent: only if not set)
    if (u.shouldScore) {
      await supabase.from("answers").update({ correct: u.correct, points: u.points }).eq("id", u.id);
      if (u.player_id) {
        const deltaCorrect = u.correct ? 1 : 0;
        const deltaIncorrect = u.correct ? 0 : 1;
        await supabase.rpc("increment_player_score", { p_player_id: u.player_id, p_points: u.points });
        await supabase.rpc("increment_player_counts", {
          p_player_id: u.player_id,
          p_correct: deltaCorrect,
          p_incorrect: deltaIncorrect,
        });
      }
    }
  }

  await supabase
    .from("rounds")
    .update({ status: "revealed", ends_at: new Date().toISOString() })
    .eq("id", roundId);

  await logGameEvent(gameId, "trivia_round_revealed", {
    round_id: roundId,
    seq: round.seq,
  });

  // Winner + next picker logic
  const { data: gameRow } = await supabase.from("games").select("target_score, current_block").eq("id", gameId).single();
  if (gameRow) {
  const { data: playerScores } = await supabase.from("players").select("id, score, role").eq("game_id", gameId).neq("role", "ref");
  const winner = playerScores?.find((p) => (p.score ?? 0) >= (gameRow.target_score ?? 25));
  if (winner) {
    await supabase.from("games").update({ status: "completed", winner_player_id: winner.id }).eq("id", gameId);
    await logGameEvent(gameId, "trivia_completed", { winner: winner.id, score: winner.score });
    return { success: true };
  }

  const { count: revealedInBlock } = await supabase
    .from("rounds")
    .select("id", { count: "exact" })
    .eq("game_id", gameId)
    .eq("block", round.block ?? 1)
    .eq("status", "revealed");

  // Single 20-question block: when all revealed, determine winner by high score (ties random)
  if ((revealedInBlock ?? 0) >= 20) {
    const topScore = playerScores?.reduce((max, p) => Math.max(max, p.score ?? 0), 0) ?? 0;
    const topPlayers = (playerScores ?? []).filter((p) => (p.score ?? 0) === topScore);
    const finalWinner = topPlayers.length > 0 ? topPlayers[Math.floor(Math.random() * topPlayers.length)] : null;
    await supabase.from("games").update({ status: "completed", winner_player_id: finalWinner?.id ?? null }).eq("id", gameId);
    await logGameEvent(gameId, "trivia_block_completed", { block: round.block ?? 1 });
    await logGameEvent(gameId, "trivia_completed", { winner: finalWinner?.id ?? null, score: topScore });
    return { success: true };
  }

}

  return { success: true };
}

export async function ensureLiveRound(gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { count: liveCount } = await supabase
    .from("rounds")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .eq("status", "live");
  if ((liveCount ?? 0) > 0) return { success: true };

  const { data: nextPending } = await supabase
    .from("rounds")
    .select("id, seq")
    .eq("game_id", gameId)
    .eq("status", "pending")
    .order("seq", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextPending?.id) return { success: false, error: "No pending rounds to start." };

  const { error } = await supabase
    .from("rounds")
    .update({ status: "live", starts_at: new Date().toISOString(), ends_at: null })
    .eq("id", nextPending.id);
  if (error) return { success: false, error: error.message };

  await logGameEvent(gameId, "trivia_round_started", { round_id: nextPending.id, seq: nextPending.seq });
  return { success: true };
}

export async function importOpenTriviaBatch(
  amount = 20,
  difficulty?: "easy" | "medium" | "hard",
  categoryId?: number,
): Promise<ActionResult> {
  const url = new URL("https://opentdb.com/api.php");
  url.searchParams.set("amount", String(amount));
  url.searchParams.set("type", "multiple");
  if (difficulty) url.searchParams.set("difficulty", difficulty);
  if (categoryId) url.searchParams.set("category", String(categoryId));

  const res = await fetch(url.toString());
  if (!res.ok) return { success: false, error: `OTDB fetch failed (${res.status})` };
  const body = await res.json();
  if (!body?.results) return { success: false, error: "No OTDB results." };

  const supabase = createSupabaseServerClient();

  const rows = (body.results as OtdbQuestion[]).map((q) => {
    const decodedQuestion = decodeHtml(q.question);
    const decodedCorrect = decodeHtml(q.correct_answer);
    const decodedIncorrect = q.incorrect_answers.map((a) => decodeHtml(a));
    const choices = shuffle([decodedCorrect, ...decodedIncorrect]);
    const correctIndex = choices.indexOf(decodedCorrect);
    return {
      text: decodedQuestion,
      choices,
      correct_index: correctIndex,
      difficulty: q.difficulty ?? "medium",
      category: q.category,
      type: q.type,
      source: "opentdb",
    };
  });

  const { error } = await supabase.from("questions").insert(rows);
  if (error) return { success: false, error: error.message };

  return { success: true, message: `Imported ${rows.length} questions from OTDB.` };
}

export async function startTriviaGame(gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: players } = await supabase
    .from("players")
    .select("id")
    .eq("game_id", gameId)
    .neq("role", "ref");
  if (!players || players.length === 0) return { success: false, error: "Need at least one player." };
  const picker = players[Math.floor(Math.random() * players.length)];

  // Auto-seed a baseline of questions if table is light
  const { count: questionCount } = await supabase.from("questions").select("id", { count: "exact", head: true });
  if ((questionCount ?? 0) < 20) {
    await importOpenTriviaBatch(50, undefined, undefined);
  }

  await supabase.from("players").update({ score: 0 }).eq("game_id", gameId);
  await supabase
    .from("games")
    .update({ picker_player_id: picker.id, current_block: 1, winner_player_id: null, status: "in_progress" })
    .eq("id", gameId);
  await logGameEvent(gameId, "trivia_picker_assigned", { picker: picker.id, block: 1 });
  return { success: true, message: "Trivia game started.", game: { picker_player_id: picker.id, current_block: 1, status: "in_progress" } };
}

export async function chooseCategoryDifficulty(
  gameId: string,
  pickerId: string,
  category: string,
  difficulty: "easy" | "medium" | "hard",
): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: game } = await supabase.from("games").select("picker_player_id, current_block").eq("id", gameId).single();
  if (!game) return { success: false, error: "Game not found." };
  // Always set/refresh picker to the caller to unblock flow.
  await supabase.from("games").update({ picker_player_id: pickerId }).eq("id", gameId);

  const normalizedCategory = category.trim();
  const { data: used } = await supabase.from("rounds").select("question_id").eq("game_id", gameId);
  const usedIds = (used ?? []).map((r) => r.question_id);

  // Single block game: clear any existing rounds before seeding new set
  await supabase.from("rounds").delete().eq("game_id", gameId);

  const BLOCK_SIZE = 20;

  let query = supabase
    .from("questions")
    .select("id, category")
    .ilike("category", normalizedCategory)
    .eq("difficulty", difficulty);

  // Only apply exclusion if we actually have used ids
  if (usedIds.length > 0) {
    query = query.not("id", "in", `(${usedIds.map((id) => `'${id}'`).join(",")})`);
  }

  let { data: questions } = await query.limit(BLOCK_SIZE);

  // Auto-fetch/import if not enough questions for that combo
  if (!questions || questions.length < 5) {
    const catId = OTDB_CATEGORY_MAP[normalizedCategory.toLowerCase()] ?? undefined;
    await importOpenTriviaBatch(30, difficulty, catId);
    ({ data: questions } = await query.limit(BLOCK_SIZE));

    // If still short, relax to difficulty-only (and import again) so the picker isn't blocked
    if (!questions || questions.length < 5) {
      let relaxed = supabase.from("questions").select("id").eq("difficulty", difficulty);
      if (usedIds.length > 0) relaxed = relaxed.not("id", "in", `(${usedIds.map((id) => `'${id}'`).join(",")})`);
      const { data: relaxedQs } = await relaxed.limit(BLOCK_SIZE);
      questions = relaxedQs ?? questions;

      if (!questions || questions.length < 5) {
        await importOpenTriviaBatch(30, difficulty, undefined);
        const { data: relaxedAfterImport } = await relaxed.limit(BLOCK_SIZE);
        questions = relaxedAfterImport ?? questions;
      }

      // Final fallback: ignore usedIds entirely to avoid blocking
      if (!questions || questions.length < 5) {
        const { data: anyQs } = await supabase.from("questions").select("id").eq("difficulty", difficulty).limit(BLOCK_SIZE);
        questions = anyQs ?? questions;
      }
    }
  }

  if (!questions || questions.length === 0) {
    return { success: false, error: "Not enough questions for that category/difficulty." };
  }

  // Proceed even if we have fewer than the target block size so the picker isn’t blocked
  const usableQuestions = questions.slice(0, BLOCK_SIZE);

  const { data: lastRound } = await supabase
    .from("rounds")
    .select("seq")
    .eq("game_id", gameId)
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();
  const startSeq = (lastRound?.seq ?? 0) + 1;

  const inserts = usableQuestions.map((q, idx) => ({
    game_id: gameId,
    seq: startSeq + idx,
    question_id: q.id,
    status: idx === 0 ? "live" : "pending",
    block: 1,
    category,
    difficulty,
  }));
  const { error } = await supabase.from("rounds").insert(inserts);
  if (error) return { success: false, error: error.message };

  await logGameEvent(gameId, "trivia_block_seeded", { block: game.current_block ?? 1, category, difficulty });
  return { success: true, message: "Category/difficulty set. First question is live." };
}

export async function confirmReadyNext(gameId: string, playerId: string, roundId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: player } = await supabase
    .from("players")
    .select("id, role")
    .eq("id", playerId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!player || player.role === "ref" || player.role === "host") return { success: false, error: "Player not found or not eligible." };

  // Ensure an answer row exists and mark ready_next
  const { error: readyErr } = await supabase
    .from("answers")
    .upsert(
      {
        round_id: roundId,
        game_id: gameId,
        player_id: playerId,
        ready_next: true,
      },
      { onConflict: "round_id,player_id" },
    );
  if (readyErr) return { success: false, error: readyErr.message };

  const { count: totalPlayers } = await supabase
    .from("players")
    .select("id", { count: "exact", head: true })
    .eq("game_id", gameId)
    .not("role", "in", "(ref,host)");
  const { count: readyCount } = await supabase
    .from("answers")
    .select("id", { count: "exact", head: true })
    .eq("round_id", roundId)
    .eq("ready_next", true);

  if ((totalPlayers ?? 0) > 0 && (readyCount ?? 0) >= (totalPlayers ?? 0)) {
    const { data: nextPending } = await supabase
      .from("rounds")
      .select("id, seq")
      .eq("game_id", gameId)
      .eq("status", "pending")
      .order("seq", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (nextPending?.id) {
      await supabase
        .from("rounds")
        .update({ status: "live", starts_at: new Date().toISOString(), ends_at: null })
        .eq("id", nextPending.id);
      await logGameEvent(gameId, "trivia_round_started", { seq: nextPending.seq, round_id: nextPending.id });
    }
  }

  return { success: true };
}

export async function resetTriviaGame(gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();

  const { error: ansErr } = await supabase.from("answers").delete().eq("game_id", gameId);
  if (ansErr) return { success: false, error: ansErr.message };

  const { error: roundErr } = await supabase.from("rounds").delete().eq("game_id", gameId);
  if (roundErr) return { success: false, error: roundErr.message };

  await supabase.from("players").update({ score: 0, correct_count: 0, incorrect_count: 0 }).eq("game_id", gameId);
  const { error: gameErr } = await supabase
    .from("games")
    .update({
      status: "lobby_open",
      picker_player_id: null,
      current_block: 1,
      winner_player_id: null,
      mode: "trivia",
    })
    .eq("id", gameId);
  if (gameErr) return { success: false, error: gameErr.message };

  await logGameEvent(gameId, "trivia_reset", {});
  return { success: true, message: "Trivia game reset. Start again when ready." };
}

export async function startNextPendingRound(gameId: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: nextPending } = await supabase
    .from("rounds")
    .select("id, seq")
    .eq("game_id", gameId)
    .eq("status", "pending")
    .order("seq", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!nextPending?.id) return { success: false, error: "No pending round to start." };

  const { error } = await supabase
    .from("rounds")
    .update({ status: "live", starts_at: new Date().toISOString(), ends_at: null })
    .eq("id", nextPending.id);
  if (error) return { success: false, error: error.message };

  await logGameEvent(gameId, "trivia_round_started", { seq: nextPending.seq, round_id: nextPending.id, triggered: "manual_start" });
  return { success: true };
}

export async function closeTriviaGame(gameId: string, requesterId?: string): Promise<ActionResult> {
  const supabase = createSupabaseServerClient();
  const { data: game } = await supabase.from("games").select("host_player_id, code").eq("id", gameId).maybeSingle();
  if (!game) return { success: false, error: "Game not found." };
  if (game.host_player_id && requesterId && requesterId !== game.host_player_id) {
    return { success: false, error: "Only the host can close this game." };
  }

  const { error } = await supabase.from("games").delete().eq("id", gameId);
  if (error) return { success: false, error: error.message };
  return { success: true, message: `Game ${game.code ?? ""} closed.` };
}
