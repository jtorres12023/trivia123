"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { supabase } from "@/lib/supabaseClient";

import {
  createLobbyAction,
  joinLobbyAction,
  leaveLobbyAction,
  startGameAction,
  setReadyAction,
  kickPlayerAction,
  setLobbyLockedAction,
  updatePlayerSideAction,
  updateTeamNamesAction,
} from "./actions/lobby";

type Status = { type: "success" | "error"; message: string };
type Player = {
  id: string;
  display_name: string;
  role: string;
  ready: boolean;
  side: "home" | "away" | null;
  created_at?: string;
};
type LobbyGame = {
  id: string;
  code: string;
  status: string;
  home_team_name: string;
  away_team_name: string;
};

export default function Home() {
  const router = useRouter();
  const [createName, setCreateName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [activeLobby, setActiveLobby] = useState<{ gameId: string; code: string; playerId: string } | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [rosterStatus, setRosterStatus] = useState<"idle" | "loading" | "error">("idle");
  const [status, setStatus] = useState<Status | null>(null);
  const [isPending, startTransition] = useTransition();
  const [gameMeta, setGameMeta] = useState<LobbyGame | null>(null);
  const [homeName, setHomeName] = useState("Home");
  const [awayName, setAwayName] = useState("Away");
  const STORAGE_KEY = "gridiron-lobby";
  const [lockPending, setLockPending] = useState(false);

  // Restore lobby from localStorage if present.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as { gameId: string; playerId: string };
      if (parsed?.gameId && parsed?.playerId) {
        // Verify player still exists.
        supabase
          .from("players")
          .select("id, game_id")
          .eq("id", parsed.playerId)
          .eq("game_id", parsed.gameId)
          .single()
          .then(({ data, error }) => {
            if (error || !data) {
              localStorage.removeItem(STORAGE_KEY);
              return;
            }
            setActiveLobby({ gameId: parsed.gameId, code: "", playerId: parsed.playerId });
          });
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Persist lobby to localStorage.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (activeLobby?.gameId && activeLobby?.playerId) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ gameId: activeLobby.gameId, playerId: activeLobby.playerId }),
      );
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [activeLobby?.gameId, activeLobby?.playerId]);

  // Load roster and subscribe to realtime updates for the active lobby.
  useEffect(() => {
    if (!activeLobby?.gameId) return undefined;

    let isMounted = true;

    const loadPlayers = async () => {
      setRosterStatus("loading");

      const { data, error } = await supabase
        .from("players")
        .select("id, display_name, role, ready, side, created_at")
        .eq("game_id", activeLobby.gameId)
        .order("created_at", { ascending: true });

      if (!isMounted) return;

      if (error || !data) {
        setRosterStatus("error");
        return;
      }

      setPlayers(data);
      setRosterStatus("idle");
    };

    loadPlayers();

    const channel = supabase
      .channel(`players-${activeLobby.gameId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players", filter: `game_id=eq.${activeLobby.gameId}` },
        (payload) => {
          setPlayers((prev) => {
            if (payload.eventType === "INSERT") {
              return [...prev, payload.new as Player];
            }

            if (payload.eventType === "UPDATE") {
              return prev.map((player) => (player.id === payload.new.id ? (payload.new as Player) : player));
            }

            if (payload.eventType === "DELETE") {
              return prev.filter((player) => player.id !== payload.old.id);
            }

            return prev;
          });
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [activeLobby?.gameId]);

  // Load game metadata (team names, status) and keep it updated.
  useEffect(() => {
    if (!activeLobby?.gameId) return undefined;

    let isMounted = true;

    const loadGame = async () => {
      const { data, error } = await supabase
        .from("games")
        .select("id, code, status, home_team_name, away_team_name, lobby_locked")
        .eq("id", activeLobby.gameId)
        .single();

      if (!isMounted) return;
      if (error || !data) return;
      setGameMeta(data);
      setHomeName(data.home_team_name || "Home");
      setAwayName(data.away_team_name || "Away");
    };

    loadGame();

    const channel = supabase
      .channel(`games-${activeLobby.gameId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "games", filter: `id=eq.${activeLobby.gameId}` },
        (payload) => {
          const newGame = payload.new as LobbyGame;
          setGameMeta(newGame);
          setHomeName(newGame.home_team_name || "Home");
          setAwayName(newGame.away_team_name || "Away");
          if (!["lobby_open", "in_progress"].includes(newGame.status)) {
            localStorage.removeItem(STORAGE_KEY);
            setActiveLobby(null);
          }
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [activeLobby?.gameId]);

  const handleCreate = (event: React.FormEvent) => {
    event.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const result = await createLobbyAction(createName);
      if (result.success) {
        setActiveLobby({ gameId: result.gameId, code: result.code, playerId: result.playerId });
        setStatus({
          type: "success",
          message: `Lobby created. Code: ${result.code}`,
        });
      } else {
        setStatus({ type: "error", message: result.error });
      }
    });
  };

  const handleJoin = (event: React.FormEvent) => {
    event.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const result = await joinLobbyAction(joinName, joinCode);
      if (result.success) {
        setActiveLobby({ gameId: result.gameId, code: result.code, playerId: result.playerId });
        setStatus({
          type: "success",
          message: `Joined lobby ${result.code}`,
        });
      } else {
        setStatus({ type: "error", message: result.error });
      }
    });
  };

  const myPlayer = players.find((p) => p.id === activeLobby?.playerId);
  const isRef = myPlayer?.role === "ref";

  const handleSideChange = async (playerId: string, side: "home" | "away" | null) => {
    if (!activeLobby?.gameId || !myPlayer) return;
    // Optimistic update
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, side, ready: false } : p)));
    await updatePlayerSideAction(playerId, activeLobby.gameId, myPlayer.id, side);
  };

  const handleTeamNamesSave = async () => {
    if (!activeLobby?.gameId || !myPlayer) return;
    await updateTeamNamesAction(
      activeLobby.gameId,
      myPlayer.id,
      homeName.trim() || "Home",
      awayName.trim() || "Away",
    );
    setStatus({ type: "success", message: "Team names updated." });
  };

  const handleStartGame = async () => {
    if (!activeLobby?.gameId || !myPlayer) return;
    const result = await startGameAction(activeLobby.gameId, myPlayer.id);
    if (result.success) {
      setStatus({ type: "success", message: "Game started!" });
      const code = activeLobby.code || gameMeta?.code;
      if (code) {
        router.push(`/game/${code}`);
      }
    } else {
      setStatus({ type: "error", message: result.error });
    }
  };

  const toggleReady = async () => {
    if (!activeLobby?.gameId || !myPlayer) return;
    const nextReady = !myPlayer.ready;
    setPlayers((prev) => prev.map((p) => (p.id === myPlayer.id ? { ...p, ready: nextReady } : p)));
    const result = await setReadyAction(myPlayer.id, activeLobby.gameId, nextReady);
    if (!result.success) {
      setStatus({ type: "error", message: result.error });
    }
  };

  const handleLeave = async () => {
    if (!activeLobby?.gameId || !myPlayer) return;
    await leaveLobbyAction(myPlayer.id, activeLobby.gameId);
    setActiveLobby(null);
    setPlayers([]);
    setGameMeta(null);
    setStatus(null);
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const handleKick = async (playerId: string) => {
    if (!activeLobby?.gameId || !myPlayer || playerId === myPlayer.id) return;
    await kickPlayerAction(myPlayer.id, playerId, activeLobby.gameId);
  };

  const toggleLobbyLock = async () => {
    if (!activeLobby?.gameId || !myPlayer || !gameMeta) return;
    setLockPending(true);
    const next = !gameMeta.lobby_locked;
    await setLobbyLockedAction(myPlayer.id, activeLobby.gameId, next);
    setLockPending(false);
  };

  const participants = players.filter((p) => p.side === "home" || p.side === "away");
  const rosterPlayers = players.filter((p) => p.role !== "ref");
  const homePlayers = participants.filter((p) => p.side === "home");
  const awayPlayers = participants.filter((p) => p.side === "away");
  const allReady = participants.length > 0 && participants.every((p) => p.ready);
  const canStart = gameMeta?.status === "lobby_open" && homePlayers.length > 0 && awayPlayers.length > 0 && allReady;

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-br from-slate-900 via-slate-950 to-black px-6 py-12 text-slate-50">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 rounded-3xl border border-slate-800/60 bg-slate-900/70 p-10 shadow-2xl shadow-slate-950/40 backdrop-blur">
        <div>
          <p className="text-sm uppercase tracking-[0.3em] text-emerald-400">
            Gridiron Trivia
          </p>
          <h1 className="mt-2 text-3xl font-semibold leading-tight text-slate-50">
            Start or join a lobby
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-slate-300/80">
            Create a lobby to host a game or join an existing one with a code.
            We&apos;ll hook this up to the main field view next.
          </p>
        </div>

        {activeLobby ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-700/50 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-100">
            <span>
              In lobby <span className="font-semibold">{activeLobby.code || gameMeta?.code}</span>. Share this code with
              teammates.
            </span>
            {myPlayer && myPlayer.role !== "ref" ? (
              <button
                onClick={toggleReady}
                className={`rounded-lg border px-3 py-1 text-xs font-semibold transition ${
                  myPlayer.ready
                    ? "border-emerald-400 bg-emerald-500/20 text-emerald-50 hover:bg-emerald-500/30"
                    : "border-slate-500 text-slate-100 hover:bg-slate-800/70"
                }`}
              >
                {myPlayer.ready ? "Ready" : "Set ready"}
              </button>
            ) : null}
            <button
              onClick={handleLeave}
              className="rounded-lg border border-emerald-500/60 px-3 py-1 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-500/10"
            >
              Leave lobby
            </button>
            {gameMeta?.status === "in_progress" && (activeLobby.code || gameMeta.code) ? (
              <button
                onClick={() => router.push(`/game/${activeLobby.code || gameMeta.code}`)}
                className="rounded-lg border border-amber-400/70 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-200 transition hover:bg-amber-400/20"
              >
                Go to game view
              </button>
            ) : null}
          </div>
        ) : null}

        {activeLobby && gameMeta && isRef ? (
          <div className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6 md:grid-cols-2">
            <div>
              <div className="text-sm font-semibold text-slate-100">Team names</div>
              <div className="mt-3 flex flex-col gap-3">
                <label className="text-xs uppercase tracking-[0.15em] text-slate-400">
                  Home
                  <input
                    className="mt-2 w-full rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-base text-slate-50 outline-none ring-emerald-500/30 transition focus:border-emerald-400/80 focus:ring"
                    value={homeName}
                    onChange={(e) => setHomeName(e.target.value)}
                  />
                </label>
                <label className="text-xs uppercase tracking-[0.15em] text-slate-400">
                  Away
                  <input
                    className="mt-2 w-full rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-base text-slate-50 outline-none ring-emerald-500/30 transition focus:border-emerald-400/80 focus:ring"
                    value={awayName}
                    onChange={(e) => setAwayName(e.target.value)}
                  />
                </label>
              </div>
              <button
                onClick={handleTeamNamesSave}
                className="mt-3 inline-flex items-center justify-center rounded-lg bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400"
              >
                Save team names
              </button>
            </div>
            <div className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800/70 bg-slate-950/60 p-4">
              <div>
                <div className="text-sm font-semibold text-slate-100">Game status</div>
                <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">
                {gameMeta.status === "lobby_open" ? "Lobby open" : gameMeta.status}
              </p>
              <p className="mt-2 text-xs text-slate-300">
                Home: {homePlayers.length} · Away: {awayPlayers.length}
              </p>
              <p className="text-xs text-slate-300">
                Ready: {participants.filter((p) => p.ready).length}/{participants.length}
              </p>
              </div>
              <button
                onClick={toggleLobbyLock}
                disabled={lockPending}
                className="inline-flex items-center justify-center rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-100 transition hover:bg-slate-800 disabled:opacity-50"
              >
                {gameMeta.lobby_locked ? "Unlock lobby" : "Lock lobby"}
              </button>
              <button
                onClick={handleStartGame}
                disabled={!canStart}
                className="inline-flex items-center justify-center rounded-lg bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Start game
              </button>
            </div>
          </div>
        ) : null}

        {status ? (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              status.type === "success"
                ? "border-emerald-700 bg-emerald-500/10 text-emerald-100"
                : "border-rose-700 bg-rose-500/10 text-rose-100"
            }`}
          >
            {status.message}
            {gameMeta?.status === "in_progress" && (activeLobby?.code || gameMeta?.code) ? (
              <button
                onClick={() => router.push(`/game/${activeLobby?.code || gameMeta?.code}`)}
                className="ml-3 inline-flex items-center rounded-md border border-emerald-500/70 px-3 py-1 text-xs font-semibold text-emerald-50 transition hover:bg-emerald-500/10"
              >
                Open game view
              </button>
            ) : null}
          </div>
        ) : null}

        {activeLobby ? (
          <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs text-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-100">Ready check</span>
              <span>
                Home: {homePlayers.length} | Away: {awayPlayers.length} | Ready:{" "}
                {players.filter((p) => p.ready).length}/{players.length}
              </span>
              {!canStart ? (
                <span className="text-amber-300">
                  Need {homePlayers.length === 0 ? "home player " : ""}{awayPlayers.length === 0 ? "away player " : ""}
                  {!allReady ? "all players ready" : ""}
                </span>
              ) : (
                <span className="text-emerald-300">All set</span>
              )}
            </div>
          </div>
        ) : null}

        <div className="grid gap-6 md:grid-cols-2">
          <form
            onSubmit={handleCreate}
            className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.6)]" />
              Host a lobby
            </div>
            <label className="text-sm text-slate-300">
              Display name
              <input
                className="mt-2 w-full rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-base text-slate-50 outline-none ring-emerald-500/30 transition focus:border-emerald-400/80 focus:ring"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Coach Taylor"
                required
              />
            </label>
            <button
              type="submit"
              disabled={isPending}
              className="mt-2 inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-50"
            >
              {isPending ? "Creating..." : "Create lobby"}
            </button>
          </form>

          <form
            onSubmit={handleJoin}
            className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/80 p-6"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <span className="h-2 w-2 rounded-full bg-blue-400 shadow-[0_0_12px_rgba(96,165,250,0.6)]" />
              Join a lobby
            </div>
            <label className="text-sm text-slate-300">
              Display name
              <input
                className="mt-2 w-full rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-base text-slate-50 outline-none ring-blue-500/30 transition focus:border-blue-400/80 focus:ring"
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="QB1"
                required
              />
            </label>
            <label className="text-sm text-slate-300">
              Game code
              <input
                className="mt-2 w-full rounded-lg border border-slate-700/70 bg-slate-950/50 px-3 py-2 text-base uppercase tracking-[0.2em] text-slate-50 outline-none ring-blue-500/30 transition focus:border-blue-400/80 focus:ring"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="ABC123"
                required
              />
            </label>
            <button
              type="submit"
              disabled={isPending}
              className="mt-2 inline-flex items-center justify-center rounded-lg bg-blue-500 px-4 py-2.5 text-sm font-semibold text-blue-950 transition hover:bg-blue-400 disabled:opacity-50"
            >
              {isPending ? "Joining..." : "Join lobby"}
            </button>
            <p className="text-xs text-slate-400">After joining, go to /game/{joinCode || "CODE"} to view the game.</p>
          </form>
        </div>

        {activeLobby ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.6)]" />
                Lobby roster
              </div>
              {rosterStatus === "loading" ? (
                <span className="text-xs text-slate-400">Loading…</span>
              ) : rosterStatus === "error" ? (
                <span className="text-xs text-rose-200">Error loading roster</span>
              ) : (
                <span className="text-xs text-slate-400">{rosterPlayers.length} player(s)</span>
              )}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {rosterPlayers.map((player) => (
                <div
                  key={player.id}
                  className="flex items-center justify-between rounded-lg border border-slate-800/80 bg-slate-950/60 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-50">{player.display_name}</p>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{player.role}</p>
                    <p className="text-xs text-slate-300">
                      Side:{" "}
                      <span className="font-semibold text-slate-100">
                        {player.side ? player.side : "Unassigned"}
                      </span>
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {isRef && player.role !== "ref" ? (
                      <select
                        value={player.side ?? ""}
                        onChange={(e) =>
                          handleSideChange(
                            player.id,
                            e.target.value === "" ? null : (e.target.value as "home" | "away"),
                          )
                        }
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-50"
                      >
                        <option value="">Unassigned</option>
                        <option value="home">Home</option>
                        <option value="away">Away</option>
                      </select>
                    ) : null}
                    {isRef && player.id !== myPlayer?.id && player.role !== "ref" ? (
                      <button
                        onClick={() => handleKick(player.id)}
                        className="rounded-md border border-rose-500/60 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-100 transition hover:bg-rose-500/10"
                      >
                        Kick
                      </button>
                    ) : null}
                    <span
                      className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                        player.ready
                          ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/60"
                          : "bg-slate-800 text-slate-300 ring-1 ring-slate-700"
                      }`}
                    >
                      {player.ready ? "Ready" : "Not ready"}
                    </span>
                  </div>
                </div>
              ))}
              {rosterPlayers.length === 0 && rosterStatus !== "loading" ? (
                <div className="rounded-lg border border-dashed border-slate-800/80 bg-slate-950/40 px-4 py-8 text-center text-sm text-slate-400">
                  No players yet. Share the code to get teammates in.
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
