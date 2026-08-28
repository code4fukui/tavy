CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
  mood TEXT NOT NULL CHECK (mood IN ('idea', 'question', 'agree', 'note')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE reactions (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, visitor_id)
) STRICT;

CREATE TABLE bookmarks (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (post_id, visitor_id)
) STRICT;

CREATE INDEX posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX bookmarks_visitor_created_idx ON bookmarks(visitor_id, created_at DESC);
