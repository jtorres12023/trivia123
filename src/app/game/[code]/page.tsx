"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { supabase } from "@/lib/supabaseClient";

import type { GameState } from "@/app/actions/game";
import {
  chooseTossOptionAction,
  flipCoinAction,
  getGameByCode,
  resetDriveAction,
  resolveKickoffTouchbackAction,
  startCoinToss,
} from "@/app/actions/game";
import {
  continueAfterRollAction,
  submitPlayCallAction,
  submitQuestionAnswerAction,
  submitRollAction,
} from "@/app/actions/play";
import type { GameEvent } from "@/app/actions/events";
import { getRecentEvents } from "@/app/actions/events";

type View = "ref" | "team";
type PlayerInfo = {
  id: string;
  role: string;
  side: "home" | "away" | null;
  display_name: string;
};
type LatestPlay = {
  call_offense?: string | null;
  call_defense?: string | null;
  offense_roll?: number | null;
  defense_roll?: number | null;
  offense_correct?: boolean | null;
  defense_correct?: boolean | null;
  yards?: number | null;
  result_text?: string | null;
  created_at?: string;
};
type RollPhase = {
  started: boolean;
  offense_roll?: number | null;
  defense_roll?: number | null;
};

export default function GamePage() {
  const randomDie = () => Math.floor(Math.random() * 20) + 1;
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [game, setGame] = useState<GameState | null>(null);
  const [view, setView] = useState<View>("team");
  const [playerInfo, setPlayerInfo] = useState<PlayerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [coinCall, setCoinCall] = useState<"heads" | "tails">("heads");
  const [winnerChoice, setWinnerChoice] = useState<"receive" | "kick" | "defer">("receive");
  const [coinPending, setCoinPending] = useState(false);
  const [coinStatus, setCoinStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const isAway = playerInfo?.side === "away";
  const isWinner = playerInfo && game?.toss_winner_side && playerInfo.side === game.toss_winner_side;
  const isRef = playerInfo?.role === "ref";
  const [kickoffPending, setKickoffPending] = useState(false);
  const [kickoffStatus, setKickoffStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const isKickingTeam = game?.phase === "kickoff" && game.possession_side
    ? (playerInfo?.side === (game.possession_side === "home" ? "away" : "home"))
    : false;
  const isOffense = playerInfo?.side && game?.offense_side && playerInfo.side === game.offense_side;
  const isDefense = playerInfo?.side && game?.defense_side && playerInfo.side === game.defense_side;
  const offenseOptions = ["Run", "Pass", "Screen", "Trick", "Hail Mary"];
  const defenseOptions = ["Run stop", "Pass D", "Blitz", "Zone"];
  const difficultyOptions = ["easy", "medium", "hard"];
  const [playCall, setPlayCall] = useState(offenseOptions[0]);
  const [playDifficulty, setPlayDifficulty] = useState(difficultyOptions[0]);
  const [defenseCall, setDefenseCall] = useState(defenseOptions[0]);
  const [defenseAnswerPending, setDefenseAnswerPending] = useState(false);
  const [questionAnswerPending, setQuestionAnswerPending] = useState(false);
  const [playStatus, setPlayStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [latestPlay, setLatestPlay] = useState<LatestPlay | null>(null);
  const [answerStatus, setAnswerStatus] = useState<{ offense: boolean; defense: boolean }>({ offense: false, defense: false });
  const [rollStatus, setRollStatus] = useState<{ offense: boolean; defense: boolean }>({ offense: false, defense: false });
  const [readyStatus, setReadyStatus] = useState<{ offense: boolean; defense: boolean }>({ offense: false, defense: false });
  const [rollPhase, setRollPhase] = useState<RollPhase>({ started: false });
  const [rollOverlayVisible, setRollOverlayVisible] = useState(false);
  const [rollAnim, setRollAnim] = useState<{ offense: number; defense: number }>({
    offense: randomDie(),
    defense: randomDie(),
  });
  const [showDefenseRoll, setShowDefenseRoll] = useState(false);

  const refreshGameState = async (gameId: string) => {
    const { data } = await supabase
      .from("games")
      .select(
        "id, code, status, phase, play_subphase, quarter, clock_seconds, play_clock_seconds, possession_side, offense_side, defense_side, down, distance, yard_line, score_home, score_away, home_team_name, away_team_name, lobby_locked, host_player_id, toss_result, toss_winner_side, toss_choice, second_half_kickoff_side, current_play_seq",
      )
      .eq("id", gameId)
      .single();
    if (data) {
      setGame(data as GameState);
    }
  };
  const refreshLatestPlay = async (gameId: string) => {
    const { data } = await supabase
      .from("plays")
      .select("call_offense, call_defense, offense_roll, defense_roll, offense_correct, defense_correct, yards, result_text, created_at")
      .eq("game_id", gameId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) setLatestPlay(data as LatestPlay);
  };
  const refreshAnswerStatus = async (gameId: string, seq?: number | null) => {
    let targetSeq = seq ?? null;
    if (!targetSeq) {
      const { data: g } = await supabase.from("games").select("current_play_seq").eq("id", gameId).maybeSingle();
      targetSeq = g?.current_play_seq ?? 1;
    }
    const { data } = await supabase
      .from("play_calls")
      .select("role, answer, roll, ready_after_roll, seq")
      .eq("game_id", gameId)
      .eq("seq", targetSeq ?? 1);
    const offense = data?.some((d) => d.role === "offense" && d.answer !== null) ?? false;
    const defense = data?.some((d) => d.role === "defense" && d.answer !== null) ?? false;
    setAnswerStatus({ offense, defense });
    const offenseRoll = data?.some((d) => d.role === "offense" && d.roll !== null) ?? false;
    const defenseRoll = data?.some((d) => d.role === "defense" && d.roll !== null) ?? false;
    setRollStatus({ offense: offenseRoll, defense: defenseRoll });
    const offenseReady = data?.some((d) => d.role === "offense" && d.ready_after_roll) ?? false;
    const defenseReady = data?.some((d) => d.role === "defense" && d.ready_after_roll) ?? false;
    setReadyStatus({ offense: offenseReady, defense: defenseReady });
  };

  useEffect(() => {
    const load = async () => {
      const g = await getGameByCode(code);
      if (!g) {
        setError("Game not found.");
        setLoading(false);
        return;
      }
      setGame(g);
      setLoading(false);
      await refreshLatestPlay(g.id);
      await refreshAnswerStatus(g.id, g.current_play_seq ?? 1);
      // Redirect to lobby if not started
      if (g.status === "lobby_open") {
        router.push("/");
      }
    };
    load();
  }, [code, router]);

  // Pull player identity from localStorage (stored during lobby) and set view.
  useEffect(() => {
    if (!game?.id) return;
    const stored = typeof window !== "undefined" ? localStorage.getItem("gridiron-lobby") : null;
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as { gameId: string; playerId: string };
      if (parsed?.gameId !== game.id || !parsed.playerId) return;

      supabase
        .from("players")
        .select("id, role, side, display_name, game_id")
        .eq("id", parsed.playerId)
        .single()
        .then(({ data, error: playerError }) => {
          if (playerError || !data || data.game_id !== game.id) return;
          const info: PlayerInfo = {
            id: data.id,
            role: data.role,
            side: data.side,
            display_name: data.display_name,
          };
          setPlayerInfo(info);
          if (data.role === "ref") {
            setView("ref");
          } else {
            setView("team");
          }
        });
    } catch {
      // ignore parse errors
    }
  }, [game?.id, game?.current_play_seq]);

  useEffect(() => {
    if (!game?.id) return;

    let isActive = true;

    const load = async () => {
      const evts = await getRecentEvents(game.id);
      if (isActive) {
        setEvents(evts);
      }
      if (isActive) {
        await refreshGameState(game.id);
        await refreshLatestPlay(game.id);
        await refreshAnswerStatus(game.id, game.current_play_seq ?? 1);
      }
    };

    load();

    const channel = supabase
      .channel(`game-${game.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        (payload) => {
          setGame(payload.new as GameState);
          refreshLatestPlay(game.id);
          refreshAnswerStatus(game.id, (payload.new as GameState).current_play_seq ?? 1);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "plays", filter: `game_id=eq.${game.id}` },
        () => {
          refreshGameState(game.id);
          refreshLatestPlay(game.id);
          refreshAnswerStatus(game.id, game.current_play_seq ?? 1);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "game_events", filter: `game_id=eq.${game.id}` },
        (payload) => {
          setEvents((prev) => [...prev, payload.new as GameEvent]);
          // Refresh game state on key events to sync all clients
          const evt = payload.new as GameEvent;
          const important = [
            "coin_toss_flipped",
            "coin_toss_choice",
            "kickoff_touchback",
            "coin_toss_result",
            "play_calls_locked",
            "play_resolved",
            "play_call_submitted",
            "drive_reset",
            "answer_submitted",
            "roll_submitted",
            "rolls_started",
            "rolls_completed",
            "ready_after_roll",
          ];
          if (important.includes(evt.type)) {
            refreshGameState(game.id);
            refreshLatestPlay(game.id);
            const payloadSeq = typeof evt.payload === "object" && evt.payload && "seq" in evt.payload ? (evt.payload as { seq?: number }).seq : undefined;
            refreshAnswerStatus(game.id, payloadSeq);
            if (evt.type === "rolls_started") {
              setRollPhase({ started: true, offense_roll: null, defense_roll: null });
              setRollOverlayVisible(true);
              setShowDefenseRoll(false);
            }
            if (evt.type === "rolls_completed") {
              const pr = evt.payload as { offense_roll?: number; defense_roll?: number };
              setRollPhase({
                started: false,
                offense_roll: pr.offense_roll ?? null,
                defense_roll: pr.defense_roll ?? null,
              });
              setRollOverlayVisible(true);
              setShowDefenseRoll(false);
            }
            if (evt.type === "roll_submitted") {
              const pr = evt.payload as { offense_roll?: number | null; defense_roll?: number | null };
              setRollPhase((prev) => ({
                started: true,
                offense_roll: pr.offense_roll ?? prev.offense_roll ?? null,
                defense_roll: pr.defense_roll ?? prev.defense_roll ?? null,
              }));
              setRollOverlayVisible(true);
            }
            if (evt.type === "play_resolved" || evt.type === "drive_reset") {
              setRollPhase({ started: false, offense_roll: null, defense_roll: null });
              setRollOverlayVisible(false);
              setShowDefenseRoll(false);
            }
          }
        },
      )
      .subscribe();

    return () => {
      isActive = false;
      supabase.removeChannel(channel);
    };
  }, [game?.id, game?.current_play_seq]);

  const handleStartCoinToss = async () => {
    if (!game?.id) return;
    await startCoinToss(game.id);
  };

  const handleFlipCoin = async () => {
    if (!game?.id || !playerInfo) return;
    setCoinStatus(null);
    setCoinPending(true);
    const result = await flipCoinAction(game.id, playerInfo.id, coinCall);
    setCoinPending(false);
    if (!result.success) {
      setCoinStatus({ type: "error", message: result.error ?? "Could not flip coin." });
    } else {
      setCoinStatus({
        type: "success",
        message: `Coin: ${result.coin} · Winner: ${result.winner}`,
      });
    }
  };

  const handleResolveCoinToss = async () => {
    if (!game?.id || !playerInfo) return;
    setCoinStatus(null);
    setCoinPending(true);
    const result = await chooseTossOptionAction(game.id, playerInfo.id, winnerChoice);
    setCoinPending(false);
    if (!result.success) {
      setCoinStatus({ type: "error", message: result.error ?? "Could not apply choice." });
    }
  };

  const handleKickoffTouchback = async () => {
    if (!game?.id) return;
    setKickoffStatus(null);
    setKickoffPending(true);
    const result = await resolveKickoffTouchbackAction(game.id);
    setKickoffPending(false);
    if (!result.success) {
      setKickoffStatus({ type: "error", message: result.error ?? "Kickoff failed." });
    } else {
      setKickoffStatus({ type: "success", message: "Kickoff resolved as touchback." });
    }
  };

  const handleResetDrive = async () => {
    if (!game?.id || !playerInfo || playerInfo.role !== "ref") return;
    setPlayStatus(null);
    const result = await resetDriveAction(game.id, playerInfo.id);
    if (result.success && result.game) {
      setGame(result.game as GameState);
      setLatestPlay(null);
      setAnswerStatus({ offense: false, defense: false });
    } else {
      await refreshGameState(game.id);
    }
  };

  const handleSubmitOffensePlay = async () => {
    if (!game?.id || !playerInfo) return;
    setPlayStatus(null);
    const result = await submitPlayCallAction(game.id, playerInfo.id, "offense", playCall || "offense_play", playDifficulty);
    if (!result.success) {
      setPlayStatus({ type: "error", message: result.error });
    } else {
      if (result.game) setGame(result.game as GameState);
      setPlayStatus({ type: "success", message: "Play submitted." });
      await refreshGameState(game.id);
      await refreshAnswerStatus(game.id);
      await refreshLatestPlay(game.id);
    }
  };

  const handleSubmitDefensePlay = async () => {
    if (!game?.id || !playerInfo) return;
    setPlayStatus(null);
    const result = await submitPlayCallAction(game.id, playerInfo.id, "defense", defenseCall || "defense_play", "n/a");
    if (!result.success) {
      setPlayStatus({ type: "error", message: result.error });
    } else {
      if (result.game) setGame(result.game as GameState);
      setPlayStatus({ type: "success", message: "Play submitted." });
      await refreshGameState(game.id);
      await refreshAnswerStatus(game.id);
      await refreshLatestPlay(game.id);
    }
  };

  const handleAnswerQuestion = async (isCorrect: boolean) => {
    if (!game?.id || !playerInfo) return;
    setPlayStatus(null);
    setQuestionAnswerPending(true);
    const result = await submitQuestionAnswerAction(game.id, playerInfo.id, isCorrect, undefined, undefined);
    setQuestionAnswerPending(false);
    if (!result.success) {
      setPlayStatus({ type: "error", message: result.error });
    } else {
      setPlayStatus({ type: "success", message: result.message ?? `Answer submitted (${isCorrect ? "correct" : "incorrect"})` });
      if (result.game) setGame(result.game as GameState);
      if (result.play) setLatestPlay(result.play as LatestPlay);
      await refreshGameState(game.id);
      await refreshAnswerStatus(game.id);
      await refreshLatestPlay(game.id);
    }
  };

  const handleSubmitRoll = async () => {
    if (!game?.id || !playerInfo) return;
    setPlayStatus(null);
    const result = await submitRollAction(game.id, playerInfo.id, undefined);
    if (!result.success) {
      setPlayStatus({ type: "error", message: result.error });
    } else {
      setPlayStatus({ type: "success", message: "Roll submitted." });
      await refreshGameState(game.id);
      await refreshAnswerStatus(game.id);
    }
  };

  const handleContinueAfterRoll = async () => {
    if (!game?.id || !playerInfo) return;
    const result = await continueAfterRollAction(game.id, playerInfo.id);
    if (!result.success) {
      setPlayStatus({ type: "error", message: result.error });
    } else {
      setPlayStatus({ type: "success", message: result.message ?? "Continue recorded." });
      if (result.game) setGame(result.game as GameState);
      if (result.play) setLatestPlay(result.play as LatestPlay);
      await refreshGameState(game.id);
      await refreshAnswerStatus(game.id);
      await refreshLatestPlay(game.id);
    }
  };

  // Handle roll overlay animation and visibility
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let timeoutReveal: ReturnType<typeof setTimeout> | null = null;

    // Keep overlay visible during rolls/ready; only hide on play_resolved/drive_reset handler
    if (rollPhase.started || rollPhase.offense_roll != null || rollPhase.defense_roll != null) {
      setRollOverlayVisible(true);
    }

    const anyRollsIn = rollStatus.offense || rollStatus.defense || rollPhase.offense_roll != null || rollPhase.defense_roll != null;

    if (rollPhase.started && anyRollsIn) {
      interval = setInterval(() => {
        setRollAnim({ offense: randomDie(), defense: randomDie() });
      }, 220);
    } else if (rollPhase.started && !anyRollsIn) {
      // Waiting for first roll submission; no spin yet
      setRollAnim({ offense: randomDie(), defense: randomDie() });
    } else if (rollPhase.offense_roll != null || rollPhase.defense_roll != null) {
      setRollAnim({
        offense: rollPhase.offense_roll ?? randomDie(),
        defense: rollPhase.defense_roll ?? randomDie(),
      });
      setShowDefenseRoll(false);
      timeoutReveal = setTimeout(() => setShowDefenseRoll(true), 600);
    } else {
      setRollOverlayVisible(false);
      setShowDefenseRoll(false);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (timeoutReveal) clearTimeout(timeoutReveal);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollPhase.started, rollPhase.offense_roll, rollPhase.defense_roll, rollStatus.offense, rollStatus.defense]);

  if (loading) {
    return <div className="p-6 text-slate-200">Loading game…</div>;
  }
  if (error || !game) {
    return <div className="p-6 text-rose-200">{error ?? "Game not found."}</div>;
  }
  const isCoinTossChoice = game.phase === "coin_toss_choice";

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-emerald-400">Gridiron Trivia</p>
          <h1 className="text-3xl font-semibold text-slate-50">Game {game.code}</h1>
          <p className="text-sm text-slate-300">
            {game.home_team_name} vs {game.away_team_name} · {game.status} · Phase: {game.phase}
          </p>
          {playerInfo ? (
            <p className="text-xs text-slate-400">
              You are {playerInfo.display_name} ({playerInfo.role}
              {playerInfo.side ? ` · ${playerInfo.side}` : ""})
            </p>
          ) : (
            <p className="text-xs text-slate-400">No player identity loaded; defaulting to team view.</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView("team")}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
              view === "team" ? "bg-slate-800 text-slate-50" : "text-slate-300"
            }`}
          >
            Team view
          </button>
          <button
            onClick={() => setView("ref")}
            className={`rounded-lg px-3 py-2 text-sm font-semibold ${
              view === "ref" ? "bg-slate-800 text-slate-50" : "text-slate-300"
            }`}
          >
            Ref view
          </button>
        </div>
      </div>

      {view === "ref" ? (
        <div className="relative rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-slate-100">
                {game.home_team_name} {game.score_home} — {game.away_team_name} {game.score_away}
              </p>
              <p className="text-xs text-slate-300">
                Q{game.quarter} · {game.clock_seconds}s · {game.down}&amp;{game.distance} @ {game.yard_line}
              </p>
              <p className="text-xs text-slate-300">
                Possession: {game.possession_side ?? "TBD"} · Phase: {game.phase}
              </p>
            </div>
            <div className="flex gap-2">
              {game.phase === "lobby" ? (
                <button
                  onClick={handleStartCoinToss}
                  className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300"
                >
                  Start coin toss
                </button>
              ) : null}
              {playerInfo?.role === "ref" ? (
                <button
                  onClick={handleResetDrive}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-100 transition hover:bg-slate-800"
                >
                  Reset drive (ref)
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-[2fr,1fr]">
            <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 p-4">
              <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
                <span>Field</span>
                <span>Ball on {game.yard_line} | Down {game.down}&amp;{game.distance}</span>
              </div>
              <div className="relative h-64 rounded-lg bg-[linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(0deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[length:20px_100%,100%_20px]">
                <div
                  className="absolute left-0 top-0 h-full bg-emerald-500/20"
                  style={{ width: `${(game.yard_line / 100) * 100}%` }}
                />
                <div
                  className="absolute top-0 h-full w-[6px] -translate-x-1/2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.6)]"
                  style={{ left: `${(game.yard_line / 100) * 100}%` }}
                  title={`Ball on ${game.yard_line}`}
                />
              </div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Timeline</p>
              <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
                {events.length === 0 ? (
                  <p className="text-slate-300">No events yet.</p>
                ) : (
                  events
                    .slice()
                    .reverse()
                    .map((evt) => {
                      const hidePayload = evt.type === "answer_submitted";
                      return (
                        <div
                          key={evt.id}
                          className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
                        >
                          <span className="font-semibold text-slate-100">{evt.type}</span>
                          <span className="ml-1 text-slate-400">
                            {new Date(evt.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          {evt.payload && !hidePayload ? (
                            <div className="text-[11px] text-slate-400">
                              {Object.entries(evt.payload)
                                .slice(0, 4)
                                .map(([k, v]) => (
                                  <span key={k} className="mr-1">
                                    {k}:{String(v)}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })
                )}
              </div>
              {latestPlay ? (
                <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100">
                  <div className="flex justify-between text-[11px] uppercase tracking-[0.2em]">
                    <span>Last play</span>
                    <span>{latestPlay.result_text ?? ""}</span>
                  </div>
                  <div className="mt-1 grid gap-2 text-[11px] text-emerald-50 md:grid-cols-2">
                    <div>
                      Off: {latestPlay.call_offense ?? "-"} | Roll: {latestPlay.offense_roll ?? "-"} |{" "}
                      {latestPlay.offense_correct ? "Correct" : "Incorrect"}
                    </div>
                    <div>
                      Def: {latestPlay.call_defense ?? "-"} | Roll: {latestPlay.defense_roll ?? "-"} |{" "}
                      {latestPlay.defense_correct ? "Correct" : "Incorrect"}
                    </div>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-emerald-200">Yards: {latestPlay.yards ?? 0}</div>
                </div>
              ) : null}
              {game.phase === "kickoff" ? (
                <div className="mt-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
                  Kickoff pending. Press to resolve as touchback for now.
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={handleKickoffTouchback}
                      disabled={kickoffPending}
                      className="rounded-md bg-amber-400 px-3 py-1 font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-60"
                    >
                      {kickoffPending ? "Resolving..." : "Kickoff (touchback)"}
                    </button>
                    {kickoffStatus ? (
                      <span
                        className={`rounded-md px-2 py-1 ${
                          kickoffStatus.type === "success"
                            ? "bg-emerald-500/20 text-emerald-100"
                            : "bg-rose-500/20 text-rose-100"
                        }`}
                      >
                        {kickoffStatus.message}
                      </span>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {game.phase === "coin_toss" ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur">
              <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-amber-500/10">
                <p className="text-xs uppercase tracking-[0.3em] text-amber-300">Coin toss</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-50">
                  Away calls it. Winner chooses receive, kick, or defer.
                </h2>
                <div className="mt-4 grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Away call</p>
                    <div className="mt-2 flex gap-2">
                      {["heads", "tails"].map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setCoinCall(opt as "heads" | "tails")}
                          className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize transition ${
                            coinCall === opt ? "bg-amber-400 text-amber-950" : "bg-slate-800 text-slate-100"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">On win</p>
                    <div className="mt-2 flex gap-2">
                      {["receive", "kick", "defer"].map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setWinnerChoice(opt as "receive" | "kick" | "defer")}
                          className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize transition ${
                            winnerChoice === opt ? "bg-emerald-400 text-emerald-950" : "bg-slate-800 text-slate-100"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleFlipCoin}
                      disabled={coinPending}
                      className="mt-2 inline-flex items-center justify-center rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-60"
                    >
                      {coinPending ? "Flipping..." : "Flip coin"}
                    </button>
                    {isWinner && game.toss_result && isCoinTossChoice ? (
                      <button
                        onClick={handleResolveCoinToss}
                        disabled={coinPending}
                        className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-60"
                      >
                        Confirm choice
                      </button>
                    ) : null}
                  </div>
                  {game.toss_result ? (
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">
                      Coin: <span className="font-semibold">{game.toss_result}</span> · Winner:{" "}
                      <span className="font-semibold">{game.toss_winner_side}</span> · Choice:{" "}
                      <span className="font-semibold">{game.toss_choice ?? "pending"}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
          {rollOverlayVisible || rollPhase.started || game.play_subphase === "rolls" ? (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 backdrop-blur">
              <div className="w-full max-w-md rounded-2xl border border-amber-400/40 bg-slate-900/90 p-6 text-center shadow-2xl shadow-amber-500/20">
                <p className="text-xs uppercase tracking-[0.3em] text-amber-300">Dice rolls</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-50">Offense rolls first, then defense</h2>
                <div className="mt-4 grid grid-cols-2 gap-4 text-sm text-slate-100">
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Offense</p>
                    <p className="mt-2 text-3xl font-bold text-emerald-200">
                      {rollPhase.started
                        ? rollAnim.offense
                        : rollPhase.offense_roll ?? rollAnim.offense ?? "…"}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-blue-300">Defense</p>
                    <p className="mt-2 text-3xl font-bold text-blue-200">
                      {rollPhase.started
                        ? rollAnim.defense
                        : showDefenseRoll
                          ? rollPhase.defense_roll ?? rollAnim.defense ?? "…"
                          : "…"}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-slate-300">
                  Rolling… we&apos;ll show the final rolls and play result as soon as both are in.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="relative rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <p className="text-sm font-semibold text-slate-100">Team view</p>
          <p className="text-xs text-slate-300">
            Score {game.home_team_name} {game.score_home} — {game.away_team_name} {game.score_away} | Q{game.quarter} ·{" "}
            {game.clock_seconds}s · {game.down}&amp;{game.distance} @ {game.yard_line}
          </p>
          <div className="mt-2 rounded-lg border border-slate-800/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
            {game.phase === "coin_toss" ? (
              <span>
                Coin toss in progress. Away calls it.{" "}
                {isAway ? "Make the call and flip when ready." : "Awaiting away team to flip."}
              </span>
            ) : isCoinTossChoice ? (
              <span>
                Coin: {game.toss_result} · Winner: {game.toss_winner_side} · Choice:{" "}
                {game.toss_choice ?? "pending"}{" "}
                {isWinner && !game.toss_choice ? "Select receive/kick/defer to continue." : ""}
              </span>
            ) : game.phase === "kickoff" ? (
              <span>
                Kickoff pending (touchback for now). Kickoff team:{" "}
                {game.possession_side === "home" ? "away" : "home"} · Receiving: {game.possession_side}
              </span>
            ) : (
              <span>
                Possession: {game.possession_side} · Offense: {game.offense_side} · Defense: {game.defense_side} ·
                Phase: {game.phase} {game.play_subphase ? `> ${game.play_subphase}` : ""}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-100">Play call</span>
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                  {game.play_subphase === "play_call" ? "Awaiting calls" : "Locked"}
                </span>
              </div>
              {playStatus ? (
                <div
                  className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                    playStatus.type === "success"
                      ? "border-emerald-700 bg-emerald-500/10 text-emerald-100"
                      : "border-rose-700 bg-rose-500/10 text-rose-100"
                  }`}
                >
                  {playStatus.message}
                </div>
              ) : null}
              {isOffense && game.play_subphase === "play_call" ? (
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Play</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {offenseOptions.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setPlayCall(opt)}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                            playCall === opt ? "bg-emerald-500 text-emerald-950" : "bg-slate-800 text-slate-100"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Difficulty</p>
                    <div className="mt-2 flex gap-2">
                      {difficultyOptions.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setPlayDifficulty(opt)}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize transition ${
                            playDifficulty === opt ? "bg-amber-400 text-amber-950" : "bg-slate-800 text-slate-100"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={handleSubmitOffensePlay}
                    className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
                  >
                    Submit play
                  </button>
                </div>
              ) : null}
              {isDefense && game.play_subphase === "play_call" ? (
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Defense call</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {defenseOptions.map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setDefenseCall(opt)}
                          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                            defenseCall === opt ? "bg-blue-500 text-blue-950" : "bg-slate-800 text-slate-100"
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={handleSubmitDefensePlay}
                    className="mt-2 inline-flex items-center justify-center rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-blue-950 transition hover:bg-blue-400"
                  >
                    Submit defense
                  </button>
                </div>
              ) : null}
              {!isOffense && !isDefense ? (
                <p className="mt-3 text-xs text-slate-400">Waiting for teams to submit play calls.</p>
              ) : null}
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-100">Question</span>
                <span className="text-[11px] uppercase tracking-[0.2em] text-slate-400">
                  {game.play_subphase ? game.play_subphase : "Pending"} · Off:{" "}
                  {answerStatus.offense ? "✓" : "…"} · Def: {answerStatus.defense ? "✓" : "…"}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-300">
                (Placeholder) Answer correct or incorrect to resolve play. Timer off for now.
              </p>
              {game.play_subphase === "question" ? (
                <div className="mt-3 flex flex-col gap-3">
                  {(isOffense || isRef) && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Offense answer</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => handleAnswerQuestion(true)}
                          disabled={questionAnswerPending}
                          className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-60"
                        >
                          {questionAnswerPending ? "Submitting..." : "Mark correct"}
                        </button>
                        <button
                          onClick={() => handleAnswerQuestion(false)}
                          disabled={questionAnswerPending}
                          className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-rose-50 transition hover:bg-rose-400 disabled:opacity-60"
                        >
                          Incorrect / Timeout
                        </button>
                      </div>
                    </div>
                  )}

                  {(isDefense || isRef) && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.15em] text-slate-400">Defense answer</p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={async () => {
                            setDefenseAnswerPending(true);
                            await submitQuestionAnswerAction(game.id, playerInfo!.id, true, "defense");
                            setDefenseAnswerPending(false);
                            await refreshGameState(game.id);
                            await refreshLatestPlay(game.id);
                            await refreshAnswerStatus(game.id);
                          }}
                          disabled={defenseAnswerPending}
                          className="rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-blue-950 transition hover:bg-blue-400 disabled:opacity-60"
                        >
                          Mark defense correct
                        </button>
                        <button
                          onClick={async () => {
                            setDefenseAnswerPending(true);
                            await submitQuestionAnswerAction(game.id, playerInfo!.id, false, "defense");
                            setDefenseAnswerPending(false);
                            await refreshGameState(game.id);
                            await refreshLatestPlay(game.id);
                            await refreshAnswerStatus(game.id);
                          }}
                          disabled={defenseAnswerPending}
                          className="rounded-lg bg-slate-700 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-600 disabled:opacity-60"
                        >
                          Defense incorrect
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {game.play_subphase === "rolls" ? (
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-xs uppercase tracking-[0.15em] text-slate-400">
                    Roll phase — Offense rolls first, then defense
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-300">Offense</p>
                      <p className="text-xs text-slate-400">
                        {rollStatus.offense ? "Roll submitted" : "Swipe/press to roll"}
                      </p>
                      {(isOffense || isRef) && (
                        <button
                          onClick={handleSubmitRoll}
                          disabled={rollStatus.offense}
                          className="mt-2 w-full rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-60"
                        >
                          {rollStatus.offense ? "Rolled" : "Swipe to roll"}
                        </button>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-blue-300">Defense</p>
                      <p className="text-xs text-slate-400">
                        {rollStatus.defense ? "Roll submitted" : "Swipe/press to roll"}
                      </p>
                      {(isDefense || isRef) && (
                        <button
                          onClick={handleSubmitRoll}
                          disabled={rollStatus.defense}
                          className="mt-2 w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-blue-950 transition hover:bg-blue-400 disabled:opacity-60"
                        >
                          {rollStatus.defense ? "Rolled" : "Swipe to roll"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}

              {game.play_subphase === "rolls_done" ? (
                <div className="mt-3 flex flex-col gap-3">
                  <p className="text-xs uppercase tracking-[0.15em] text-slate-400">
                    Rolls complete. Both teams tap Continue to reveal result.
                  </p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-emerald-300">Offense</p>
                      <p className="text-xs text-slate-400">
                        Roll: {rollPhase.offense_roll ?? "-"} · {readyStatus.offense ? "Ready" : "Waiting"}
                      </p>
                      {(isOffense || isRef) && (
                        <button
                          onClick={handleContinueAfterRoll}
                          disabled={readyStatus.offense}
                          className="mt-2 w-full rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-60"
                        >
                          {readyStatus.offense ? "Ready" : "Continue"}
                        </button>
                      )}
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                      <p className="text-[11px] uppercase tracking-[0.2em] text-blue-300">Defense</p>
                      <p className="text-xs text-slate-400">
                        Roll: {rollPhase.defense_roll ?? "-"} · {readyStatus.defense ? "Ready" : "Waiting"}
                      </p>
                      {(isDefense || isRef) && (
                        <button
                          onClick={handleContinueAfterRoll}
                          disabled={readyStatus.defense}
                          className="mt-2 w-full rounded-lg bg-blue-500 px-3 py-2 text-sm font-semibold text-blue-950 transition hover:bg-blue-400 disabled:opacity-60"
                        >
                          {readyStatus.defense ? "Ready" : "Continue"}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-400">Result calculates when both sides continue.</p>
                </div>
              ) : null}

              {!["question", "rolls", "rolls_done"].includes(game.play_subphase ?? "") ? (
                <p className="mt-2 text-xs text-slate-400">
                  Waiting for offense/defense answers. (Subphase: {game.play_subphase ?? "n/a"})
                </p>
              ) : null}
            </div>
          </div>

          {["coin_toss", "coin_toss_choice"].includes(game.phase) ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur">
              <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-amber-500/10">
                <p className="text-xs uppercase tracking-[0.3em] text-amber-300">Coin toss</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-50">
                  Away calls it. Winner chooses receive, kick, or defer.
                </h2>
                <div className="mt-4 grid gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Away call</p>
                    <div className="mt-2 flex gap-2">
                      {["heads", "tails"].map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setCoinCall(opt as "heads" | "tails")}
                          disabled={!(isAway || isRef)}
                          className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize transition ${
                            coinCall === opt ? "bg-amber-400 text-amber-950" : "bg-slate-800 text-slate-100"
                          } ${!(isAway || isRef) ? "opacity-50" : ""}`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-400">On win</p>
                    <div className="mt-2 flex gap-2">
                      {["receive", "kick", "defer"].map((opt) => (
                        <button
                          key={opt}
                          onClick={() => setWinnerChoice(opt as "receive" | "kick" | "defer")}
                          disabled={!(isWinner || isRef)}
                          className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize transition ${
                            winnerChoice === opt ? "bg-emerald-400 text-emerald-950" : "bg-slate-800 text-slate-100"
                          } ${!(isWinner || isRef) ? "opacity-50" : ""}`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleFlipCoin}
                      disabled={coinPending || !(isAway || isRef)}
                      className="mt-2 inline-flex items-center justify-center rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-60"
                    >
                      {coinPending ? "Flipping..." : "Flip coin"}
                    </button>
                    {isWinner && game.toss_result && isCoinTossChoice ? (
                      <button
                        onClick={handleResolveCoinToss}
                        disabled={coinPending || !(isWinner || isRef)}
                        className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-60"
                      >
                        Confirm choice
                      </button>
                    ) : null}
                  </div>
                  {coinStatus ? (
                    <div
                      className={`rounded-lg border px-3 py-2 text-xs ${
                        coinStatus.type === "success"
                          ? "border-emerald-700 bg-emerald-500/10 text-emerald-100"
                          : "border-rose-700 bg-rose-500/10 text-rose-100"
                      }`}
                    >
                      {coinStatus.message}
                    </div>
                  ) : null}
                  {game.toss_result ? (
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-200">
                      Coin: <span className="font-semibold">{game.toss_result}</span> · Winner:{" "}
                      <span className="font-semibold">{game.toss_winner_side}</span> · Choice:{" "}
                      <span className="font-semibold">{game.toss_choice ?? "pending"}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ) : game.phase === "kickoff" && (isRef || isKickingTeam) ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur">
              <div className="w-full max-w-md rounded-2xl border border-amber-500/60 bg-slate-900 p-6 shadow-2xl shadow-amber-500/10">
                <p className="text-xs uppercase tracking-[0.3em] text-amber-300">Kickoff</p>
                <h2 className="mt-2 text-xl font-semibold text-slate-50">
                  Kickoff pending. Trigger touchback (stub) or wait for animation.
                </h2>
                <p className="mt-2 text-sm text-amber-100">
                  Kicking: {game.possession_side === "home" ? "away" : "home"} · Receiving: {game.possession_side}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    onClick={handleKickoffTouchback}
                    disabled={kickoffPending}
                    className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-60"
                  >
                    {kickoffPending ? "Resolving..." : "Kickoff (touchback)"}
                  </button>
                  {kickoffStatus ? (
                    <span
                      className={`rounded-md px-2 py-1 text-xs ${
                        kickoffStatus.type === "success"
                          ? "bg-emerald-500/20 text-emerald-100"
                          : "bg-rose-500/20 text-rose-100"
                      }`}
                    >
                      {kickoffStatus.message}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
