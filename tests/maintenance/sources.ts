/** The committed recipes and manifests, and what a fetch of them leaves in the database and the
 *  private bucket, in the shape Data Preparation saves. Stored bytes are synthetic. */
import {readFileSync, readdirSync} from 'node:fs';
import type {
  InputRef,
  Recipe,
  RecipeUnit,
} from '../../services/maintenance/control/src/contracts.ts';
import {canonicalJson} from '../../services/maintenance/control/src/d1.ts';
import {GitHubActions} from '../../services/maintenance/control/src/github.ts';
import type {ObjectStore} from '../../services/maintenance/control/src/selection.ts';
import {fakeGitHub} from './github.ts';
import type {localD1} from './d1.ts';

const root = new URL('../../', import.meta.url);
const file = (path: string) =>
  JSON.parse(readFileSync(new URL(path, root), 'utf8'));

export interface AdmissionBlock {
  terms_basis: string;
  permitted_uses: string[];
  restrictions: string[];
  notices: string[];
  both_hosts_eligible: boolean;
  public_redistribution: string;
}
/** A committed fetch recipe, with the fields the tests read and change. */
export type RecipeFile = Recipe & {
  task_inputs: InputRef[];
  units: RecipeUnit[];
  parameters: {
    manifest?: string;
    component: string;
    commit: string;
    sha256?: string;
    byte_count: number;
    admission_record?: AdmissionBlock;
  };
};
export interface ManifestFile {
  source_revision: string;
  url: string;
  expected_sha256?: string;
  byte_count?: number;
  admission_record: AdmissionBlock;
}
export type Files = Record<string, unknown>;

export const recipeNames = () =>
  readdirSync(new URL('collection/recipes/', root))
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -5));

export const recipeFile = (files: Files, name: string) =>
  files[`collection/recipes/${name}.json`] as RecipeFile;
export const manifestFile = (files: Files, name: string) =>
  files[
    `collection/manifests/${recipeFile(files, name).parameters.manifest}`
  ] as ManifestFile;

/** These recipes, each acquire-only one with the manifest it names. */
export function committed(...names: string[]): Files {
  const files: Files = {};
  for (const name of names) {
    files[`collection/recipes/${name}.json`] = file(
      `collection/recipes/${name}.json`,
    );
    const {manifest} = recipeFile(files, name).parameters;
    if (manifest)
      files[`collection/manifests/${manifest}`] = file(
        `collection/manifests/${manifest}`,
      );
  }
  return files;
}

export function reader(files: Record<string, unknown>) {
  const server = fakeGitHub({recipes: files});
  const github = new GitHubActions(
    {repository: 'owner/app', token: 'synthetic-token'},
    server.fetcher,
  );
  return {server, github};
}

export function bucket() {
  const stored = new Map<string, number>();
  const objects: ObjectStore = {
    async list(prefix) {
      return {
        objects: [...stored]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, size]) => ({key, size})),
      };
    },
    async remove(keys) {
      for (const key of keys) stored.delete(key);
    },
  };
  return {stored, objects};
}

export const DIGEST = 'd'.repeat(64);

/** The original a fetch recipe keeps, as its files state it. */
export function stated(files: Files, name: string) {
  const recipe = recipeFile(files, name);
  const p = recipe.parameters;
  if (!p.manifest)
    return {
      revision: recipe.task_inputs[1].id,
      component: p.component,
      digest: p.sha256!,
      size: p.byte_count,
      file: `${p.component}.txt`,
      details: {commit: p.commit, licence: 'synthetic', base_text: 'synthetic'},
      admission: p.admission_record!,
    };
  const manifest = manifestFile(files, name);
  const revision = manifest.source_revision;
  const digest = manifest.expected_sha256 ?? DIGEST;
  const size = manifest.byte_count ?? 7;
  return {
    revision,
    component: 'archive',
    digest,
    size,
    file: 'original',
    details: {
      sha256: digest,
      byte_count: size,
      locator: `originals/${revision}/${digest}/original`,
      upstream_basis: 'etag:synthetic',
      url: manifest.url,
    },
    admission: manifest.admission_record,
  };
}

type Database = ReturnType<typeof localD1>;

export function saveSource(db: Database, revision: string, details: unknown) {
  const insert = db.sqlite.prepare(
    'INSERT OR IGNORE INTO source_nodes VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [id, kind, parent, detail] of [
    [`${revision}:w`, 'work', null, {}],
    [`${revision}:e`, 'edition', `${revision}:w`, {}],
    [`${revision}:r`, 'representation', `${revision}:e`, {}],
    [revision, 'source_revision', `${revision}:r`, details],
  ] as const)
    insert.run(
      id,
      kind,
      parent,
      'synthetic',
      'synthetic',
      'synthetic',
      canonicalJson(detail),
    );
}

/** Save the records and the kept original of one fetch recipe. */
export function fetched(
  db: Database,
  stored: Map<string, number>,
  files: Files,
  name: string,
) {
  const source = stated(files, name);
  saveSource(db, source.revision, source.details);
  const record = source.admission;
  db.sqlite
    .prepare('INSERT INTO admissions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      `${source.revision}:${source.component}`,
      source.revision,
      source.component,
      record.terms_basis,
      JSON.stringify(record.permitted_uses),
      JSON.stringify(record.restrictions),
      JSON.stringify(record.notices),
      record.both_hosts_eligible ? 1 : 0,
      record.public_redistribution,
    );
  const key = `originals/${source.revision}/${source.digest}/${source.file}`;
  stored.set(key, source.size);
  return {...source, key};
}
