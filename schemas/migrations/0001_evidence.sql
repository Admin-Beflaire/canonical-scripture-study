-- Evidence contracts only. Task state and preparation transactions belong to Maintenance.
CREATE TABLE source_nodes (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('work','edition','representation','source_revision')),
  parent_id TEXT REFERENCES source_nodes(id),
  name TEXT NOT NULL CHECK (length(name) > 0),
  attribution TEXT NOT NULL CHECK (length(attribution) > 0),
  origin TEXT NOT NULL CHECK (length(origin) > 0),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  CHECK ((kind = 'work' AND parent_id IS NULL) OR (kind <> 'work' AND parent_id IS NOT NULL))
) STRICT;
CREATE INDEX source_nodes_parent ON source_nodes(parent_id, kind);
CREATE TRIGGER source_parent_kind BEFORE INSERT ON source_nodes
WHEN NEW.parent_id IS NOT NULL AND
  (SELECT kind FROM source_nodes WHERE id = NEW.parent_id) IS NOT
  CASE NEW.kind WHEN 'edition' THEN 'work' WHEN 'representation' THEN 'edition' ELSE 'representation' END
BEGIN SELECT RAISE(ABORT, 'Invalid source hierarchy'); END;
CREATE TRIGGER source_identity_stable BEFORE UPDATE OF id, kind, parent_id ON source_nodes
BEGIN SELECT RAISE(ABORT, 'Source hierarchy identities are immutable'); END;

CREATE TABLE admissions (
  id TEXT PRIMARY KEY NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  component TEXT NOT NULL CHECK (length(component) > 0),
  terms_basis TEXT NOT NULL CHECK (length(terms_basis) > 0),
  permitted_uses_json TEXT NOT NULL CHECK (json_valid(permitted_uses_json) AND json_type(permitted_uses_json) = 'array'),
  restrictions_json TEXT NOT NULL CHECK (json_valid(restrictions_json) AND json_type(restrictions_json) = 'array'),
  notices_json TEXT NOT NULL CHECK (json_valid(notices_json) AND json_type(notices_json) = 'array'),
  both_hosts_eligible INTEGER NOT NULL CHECK (both_hosts_eligible IN (0,1)),
  public_redistribution TEXT NOT NULL CHECK (public_redistribution IN ('allowed','not_allowed','unresolved')),
  UNIQUE(source_revision_id, component)
) STRICT;

CREATE TABLE prepared_outputs (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  input_revisions_json TEXT NOT NULL CHECK (json_valid(input_revisions_json) AND json_type(input_revisions_json) = 'array' AND json_array_length(input_revisions_json) > 0),
  method_version TEXT NOT NULL CHECK (length(method_version) > 0),
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json) AND json_type(parameters_json) = 'object'),
  native_extent_json TEXT NOT NULL CHECK (json_valid(native_extent_json) AND json_type(native_extent_json) = 'object'),
  validation_basis_json TEXT NOT NULL CHECK (json_valid(validation_basis_json) AND json_type(validation_basis_json) = 'object')
) STRICT;
CREATE TRIGGER prepared_identity_stable BEFORE UPDATE ON prepared_outputs
BEGIN SELECT RAISE(ABORT, 'Prepared outputs are immutable'); END;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  output_id TEXT REFERENCES prepared_outputs(id),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_count INTEGER NOT NULL CHECK (byte_count BETWEEN 0 AND 9007199254740991),
  format TEXT NOT NULL CHECK (length(format) > 0),
  registered_locator TEXT NOT NULL CHECK (
    length(registered_locator) > 0 AND substr(registered_locator,1,1) <> '/' AND
    instr(registered_locator,'://') = 0 AND instr(registered_locator,char(92)) = 0 AND
    instr('/' || registered_locator || '/','/../') = 0 AND
    instr(registered_locator,'?') = 0 AND instr(registered_locator,'#') = 0)
) STRICT;
CREATE INDEX artifacts_source ON artifacts(source_revision_id);
CREATE INDEX artifacts_output ON artifacts(output_id);
CREATE INDEX artifacts_digest ON artifacts(sha256);

