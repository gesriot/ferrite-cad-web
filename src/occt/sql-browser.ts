import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { wrapSql, type SqlDb } from "./sql.ts";

let ready: Promise<SqlJsStatic> | null = null;
let SQL: SqlJsStatic | null = null;

export const SQLJS_VERSION = "1.13.0";

export function ensureSql(): Promise<SqlJsStatic> {
  if (SQL) return Promise.resolve(SQL);
  if (!ready) {
    ready = initSqlJs({ locateFile: () => wasmUrl })
      .then((loaded) => {
        SQL = loaded;
        return loaded;
      })
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

/** Copies `bytes` so the caller's file is never aliased by the SQLite heap. */
export function openBrowserDb(bytes: Uint8Array): SqlDb {
  if (!SQL) throw new Error("SQLite is not loaded yet");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const db = wrapSql(new SQL.Database(copy));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = DELETE");
  return db;
}
