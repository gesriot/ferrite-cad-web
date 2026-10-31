/** Tiny SQLite surface shared by the browser runtime and the FCAD tests. */

export type SqlValue = null | number | string | Uint8Array;

export interface SqlStatement {
  bind(values?: unknown[]): void;
  step(): boolean;
  get(): unknown[];
  free(): void;
}

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array;
  close(): void;
}

export interface SqlDb {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  get(sql: string, params?: SqlValue[]): unknown[] | undefined;
  all(sql: string, params?: SqlValue[]): unknown[][];
  export(): Uint8Array;
  close(): void;
}

export function wrapSql(db: SqlDatabase): SqlDb {
  return {
    exec(sql) {
      db.exec(sql);
    },
    run(sql, params = []) {
      db.run(sql, params);
    },
    get(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        if (!stmt.step()) return undefined;
        return stmt.get();
      } finally {
        stmt.free();
      }
    },
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      const rows: unknown[][] = [];
      try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.get());
        return rows;
      } finally {
        stmt.free();
      }
    },
    export() {
      return db.export().slice();
    },
    close() {
      db.close();
    },
  };
}
