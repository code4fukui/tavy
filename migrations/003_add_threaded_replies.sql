ALTER TABLE posts ADD COLUMN parent_id INTEGER REFERENCES posts(id);
CREATE INDEX posts_parent_created_at_idx ON posts(parent_id, created_at);
