import type {D1Database} from './d1.ts';
import {partOf} from './release-members.ts';

/** What current data holds from each source revision, so a removal or a replacement can name it
 *  (Maintenance Technical §6). Read only; bounded pages. */

const REVISIONS = 10;
const PARTS = 100;

/** The current release's available coverage. */
const CURRENT = `release_selection s
  JOIN release_outputs ro ON ro.release_id = s.current_release_id
  JOIN coverage c ON c.output_id = ro.output_id`;
const AVAILABLE = `s.singleton_id = 1 AND c.state = 'available'`;

/** One stored extent of a source revision and the capabilities available over it. */
interface HeldRow {
  revision: string;
  extent: string;
  capabilities: string;
}

/** Each distinct extent once: its units are read here, not expanded into database rows. */
async function heldRows(db: D1Database, revisions: string[]) {
  if (!revisions.length) return [];
  const marks = revisions.map(() => '?').join(',');
  return (
    await db
      .prepare(
        `SELECT c.source_revision_id AS revision, c.native_extent_json AS extent,
    json_group_array(DISTINCT c.capability) AS capabilities
    FROM ${CURRENT} WHERE ${AVAILABLE} AND c.source_revision_id IN (${marks})
    GROUP BY 1, 2`,
      )
      .bind(...revisions)
      .all<HeldRow>()
  ).results;
}

/** How many native units these extents cover, and in which parts. */
function covered(extents: string[][]) {
  const units = new Set(extents.flat());
  const parts = [...new Set([...units].map(partOf))].sort();
  return {
    units: units.size,
    parts: parts.slice(0, PARTS),
    ...(parts.length > PARTS ? {more_parts: parts.length - PARTS} : {}),
  };
}

/** Capabilities held over the same extents are listed together. */
function holds(rows: HeldRow[]) {
  const extentsOf = new Map<string, number[]>();
  rows.forEach((row, index) => {
    for (const capability of JSON.parse(row.capabilities) as string[])
      extentsOf.set(capability, [...(extentsOf.get(capability) ?? []), index]);
  });
  const together = new Map<string, string[]>();
  for (const [capability, indexes] of [...extentsOf].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const key = indexes.join(' ');
    together.set(key, [...(together.get(key) ?? []), capability]);
  }
  return [...together].map(([key, capabilities]) => ({
    capabilities,
    ...covered(
      key
        .split(' ')
        .map(
          index =>
            (JSON.parse(rows[Number(index)].extent) as {unit_ids?: string[]})
              .unit_ids ?? [],
        ),
    ),
  }));
}

/** The source revisions in current data whose ID contains the word, after `after`. */
export async function currentSources(db: D1Database, find: string, after = '') {
  const found = (
    await db
      .prepare(
        `SELECT DISTINCT c.source_revision_id AS id FROM ${CURRENT}
    WHERE ${AVAILABLE} AND instr(lower(c.source_revision_id), ?) > 0 AND c.source_revision_id > ?
    ORDER BY c.source_revision_id LIMIT ?`,
      )
      .bind(find.toLowerCase(), after, REVISIONS + 1)
      .all<{id: string}>()
  ).results.map(row => row.id);
  const page = found.slice(0, REVISIONS);
  const rows = await heldRows(db, page);
  return {
    current_sources: page.map(id => ({
      source_revision: id,
      holds: holds(rows.filter(row => row.revision === id)),
    })),
    ...(found.length > page.length
      ? {next_sources_after: page[page.length - 1]}
      : {}),
  };
}
