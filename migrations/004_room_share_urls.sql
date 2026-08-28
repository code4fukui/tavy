ALTER TABLE rooms ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX rooms_slug_idx ON rooms(slug);

DELETE FROM reactions WHERE post_id IN (
  SELECT p.id FROM posts p JOIN rooms r ON r.id = p.room_id
  WHERE r.name = 'みんなのルーム' AND r.owner_id = 'admin'
);
DELETE FROM bookmarks WHERE post_id IN (
  SELECT p.id FROM posts p JOIN rooms r ON r.id = p.room_id
  WHERE r.name = 'みんなのルーム' AND r.owner_id = 'admin'
);
DELETE FROM posts WHERE room_id IN (
  SELECT id FROM rooms WHERE name = 'みんなのルーム' AND owner_id = 'admin'
);
DELETE FROM rooms WHERE name = 'みんなのルーム' AND owner_id = 'admin';
