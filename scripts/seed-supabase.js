/* eslint-disable @typescript-eslint/no-require-imports */
require("dotenv").config({ path: ".env.local" });

const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("Missing Supabase env vars. Check .env.local.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

async function main() {
  const seedCode = "SEED01";

  const { data: existingGame } = await supabase
    .from("games")
    .select("id, code, status")
    .eq("code", seedCode)
    .maybeSingle();

  let gameId = existingGame?.id;

  if (!gameId) {
    const { data: gameInsert, error: gameError } = await supabase
      .from("games")
      .insert({
        code: seedCode,
        status: "lobby_open",
      })
      .select("id, code")
      .single();

    if (gameError || !gameInsert) {
      console.error("Failed to seed game:", gameError?.message);
      process.exit(1);
    }

    gameId = gameInsert.id;
    console.log(`Inserted seed game with code ${seedCode} (id: ${gameId})`);
  } else {
    console.log(`Seed game already exists with code ${seedCode} (id: ${gameId})`);
  }

  const players = [
    { display_name: "Coach Host", role: "host", side: "home" },
    { display_name: "Player One", role: "player", side: "away" },
  ];

  for (const player of players) {
    const { data: existingPlayer } = await supabase
      .from("players")
      .select("id")
      .eq("game_id", gameId)
      .eq("display_name", player.display_name)
      .maybeSingle();

    if (existingPlayer?.id) {
      console.log(`Player "${player.display_name}" already in seed game.`);
      continue;
    }

    const { error: playerError } = await supabase.from("players").insert({
      game_id: gameId,
      display_name: player.display_name,
      role: player.role,
    });

    if (playerError) {
      console.error(`Failed to insert player "${player.display_name}":`, playerError.message);
      process.exit(1);
    }

    console.log(`Inserted player "${player.display_name}".`);
  }

  console.log("Seed complete.");
}

main().catch((err) => {
  console.error("Supabase seed failed:", err);
  process.exit(1);
});
