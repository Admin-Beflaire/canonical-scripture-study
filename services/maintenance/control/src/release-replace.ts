import type {D1Database} from './d1.ts';
import {inChunks, type Output} from './release-check.ts';
import {partOf, units} from './release-members.ts';

/** `replaces` drops a whole source revision. That is allowed only when the release that results
 *  gives, from the build's own source revisions, every capability the dropped data gave, over
 *  every native unit it covered. Data listed by units that do not name content cannot be shown
 *  to be covered, so it is not dropped this way. */

interface CoverageRow {
  output_id: string;
  source_revision_id: string;
  capability: string;
  state: string;
  native_extent_json: string;
}

/** One thing a source revision gave: a capability over units of one coordinate system. */
interface Given {
  key: string;
  revision: string;
  capability: string;
  units: string[];
  /** Whether every unit names content, so that another revision can be compared by it. */
  comparable: boolean;
}

const PARTS = 20;

const VERSE = /^[1-3]?[A-Za-z]{2,8}\.\d{1,3}\.\d{1,3}$/;

/** A native verse or the whole statement names content. A technical part, such as a page of a
 *  language aid, holds other content in each revision under the same name. */
const namesContent = (unit: string, coordinates: unknown) =>
  VERSE.test(unit) ||
  (unit === 'statement' && coordinates === 'character-statement/1');

/** What one coverage row says, comparable between source revisions: a row about the output's own
 *  revision matches the same row about another own revision; a row about a third revision keeps
 *  naming it. Null when the row does not list its units. */
function given(row: CoverageRow, output: Output): Given | null {
  const list = units(
    JSON.parse(row.native_extent_json) as Record<string, unknown>,
  );
  if (row.state === 'unresolved' || !list) return null;
  const revision = output.revisions[0];
  const about =
    row.source_revision_id === revision ? '' : row.source_revision_id;
  return {
    key: JSON.stringify([
      row.capability,
      about,
      output.extent.coordinate_version ?? null,
    ]),
    revision,
    capability: row.capability,
    units: list,
    comparable: list.every(unit =>
      namesContent(unit, output.extent.coordinate_version),
    ),
  };
}

async function coverageOf(db: D1Database, outputs: Output[]) {
  const rows = await inChunks<CoverageRow>(
    db,
    marks =>
      `SELECT output_id, source_revision_id, capability, state, native_extent_json
    FROM coverage WHERE output_id IN (${marks})`,
    outputs.map(item => item.id),
  );
  const byId = new Map(outputs.map(item => [item.id, item]));
  return rows.map(row => ({row, output: byId.get(row.output_id)!}));
}

/** What the dropped data gave, and the outputs whose records cannot show it. */
async function dataDropped(db: D1Database, dropped: Output[]) {
  const rows = await coverageOf(db, dropped);
  const recorded = new Set(rows.map(item => item.output.id));
  const unclear = dropped.filter(item => !recorded.has(item.id));
  const gave: Given[] = [];
  const parts: Given[] = [];
  for (const {row, output} of rows) {
    if (row.state === 'missing') continue;
    const found = given(row, output);
    if (!found) unclear.push(output);
    else (found.comparable ? gave : parts).push(found);
  }
  return {gave, parts, unclear};
}

/** Units that are available, by key. */
async function dataAvailable(db: D1Database, outputs: Output[]) {
  const have = new Map<string, Set<string>>();
  for (const {row, output} of await coverageOf(db, outputs)) {
    if (row.state !== 'available') continue;
    const found = given(row, output);
    if (!found) continue;
    const set = have.get(found.key) ?? new Set<string>();
    found.units.forEach(unit => set.add(unit));
    have.set(found.key, set);
  }
  return have;
}

function partsOf(list: string[]) {
  const parts = [...new Set(list.map(partOf))].sort();
  const more = parts.length - PARTS;
  return `${parts.slice(0, PARTS).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** One problem for each capability of a replaced revision that would be lost. */
function lost(gave: Given[], have: Map<string, Set<string>>, from: string[]) {
  const missing = new Map<string, {item: Given; units: Set<string>}>();
  for (const item of gave) {
    const entry = missing.get(`${item.revision} ${item.key}`) ?? {
      item,
      units: new Set<string>(),
    };
    item.units
      .filter(unit => !have.get(item.key)?.has(unit))
      .forEach(unit => entry.units.add(unit));
    if (entry.units.size) missing.set(`${item.revision} ${item.key}`, entry);
  }
  return [...missing.values()].map(({item, units}) => {
    const list = [...units].sort();
    const why = have.has(item.key)
      ? 'does not give'
      : 'does not give, in the same native coordinates,';
    return `replaces ${item.revision} is refused: ${from.join(', ')} ${why} ${item.capability} for ${list.length} unit(s) of it, in ${partsOf(list)}, first ${list[0]}`;
  });
}

/** One problem for each capability that only technical parts record. */
function incomparable(parts: Given[], from: string[]) {
  const each = new Map(
    parts.map(item => [`${item.revision} ${item.capability}`, item]),
  );
  return [...each.values()].map(
    ({revision, capability, units}) =>
      `replaces ${revision} is refused: its ${capability} is listed by technical parts such as ${units[0]}, not by content, so the records cannot show that ${from.join(', ')} keeps it`,
  );
}

/** Why the sources a build `replaces` may not be dropped. `current` holds the members before,
 *  `result` the members after, `built` the build's own outputs. */
export async function replacementProblems(
  db: D1Database,
  replaces: Set<string>,
  current: Output[],
  result: Output[],
  built: Output[],
) {
  const kept = new Set(result.map(item => item.id));
  const dropped = current.filter(
    item => replaces.has(item.revisions[0]) && !kept.has(item.id),
  );
  if (!dropped.length) return [];
  const from = [...new Set(built.map(item => item.revisions[0]))].sort();
  const {gave, parts, unclear} = await dataDropped(db, dropped);
  const have = await dataAvailable(
    db,
    result.filter(item => from.includes(item.revisions[0])),
  );
  return [
    ...[...new Set(unclear.map(item => item.id))]
      .slice(0, PARTS)
      .map(
        id =>
          `replaces is refused: the records do not show what output ${id} covers`,
      ),
    ...incomparable(parts, from),
    ...lost(gave, have, from),
  ];
}
