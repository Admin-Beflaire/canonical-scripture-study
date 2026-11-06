import schema from "../../../schemas/native-reference.v1.schema.json" with { type: "json" };

export interface NativeSegment {
  unit_id: string;
  start: number;
  end: number;
}

export interface NativeReference {
  schema_version: "native-reference/1";
  source_revision_id: string;
  coordinate_version: string;
  segments: NativeSegment[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keysMatch(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function segment(value: unknown): value is NativeSegment {
  const declaration = schema.properties.segments.items;
  return record(value) && keysMatch(value, declaration.required) &&
    identifier(value.unit_id) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) &&
    (value.start as number) >= declaration.properties.start.minimum &&
    (value.end as number) >= (value.start as number);
}

/** Shape checks never establish source availability, attribution or equivalence. */
export function assertReference(value: unknown): asserts value is NativeReference {
  if (!record(value) || !keysMatch(value, schema.required) ||
      value.schema_version !== schema.properties.schema_version.const ||
      !identifier(value.source_revision_id) || !identifier(value.coordinate_version) ||
      !Array.isArray(value.segments) || value.segments.length < schema.properties.segments.minItems ||
      !value.segments.every(segment)) {
    throw new Error("Invalid native reference");
  }
}

export function parseReference(serialized: string): NativeReference {
  const value: unknown = JSON.parse(serialized);
  assertReference(value);
  return value;
}

/** Stable identity encoding: preserves strings and supplied segment order exactly. */
export function serializeReference(reference: NativeReference): string {
  assertReference(reference);
  return JSON.stringify({
    schema_version: reference.schema_version,
    source_revision_id: reference.source_revision_id,
    coordinate_version: reference.coordinate_version,
    segments: reference.segments.map(s => ({ unit_id: s.unit_id, start: s.start, end: s.end })),
  });
}

/** Only for a caller-supplied Unicode-scalar text profile, never UTF-16 offsets. */
export function extractScalarSegments(
  reference: NativeReference,
  textBasis: { source_revision_id: string; coordinate_version: string; units: ReadonlyMap<string, string> },
): string[] {
  assertReference(reference);
  if (reference.source_revision_id !== textBasis.source_revision_id ||
      reference.coordinate_version !== textBasis.coordinate_version) {
    throw new Error("Text coordinate basis mismatch");
  }
  return reference.segments.map(segment => {
    const text = textBasis.units.get(segment.unit_id);
    if (text === undefined || /[\uD800-\uDFFF]/u.test(text)) {
      throw new Error("Native scalar text unavailable");
    }
    const scalars = Array.from(text);
    if (segment.end > scalars.length) throw new Error("Native coordinate out of bounds");
    return scalars.slice(segment.start, segment.end).join("");
  });
}
