"use server";

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabaseServer";

export async function GET(
  _: Request,
  context: { params: { code: string } } | { params: Promise<{ code: string }> },
) {
  const rawParams = "params" in context ? (context as any).params : null;
  const resolvedParams = rawParams && typeof rawParams.then === "function" ? await rawParams : rawParams;
  const code = resolvedParams?.code?.toUpperCase?.();
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const supabase = createSupabaseServerClient();

  const { data: game } = await supabase
    .from("games")
    .select("id, code, status, host_player_id, picker_player_id, target_score, current_block, winner_player_id, mode")
    .eq("code", code)
    .maybeSingle();
  if (!game) return NextResponse.json({ error: "Game not found" }, { status: 404 });

  // Choose a round: live > latest revealed > earliest pending
  const { data: live } = await supabase
    .from("rounds")
    .select("id, seq, status, question_id, block")
    .eq("game_id", game.id)
    .eq("status", "live")
    .order("seq", { ascending: true })
    .limit(1)
    .maybeSingle();

  const { data: revealed } = await supabase
    .from("rounds")
    .select("id, seq, status, question_id, block")
    .eq("game_id", game.id)
    .eq("status", "revealed")
    .order("seq", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: pending } = await supabase
    .from("rounds")
    .select("id, seq, status, question_id, block")
    .eq("game_id", game.id)
    .eq("status", "pending")
    .order("seq", { ascending: true })
    .limit(1)
    .maybeSingle();

  const round = live ?? revealed ?? pending ?? null;
  let question = null;
  if (round?.question_id) {
    const { data: q } = await supabase
      .from("questions")
      .select("id, text, choices, correct_index, difficulty, category")
      .eq("id", round.question_id)
      .maybeSingle();
    question = q ?? null;
  }

  // Counts for readiness/answers (used to drive UI state)
  let totalPlayers = 0;
  let answersCount = 0;
  let readyCount = 0;
  let pendingCount = 0;
  if (round?.id) {
    const { count: total } = await supabase
      .from("players")
      .select("id", { count: "exact", head: true })
      .eq("game_id", game.id)
      .not("role", "in", "(ref,host)");
    totalPlayers = total ?? 0;

    const { count: ans } = await supabase
      .from("answers")
      .select("id", { count: "exact", head: true })
      .eq("round_id", round.id);
    answersCount = ans ?? 0;

    const { count: ready } = await supabase
      .from("answers")
      .select("id", { count: "exact", head: true })
      .eq("round_id", round.id)
      .eq("ready_next", true);
    readyCount = ready ?? 0;

    const { count: pendingRoundCount } = await supabase
      .from("rounds")
      .select("id", { count: "exact", head: true })
      .eq("game_id", game.id)
      .eq("status", "pending");
    pendingCount = pendingRoundCount ?? 0;
  }

  // Answers summary for reveal UI
  let answersSummary: Array<{ player_id: string; display_name: string | null; correct: boolean | null; points: number | null }> = [];
  if (round?.id) {
    const { data: ansRows } = await supabase
      .from("answers")
      .select("player_id, correct, points, players(display_name)")
      .eq("round_id", round.id);
    answersSummary =
      ansRows?.map((a) => ({
        player_id: a.player_id,
        display_name: (a as any).players?.display_name ?? null,
        correct: a.correct,
        points: a.points,
      })) ?? [];
  }

  return NextResponse.json({
    game,
    round,
    question,
    counts: {
      totalPlayers,
      answersCount,
      readyCount,
      pendingCount,
    },
    answersSummary,
  });
}
