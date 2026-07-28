// Content-addressed object store + refs over Durable Object SQLite.
// objects.data holds zlib-deflated RAW content (no loose-object header), so
// upload-pack can copy stored bytes verbatim into pack entries.

import { deflate, inflate } from './zlib';
import { oidOf } from './objects';

export const ZERO_OID = '0'.repeat(40);

/** Minimal structural view of DO SqlStorage so this module carries no type deps. */
export interface SqlLike {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

function blobToBytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('unexpected blob column type');
}

export class ObjectStore {
  constructor(private sql: SqlLike) {}

  init(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects(
        oid TEXT PRIMARY KEY,
        type INTEGER NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, oid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '1');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('head', 'refs/heads/main');
    `);
  }

  has(oid: string): boolean {
    return this.sql.exec('SELECT 1 AS x FROM objects WHERE oid = ?', oid).toArray().length > 0;
  }

  /** Stored form: type, inflated size, deflated raw content. */
  getRaw(oid: string): { type: number; size: number; deflated: Uint8Array } | null {
    const rows = this.sql.exec('SELECT type, size, data FROM objects WHERE oid = ?', oid).toArray();
    if (rows.length === 0) return null;
    const r = rows[0];
    return { type: r.type as number, size: r.size as number, deflated: blobToBytes(r.data) };
  }

  getContent(oid: string): { type: number; content: Uint8Array } | null {
    const raw = this.getRaw(oid);
    if (!raw) return null;
    return { type: raw.type, content: inflate(raw.deflated) };
  }

  /** Insert pre-hashed raw content. Idempotent (content-addressed), synchronous. */
  putRaw(oid: string, type: number, raw: Uint8Array): void {
    this.sql.exec(
      'INSERT OR IGNORE INTO objects(oid, type, size, data) VALUES (?, ?, ?, ?)',
      oid,
      type,
      raw.length,
      toArrayBuffer(deflate(raw))
    );
  }

  async put(type: number, raw: Uint8Array): Promise<string> {
    const oid = await oidOf(type, raw);
    this.putRaw(oid, type, raw);
    return oid;
  }

  getRefs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.sql.exec('SELECT name, oid FROM refs ORDER BY name').toArray()) {
      out[r.name as string] = r.oid as string;
    }
    return out;
  }

  getRef(name: string): string | null {
    const rows = this.sql.exec('SELECT oid FROM refs WHERE name = ?', name).toArray();
    return rows.length ? (rows[0].oid as string) : null;
  }

  setRef(name: string, oid: string): void {
    this.sql.exec(
      'INSERT INTO refs(name, oid) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET oid = excluded.oid',
      name,
      oid
    );
  }

  deleteRef(name: string): void {
    this.sql.exec('DELETE FROM refs WHERE name = ?', name);
  }

  getMeta(key: string): string | null {
    const rows = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray();
    return rows.length ? (rows[0].value as string) : null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }

  /** Symbolic HEAD target, e.g. "refs/heads/main". */
  getHead(): string {
    return this.getMeta('head') ?? 'refs/heads/main';
  }

  headOid(): string | null {
    return this.getRef(this.getHead());
  }
}
