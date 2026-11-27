import {canonicalJson} from './d1.ts';
import type {Output} from './release-check.ts';

/** Which outputs a release holds when something is added, replaced or removed. Pure. */

export const units = (extent: Record<string, unknown>) =>
  Array.isArray(extent.unit_ids) &&
  extent.unit_ids.length &&
  extent.unit_ids.every(unit => typeof unit === 'string')
    ? (extent.unit_ids as string[])
    : null;

/** The part of a source a native unit belongs to: its name up to the first dot, which for a
 *  Bible text is the book. */
export const partOf = (unit: string) => unit.split('.')[0];

/** Same kind, except that an `aid_entries` output replaces the `evidence` output that held the
 *  same language aids before they moved to an entries file (same source revision, coordinate
 *  version and units). An `evidence` candidate never replaces an `aid_entries` output. */
const sameKind = (base: Output, next: Output) =>
  base.kind === next.kind ||
  (base.kind === 'evidence' && next.kind === 'aid_entries');

export const overlaps = (a: Output, b: Output) => {
  if (
    !sameKind(a, b) ||
    a.revisions[0] !== b.revisions[0] ||
    a.extent.coordinate_version !== b.extent.coordinate_version
  )
    return false;
  const left = units(a.extent);
  const right = units(b.extent);
  if (!left || !right)
    return canonicalJson(a.extent) === canonicalJson(b.extent);
  const set = new Set(left);
  return right.some(unit => set.has(unit));
};

/** Base members kept, plus the candidate. Same-kind outputs of the same source revision over
 *  overlapping native units are replaced; `replaces` and `removes` drop whole source revisions.
 *  A kept output that depends on a dropped one is a problem: it would point at nothing. */
export function membership(
  base: Output[],
  candidate: Output[],
  replaces: Set<string>,
  removes: Set<string>,
) {
  const candidateIds = new Set(candidate.map(item => item.id));
  const dropped = base.filter(
    item =>
      !candidateIds.has(item.id) &&
      (replaces.has(item.revisions[0]) ||
        removes.has(item.revisions[0]) ||
        candidate.some(next => overlaps(item, next))),
  );
  const droppedIds = new Set(dropped.map(item => item.id));
  const kept = base.filter(item => !droppedIds.has(item.id));
  const all = [
    ...kept,
    ...candidate.filter(item => !kept.some(old => old.id === item.id)),
  ];
  const problems = kept
    .filter(item =>
      item.dependencies.some(dependency => droppedIds.has(dependency)),
    )
    .map(item => `kept output ${item.id} depends on an output this task drops`);
  return {
    ids: all.map(item => item.id).sort(),
    all,
    dropped: [...droppedIds].sort(),
    problems,
  };
}