CREATE TABLE text_payloads (
  content_id TEXT PRIMARY KEY NOT NULL CHECK (length(content_id) = 64 AND content_id NOT GLOB '*[^0-9a-f]*'),
  exact_text TEXT NOT NULL
) STRICT;
CREATE TABLE native_spans (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  parent_id TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  native_order INTEGER NOT NULL CHECK (native_order BETWEEN 0 AND 9007199254740991),
  coordinate_version TEXT NOT NULL,
  segments_json TEXT NOT NULL CHECK (json_valid(segments_json) AND json_type(segments_json) = 'array' AND json_array_length(segments_json) > 0),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  content_id TEXT REFERENCES text_payloads(content_id),
  body_ranges_json TEXT NOT NULL CHECK (json_valid(body_ranges_json) AND json_type(body_ranges_json) = 'array'),
  reading_kind TEXT NOT NULL CHECK (reading_kind IN ('preserved','transcribed','extracted','restored','reconstructed','variant','translation','gap')),
  CHECK ((content_id IS NOT NULL AND json_array_length(body_ranges_json) = 0) OR
         (content_id IS NULL AND (json_array_length(body_ranges_json) > 0 OR reading_kind = 'gap'))),
  UNIQUE(id, source_revision_id),
  UNIQUE(id, source_revision_id, coordinate_version),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY(parent_id, source_revision_id, coordinate_version) REFERENCES native_spans(id, source_revision_id, coordinate_version)
) STRICT;
CREATE INDEX native_spans_output ON native_spans(output_id, source_revision_id, native_order, id);
CREATE INDEX native_spans_source_order ON native_spans(source_revision_id, native_order, id);
CREATE INDEX native_spans_parent ON native_spans(parent_id, source_revision_id, coordinate_version);
CREATE INDEX native_spans_payload ON native_spans(content_id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  span_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object'),
  details_json TEXT NOT NULL CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
  FOREIGN KEY(span_id, source_revision_id) REFERENCES native_spans(id, source_revision_id)
) STRICT;
CREATE INDEX annotations_output ON annotations(output_id, span_id);
CREATE INDEX annotations_span ON annotations(span_id, source_revision_id, kind);
CREATE TABLE relationships (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  kind TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('directed','undirected')),
  status TEXT NOT NULL CHECK (status IN ('proposed','supported','disputed','unresolved')),
  basis_json TEXT NOT NULL CHECK (json_valid(basis_json) AND json_type(basis_json) = 'object')
) STRICT;
CREATE INDEX relationships_output_kind ON relationships(output_id, kind, id);
CREATE TABLE relation_members (
  relationship_id TEXT NOT NULL REFERENCES relationships(id),
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9007199254740991),
  span_id TEXT REFERENCES native_spans(id),
  correspondence TEXT NOT NULL CHECK (correspondence IN ('exact','partial','reordered','composite','missing','unresolved')),
  gap_reason TEXT,
  CHECK (span_id IS NOT NULL OR (correspondence IN ('missing','unresolved') AND gap_reason IS NOT NULL AND length(gap_reason) > 0)),
  PRIMARY KEY(relationship_id, role, ordinal)
) STRICT;
CREATE INDEX relation_members_span ON relation_members(span_id, relationship_id, role, ordinal);

