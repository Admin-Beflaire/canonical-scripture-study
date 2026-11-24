-- Exact key-to-output routing for selected search indexes.
-- Outputs created before this migration have no route and retain the full-walk fallback.
CREATE TABLE index_routes (
  output_id TEXT PRIMARY KEY REFERENCES prepared_outputs(id),
  keys_json TEXT NOT NULL CHECK (json_valid(keys_json) AND json_type(keys_json) = 'array')
) STRICT;
CREATE TABLE index_route_keys (
  search_key TEXT NOT NULL,
  output_id TEXT NOT NULL REFERENCES index_routes(output_id),
  PRIMARY KEY (search_key, output_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX index_route_keys_output ON index_route_keys(output_id);
-- Expand one prepared record per output. The D1 candidate batch is atomic.
CREATE TRIGGER index_routes_keys_insert AFTER INSERT ON index_routes BEGIN
  INSERT INTO index_route_keys(search_key, output_id)
  SELECT DISTINCT value, NEW.output_id FROM json_each(NEW.keys_json)
  WHERE type = 'text' AND length(value) > 0;
END;
CREATE TRIGGER index_routes_insert_selected BEFORE INSERT ON index_routes
WHEN EXISTS (SELECT 1 FROM release_outputs ro JOIN release_selection rs
  ON ro.release_id IN (rs.current_release_id, rs.previous_release_id)
  WHERE ro.output_id = NEW.output_id)
BEGIN SELECT RAISE(ABORT, 'Selected output routing is immutable'); END;
