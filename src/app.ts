import type { Database } from "./db.ts";
import { hashPassword, verifyPassword } from "./db.ts";
import QRCode from "qrcode";

const encoder = new TextEncoder();
const moods = new Set(["idea", "question", "agree", "note"]);
const staticTypes: Record<string, string> = {
  "/": "text/html; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/style.css": "text/css; charset=utf-8",
};

export function createHandler(db: Database, publicDir = "public", secureCookie = false) {
  const roomSockets = new Map<number, Set<WebSocket>>();
  const notifyRoom = (roomId: number, mode: "delta" | "full" = "full") => {
    const message = JSON.stringify({ type: "changed", mode });
    for (const socket of roomSockets.get(roomId) ?? []) {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    }
  };
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const visitor = getVisitor(request, secureCookie);
      const user = getUser(db, request);

      if (url.pathname === "/api/me" && request.method === "GET") {
        return json({ user }, 200, visitor.cookie);
      }
      if (url.pathname === "/api/register" && request.method === "POST") {
        const input = await readJson(request);
        const id = typeof input.id === "string" ? input.id.trim() : "";
        const password = typeof input.password === "string" ? input.password : "";
        if (!/^[A-Za-z0-9_-]{3,32}$/.test(id) || password.length < 8 || password.length > 128) {
          return json(
            { error: "IDは半角英数字・_-で3〜32文字、パスワードは8文字以上にしてください" },
            400,
            visitor.cookie,
          );
        }
        try {
          db.prepare("INSERT INTO users (id, password_hash) VALUES (?, ?)")
            .run(id, hashPassword(password));
        } catch (error) {
          if (String(error).includes("UNIQUE")) {
            return json({ error: "このIDは使用できません" }, 409, visitor.cookie);
          }
          throw error;
        }
        return createSessionResponse(db, id, secureCookie, 201, visitor.cookie);
      }
      if (url.pathname === "/api/login" && request.method === "POST") {
        const input = await readJson(request);
        const id = typeof input.id === "string" ? input.id : "";
        const password = typeof input.password === "string" ? input.password : "";
        const found = db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(id) as
          | { id: string; password_hash: string }
          | undefined;
        if (!found || !verifyPassword(password, found.password_hash)) {
          return json({ error: "Invalid ID or password" }, 401, visitor.cookie);
        }
        return createSessionResponse(db, found.id, secureCookie, 200, visitor.cookie);
      }
      if (url.pathname === "/api/logout" && request.method === "POST") {
        const sessionId = getCookie(request, "tavy_session");
        if (sessionId) db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
        return json({ ok: true }, 200, expiredSessionCookie(secureCookie), visitor.cookie);
      }
      if (url.pathname === "/api/password" && request.method === "POST") {
        if (!user) return json({ error: "ログインしてください" }, 401, visitor.cookie);
        const input = await readJson(request);
        const currentPassword = typeof input.current_password === "string"
          ? input.current_password
          : "";
        const newPassword = typeof input.new_password === "string" ? input.new_password : "";
        if (newPassword.length < 8 || newPassword.length > 128) {
          return json(
            { error: "新しいパスワードは8〜128文字で入力してください" },
            400,
            visitor.cookie,
          );
        }
        const found = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as
          | { password_hash: string }
          | undefined;
        if (!found || !verifyPassword(currentPassword, found.password_hash)) {
          return json({ error: "現在のパスワードが正しくありません" }, 401, visitor.cookie);
        }
        const sessionId = getCookie(request, "tavy_session");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?",
          ).run(hashPassword(newPassword), user.id);
          db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").run(
            user.id,
            sessionId ?? "",
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return json({ ok: true }, 200, visitor.cookie);
      }
      if (url.pathname === "/api/rooms" && request.method === "GET") {
        const rooms = user?.is_admin
          ? db.prepare(`SELECT r.id, r.slug, r.name, r.owner_id, r.created_at,
          count(p.id) AS post_count FROM rooms r LEFT JOIN posts p ON p.room_id = r.id
          GROUP BY r.id ORDER BY r.created_at DESC`).all()
          : user
          ? db.prepare(`SELECT r.id, r.slug, r.name, r.owner_id, r.created_at,
          count(p.id) AS post_count FROM rooms r LEFT JOIN posts p ON p.room_id = r.id
          WHERE r.owner_id = ? GROUP BY r.id ORDER BY r.created_at DESC`).all(user.id)
          : [];
        return json({ rooms }, 200, visitor.cookie);
      }
      if (url.pathname === "/api/users" && request.method === "GET") {
        if (!user) return json({ error: "ログインしてください" }, 401, visitor.cookie);
        if (!user.is_admin) return json({ error: "管理者権限が必要です" }, 403, visitor.cookie);
        const users = db.prepare(`SELECT u.id, u.is_admin, u.must_change_password, u.created_at,
          count(r.id) AS room_count FROM users u LEFT JOIN rooms r ON r.owner_id = u.id
          GROUP BY u.id ORDER BY u.created_at ASC, u.id ASC`).all();
        return json({ users }, 200, visitor.cookie);
      }
      const socketMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/ws$/);
      if (socketMatch && request.method === "GET") {
        const room = findRoom(db, socketMatch[1]);
        if (!room) return json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return json({ error: "WebSocket upgrade required" }, 426, visitor.cookie);
        }
        const { socket, response } = Deno.upgradeWebSocket(request);
        socket.addEventListener("open", () => {
          const sockets = roomSockets.get(room.id) ?? new Set<WebSocket>();
          sockets.add(socket);
          roomSockets.set(room.id, sockets);
        });
        const remove = () => {
          const sockets = roomSockets.get(room.id);
          sockets?.delete(socket);
          if (!sockets?.size) roomSockets.delete(room.id);
        };
        socket.addEventListener("close", remove);
        socket.addEventListener("error", remove);
        socket.addEventListener("message", (event) => {
          if (event.data === "ping") socket.send("pong");
        });
        return response;
      }
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)$/);
      if (roomMatch && request.method === "GET") {
        const room = db.prepare(`SELECT r.id, r.slug, r.name, r.owner_id, r.created_at,
          count(p.id) AS post_count FROM rooms r LEFT JOIN posts p ON p.room_id = r.id
          WHERE r.slug = ? GROUP BY r.id`).get(roomMatch[1]);
        return room
          ? json({ room }, 200, visitor.cookie)
          : json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
      }
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        if (!user) {
          return json({ error: "ルームを作るにはログインしてください" }, 401, visitor.cookie);
        }
        const input = await readJson(request);
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 60) {
          return json({ error: "ルーム名は1〜60文字で入力してください" }, 400, visitor.cookie);
        }
        const slug = randomHex(12);
        const result = db.prepare("INSERT INTO rooms (name, owner_id, slug) VALUES (?, ?, ?)")
          .run(name, user.id, slug);
        return json({ id: Number(result.lastInsertRowid), slug }, 201, visitor.cookie);
      }
      const qrMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/qr$/);
      if (qrMatch && request.method === "GET") {
        if (!db.prepare("SELECT 1 FROM rooms WHERE slug = ?").get(qrMatch[1])) {
          return json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
        }
        const roomUrl = `${url.origin}/r/${qrMatch[1]}`;
        return new Response(
          await QRCode.toString(roomUrl, {
            type: "svg",
            margin: 1,
            color: { dark: "#18332d", light: "#fffef9" },
          }),
          { headers: { "content-type": "image/svg+xml; charset=utf-8" } },
        );
      }
      const exportMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]+)\/export\.json$/);
      if (exportMatch && request.method === "GET") {
        const room = db.prepare("SELECT id, slug, name, created_at FROM rooms WHERE slug = ?")
          .get(exportMatch[1]) as
            | { id: number; slug: string; name: string; created_at: string }
            | undefined;
        if (!room) return json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
        const posts = db.prepare(`SELECT p.id, p.parent_id, p.body, p.mood, p.created_at,
          count(DISTINCT r.visitor_id) AS likes,
          count(DISTINCT child.id) AS replies
          FROM posts p LEFT JOIN reactions r ON r.post_id = p.id
          LEFT JOIN posts child ON child.parent_id = p.id
          WHERE p.room_id = ? GROUP BY p.id ORDER BY p.created_at ASC`).all(room.id);
        const payload = JSON.stringify({ room, posts }, null, 2);
        return new Response(payload, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="tavy-${room.slug}.json"`,
          },
        });
      }
      if (url.pathname === "/api/posts" && request.method === "GET") {
        const room = findRoom(db, url.searchParams.get("room") ?? "");
        if (!room) {
          return json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
        }
        const savedOnly = url.searchParams.get("saved") === "1";
        const sinceValue = Number(url.searchParams.get("since") ?? "0");
        const sinceId = Number.isSafeInteger(sinceValue) && sinceValue > 0 ? sinceValue : 0;
        return json(
          { posts: listPosts(db, room.id, visitor.id, savedOnly, sinceId) },
          200,
          visitor.cookie,
        );
      }
      if (url.pathname === "/api/posts" && request.method === "POST") {
        const input = await readJson(request);
        const body = typeof input.body === "string" ? input.body.trim() : "";
        const mood = typeof input.mood === "string" ? input.mood : "note";
        const roomId = Number(input.room_id);
        if (!Number.isSafeInteger(roomId) || !roomExists(db, roomId)) {
          return json({ error: "ルームが見つかりません" }, 404, visitor.cookie);
        }
        if (!body || body.length > 280 || !moods.has(mood)) {
          return json({ error: "メモは1〜280文字で入力してください" }, 400, visitor.cookie);
        }
        const parentId = input.parent_id == null ? null : Number(input.parent_id);
        if (
          parentId !== null && (!Number.isSafeInteger(parentId) || !db.prepare(
            "SELECT 1 FROM posts WHERE id = ? AND room_id = ?",
          ).get(parentId, roomId))
        ) {
          return json({ error: "返信先が見つかりません" }, 404, visitor.cookie);
        }
        if (
          db.prepare(
            "SELECT 1 FROM posts WHERE room_id = ? AND visitor_id = ? AND body = ? LIMIT 1",
          )
            .get(roomId, visitor.id, body)
        ) {
          return json({ error: "同じ内容のつぶやみは投稿できません" }, 409, visitor.cookie);
        }
        const result = db.prepare(
          "INSERT INTO posts (body, mood, room_id, parent_id, visitor_id) VALUES (?, ?, ?, ?, ?)",
        ).run(body, mood, roomId, parentId, visitor.id);
        notifyRoom(roomId, "delta");
        return json({ id: Number(result.lastInsertRowid) }, 201, visitor.cookie);
      }
      const ownPost = url.pathname.match(/^\/api\/posts\/(\d+)$/);
      if (ownPost && request.method === "PATCH") {
        const postId = Number(ownPost[1]);
        const input = await readJson(request);
        const body = typeof input.body === "string" ? input.body.trim() : "";
        const roomId = postRoomId(db, postId);
        if (body.length > 280) {
          return json({ error: "つぶやきは280文字以内で入力してください" }, 400, visitor.cookie);
        }
        if (!body) {
          if (!deleteOwnPost(db, postId, visitor.id)) {
            return json({ error: "自分のつぶやきだけ編集できます" }, 403, visitor.cookie);
          }
          if (roomId) notifyRoom(roomId);
          return json({ ok: true, deleted: true }, 200, visitor.cookie);
        }
        const result = db.prepare(
          "UPDATE posts SET body = ? WHERE id = ? AND visitor_id = ?",
        ).run(body, postId, visitor.id);
        if (!result.changes) {
          return json({ error: "自分のつぶやきだけ編集できます" }, 403, visitor.cookie);
        }
        if (roomId) notifyRoom(roomId);
        return json({ ok: true }, 200, visitor.cookie);
      }
      if (ownPost && request.method === "DELETE") {
        const postId = Number(ownPost[1]);
        const roomId = postRoomId(db, postId);
        if (!deleteOwnPost(db, postId, visitor.id)) {
          return json({ error: "自分のつぶやきだけ削除できます" }, 403, visitor.cookie);
        }
        if (roomId) notifyRoom(roomId);
        return json({ ok: true }, 200, visitor.cookie);
      }
      const action = url.pathname.match(/^\/api\/posts\/(\d+)\/(like|bookmark)$/);
      if (action && request.method === "PUT") {
        const postId = Number(action[1]);
        const roomId = postRoomId(db, postId);
        if (!roomId) {
          return json({ error: "メモが見つかりません" }, 404, visitor.cookie);
        }
        const table = action[2] === "like" ? "reactions" : "bookmarks";
        const existing = db.prepare(`SELECT 1 FROM ${table} WHERE post_id = ? AND visitor_id = ?`)
          .get(postId, visitor.id);
        const sql = existing
          ? `DELETE FROM ${table} WHERE post_id = ? AND visitor_id = ?`
          : `INSERT INTO ${table} (post_id, visitor_id) VALUES (?, ?)`;
        db.prepare(sql).run(postId, visitor.id);
        notifyRoom(roomId);
        return json({ active: !existing }, 200, visitor.cookie);
      }
      if (
        request.method === "GET" &&
        (staticTypes[url.pathname] || /^\/r\/[A-Za-z0-9_-]+$/.test(url.pathname))
      ) {
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const staticName = url.pathname.startsWith("/r/") ? "index.html" : name;
        return new Response(await Deno.readFile(`${publicDir}/${staticName}`), {
          headers: {
            "content-type": staticTypes[url.pathname],
            "cache-control": "no-cache",
          },
        });
      }
      return json({ error: "Not found" }, 404, visitor.cookie);
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: "JSONが不正です" }, 400);
      console.error(error instanceof Error ? error.message : error);
      return json({ error: "サーバーエラーが発生しました" }, 500);
    }
  };
}

type User = { id: string; is_admin: number; must_change_password: number };

function getUser(db: Database, request: Request): User | null {
  const sessionId = getCookie(request, "tavy_session");
  if (!sessionId) return null;
  return db.prepare(`SELECT u.id, u.is_admin, u.must_change_password FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .get(sessionId) as User | undefined ?? null;
}

function createSessionResponse(
  db: Database,
  userId: string,
  secure: boolean,
  status: number,
  visitorCookie?: string,
): Response {
  const id = randomHex(32);
  db.prepare(
    "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
  )
    .run(id, userId);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.append("set-cookie", sessionCookie(id, secure, 2592000));
  if (visitorCookie) headers.append("set-cookie", visitorCookie);
  const user = db.prepare("SELECT id, is_admin, must_change_password FROM users WHERE id = ?")
    .get(userId) as User;
  return Response.json({ user }, { status, headers });
}

function roomExists(db: Database, id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(id));
}

