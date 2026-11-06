import { assertReference, serializeReference } from "./references.ts";
import type { NativeReference } from "./references.ts";

/** In-memory correspondence input; storage relationship records remain domain-owned. */
export interface VersificationMapping {
  from: NativeReference;
  to: NativeReference[];
  status: "exact" | "partial" | "disputed" | "missing" | "unresolved";
  basis: string;
  gap_reason?: string;
}

/** Validate and copy explicit mappings; never infer a match from a shared verse label. */
export function mappingsFor(
  reference: NativeReference,
  mappings: readonly VersificationMapping[],
): VersificationMapping[] {
  const key = serializeReference(reference);
  const result: VersificationMapping[] = [];
  for (const mapping of mappings) {
    assertReference(mapping.from);
    for (const target of mapping.to) assertReference(target);
    if (!["exact", "partial", "disputed", "missing", "unresolved"].includes(mapping.status) ||
        typeof mapping.basis !== "string" || !mapping.basis.trim() ||
        (mapping.gap_reason !== undefined && (typeof mapping.gap_reason !== "string" || !mapping.gap_reason.trim())) ||
        (mapping.status === "missing" && (mapping.to.length !== 0 || !mapping.gap_reason)) ||
        (["exact", "partial", "disputed"].includes(mapping.status) && mapping.to.length === 0) ||
        (mapping.to.length === 0 && !mapping.gap_reason)) {
      throw new Error("Invalid versification mapping");
    }
    if (serializeReference(mapping.from) === key) result.push(structuredClone(mapping));
  }
  return result;
}
