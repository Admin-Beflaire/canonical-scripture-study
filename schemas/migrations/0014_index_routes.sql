-- Compact, indexed routing from normalized keys to immutable source/word index outputs.
-- Outputs without routes continue through the original full walk.
CREATE TABLE index_routes (
  output_key INTEGER PRIMARY KEY,
  output_id TEXT NOT NULL UNIQUE REFERENCES prepared_outputs(id),
  keys_json TEXT NOT NULL CHECK (json_valid(keys_json) AND json_type(keys_json) = 'array')
) STRICT;
CREATE TABLE index_route_keys (
  search_key TEXT NOT NULL,
  output_key INTEGER NOT NULL REFERENCES index_routes(output_key),
  PRIMARY KEY (search_key, output_key)
) STRICT, WITHOUT ROWID;
-- Expose saved pairs for semantic verification without a second write path.
CREATE VIEW index_route_key_records AS
SELECT r.output_id, k.search_key
FROM index_routes r
CROSS JOIN json_each(r.keys_json) j
JOIN index_route_keys k ON k.search_key = j.value AND k.output_key = r.output_key;
CREATE TRIGGER index_routes_keys_insert AFTER INSERT ON index_routes BEGIN
  INSERT INTO index_route_keys(search_key, output_key)
  SELECT DISTINCT value, NEW.output_key FROM json_each(NEW.keys_json)
  WHERE type = 'text' AND length(value) > 0;
END;
CREATE TRIGGER index_routes_insert_selected BEFORE INSERT ON index_routes
WHEN EXISTS (SELECT 1 FROM release_outputs ro JOIN release_selection rs
  ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = NEW.output_id)
BEGIN SELECT RAISE(ABORT, 'Selected output routing is immutable'); END;
