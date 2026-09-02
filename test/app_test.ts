import { DatabaseSync } from "node:sqlite";
import { createHandler } from "../src/app.ts";
import { hashPassword } from "../src/db.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertMatch(actual: string, expected: RegExp): void {
  if (!expected.test(actual)) {
    throw new Error(`${JSON.stringify(actual)} does not match ${expected}`);
  }
}
function testApp() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (
    const name of [
      "001_init.sql",
      "002_add_users_rooms.sql",
      "003_add_threaded_replies.sql",
      "004_room_share_urls.sql",
      "005_add_post_visitor.sql",
    ]
  ) {
    db.exec(Deno.readTextFileSync(`migrations/${name}`));
  }
  db.prepare("INSERT INTO users (id, password_hash) VALUES (?, ?)").run(
    "owner",
    hashPassword("password123"),
  );
  const roomId = Number(
    db.prepare("INSERT INTO rooms (name, owner_id, slug) VALUES (?, ?, ?)").run(
      "テストルーム",
      "owner",
      "test-room",
    )
      .lastInsertRowid,
  );
  return { db, roomId, handler: createHandler(db) };
}
async function request(
  handler: (request: Request) => Promise<Response>,
  path: string,
  body?: unknown,
  cookie = "",
) {
  return await handler(
    new Request(`http://local${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? { cookie } : { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

Deno.test("ユーザー登録でsessionを作成する", async () => {
  const { handler } = testApp();
  const response = await request(handler, "/api/register", {
    id: "new_user",
    password: "long-password",
  });
  assertEquals(response.status, 201);
  assertMatch(response.headers.get("set-cookie") ?? "", /tavy_session=.*HttpOnly; SameSite=Lax/);
});

Deno.test("登録ユーザーだけがルームを作成できる", async () => {
  const { handler } = testApp();
  assertEquals((await request(handler, "/api/rooms", { name: "新ルーム" })).status, 401);
  const login = await request(handler, "/api/login", { id: "owner", password: "password123" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assertEquals((await request(handler, "/api/rooms", { name: "新ルーム" }, cookie)).status, 201);
});

Deno.test("管理者だけが全ルームとユーザー一覧を取得できる", async () => {
  const { db, handler } = testApp();
  db.prepare("INSERT INTO users (id, password_hash, is_admin) VALUES (?, ?, 1)").run(
    "admin_user",
    hashPassword("admin-password"),
  );
  db.prepare("INSERT INTO rooms (name, owner_id, slug) VALUES (?, ?, ?)").run(
    "管理者ルーム",
    "admin_user",
    "admin-room",
  );
  assertEquals((await request(handler, "/api/users")).status, 401);

  const ownerLogin = await request(handler, "/api/login", {
    id: "owner",
    password: "password123",
  });
  const ownerCookie = ownerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  assertEquals((await request(handler, "/api/users", undefined, ownerCookie)).status, 403);
  const ownerRooms = (await request(handler, "/api/rooms", undefined, ownerCookie)).json();
  assertEquals((await ownerRooms).rooms.map((room: { slug: string }) => room.slug), ["test-room"]);

  const adminLogin = await request(handler, "/api/login", {
    id: "admin_user",
    password: "admin-password",
  });
  const adminResult = await adminLogin.clone().json();
  assertEquals(adminResult.user.is_admin, 1);
  const adminCookie = adminLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
  const adminRooms = await (await request(handler, "/api/rooms", undefined, adminCookie)).json();
  assertEquals(adminRooms.rooms.length, 2);
  const users = await (await request(handler, "/api/users", undefined, adminCookie)).json();
  assertEquals(users.users.map((item: { id: string }) => item.id), ["owner", "admin_user"]);
  assertEquals(users.users.map((item: { room_count: number }) => item.room_count), [1, 1]);
});

Deno.test("ログインユーザーが現在のパスワードを確認して変更できる", async () => {
  const { db, handler } = testApp();
  assertEquals(
    (await request(handler, "/api/password", {
      current_password: "password123",
      new_password: "new-password-456",
    })).status,
    401,
  );
  const login = await request(handler, "/api/login", { id: "owner", password: "password123" });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  assertEquals(
    (await request(handler, "/api/password", {
      current_password: "wrong-password",
      new_password: "new-password-456",
    }, cookie)).status,
    401,
  );
  db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run("owner");
  assertEquals(
    (await request(handler, "/api/password", {
      current_password: "password123",
      new_password: "new-password-456",
    }, cookie)).status,
    200,
  );
  assertEquals(
    (db.prepare("SELECT must_change_password FROM users WHERE id = ?").get("owner") as {
      must_change_password: number;
    }).must_change_password,
    0,
  );
  assertEquals(
    (await request(handler, "/api/login", { id: "owner", password: "password123" })).status,
    401,
  );
  assertEquals(
    (await request(handler, "/api/login", { id: "owner", password: "new-password-456" })).status,
    200,
  );
});

Deno.test("新規登録直後のsessionでルームを作成できる", async () => {
  const { handler } = testApp();
  const registered = await request(handler, "/api/register", {
    id: "fresh_user",
    password: "generated-password-123",
  });
  const cookie = registered.headers.get("set-cookie")?.match(/tavy_session=[a-f0-9]+/)?.[0] ?? "";
  const created = await request(handler, "/api/rooms", { name: "登録直後のルーム" }, cookie);
  assertEquals(created.status, 201);
  const result = await created.json();
  assertMatch(result.slug, /^[a-f0-9]{24}$/);
  const opened = await request(handler, `/api/rooms/${result.slug}`);
  assertEquals((await opened.json()).room.name, "登録直後のルーム");
});

Deno.test("未ログインではルーム一覧を公開せず共有URLとQRから参加できる", async () => {
  const { handler } = testApp();
  const listed = await request(handler, "/api/rooms");
  assertEquals((await listed.json()).rooms, []);
  const shared = await request(handler, "/api/rooms/test-room");
  assertEquals((await shared.json()).room.name, "テストルーム");
  const qr = await request(handler, "/api/rooms/test-room/qr");
  assertEquals(qr.status, 200);
  assertMatch(qr.headers.get("content-type") ?? "", /image\/svg\+xml/);
  assertMatch(await qr.text(), /<svg/);
  const exported = await request(handler, "/api/rooms/test-room/export.json");
  assertEquals(exported.status, 200);
  assertMatch(exported.headers.get("content-disposition") ?? "", /attachment/);
  assertEquals((await exported.json()).room.slug, "test-room");
  const socketWithoutUpgrade = await request(handler, "/api/rooms/test-room/ws");
  assertEquals(socketWithoutUpgrade.status, 426);
});

Deno.test("つぶやきと深さに制限のない返信をルーム単位で取得する", async () => {
  const { roomId, handler } = testApp();
  const rootId =
    (await (await request(handler, "/api/posts", { room_id: roomId, body: "親", mood: "note" }))
      .json()).id;
  const childId = (await (await request(handler, "/api/posts", {
    room_id: roomId,
    parent_id: rootId,
    body: "返信",
    mood: "idea",
  })).json()).id;
  assertEquals(
    (await request(handler, "/api/posts", {
      room_id: roomId,
      parent_id: childId,
      body: "返信への返信",
      mood: "question",
    })).status,
    201,
  );
  const posts = (await (await request(handler, "/api/posts?room=test-room")).json()).posts;
  assertEquals(posts.map((post: { parent_id: number | null }) => post.parent_id), [
    null,
    rootId,
    childId,
  ]);
  const delta = (await (await request(handler, `/api/posts?room=test-room&since=${rootId}`)).json())
    .posts;
  assertEquals(delta.map((post: { id: number }) => post.id), [childId, childId + 1]);
});

Deno.test("別ルームのつぶやきには返信できない", async () => {
  const { db, roomId, handler } = testApp();
  const otherRoom = Number(
    db.prepare("INSERT INTO rooms (name, owner_id, slug) VALUES (?, ?, ?)").run(
      "別室",
      "owner",
      "other-room",
    )
      .lastInsertRowid,
  );
  const rootId =
    (await (await request(handler, "/api/posts", { room_id: roomId, body: "親", mood: "note" }))
      .json()).id;
  assertEquals(
    (await request(handler, "/api/posts", {
      room_id: otherRoom,
      parent_id: rootId,
      body: "不正返信",
      mood: "note",
    })).status,
    404,
  );
});

Deno.test("この端末から投稿したつぶやきを判定できる", async () => {
  const { roomId, handler } = testApp();
  const posted = await request(handler, "/api/posts", {
    room_id: roomId,
    body: "自分の投稿",
    mood: "note",
  });
  const cookie = posted.headers.get("set-cookie")?.split(";")[0] ?? "";
  const own = await request(handler, "/api/posts?room=test-room", undefined, cookie);
  assertEquals((await own.json()).posts[0].own, 1);
  const other = await request(handler, "/api/posts?room=test-room");
  assertEquals((await other.json()).posts[0].own, 0);
});

Deno.test("自分の発言を編集・削除でき、返信は親へつなぎ直す", async () => {
  const { roomId, handler } = testApp();
  const rootResponse = await request(handler, "/api/posts", {
    room_id: roomId,
    body: "編集前",
    mood: "note",
  });
  const rootId = (await rootResponse.clone().json()).id;
  const cookie = rootResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const childId = (await (await request(handler, "/api/posts", {
    room_id: roomId,
    parent_id: rootId,
    body: "返信",
    mood: "note",
  }, cookie)).json()).id;
  const edited = await handler(
    new Request(`http://local/api/posts/${rootId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ body: "編集後" }),
    }),
  );
  assertEquals(edited.status, 200);
  const removed = await handler(
    new Request(`http://local/api/posts/${rootId}`, {
      method: "DELETE",
      headers: { cookie },
    }),
  );
  assertEquals(removed.status, 200);
  const posts =
    (await (await request(handler, "/api/posts?room=test-room", undefined, cookie)).json())
      .posts;
  assertEquals(posts[0].id, childId);
  assertEquals(posts[0].parent_id, null);
});

Deno.test("編集時の空欄保存は削除として扱う", async () => {
  const { roomId, handler } = testApp();
  const posted = await request(handler, "/api/posts", {
    room_id: roomId,
    body: "削除予定",
    mood: "note",
  });
  const id = (await posted.clone().json()).id;
  const cookie = posted.headers.get("set-cookie")?.split(";")[0] ?? "";
  const response = await handler(
    new Request(`http://local/api/posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ body: "" }),
    }),
  );
  assertEquals(response.status, 200);
  assertEquals((await response.json()).deleted, true);
  const posts =
    (await (await request(handler, "/api/posts?room=test-room", undefined, cookie)).json())
      .posts;
  assertEquals(posts.length, 0);
});

Deno.test("同じ端末から同じ内容を重複投稿できない", async () => {
  const { roomId, handler } = testApp();
  const first = await request(handler, "/api/posts", {
    room_id: roomId,
    body: "同じ内容",
    mood: "note",
  });
  const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
  const duplicate = await request(handler, "/api/posts", {
    room_id: roomId,
    body: "同じ内容",
    mood: "note",
  }, cookie);
  assertEquals(duplicate.status, 409);
});
