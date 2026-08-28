const $ = (selector) => document.querySelector(selector);
const form = $("#post-form");
const memo = $("#memo");
const graph = $("#graph");
const notes = $("#notes");
const loginDialog = $("#login-dialog");
const registerDialog = $("#register-dialog");
const roomDialog = $("#room-dialog");
const shareDialog = $("#share-dialog");
let user = null;
let rooms = [];
let room = null;
let posts = [];
let replyTo = null;
let savedOnly = false;
let filter = "all";
let followLatest = true;
let roomSocket = null;
let socketRetry = null;
let realtimeRefresh = null;
let socketHeartbeat = null;
let inlineReplyActive = false;

memo.addEventListener("input", () => $("#counter").textContent = `${memo.value.length} / 280`);
memo.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    body.room_id = room.id;
    if (replyTo) body.parent_id = replyTo;
    await api("/api/posts", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    clearReply();
    closeComposer();
    $("#counter").textContent = "0 / 280";
    followLatest = true;
    await loadPosts();
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#login-open").addEventListener("click", () => loginDialog.showModal());
$("#register-open").addEventListener("click", () => registerDialog.showModal());
$("#create-room-open").addEventListener(
  "click",
  () => user ? roomDialog.showModal() : registerDialog.showModal(),
);
document.querySelectorAll(".dialog-close").forEach((button) =>
  button.addEventListener("click", () => button.closest("dialog").close())
);
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const loginForm = event.currentTarget;
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(loginForm))),
    });
    user = result.user;
    loginDialog.close();
    syncUser();
    await loadRooms();
  } catch (error) {
    showToast(error.message);
  }
});
$("#register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const registerForm = event.currentTarget;
  const body = Object.fromEntries(new FormData(registerForm));
  if (body.password !== body.password_confirm) {
    showToast("パスワードが一致しません");
    return;
  }
  delete body.password_confirm;
  try {
    const result = await api("/api/register", { method: "POST", body: JSON.stringify(body) });
    user = result.user;
    registerDialog.close();
    registerForm.reset();
    syncUser();
    await loadRooms();
  } catch (error) {
    showToast(error.message);
  }
});
$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  user = null;
  syncUser();
  history.replaceState({}, "", "/");
  await showHome();
});
$("#room-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const roomForm = event.currentTarget;
  try {
    const created = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(roomForm))),
    });
    roomDialog.close();
    roomForm.reset();
    await loadRooms();
    await openRoom(created.slug, true);
  } catch (error) {
    showToast(error.message);
  }
});
$("#rooms").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-slug]");
  if (button) openRoom(button.dataset.slug, true);
});
$("#reply-cancel").addEventListener("click", clearReply);
$("#compose-open").addEventListener("click", () => openComposer());
$("#compose-close").addEventListener("click", closeComposer);
$("#refresh").addEventListener("click", loadPosts);
$("#view-toggle").addEventListener("click", () => {
  savedOnly = !savedOnly;
  $("#view-toggle").setAttribute("aria-pressed", String(savedOnly));
  loadPosts();
});
document.querySelector(".map-filters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((item) =>
    item.setAttribute("aria-pressed", String(item === button))
  );
  renderFilteredGraph();
});
$("#share-room").addEventListener("click", showShare);
$("#copy-url").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#room-url").value);
  showToast("リンクをコピーしました");
});
$("#native-share").addEventListener("click", async () => {
  const url = $("#room-url").value;
  if (navigator.share) await navigator.share({ title: `${room.name} | tavy`, url });
  else await navigator.clipboard.writeText(url);
});

