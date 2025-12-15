"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import type { GameState } from "@/app/actions/game";
import { getGameByCode } from "@/app/actions/game";
import {
  startTriviaRound,
  submitTriviaAnswer,
  lockAndScoreRound,
  importOpenTriviaBatch,
  startTriviaGame,
  chooseCategoryDifficulty,
  confirmReadyNext,
  resetTriviaGame,
  startNextPendingRound,
  closeTriviaGame,
} from "@/app/actions/trivia";

type TriviaQuestion = {
  id: string;
  text: string;
  choices: string[];
  correct_index: number;
  difficulty: string;
};

type Round = {
  id: string;
  seq: number;
  status: string;
  question_id: string;
  block?: number;
};

type LiveTriviaState = {
  game: GameState | null;
  round: Round | null;
  question: TriviaQuestion | null;
  counts: { totalPlayers: number; answersCount: number; readyCount: number; pendingCount: number };
  answersSummary: { player_id: string; display_name: string | null; correct: boolean | null; points: number | null }[];
};

const FALLBACK_CATEGORIES = [
  "General Knowledge",
  "History",
  "Geography",
  "Science & Nature",
  "Film",
  "Television",
  "Music",
  "Sports",
  "Computers",
  "Books",
];

export default function TriviaPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [game, setGame] = useState<GameState | null>(null);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [currentRound, setCurrentRound] = useState<Round | null>(null);
  const [question, setQuestion] = useState<TriviaQuestion | null>(null);
  const [answerChoice, setAnswerChoice] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importAmount, setImportAmount] = useState(20);
  const [importDifficulty, setImportDifficulty] = useState<"easy" | "medium" | "hard">("medium");
  const [categoryChoice, setCategoryChoice] = useState<string>("");
  const [difficultyChoice, setDifficultyChoice] = useState<"easy" | "medium" | "hard">("easy");
  const [scores, setScores] = useState<{ player_id: string; score: number; name: string; correct: number; incorrect: number }[]>([]);
  const [myStats, setMyStats] = useState<{ score: number; correct: number; incorrect: number; name?: string } | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [readyModalDismissed, setReadyModalDismissed] = useState(false);
  const [startModalDismissed, setStartModalDismissed] = useState(false);
  const [revealedSeen, setRevealedSeen] = useState<string | null>(null);
  const [gamePollTick, setGamePollTick] = useState(0);
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(null);
  const [readySubmittedRoundId, setReadySubmittedRoundId] = useState<string | null>(null);
  const [answersSummary, setAnswersSummary] = useState<
    { player_id: string; display_name: string | null; correct: boolean | null; points: number | null }[]
  >([]);
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const totalQuestions = 20;
  const currentSeq = currentRound?.seq ?? 0;
  const questionsLeft = currentRound ? Math.max(totalQuestions - currentSeq + (currentRound.status === "revealed" ? 0 : 1), 0) : totalQuestions;
  const [hasSubmittedAnswer, setHasSubmittedAnswer] = useState(false);
  const categoryPicker = showCategoryPicker ? (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500 mb-2">Choose category</p>
        {!isPicker ? <span className="text-[11px] text-slate-500">Waiting for picker...</span> : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {categories.length === 0 ? (
          <p className="text-xs text-slate-500">No categories loaded. Import questions first.</p>
        ) : (
          categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryChoice(cat)}
              disabled={!isPicker}
              className={`rounded-lg border px-3 py-2 text-sm font-semibold ${
                categoryChoice === cat
                  ? "border-emerald-400 bg-emerald-50 text-emerald-800"
                  : "border-slate-200 bg-white text-slate-800 hover:bg-slate-100"
              } ${!isPicker ? "opacity-60 cursor-not-allowed" : ""}`}
            >
              {cat}
            </button>
          ))
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={difficultyChoice}
          onChange={(e) => setDifficultyChoice(e.target.value as "easy" | "medium" | "hard")}
          disabled={!isPicker}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
        >
          <option value="easy">Easy</option>
          <option value="medium">Medium</option>
          <option value="hard">Hard</option>
        </select>
        <button
          onClick={handleSeedBlock}
          disabled={!isPicker}
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Set 20-question round
        </button>
      </div>
    </div>
  ) : null;

  const isHost = game?.host_player_id ? game.host_player_id === playerId : false;
  const isPicker = game?.picker_player_id && playerId ? game.picker_player_id === playerId : false;
  const showCategoryPicker = !currentRound || currentRound.status !== "live";

  // Temporary debugging to trace picker gate and category state
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log("picker debug", {
      isPicker,
      showCategoryPicker,
      playerId,
      pickerId: game?.picker_player_id,
      roundStatus: currentRound?.status,
      categories,
      categoryChoice,
    });
  }, [isPicker, playerId, game?.picker_player_id, currentRound?.status, categories, categoryChoice]);
  // Lightweight retry to pull fresh game state if picker isn't assigned yet
  useEffect(() => {
    if (game?.picker_player_id) return;
    const timer = setTimeout(async () => {
      const fresh = await getGameByCode(code);
      if (fresh) setGame(fresh);
    }, 1200);
    return () => clearTimeout(timer);
  }, [game?.picker_player_id, code]);

  const fetchLatestRound = async (gameId: string) => {
    try {
      const res = await fetch(`/api/trivia-state/${game?.code ?? code}`);
      if (res.status === 404) {
        setStatus("Game closed.");
        if (typeof window !== "undefined") localStorage.removeItem("gridiron-lobby");
        router.push("/");
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as LiveTriviaState;

      if (data.game) setGame(data.game as GameState);
      const round = data.round;
      const q = data.question;
      const noPending = (data.counts?.pendingCount ?? 0) === 0;
      const totalPlayers = data.counts?.totalPlayers ?? 0;
      const readyAll = totalPlayers > 0 && (data.counts?.readyCount ?? 0) >= totalPlayers;
      setAnswersSummary(data.answersSummary ?? []);

      const isWaitingForNextBlock =
        round?.status === "revealed" && noPending && (data.game?.status === "in_progress" || data.game?.status === "lobby_open") && readyAll;

      // If reset/lobby or waiting for next block selection, clear local round/question/answer state
      if (!round || data.game?.status === "lobby_open" || isWaitingForNextBlock) {
        setCurrentRound(null);
        setCurrentQuestionId(null);
        setQuestion(null);
        setAnswerChoice(null);
        setReadyModalDismissed(true);
        setStartModalDismissed(false);
        setRevealedSeen(null);
        setReadySubmittedRoundId(null);
        setStatus(
          data.game?.status === "lobby_open"
            ? "Waiting for a category to be selected."
            : isPicker
            ? "Select the next category to begin the new block."
            : "Waiting for picker to choose the next category.",
        );
        return;
      }

      if (round) {
        setCurrentRound(round);
        setCurrentQuestionId(round.question_id);
        setQuestion(q);

        if (round.status === "revealed") {
          setReadyModalDismissed(false);
          setRevealedSeen(round.id);
          setStartModalDismissed(true);
        } else if (round.status === "pending") {
          setStartModalDismissed(false);
          setReadyModalDismissed(true);
          setRevealedSeen(null);
          setReadySubmittedRoundId(null);
        } else if (round.status === "live") {
          setReadyModalDismissed(true);
          setStartModalDismissed(true);
          setReadySubmittedRoundId(null);
        }
      }
    } catch (e) {
      console.error("fetchLatestRound error", e);
    }
  };

  // Clear selected answer only when the question actually changes
  useEffect(() => {
    setAnswerChoice(null);
  }, [currentQuestionId]);

  const loadQuestion = async (questionId: string) => {
    const { data } = await supabase
      .from("questions")
      .select("id, text, choices, correct_index, difficulty")
      .eq("id", questionId)
      .single();
    if (data) setQuestion(data as TriviaQuestion);
  };

  useEffect(() => {
    const load = async () => {
      const g = await getGameByCode(code);
      if (!g) return;
      setGame(g);
      const stored = typeof window !== "undefined" ? localStorage.getItem("gridiron-lobby") : null;
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { gameId: string; playerId: string };
          if (parsed.gameId === g.id) setPlayerId(parsed.playerId);
        } catch {
          // ignore
        }
      }
      fetchLatestRound(g.id);
    };
    load();
  }, [code]);

  useEffect(() => {
    if (!game?.id) return;
    const gameChannel = supabase
      .channel(`trivia-game-${game.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "games", filter: `id=eq.${game.id}` },
        async (payload) => {
          if (payload.eventType === "DELETE") {
            setStatus("Game closed by host.");
            if (typeof window !== "undefined") {
              localStorage.removeItem("gridiron-lobby");
            }
            setGame(null);
            setCurrentRound(null);
            setQuestion(null);
            setAnswersSummary([]);
            setHasSubmittedAnswer(false);
            router.push("/");
            return;
          }
          setGame(payload.new as GameState);
          await fetchLatestRound((payload.new as any).id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rounds", filter: `game_id=eq.${game.id}` },
        async (payload) => {
          const next = payload.new as { status?: string };
          if (next?.status === "revealed" && payload.new?.id && payload.new.id !== revealedSeen) {
            setReadyModalDismissed(false);
            setRevealedSeen(payload.new.id as string);
          }
          if (next?.status === "pending") {
            setStartModalDismissed(false);
            setRevealedSeen(null);
          }
          await fetchLatestRound(game.id);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "answers", filter: `game_id=eq.${game.id}` },
        async () => {
          await fetchLatestRound(game.id);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(gameChannel);
    };
  }, [game?.id, revealedSeen]);

  // Players realtime subscription for live leaderboard updates (host only)
  useEffect(() => {
    if (!game?.id || !isHost) return;
    const fetchPlayers = () => {
      supabase
        .from("players")
        .select("id, score, display_name, role, correct_count, incorrect_count")
        .eq("game_id", game.id)
        .not("role", "in", "(ref,host)")
        .then(({ data }) => {
          if (data) {
            setScores(
              data.map((p, idx) => ({
                player_id: p.id,
                score: p.score ?? 0,
                name: p.display_name?.trim() || `Player ${idx + 1}`,
                correct: (p as any).correct_count ?? 0,
                incorrect: (p as any).incorrect_count ?? 0,
              })),
            );
          }
        });
    };

    fetchPlayers();

    const playerChannel = supabase
      .channel(`trivia-players-${game.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `game_id=eq.${game.id}` },
        () => {
          fetchPlayers();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(playerChannel);
    };
  }, [game?.id, isHost]);

  // Personal stats for non-hosts
  useEffect(() => {
    if (!game?.id || !playerId || isHost) return;
    supabase
      .from("players")
      .select("score, correct_count, incorrect_count, display_name")
      .eq("game_id", game.id)
      .eq("id", playerId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setMyStats({
            score: data.score ?? 0,
            correct: (data as any).correct_count ?? 0,
            incorrect: (data as any).incorrect_count ?? 0,
            name: (data as any).display_name ?? undefined,
          });
        }
      });

    const personalChannel = supabase
      .channel(`trivia-player-${playerId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "players", filter: `id=eq.${playerId}` },
        ({ new: row }) => {
          if (row) {
            setMyStats({
              score: (row as any).score ?? 0,
              correct: (row as any).correct_count ?? 0,
              incorrect: (row as any).incorrect_count ?? 0,
              name: (row as any).display_name ?? undefined,
            });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(personalChannel);
    };
  }, [game?.id, playerId, isHost]);

  // Reset ready modal visibility whenever the round changes
  useEffect(() => {
    if (!currentRound || currentRound.status === "pending") {
      setStartModalDismissed(false);
      setReadyModalDismissed(true);
    }
  }, [currentRound]);

  // Fallback polling to catch pending rounds if realtime misses
  useEffect(() => {
    if (!game?.id) return;
    const interval = setInterval(() => {
      fetchLatestRound(game.id);
    }, 3000);
    return () => clearInterval(interval);
  }, [game?.id]);

  // Lightweight existence check to catch deleted/closed games
  useEffect(() => {
    const interval = setInterval(async () => {
      const g = await getGameByCode(code);
      if (!g) {
        setStatus("Game closed.");
        if (typeof window !== "undefined") localStorage.removeItem("gridiron-lobby");
        router.push("/");
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [code, router]);

  // Load distinct categories from questions
  useEffect(() => {
    supabase
      .from("questions")
      .select("category")
      .not("category", "is", null)
      .neq("category", "")
      .order("category", { ascending: true })
      .then(({ data }) => {
        const unique = data ? Array.from(new Set(data.map((d) => d.category as string))).filter(Boolean) : [];
        const list = unique.length > 0 ? unique : FALLBACK_CATEGORIES;
        setCategories(list);
        setCategoryChoice((prev) => prev || list[0]);
      });
  }, []);

  const handleStartRound = async () => {
    if (!game?.id || !playerId || !question) return;
    setStatus(null);
    const seq = (currentRound?.seq ?? 0) + 1;
    const res = await startTriviaRound(game.id, playerId, question.id, seq);
    if (!res.success) setStatus(res.error);
    else {
      setStatus("Round started");
      setCurrentRound({ id: question.id, seq, status: "live", question_id: question.id });
    }
  };

  const handleAnswer = async () => {
    if (!currentRound || !game?.id || !playerId) {
      setStatus("Join the lobby to answer.");
      return;
    }
    if (currentRound.status !== "live") {
      setStatus("Waiting for the question to go live.");
      return;
    }
    if (answerChoice === null) {
      setStatus("Pick an answer first.");
      return;
    }
    const res = await submitTriviaAnswer(currentRound.id, game.id, playerId, answerChoice);
    if (!res.success) setStatus(res.error);
    else {
      setStatus("Answer submitted");
      setHasSubmittedAnswer(true);
      await fetchLatestRound(game.id);
    }
  };

  const handleReadyNext = async () => {
    if (!game?.id || !playerId || !currentRound) {
      setStatus("Join the lobby to continue.");
      return;
    }
    if (isHost) {
      setStatus("Host does not need to confirm ready.");
      return;
    }
    const res = await confirmReadyNext(game.id, playerId, currentRound.id);
    if (!res.success) {
      setStatus(res.error);
    } else {
      setStatus("Ready for next question");
      setReadySubmittedRoundId(currentRound.id);
      setHasSubmittedAnswer(false);
      await fetchLatestRound(game.id);
    }
  };

  const handleReveal = async () => {
    if (!currentRound || !game?.id) return;
    const res = await lockAndScoreRound(currentRound.id, game.id);
    if (!res.success) setStatus(res.error);
    else setStatus("Revealed");
  };

  const handleImport = async () => {
    setImportStatus(null);
    setImportLoading(true);
    const res = await importOpenTriviaBatch(importAmount, importDifficulty);
    setImportLoading(false);
    if (!res.success) setImportStatus(res.error);
    else setImportStatus(res.message ?? "Imported questions.");
  };

  const handleStartGame = async () => {
    if (!game?.id) return;
    const res = await startTriviaGame(game.id);
    if (!res.success) setStatus(res.error);
    else {
      setStatus("Game started. Picker assigned.");
      if (res.game) {
        setGame((prev) => (prev ? { ...prev, ...res.game } : prev));
      }
      await fetchLatestRound(game.id);
    }
  };

  const handleSeedBlock = async () => {
    if (!game?.id || !playerId) return;
    const res = await chooseCategoryDifficulty(game.id, playerId, categoryChoice, difficultyChoice);
    if (!res.success) setStatus(res.error);
    else {
      setStatus(res.message ?? "Block seeded.");
      setStartModalDismissed(false);
      await fetchLatestRound(game.id);
    }
  };

  const handleResetGame = async () => {
    if (!game?.id) return;
    const res = await resetTriviaGame(game.id);
    if (!res.success) setStatus(res.error);
    else {
      setStatus(res.message ?? "Game reset.");
      await fetchLatestRound(game.id);
    }
  };

  const handleCloseGame = async () => {
    if (!game?.id || !playerId) return;
    const res = await closeTriviaGame(game.id, playerId);
    if (!res.success) {
      setStatus(res.error);
      return;
    }
    setStatus("Game closed. Returning to lobby.");
    if (typeof window !== "undefined") {
      localStorage.removeItem("gridiron-lobby");
    }
    router.push("/");
  };

  const handleStartPending = async () => {
    if (!game?.id) return;
    const res = await startNextPendingRound(game.id);
    if (!res.success) setStatus(res.error);
    else {
      setStatus("Question live.");
      await fetchLatestRound(game.id);
    }
  };

  const handleLeaveGame = () => setShowLeaveModal(true);

  const confirmLeaveGame = async () => {
    if (!playerId) return;
    setStatus(null);
    const { error } = await supabase.from("players").delete().eq("id", playerId);
    if (error) {
      setStatus(error.message);
      return;
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("gridiron-lobby");
    }
    setStatus("You left the game.");
    setShowLeaveModal(false);
    router.push("/");
  };

  const questionBlock = question ? (
    <div className={`rounded-lg border border-slate-200 bg-slate-50 ${isHost ? "p-6" : "p-4"} shadow-sm`}>
      <p className={`${isHost ? "text-lg" : "text-sm"} uppercase tracking-[0.2em] text-slate-500`}>Question</p>
      <h2 className={`mt-2 ${isHost ? "text-3xl" : "text-2xl"} font-semibold leading-snug text-slate-900`}>{question.text}</h2>
      <div className="mt-4 grid gap-3">
        {question.choices.map((c, idx) => (
          <button
            key={idx}
            onClick={() => setAnswerChoice(idx)}
            className={`rounded-lg text-left font-semibold ${
              isHost ? "px-5 py-3 text-lg" : "px-4 py-3 text-base"
            } ${
              answerChoice === idx ? "bg-emerald-500 text-white" : "bg-white text-slate-900 border border-slate-200"
            }`}
            disabled={currentRound?.status === "revealed"}
          >
            {c}
          </button>
        ))}
      </div>
      {currentRound?.status === "revealed" && readyModalDismissed ? (
        <div className={`mt-3 rounded-lg bg-emerald-50 px-3 py-2 ${isHost ? "text-lg" : "text-base"} text-emerald-800`}>
          Correct answer: <span className="font-semibold">{question.choices[question.correct_index]}</span>. Tap ready to continue.
          <div className="mt-2 flex gap-2">
            <button
              onClick={handleReadyNext}
              className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-white"
              disabled={readySubmittedRoundId === currentRound?.id}
            >
              {readySubmittedRoundId === currentRound?.id ? "Ready submitted..." : "Ready for next question"}
            </button>
            <span className="text-xs text-slate-600">All players must tap ready to advance.</span>
            {readySubmittedRoundId === currentRound?.id ? (
              <span className="text-xs font-semibold text-slate-600">Ready recorded. Waiting for other players…</span>
            ) : null}
          </div>
        </div>
      ) : !isHost ? (
        <div className="mt-3 flex gap-2">
          <button
            onClick={handleAnswer}
            className={`rounded-lg px-3 py-2 text-sm font-semibold text-white ${
              hasSubmittedAnswer ? "bg-slate-400 cursor-not-allowed" : "bg-emerald-500 hover:bg-emerald-400"
            }`}
            disabled={!currentRound || currentRound.status !== "live" || hasSubmittedAnswer}
          >
            {hasSubmittedAnswer ? "Answer submitted..." : "Submit answer"}
          </button>
          {currentRound && currentRound.status !== "live" ? (
            <span className="self-center text-xs text-slate-600">Waiting for this question to go live.</span>
          ) : hasSubmittedAnswer ? (
            <span className="self-center text-xs text-slate-600">Waiting for other players to answer…</span>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : (
    <p className="text-slate-600">Load or seed a question to begin.</p>
  );

  return (
    <div className="trivia-light mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 bg-gradient-to-b from-white via-[#f5f8ff] to-[#eef5ff] px-10 py-8 text-slate-900">
      <div className={`flex ${isHost ? "items-center justify-between" : "items-center justify-center"} gap-3`}>
        <h1 className="text-3xl font-semibold text-slate-900">
          {isHost ? `Trivia Game ${game?.code}` : myStats?.name ? myStats.name : "Trivia"}
        </h1>
        {isHost ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleStartGame}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
            >
              Start trivia game
            </button>
            <button
              onClick={handleResetGame}
              className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
            >
              Reset game
            </button>
            <button
              onClick={handleCloseGame}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
            >
              Close game
            </button>
          </div>
        ) : playerId ? (
          <button
            onClick={handleLeaveGame}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-100"
          >
            Leave game
          </button>
        ) : null}
      </div>
      {isHost ? (
        <div className="grid gap-5 items-start md:[grid-template-columns:2fr_1fr]">
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
              <div className="w-full rounded-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-blue-600 px-6 py-5 text-white shadow-lg">
                <p className="text-4xl font-black leading-tight">Question {currentSeq || 1}</p>
                <p className="text-lg font-semibold leading-tight opacity-95">{questionsLeft} left</p>
              </div>
              {status ? <p className="mt-2 text-sm text-amber-700">{status}</p> : null}
            </div>
            {categoryPicker}
            {questionBlock}
          </div>
          <div className="lg:sticky lg:top-6">
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm uppercase tracking-[0.2em] text-slate-500 mb-3">Leaderboard</p>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-base text-slate-800">
                  <thead>
                    <tr className="text-sm uppercase tracking-[0.1em] text-slate-500">
                      <th className="px-4 py-3">Pos</th>
                      <th className="px-4 py-3">Player</th>
                      <th className="px-4 py-3 text-right">Correct</th>
                      <th className="px-4 py-3 text-right">Incorrect</th>
                      <th className="px-4 py-3 text-right">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...scores]
                      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
                      .map((s, idx) => (
                        <tr key={s.player_id} className="border-t border-slate-100">
                          <td className="px-4 py-3 text-lg font-black text-slate-800">{idx + 1}</td>
                          <td className="px-4 py-3 text-lg font-semibold truncate">{s.name}</td>
                          <td className="px-4 py-3 text-right text-emerald-700 font-semibold text-lg">✅ {s.correct}</td>
                          <td className="px-4 py-3 text-right text-rose-700 font-semibold text-lg">❌ {s.incorrect}</td>
                          <td className="px-4 py-3 text-right text-lg font-black">{s.score} pts</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ) : myStats ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-sm">
          <div className="flex items-center justify-between text-sm text-slate-800">
            <div className="rounded-full bg-gradient-to-r from-emerald-500 to-blue-500 px-4 py-2 text-white shadow-md">
              <p className="text-sm font-bold">
                Question {currentSeq || 1} / {totalQuestions}
              </p>
              <p className="text-[11px] font-semibold opacity-90">{questionsLeft} left</p>
            </div>
            {status ? <span className="text-xs text-amber-700">{status}</span> : null}
          </div>
          <div className="mt-2 flex items-center justify-between text-sm text-slate-800">
            <div>
              <div className="font-semibold text-lg">{myStats.score} pts</div>
              <div className="text-xs text-slate-600">
                ✅ {myStats.correct} · ❌ {myStats.incorrect}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!isHost ? categoryPicker : null}

      {!isHost ? questionBlock : null}

      {currentRound?.status === "pending" && !startModalDismissed ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Ready to start</p>
            <h3 className="mt-2 text-2xl font-bold text-slate-900">Next question is queued.</h3>
            <p className="mt-1 text-sm text-slate-600">
              Waiting for the host/picker to start the question so everyone is in sync.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {isHost || isPicker ? (
                <button
                  onClick={handleStartPending}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500"
                >
                  Start question
                </button>
              ) : (
                <span className="rounded-md bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                  Waiting for host/picker to start
                </span>
              )}
              <button
                onClick={() => setStartModalDismissed(true)}
                className="text-sm font-semibold text-slate-500 underline underline-offset-4"
              >
                Hide
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {currentRound?.status === "revealed" && question && !readyModalDismissed ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Answer revealed</p>
            <h3 className="mt-2 text-2xl font-bold text-slate-900">Correct: {question.choices[question.correct_index]}</h3>
            <p className="mt-1 text-sm text-slate-600">
              Waiting for players to acknowledge before the next question goes live.
            </p>
            {isHost && answersSummary && answersSummary.length > 0 ? (
              <div className="mt-3 rounded-lg bg-slate-50 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500 mb-2">Who got it right</p>
                <div className="space-y-1 text-sm">
                  {answersSummary.map((a) => (
                    <div
                      key={a.player_id}
                      className={`flex items-center justify-between rounded-md px-2 py-1 ${
                        a.correct ? "text-emerald-700" : "text-rose-700"
                      }`}
                    >
                      <span className="truncate">{a.display_name || a.player_id}</span>
                      <span className="text-xs font-semibold">
                        {a.correct ? "Correct" : "Incorrect"} {typeof a.points === "number" ? `· ${a.points} pts` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {!isHost ? (
                <button
                  onClick={handleReadyNext}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-400"
                  disabled={readySubmittedRoundId === currentRound?.id}
                >
                  {readySubmittedRoundId === currentRound?.id ? "Ready submitted..." : "Ready for next question"}
                </button>
              ) : (
                <span className="rounded-md bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">Host view</span>
              )}
              {readySubmittedRoundId === currentRound?.id ? (
                <span className="text-sm font-semibold text-slate-600">Ready recorded. Waiting for other players…</span>
              ) : null}
              <button
                onClick={() => setReadyModalDismissed(true)}
                className="text-sm font-semibold text-slate-500 underline underline-offset-4"
              >
                Hide
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showLeaveModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-xs uppercase tracking-[0.25em] text-slate-500">Leave game</p>
            <h3 className="mt-2 text-xl font-bold text-slate-900">Are you sure you want to leave?</h3>
            <p className="mt-1 text-sm text-slate-600">You’ll be removed from this game and taken back to the lobby join screen.</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                onClick={confirmLeaveGame}
                className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-400"
              >
                Leave game
              </button>
              <button
                onClick={() => setShowLeaveModal(false)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx global>{`
        .trivia-light {
          background-color: #ffffff;
          color: #0f172a;
        }
        .trivia-light * {
          color-scheme: light;
        }
      `}</style>
    </div>
  );
}
