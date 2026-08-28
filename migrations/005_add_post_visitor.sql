ALTER TABLE posts ADD COLUMN visitor_id TEXT;
CREATE INDEX posts_visitor_created_at_idx ON posts(visitor_id, created_at DESC);
