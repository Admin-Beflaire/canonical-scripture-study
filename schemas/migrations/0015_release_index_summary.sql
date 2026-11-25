-- One stored summary per release, source and capability of the index outputs it selects, so a
-- search reads one row instead of scanning every output's coverage, membership and route rows.
-- Derived from coverage, release membership and routes when the release is created.
-- A release without a summary row keeps the full scan.
CREATE TABLE release_index_summary (
  release_id TEXT NOT NULL REFERENCES releases(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  capability TEXT NOT NULL,
  has_routing INTEGER NOT NULL CHECK (has_routing IN (0, 1)),
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json) AND json_type(outputs_json) = 'array'),
  PRIMARY KEY (release_id, source_revision_id, capability)
) STRICT, WITHOUT ROWID;
