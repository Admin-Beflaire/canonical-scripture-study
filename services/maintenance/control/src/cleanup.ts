import {reportError} from '../../../../packages/shared/src/error-record.ts';
import type {D1Database} from './d1.ts';
import type {ObjectStore} from './selection.ts';
import {OPEN_STATES} from './tasks.ts';

/** Release cleanup (Proposal M2): keep only what selection and open work need.
 *
 *  Kept: the current and previous releases, the base and candidate releases of every open
 *  task, and the saved outputs of an open task's finished jobs. Removed: the membership rows
 *  of every other release, then the saved outputs that nothing kept uses, with their D1
 *  rows. Release records stay (tasks refer to them). A removed output goes in three steps:
 *  its content rows, then its stored objects in one call to the bucket (except an object
 *  another artifact record still names, and anything under receipts, checkpoints or the
 *  language-aid cache), then its artifact records. The records stay until the objects are gone,
 *  so a failure at any step is found and finished by the next call and no object is left
 *  without a record. Without a bucket no output is removed. The owner decided that no recovery
 *  copy is needed first.
 *
 *  It never changes what is selected, only deletes rows nothing kept refers to. Each call
 *  does a bounded amount of work, so a large backlog is cleared over several calls. A
 *  release's membership is removed whole, in one transaction: a release is either complete
 *  or empty, never partly cleaned, so validation cannot take a remainder for a release. */
const OPEN = `('${OPEN_STATES.join("','")}')`;
const UNFINISHED = `('intended','dispatched','running','checkpointed')`;
const RELEASES_PER_CALL = 20; // Releases whose membership is removed by one call.
const OUTPUTS_PER_CALL = 4; // Saved outputs removed by one call.
const OBJECTS_PER_DELETE = 1000; // Keys one bucket delete accepts.

/** Stored objects of one output that no other artifact record names. */
const OUTPUT_OBJECTS = `SELECT a.registered_locator AS key FROM artifacts a WHERE a.output_id = ?
  AND a.registered_locator LIKE 'prepared/%'
  AND a.registered_locator NOT LIKE 'prepared/receipts/%'
  AND a.registered_locator NOT LIKE 'prepared/checkpoints/%'
  AND a.registered_locator NOT LIKE 'prepared/language-aid-cache/%'
  AND NOT EXISTS (SELECT 1 FROM artifacts o WHERE o.registered_locator = a.registered_locator
    AND (o.output_id IS NULL OR o.output_id <> a.output_id))`;

const KEPT_RELEASES = `SELECT current_release_id AS id FROM release_selection WHERE current_release_id IS NOT NULL
  UNION SELECT previous_release_id FROM release_selection WHERE previous_release_id IS NOT NULL
  UNION SELECT base_release_id FROM maintenance_tasks WHERE state IN ${OPEN} AND base_release_id IS NOT NULL
  UNION SELECT candidate_release_id FROM maintenance_tasks WHERE state IN ${OPEN} AND candidate_release_id IS NOT NULL`;

/** Saved outputs no kept release lists and no open task's finished job refers to. An approved
 *  character-of-God statement is the owner's text and is never removed here. */
const UNUSED_OUTPUTS = `SELECT po.id FROM prepared_outputs po
  WHERE po.kind <> 'character_statement'
    AND NOT EXISTS (SELECT 1 FROM release_outputs ro WHERE ro.output_id = po.id)
    AND NOT EXISTS (
      SELECT 1 FROM maintenance_jobs j
        JOIN maintenance_tasks t ON t.id = j.task_id
        JOIN json_each(j.result_json, '$.output_refs') ref
        JOIN artifacts a ON a.id = json_extract(ref.value, '$.artifact_id')
      WHERE a.output_id = po.id AND j.state = 'succeeded' AND t.state IN ${OPEN})
  LIMIT ?`;