CREATE TABLE coverage (
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  source_revision_id TEXT NOT NULL REFERENCES source_nodes(id),
  native_extent_json TEXT NOT NULL CHECK (json_valid(native_extent_json) AND json_type(native_extent_json) = 'object'),
  capability TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','partial','missing','unresolved')),
  method_version TEXT NOT NULL,
  index_artifact_id TEXT REFERENCES artifacts(id),
  dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json) = 'array'),
  limitation TEXT,
  CHECK (state = 'available' OR (limitation IS NOT NULL AND length(limitation) > 0)),
  PRIMARY KEY(output_id, source_revision_id, capability)
) STRICT;
CREATE INDEX coverage_source ON coverage(source_revision_id, capability, output_id);
CREATE INDEX coverage_artifact ON coverage(index_artifact_id);
CREATE TABLE study_packages (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  subject TEXT NOT NULL,
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND json_type(source_refs_json) = 'array' AND json_array_length(source_refs_json) > 0),
  dependency_ids_json TEXT NOT NULL CHECK (json_valid(dependency_ids_json) AND json_type(dependency_ids_json) = 'array' AND json_array_length(dependency_ids_json) > 0)
) STRICT;
CREATE INDEX study_packages_output ON study_packages(output_id, id);
CREATE TABLE character_statements (
  id TEXT PRIMARY KEY NOT NULL,
  output_id TEXT NOT NULL UNIQUE REFERENCES prepared_outputs(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','approved')),
  scripture_basis_json TEXT NOT NULL CHECK (json_valid(scripture_basis_json) AND json_type(scripture_basis_json) = 'array' AND json_array_length(scripture_basis_json) > 0),
  owner_approval_ref TEXT,
  CHECK (status <> 'approved' OR (owner_approval_ref IS NOT NULL AND length(owner_approval_ref) > 0)),
  UNIQUE(name, version)
) STRICT;
CREATE TABLE releases (
  id TEXT PRIMARY KEY NOT NULL,
  manifest_revision TEXT NOT NULL CHECK (length(manifest_revision) > 0),
  recipe_revision TEXT NOT NULL CHECK (length(recipe_revision) > 0),
  schema_versions_json TEXT NOT NULL CHECK (json_valid(schema_versions_json) AND json_type(schema_versions_json) = 'object'),
  coverage_basis TEXT NOT NULL CHECK (length(coverage_basis) > 0),
  quality_receipt TEXT NOT NULL CHECK (length(quality_receipt) > 0),
  scope_receipt TEXT NOT NULL CHECK (length(scope_receipt) > 0)
) STRICT;
CREATE TABLE release_outputs (
  release_id TEXT NOT NULL REFERENCES releases(id),
  output_id TEXT NOT NULL REFERENCES prepared_outputs(id),
  PRIMARY KEY(release_id, output_id)
) STRICT;
CREATE INDEX release_outputs_output ON release_outputs(output_id, release_id);
CREATE TABLE release_selection (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  current_release_id TEXT REFERENCES releases(id),
  previous_release_id TEXT REFERENCES releases(id),
  CHECK (current_release_id IS NOT NULL OR previous_release_id IS NULL),
  CHECK (previous_release_id IS NULL OR previous_release_id <> current_release_id)
) STRICT;
INSERT INTO release_selection VALUES (1,NULL,NULL);

-- Relational integrity only; these constraints do not approve a statement or promote a release.
CREATE TRIGGER statement_output_kind BEFORE INSERT ON character_statements
WHEN (SELECT kind FROM prepared_outputs WHERE id = NEW.output_id) <> 'character_statement'
  OR EXISTS (SELECT 1 FROM release_outputs WHERE output_id = NEW.output_id)
BEGIN SELECT RAISE(ABORT, 'Statement must precede release membership with its own output kind'); END;
CREATE TRIGGER statement_update_guard BEFORE UPDATE ON character_statements
WHEN NEW.output_id <> OLD.output_id
  OR EXISTS (SELECT 1 FROM release_outputs WHERE output_id = OLD.output_id)
BEGIN SELECT RAISE(ABORT, 'Selected statement identity and approval are immutable'); END;
CREATE TRIGGER release_statement_limit BEFORE INSERT ON release_outputs
WHEN (SELECT kind FROM prepared_outputs WHERE id = NEW.output_id) = 'character_statement'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM character_statements WHERE output_id = NEW.output_id AND status = 'approved'
  ) THEN RAISE(ABORT, 'Only approved statements can enter a release') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM release_outputs AS ro JOIN character_statements AS cs ON cs.output_id = ro.output_id
    WHERE ro.release_id = NEW.release_id
  ) THEN RAISE(ABORT, 'At most one statement per release') END;
END;
CREATE TRIGGER release_membership_update_guard BEFORE UPDATE ON release_outputs
BEGIN SELECT RAISE(ABORT, 'Replace candidate memberships with explicit delete/insert'); END;
CREATE TRIGGER statement_delete_guard BEFORE DELETE ON character_statements
WHEN EXISTS (SELECT 1 FROM release_outputs WHERE output_id = OLD.output_id)
BEGIN SELECT RAISE(ABORT, 'Release membership retains its approved statement'); END;

CREATE TRIGGER admissions_revision_insert BEFORE INSERT ON admissions
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER admissions_revision_update BEFORE UPDATE ON admissions
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER artifacts_revision_insert BEFORE INSERT ON artifacts
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER artifacts_revision_update BEFORE UPDATE ON artifacts
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER native_spans_revision_insert BEFORE INSERT ON native_spans
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER native_spans_revision_update BEFORE UPDATE ON native_spans
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER annotations_revision_insert BEFORE INSERT ON annotations
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER annotations_revision_update BEFORE UPDATE ON annotations
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER coverage_revision_insert BEFORE INSERT ON coverage
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER coverage_revision_update BEFORE UPDATE ON coverage
WHEN (SELECT kind FROM source_nodes WHERE id = NEW.source_revision_id) <> 'source_revision'
BEGIN SELECT RAISE(ABORT, 'An exact source revision is required'); END;

CREATE TRIGGER text_payloads_immutable BEFORE UPDATE ON text_payloads
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;

CREATE TRIGGER artifacts_immutable BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;

CREATE TRIGGER native_spans_immutable BEFORE UPDATE ON native_spans
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;

CREATE TRIGGER releases_immutable BEFORE UPDATE ON releases
BEGIN SELECT RAISE(ABORT, 'Prepared evidence records are immutable'); END;