function syncUser() {
  $("#user-label").textContent = user ? user.id : "";
  $("#login-open").hidden = Boolean(user);
  $("#register-open").hidden = Boolean(user);
  $("#logout").hidden = !user;
}
async function loadRooms() {
  const owned = (await api("/api/rooms")).rooms;
  const history = readRoomHistory();
  const visited = await Promise.all(history.map(async (slug) => {
    try {
      return (await api(`/api/rooms/${slug}`)).room;
    } catch {
      return null;
    }
  }));
  const bySlug = new Map(owned.map((item) => [item.slug, item]));
  for (const item of visited) if (item) bySlug.set(item.slug, item);
  rooms = [
    ...history.map((slug) => bySlug.get(slug)).filter(Boolean),
    ...owned.filter((item) => !history.includes(item.slug)),
  ];
  writeRoomHistory(rooms.filter((item) => history.includes(item.slug)).map((item) => item.slug));
  renderRooms();
}
function renderRooms() {
  $("#no-rooms").hidden = rooms.length > 0;
  $("#rooms").replaceChildren(...rooms.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.slug = item.slug;
    button.className = "room";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const count = document.createElement("span");
    count.textContent = `${item.post_count}件`;
    button.append(name, count);
    return button;
  }));
}
async function openRoom(slug, updateUrl = false) {
  room = (await api(`/api/rooms/${slug}`)).room;
  rememberRoom(room.slug);
  if (updateUrl) history.pushState({}, "", `/r/${slug}`);
  document.body.classList.add("room-view");
  $("#room-content").hidden = false;
  $("#current-room-name").textContent = room.name;
  clearReply();
  closeComposer();
  await loadPosts();
  connectRoomSocket();
}
function readRoomHistory() {
  try {
    const value = JSON.parse(localStorage.getItem("tavy_rooms") ?? "[]");
    return Array.isArray(value)
      ? value.filter((slug) => typeof slug === "string" && /^[A-Za-z0-9_-]+$/.test(slug)).slice(
        0,
        50,
      )
      : [];
  } catch {
    return [];
  }
}
function writeRoomHistory(slugs) {
  localStorage.setItem("tavy_rooms", JSON.stringify(slugs.slice(0, 50)));
}
function rememberRoom(slug) {
  writeRoomHistory([slug, ...readRoomHistory().filter((item) => item !== slug)]);
}
async function showHome() {
  disconnectRoomSocket();
  room = null;
  posts = [];
  document.body.classList.remove("room-view", "composer-open");
  $("#room-content").hidden = true;
  document.querySelector(".inline-reply")?.remove();
  await loadRooms();
}
function connectRoomSocket() {
  disconnectRoomSocket();
  if (!room || document.hidden) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${room.slug}/ws`);
  roomSocket = socket;
  socket.addEventListener("open", () => {
    socketHeartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25000);
  });
  socket.addEventListener("message", (event) => {
    if (event.data !== '{"type":"changed"}') return;
    clearTimeout(realtimeRefresh);
    realtimeRefresh = setTimeout(() => room && loadPosts(), 30);
  });
  socket.addEventListener("close", () => {
    if (roomSocket !== socket) return;
    roomSocket = null;
    if (room && !document.hidden) socketRetry = setTimeout(connectRoomSocket, 1500);
  });
}
function disconnectRoomSocket() {
  clearTimeout(socketRetry);
  clearInterval(socketHeartbeat);
  socketRetry = null;
  socketHeartbeat = null;
  if (roomSocket) {
    const socket = roomSocket;
    roomSocket = null;
    socket.close();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) disconnectRoomSocket();
  else if (room) {
    loadPosts();
    connectRoomSocket();
  }
});
async function loadPosts() {
  if (!room || inlineReplyActive) return;
  const params = new URLSearchParams({ room: room.slug });
  if (savedOnly) params.set("saved", "1");
  posts = (await api(`/api/posts?${params}`)).posts;
  renderFilteredGraph();
}

function renderFilteredGraph() {
  const filtered = filter === "liked"
    ? posts.filter((post) => post.likes > 0)
    : filter === "bookmarked"
    ? posts.filter((post) => post.bookmarked)
    : filter === "own"
    ? posts.filter((post) => post.own)
    : filter === "question"
    ? posts.filter((post) => /[？?]$/.test(post.body.trimEnd()))
    : filter === "replied"
    ? posts.filter((post) => post.replies > 0)
    : posts;
  renderGraph(filtered);
  $("#empty").hidden = filtered.length > 0;
  $("#empty").textContent = posts.length
    ? "条件に合うつぶやきはありません。"
    : "まだ言葉はありません。";
}

function renderGraph(items) {
  const byParent = new Map();
  for (const item of items) {
    const key = item.parent_id ?? 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(item);
  }
  const ids = new Set(items.map((item) => item.id));
  const roots = items.filter((item) => item.parent_id == null || !ids.has(item.parent_id));
  const rows = [];
  function append(item, depth) {
    rows.push(threadRow(item, depth));
    for (const child of byParent.get(item.id) ?? []) append(child, depth + 1);
  }
  roots.forEach((root) => append(root, 0));
  graph.replaceChildren(...rows);
  if (followLatest) requestAnimationFrame(() => notes.scrollTop = notes.scrollHeight);
}

function threadRow(item, depth) {
  const row = document.createElement("article");
  row.className = `thread-row mood-${item.mood}`;
  row.style.setProperty("--depth", Math.min(depth, 12));
  row.dataset.id = item.id;
  if (item.own) row.classList.add("own");
  const body = document.createElement("p");
  body.textContent = item.body;
  body.title = "クリックして返信";
  body.addEventListener("click", () => showInlineReply(item));
  const actions = document.createElement("div");
  actions.className = "thread-actions";
  if (item.own) {
    actions.append(rowAction("edit", item, "✎", "編集"));
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "action-placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    actions.append(placeholder);
  }
  actions.append(
    rowAction("reply", item, "↩", "返信"),
    rowAction("like", item, item.liked ? `♥ ${item.likes}` : `♡ ${item.likes}`, "いいね"),
    rowAction("bookmark", item, item.bookmarked ? "◆" : "◇", "ブックマーク"),
  );
  row.append(body, actions);
  return row;
}

function rowAction(action, item, label, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  const active = action === "like" ? item.liked : action === "bookmark" && item.bookmarked;
  button.className = active ? "active" : "";
  button.addEventListener("click", async () => {
    if (action === "reply") return showInlineReply(item);
    if (action === "edit") return showInlineEdit(item);
    await api(`/api/posts/${item.id}/${action}`, { method: "PUT" });
    await loadPosts();
  });
  return button;
}

function showInlineEdit(item) {
  followLatest = false;
  inlineReplyActive = false;
  document.querySelector(".inline-reply")?.remove();
  const row = graph.querySelector(`[data-id="${item.id}"]`);
  const editor = inlineForm(item.body, "保存", async (value) => {
    await api(`/api/posts/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: value }),
    });
    await loadPosts();
  }, true);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "delete-action";
  remove.textContent = "削除";
  remove.addEventListener("click", () => deletePost(item));
  editor.append(remove);
  row.after(editor);
  editor.querySelector("textarea").focus();
}

