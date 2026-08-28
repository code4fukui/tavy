import { createHandler } from "./app.ts";
import { openDatabase } from "./db.ts";

await Deno.mkdir("data", { recursive: true });
const db = openDatabase(Deno.env.get("TAVY_DB") ?? "data/tavy.db");
const port = Number(Deno.env.get("TAVY_PORT") ?? 8000);

console.log(`tavy: http://localhost:${port}`);
Deno.serve(
  { port },
  createHandler(db, "public", Deno.env.get("TAVY_SECURE_COOKIE") === "1"),
);
