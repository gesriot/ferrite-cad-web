/** Container bound, separate from the 8 MiB limit for a CBOR buffer. */
export const MAX_FCAD_BYTES = 32 * 1024 * 1024;

export function assertCadFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FCAD_BYTES) {
    throw new Error("File exceeds the 32 MiB document limit.");
  }
}

/** Reject before allocating the file buffer, and verify the actual result too. */
export async function readCadFile(file: Pick<File, "size" | "arrayBuffer">): Promise<Uint8Array<ArrayBuffer>> {
  assertCadFileSize(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertCadFileSize(bytes.byteLength);
  return bytes;
}

/** Shared byte boundary: the factory must not allocate SQLite before this check. */
export function openFcadBytes<T>(bytes: Uint8Array, open: (bytes: Uint8Array) => T): T {
  assertCadFileSize(bytes.byteLength);
  return open(bytes);
}