async function deletePost(item) {
  if (!confirm("この発言を削除しますか？")) return;
  await api(`/api/posts/${item.id}`, { method: "DELETE" });
  await loadPosts();
}

function inlineForm(value, submitLabel, save, allowEmpty = false) {
  const editor = document.createElement("form");
  editor.className = "inline-reply";
  const input = document.createElement("textarea");
  input.maxLength = 280;
  input.rows = 1;
  input.value = value;
  input.required = !allowEmpty;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = submitLabel;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", () => editor.remove());
  editor.append(input, submit, cancel);
  editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    await save(input.value);
    editor.remove();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      editor.requestSubmit();
    }
  });
  return editor;
}

function showInlineReply(item) {
  followLatest = false;
  closeComposer();
  inlineReplyActive = true;
  document.querySelector(".inline-reply")?.remove();
  const row = graph.querySelector(`[data-id="${item.id}"]`);
  const reply = document.createElement("form");
  reply.className = "inline-reply";
  reply.style.setProperty("--depth", Math.min(threadDepth(item) + 1, 12));
  const input = document.createElement("textarea");
  input.maxLength = 280;
  input.rows = 1;
  input.placeholder = `「${item.body.slice(0, 24)}」に返信`;
  input.required = true;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      reply.requestSubmit();
    }
  });
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "返信";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "キャンセル";
  cancel.addEventListener("click", () => {
    inlineReplyActive = false;
    reply.remove();
  });
  reply.append(input, submit, cancel);
  reply.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api("/api/posts", {
        method: "POST",
        body: JSON.stringify({
          room_id: room.id,
          parent_id: item.id,
          body: input.value,
          mood: "note",
        }),
      });
      inlineReplyActive = false;
      reply.remove();
      await loadPosts();
    } catch (error) {
      submit.disabled = false;
      showToast(error.message);
    }
  });
  row.after(reply);
  input.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    reply.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function threadDepth(item) {
  let depth = 0;
  let current = item;
  while (current.parent_id && depth < 12) {
    current = posts.find((post) => post.id === current.parent_id) ?? {};
    depth++;
  }
  return depth;
}

function clearReply() {
  replyTo = null;
  inlineReplyActive = false;
  $("#reply-target").hidden = true;
  $("#compose-title").textContent = "つぶやく";
}
function openComposer() {
  document.body.classList.add("composer-open");
  requestAnimationFrame(() => memo.focus());
}
function closeComposer() {
  document.body.classList.remove("composer-open");
  clearReply();
}
function showShare() {
  const url = `${location.origin}/r/${room.slug}`;
  $("#room-url").value = url;
  $("#room-qr").src = `/api/rooms/${room.slug}/qr`;
  $("#native-share").hidden = !navigator.share;
  shareDialog.showModal();
}

notes.addEventListener("scroll", () => {
  followLatest = notes.scrollHeight - notes.scrollTop - notes.clientHeight < 48;
}, { passive: true });
async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "通信に失敗しました");
  return result;
}
let toastTimer;
function showToast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2200);
}

const me = await api("/api/me");
user = me.user;
syncUser();
await loadRooms();
const sharedSlug = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/)?.[1];
if (sharedSlug) await openRoom(sharedSlug);
globalThis.addEventListener("popstate", async () => {
  const slug = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/)?.[1];
  if (slug) await openRoom(slug);
  else await showHome();
});
setInterval(() => room && loadPosts(), 15000);