/** The D1 rows of one saved output that hold its content, children first. */
const OUTPUT_CONTENT = [
  `DELETE FROM span_segments WHERE span_id IN (SELECT id FROM native_spans WHERE output_id = ?)`,
  `DELETE FROM relation_members WHERE relationship_id IN (SELECT id FROM relationships WHERE output_id = ?)`,
  `DELETE FROM annotations WHERE output_id = ?`,
  `DELETE FROM relationships WHERE output_id = ?`,
  `DELETE FROM reader_reference_links WHERE output_id = ?`,
  `DELETE FROM reader_reference_bases WHERE output_id = ?`,
  `DELETE FROM coverage WHERE output_id = ?`,
  `DELETE FROM study_packages WHERE output_id = ?`,
  `DELETE FROM native_spans WHERE output_id = ?`,
];

/** Its artifact records and the output itself. They are kept until the stored objects are gone,
 *  so an interrupted or failed removal can find the objects again. */
const OUTPUT_RECORDS = [
  `DELETE FROM artifacts WHERE output_id = ?`,
  `DELETE FROM prepared_outputs WHERE id = ?`,
];

/** Every D1 row of one saved output, children first. */
export const OUTPUT_ROWS = [...OUTPUT_CONTENT, ...OUTPUT_RECORDS];

export interface Tidied {
  memberships: number;
  outputs: number;
  /** Saved outputs that could not be removed in this call (they are tried again next time). */
  skipped: number;
}

/** Remove what nothing kept uses. Never throws and never changes the selection. */
export async function tidyReleases(
  db: D1Database,
  objects: ObjectStore | null = null,
): Promise<Tidied> {
  const done: Tidied = {memberships: 0, outputs: 0, skipped: 0};
  try {
    const gone = (
      await db
        .prepare(
          `SELECT r.id FROM releases r WHERE r.id NOT IN (${KEPT_RELEASES})
            AND EXISTS (SELECT 1 FROM release_outputs ro WHERE ro.release_id = r.id) LIMIT ?`,
        )
        .bind(RELEASES_PER_CALL)
        .all<{id: string}>()
    ).results;
    if (gone.length) {
      const removed = await db.batch(
        gone.map(({id}) =>
          // The release is checked again here: it may have become kept since it was listed.
          db
            .prepare(
              `DELETE FROM release_outputs WHERE release_id = ? AND release_id NOT IN (${KEPT_RELEASES})`,
            )
            .bind(id),
        ),
      );
      done.memberships = removed.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }
    // A job that is still running may have saved outputs it has not reported yet.
    const running = await db
      .prepare(
        `SELECT 1 AS found FROM maintenance_jobs WHERE state IN ${UNFINISHED} LIMIT 1`,
      )
      .first();
    if (running || !objects?.remove) return done;
    const unused = (
      await db
        .prepare(UNUSED_OUTPUTS)
        .bind(OUTPUTS_PER_CALL)
        .all<{id: string}>()
    ).results;
    for (const {id} of unused) {
      try {
        // First the content rows, in one transaction: if another saved output still refers to
        // them nothing changes and the objects stay. Then the objects, then the records that name them.
        await db.batch(OUTPUT_CONTENT.map(sql => db.prepare(sql).bind(id)));
        const keys = (
          await db.prepare(OUTPUT_OBJECTS).bind(id).all<{key: string}>()
        ).results.map(row => row.key);
        for (let at = 0; at < keys.length; at += OBJECTS_PER_DELETE)
          await objects.remove(keys.slice(at, at + OBJECTS_PER_DELETE));
        await db.batch(OUTPUT_RECORDS.map(sql => db.prepare(sql).bind(id)));
        done.outputs += 1;
      } catch {
        // Tried again on the next call: the records still name whatever was not removed yet.
        done.skipped += 1;
      }
    }
    if (done.outputs)
      await db
        .prepare(
          `DELETE FROM text_payloads WHERE NOT EXISTS (
            SELECT 1 FROM native_spans s WHERE s.content_id = text_payloads.content_id)`,
        )
        .run();
  } catch (error) {
    reportError(error, {
      tool: 'control',
      stage: 'cleanup',
      code: 'cleanup_failed',
    });
  }
  return done;
}
