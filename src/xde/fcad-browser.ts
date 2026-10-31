import { openFcadBytes, assertCadFileSize } from "../occt/file-limits.ts";
import initSqlJs from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { readEmbeddedStep } from "../occt/fcad-doc.ts";
import { writeImportedDocument, type ImportedDocumentInput } from "../occt/fcad-import.ts";
import { wrapSql } from "../occt/sql.ts";
import type { ImportedSourceMeta } from "./fcad-meta.ts";
import type { PortableScene } from "./types.ts";

let ready: ReturnType<typeof initSqlJs> | null = null;

function sql() {
  ready ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  return ready;
}

/** Embedded STEP, only after the shared FCAD reader accepts the container. */
export async function extractFcad(file: Uint8Array<ArrayBufferLike>): Promise<{ step: Uint8Array<ArrayBufferLike>; meta: ImportedSourceMeta; scene: PortableScene | null }> {
  assertCadFileSize(file.byteLength);
  const SQL = await sql();
  const db = openFcadBytes(file, bytes => wrapSql(new SQL.Database(bytes)));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    return readEmbeddedStep(db);
  } finally {
    db.close();
  }
}

/** A new imported assembly document. Does not modify an open plate. */
export async function saveImportedFcad(input: ImportedDocumentInput): Promise<Uint8Array> {
  const SQL = await sql();
  const db = wrapSql(new SQL.Database());
  try {
    const bytes = writeImportedDocument(db, input);
    assertCadFileSize(bytes.byteLength);
    return bytes;
  } finally {
    db.close();
  }
}
