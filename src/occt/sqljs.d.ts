declare module "sql.js" {
  import type { SqlDatabase } from "./sql.ts";

  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | null) => SqlDatabase;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
    wasmBinary?: Uint8Array;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
