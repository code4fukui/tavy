CREATE TABLE room_members (
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visited_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (room_id, user_id)
) STRICT;
CREATE INDEX room_members_user_visited_idx ON room_members(user_id, visited_at DESC);
