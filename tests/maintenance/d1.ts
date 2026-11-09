import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import type { D1Database, D1Statement } from '../../services/maintenance/control/src/d1.ts';

/** Local D1 stand-in over SQLite with all migrations applied. Not proof of deployed D1 behaviour. */
export function localD1(): D1Database & { sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../../schemas/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  const statement = (sql: string, values: unknown[] = []): D1Statement & { exec(): { results: unknown[]; changes: number } } => ({
    bind: (...next: unknown[]) => statement(sql, next),
    exec() {
      const prepared = sqlite.prepare(sql);
      const params = values as (string | number | null)[];
      if (prepared.columns().length) return { results: prepared.all(...params) as unknown[], changes: 0 };
      return { results: [], changes: Number(prepared.run(...params).changes) };
    },
    async first<T>() { return (this.exec().results[0] as T) ?? null; },
    async all<T>() { const out = this.exec(); return { results: out.results as T[], meta: { changes: out.changes } }; },
    async run() { const out = this.exec(); return { results: [], meta: { changes: out.changes } }; },
  });
  return {
    sqlite,
    prepare: sql => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const out = statements.map(item => { const r = (item as ReturnType<typeof statement>).exec(); return { results: r.results, meta: { changes: r.changes } }; });
        sqlite.exec('COMMIT');
        return out;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
