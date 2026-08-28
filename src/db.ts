import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type Database = DatabaseSync;

export function openDatabase(path = "data/tavy.db"): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  bootstrap(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ) STRICT`);

  const applied = db.prepare("SELECT 1 FROM migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO migrations (version) VALUES (?)");
  const files = [...Deno.readDirSync("migrations")]
    .filter((entry) => entry.isFile && /^\d{3}_.+\.sql$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    const version = Number(file.name.slice(0, 3));
    if (applied.get(version)) continue;
    const sql = Deno.readTextFileSync(`migrations/${file.name}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      record.run(version);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function bootstrap(db: Database): void {
  if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get("admin")) {
    db.prepare(`INSERT INTO users (id, password_hash, is_admin, must_change_password)
      VALUES (?, ?, 1, 1)`).run("admin", hashPassword("admin"));
  }
  const rooms = db.prepare("SELECT id FROM rooms WHERE slug IS NULL").all() as { id: number }[];
  const setSlug = db.prepare("UPDATE rooms SET slug = ? WHERE id = ?");
  for (const room of rooms) {
    setSlug.run(randomBytes(12).toString("base64url"), room.id);
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algorithm, saltHex, hashHex] = stored.split(":");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
