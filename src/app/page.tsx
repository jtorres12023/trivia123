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
  const [createName, setCreateName] = useState("Host");
  const [joinName, setJoinName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [activeLobby, setActiveLobby] = useState<{ gameId: string; code: string; playerId: string } | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [rosterStatus, setRosterStatus] = useState<"idle" | "loading" | "error">("idle");
  const [status, setStatus] = useState<Status | null>(null);
  const [isPending, startTransition] = useTransition();
  const [gameMeta, setGameMeta] = useState<LobbyGame | null>(null);
  const STORAGE_KEY = "gridiron-lobby";
  const [lockPending, setLockPending] = useState(false);
  const [activeTab, setActiveTab] = useState<"join" | "host">("join");

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
          if (!["lobby_open", "in_progress"].includes(newGame.status)) {
            localStorage.removeItem(STORAGE_KEY);
            setActiveLobby(null);
          }
          if (newGame.status === "in_progress" && (activeLobby?.code || newGame.code)) {
            router.push(`/trivia/${activeLobby?.code || newGame.code}`);
          }
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, [activeLobby?.gameId]);

  const handleCreate = (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    setStatus(null);
    startTransition(async () => {
      const result = await createLobbyAction(createName || "Host");
      if (result.success) {
        if (typeof window !== "undefined") {
          localStorage.removeItem(STORAGE_KEY);
        }
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
        if (typeof window !== "undefined") {
          localStorage.removeItem(STORAGE_KEY);
        }
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

  const handleStartGame = async () => {
    if (!activeLobby?.gameId || !myPlayer) return;
    const result = await startGameAction(activeLobby.gameId, myPlayer.id);
    if (result.success) {
      setStatus({ type: "success", message: "Game started!" });
      const code = activeLobby.code || gameMeta?.code;
      if (code) {
        router.push(`/trivia/${code}`);
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

  const rosterPlayers = players.filter((p) => p.role !== "ref");
  const allReady = rosterPlayers.length > 0 && rosterPlayers.every((p) => p.ready);
  const canStart = gameMeta?.status === "lobby_open" && allReady;

  return (
    <main className="flex min-h-screen flex-col bg-gradient-to-br from-white via-[#f2f5fb] to-[#e5f2ff] px-6 py-12 text-slate-900">
      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-10 overflow-hidden rounded-3xl border border-slate-200 bg-white p-10 shadow-[0_30px_120px_rgba(15,23,42,0.15)] backdrop-blur">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_20%,rgba(59,130,246,0.15),transparent_35%),radial-gradient(circle_at_80%_20%,rgba(251,191,36,0.14),transparent_35%),radial-gradient(circle_at_50%_80%,rgba(52,211,153,0.12),transparent_30%)]" />
        <div className="flex flex-col items-center text-center gap-3">
          <p className="text-lg uppercase tracking-[0.5em] text-cyan-600 md:text-2xl">Live Trivia</p>
          <h1 className="text-5xl font-extrabold leading-tight text-slate-900 sm:text-6xl md:text-7xl">
            Join or host a game
          </h1>
          <div className="mt-2 flex flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">Scan to join</div>
            <img
              src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=192.168.0.107:3000"
              alt="Join game QR code"
              className="mt-2 h-48 w-48"
            />
            <p className="mt-1 text-xs text-slate-500">Point your phone here to open 192.168.0.107:3000</p>
          </div>
        </div>

        {activeLobby ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-base font-semibold text-emerald-900 shadow-[0_10px_40px_rgba(16,185,129,0.1)]">
            <span>
              In lobby <span className="font-semibold">{activeLobby.code || gameMeta?.code}</span>. Share this code with
              teammates.
            </span>
            {myPlayer && myPlayer.role !== "ref" ? (
              <button
                onClick={toggleReady}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                  myPlayer.ready
                    ? "border-emerald-400 bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    : "border-slate-400 text-slate-800 hover:bg-slate-200"
                }`}
              >
                {myPlayer.ready ? "Ready" : "Set ready"}
              </button>
            ) : null}
            <button
              onClick={handleLeave}
              className="rounded-lg border border-emerald-400/60 px-3 py-1 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-100"
            >
              Leave lobby
            </button>
            {gameMeta?.status === "in_progress" && (activeLobby.code || gameMeta.code) ? (
              <button
                onClick={() => router.push(`/trivia/${activeLobby.code || gameMeta.code}`)}
                className="rounded-lg border border-amber-400/70 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 transition hover:bg-amber-200"
              >
                Go to game view
              </button>
            ) : null}
          </div>
        ) : null}

        {activeLobby && gameMeta && isRef ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-cyan-300/60 bg-white p-6 shadow-[0_12px_50px_rgba(59,130,246,0.15)]">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Lobby status</div>
                <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-500">
                  {gameMeta.status === "lobby_open" ? "Lobby open" : gameMeta.status}
                </p>
                <p className="text-xs text-slate-600">
                  Players: {rosterPlayers.length} · Ready: {rosterPlayers.filter((p) => p.ready).length}/
                  {rosterPlayers.length}
                </p>
                <p className="text-xs text-slate-600">Lock lobby to prevent new joins.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={toggleLobbyLock}
                  disabled={lockPending}
                  className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${
                    gameMeta.lobby_locked
                      ? "border border-amber-400/60 bg-amber-100 text-amber-900 hover:bg-amber-200"
                      : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
                  }`}
                >
                  {gameMeta.lobby_locked ? "Locked" : "Lock lobby"}
                </button>
                <button
                  onClick={handleStartGame}
                  disabled={!canStart}
                  className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-300 disabled:opacity-50"
                >
                  Start game
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {status ? (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              status.type === "success"
                ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                : "border-rose-300 bg-rose-50 text-rose-900"
            }`}
          >
            {status.message}
            {gameMeta?.status === "in_progress" && (activeLobby?.code || gameMeta?.code) ? (
              <button
                onClick={() => router.push(`/trivia/${activeLobby?.code || gameMeta?.code}`)}
                className="ml-3 inline-flex items-center rounded-md border border-emerald-400 px-3 py-1 text-xs font-semibold text-emerald-900 transition hover:bg-emerald-100"
              >
                Open game view
              </button>
            ) : null}
          </div>
        ) : null}

        {activeLobby ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-900">Ready check</span>
              <span>
                Players: {rosterPlayers.length} | Ready: {players.filter((p) => p.ready).length}/{players.length}
              </span>
              {!canStart ? (
                <span className="text-amber-700">All players must ready up to start.</span>
              ) : (
                <span className="text-emerald-700">All set</span>
              )}
            </div>
          </div>
        ) : null}

        {!activeLobby ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-[0_12px_40px_rgba(14,165,233,0.15)]">
            <div className="mb-4 h-1 rounded-full bg-gradient-to-r from-cyan-400 via-emerald-300 to-amber-300" />
            <div className="flex gap-3">
              <button
                onClick={() => setActiveTab("join")}
                className={`rounded-full px-7 py-3 text-xl font-semibold ${
                  activeTab === "join" ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                Join a game
              </button>
              <button
                onClick={() => setActiveTab("host")}
                className={`rounded-full px-7 py-3 text-xl font-semibold ${
                  activeTab === "host" ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                Host a game
              </button>
            </div>
            {activeTab === "host" ? (
              <form onSubmit={handleCreate} className="mt-5 flex flex-col gap-4">
                <input type="hidden" value={createName} readOnly />
                <button
                  type="submit"
                  disabled={isPending}
                  className="mt-3 inline-flex items-center justify-center rounded-xl bg-emerald-500 px-5 py-4 text-lg font-semibold text-white transition hover:bg-emerald-400 disabled:opacity-50"
                >
                  {isPending ? "Creating..." : "Create lobby"}
                </button>
                <p className="text-sm text-slate-500">
                  We’ll generate a code and set you as host. Share the code to invite players.
                </p>
              </form>
            ) : (
              <form onSubmit={handleJoin} className="mt-5 flex flex-col gap-4">
                <label className="text-lg text-slate-600 font-semibold">
                  Display name
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-xl text-slate-900 outline-none ring-blue-400/20 transition focus:border-blue-300/80 focus:ring"
                    value={joinName}
                    onChange={(e) => setJoinName(e.target.value)}
                    placeholder="Your name"
                    required
                  />
                </label>
                <label className="text-lg text-slate-600 font-semibold">
                  Game code
                  <input
                    className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-4 text-xl uppercase tracking-[0.25em] text-slate-900 outline-none ring-blue-400/20 transition focus:border-blue-300/80 focus:ring"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                    placeholder="ABC123"
                    required
                  />
                </label>
                <button
                  type="submit"
                  disabled={isPending}
                  className="mt-3 inline-flex items-center justify-center rounded-xl bg-blue-500 px-5 py-4 text-lg font-semibold text-white transition hover:bg-blue-400 disabled:opacity-50"
                >
                  {isPending ? "Joining..." : "Join lobby"}
                </button>
                <p className="text-sm text-slate-500">
                  After joining, go to /trivia/{joinCode || "CODE"} to view the game.
                </p>
              </form>
            )}
          </div>
        ) : null}

        {activeLobby ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_12px_40px_rgba(14,165,233,0.15)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.6)]" />
              Lobby roster
            </div>
            {rosterStatus === "loading" ? (
              <span className="text-xs text-slate-500">Loading…</span>
            ) : rosterStatus === "error" ? (
              <span className="text-xs text-rose-500">Error loading roster</span>
            ) : (
              <span className="text-xs text-slate-500">{rosterPlayers.length} player(s)</span>
            )}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {rosterPlayers.length === 0 && rosterStatus !== "loading" ? (
              <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center text-base font-semibold text-slate-600">
                No players yet. Share the code to get teammates in.
              </div>
            ) : (
              rosterPlayers.map((player) => (
                <div
                  key={player.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-4"
                >
                  <div>
                    <p className="text-xl font-semibold text-slate-900">{player.display_name}</p>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{player.role}</p>
                    <p className="text-sm text-slate-600">Ready: {player.ready ? "Yes" : "No"}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {isRef && player.id !== myPlayer?.id && player.role !== "ref" ? (
                      <button
                        onClick={() => handleKick(player.id)}
                        className="rounded-md border border-rose-500/60 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-600 transition hover:bg-rose-50"
                      >
                        Kick
                      </button>
                    ) : null}
                    <span
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                        player.ready
                          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300"
                          : "bg-slate-200 text-slate-700 ring-1 ring-slate-300"
                      }`}
                    >
                      {player.ready ? "Ready" : "Not ready"}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
      </div>
    </main>
  );
}