function postRoomId(db: Database, postId: number): number | undefined {
  return (db.prepare("SELECT room_id FROM posts WHERE id = ?").get(postId) as
    | { room_id: number }
    | undefined)?.room_id;
}

function deleteOwnPost(db: Database, postId: number, visitorId: string): boolean {
  const post = db.prepare("SELECT parent_id FROM posts WHERE id = ? AND visitor_id = ?")
    .get(postId, visitorId) as { parent_id: number | null } | undefined;
  if (!post) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE posts SET parent_id = ? WHERE parent_id = ?").run(post.parent_id, postId);
    db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

function findRoom(db: Database, value: string): { id: number } | undefined {
  return db.prepare("SELECT id FROM rooms WHERE slug = ?").get(value) as { id: number } | undefined;
}

function listPosts(
  db: Database,
  roomId: number,
  visitorId: string,
  savedOnly: boolean,
  sinceId = 0,
) {
  const saved = savedOnly
    ? "JOIN bookmarks own_bookmark ON own_bookmark.post_id = p.id AND own_bookmark.visitor_id = ?"
    : "";
  const since = sinceId > 0 ? " AND p.id > ?" : "";
  return db.prepare(`SELECT p.id, p.parent_id, p.body, p.mood, p.created_at,
    CASE WHEN p.visitor_id = ? THEN 1 ELSE 0 END AS own,
    count(DISTINCT r.visitor_id) AS likes,
    count(DISTINCT child.id) AS replies,
    max(CASE WHEN r.visitor_id = ? THEN 1 ELSE 0 END) AS liked,
    max(CASE WHEN b.visitor_id = ? THEN 1 ELSE 0 END) AS bookmarked
    FROM posts p LEFT JOIN reactions r ON r.post_id = p.id
    LEFT JOIN posts child ON child.parent_id = p.id
    LEFT JOIN bookmarks b ON b.post_id = p.id AND b.visitor_id = ? ${saved}
    WHERE p.room_id = ?${since} GROUP BY p.id ORDER BY p.created_at DESC LIMIT 2000`)
    .all(
      visitorId,
      visitorId,
      visitorId,
      visitorId,
      ...(savedOnly ? [visitorId] : []),
      roomId,
      ...(sinceId > 0 ? [sinceId] : []),
    )
    .reverse();
}

function getVisitor(request: Request, secure: boolean): { id: string; cookie?: string } {
  const found = getCookie(request, "tavy_visitor");
  if (found && /^[a-f0-9]{64}$/.test(found)) return { id: found };
  const id = randomHex(32);
  return {
    id,
    cookie: `tavy_visitor=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${
      secure ? "; Secure" : ""
    }`,
  };
}

function randomHex(bytes: number): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
function getCookie(request: Request, name: string): string | undefined {
  return request.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
}
function sessionCookie(id: string, secure: boolean, maxAge: number): string {
  return `tavy_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
    secure ? "; Secure" : ""
  }`;
}
function expiredSessionCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}
async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new SyntaxError();
  const text = await request.text();
  if (encoder.encode(text).byteLength > 2048) throw new SyntaxError();
  return JSON.parse(text);
}
function json(value: unknown, status = 200, ...cookies: Array<string | undefined>): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  for (const cookie of cookies) if (cookie) headers.append("set-cookie", cookie);
  return Response.json(value, { status, headers });
}
