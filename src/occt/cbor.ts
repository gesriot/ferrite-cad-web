/** CBOR decoder and a small encoder for FerriteCAD envelopes.
 *
 * Map keys are rejected when a text key repeats, before the map is collapsed
 * into a JS object. Text is strict UTF-8, including unknown fields, and U+FEFF
 * stays part of the string. Invalid UTF-8 is still an error.
 *
 * An integer may use any definite width, including additional info 27. A value
 * that fits in a safe integer is a number; a wider value stays a bigint and is
 * never rounded. A count or byte length that claims more bytes than remain is
 * rejected before an array or map is built. The 8 MiB test below is the cap of one
 * parsed CBOR buffer, not the FCAD container limit. That limit is
 * MAX_FCAD_BYTES (32 MiB) in fcad-doc.ts. This is not a universal CBOR codec:
 * indefinite lengths and tags wider than a safe integer are still errors.
 */

export type CborNode =
  | { type: "uint" | "nint" | "float" | "bool" | "null" | "undefined" | "text"; start: number; end: number; value: number | bigint | boolean | null | undefined | string }
  | { type: "bytes"; start: number; end: number; value: Uint8Array }
  | { type: "array"; start: number; end: number; items: CborNode[] }
  | { type: "map"; start: number; end: number; entries: { key: CborNode; value: CborNode }[] }
  | { type: "tag"; start: number; end: number; tag: number; value: CborNode };

export class CborError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborError";
  }
}

export function halfToNumber(half: number): number {
  const sign = (half & 0x8000) >> 15;
  const exponent = (half & 0x7c00) >> 10;
  const fraction = half & 0x03ff;
  if (exponent === 0) {
    const value = (fraction / 1024) * 2 ** -14;
    return sign ? -value : value;
  }
  if (exponent === 31) return fraction ? Number.NaN : sign ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  const value = (1 + fraction / 1024) * 2 ** (exponent - 15);
  return sign ? -value : value;
}

export function numberToHalf(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, value, false);
  const bits = view.getUint32(0, false);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const fraction = bits & 0x7fffff;
  if ((bits & 0x7fffffff) === 0) return sign;
  if (((bits >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (fraction ? 1 : 0);
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  return sign | (exponent << 10) | (fraction >>> 13);
}

export function decodeCbor(bytes: Uint8Array): CborNode {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new CborError("CBOR buffer is larger than 8 MiB");
  const reader = new Reader(bytes);
  const node = reader.read(0);
  if (reader.pos !== bytes.length) {
    throw new CborError(`trailing ${bytes.length - reader.pos} bytes after CBOR value`);
  }
  return node;
}

export function cborToValue(node: CborNode): unknown {
  switch (node.type) {
    case "bytes":
      return node.value;
    case "array":
      return node.items.map(cborToValue);
    case "map": {
      rejectDuplicateFields(node.entries);
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) out[textOf(entry.key, "map key")] = cborToValue(entry.value);
      return out;
    }
    case "tag":
      return { tag: node.tag, value: cborToValue(node.value) };
    default:
      return node.value;
  }
}

export function textOf(node: CborNode, label: string): string {
  if (node.type !== "text" || typeof node.value !== "string") throw new CborError(`${label} is ${node.type}, not text`);
  return node.value;
}

export function mapOf(node: CborNode, label: string): { key: CborNode; value: CborNode }[] {
  if (node.type !== "map") throw new CborError(`${label} is ${node.type}, not a map`);
  return node.entries;
}

export function field(node: CborNode, key: string): CborNode {
  const entries = mapOf(node, key);
  rejectDuplicateFields(entries);
  const found = entries.find((entry) => entry.key.type === "text" && entry.key.value === key);
  if (!found) throw new CborError(`missing ${key}`);
  return found.value;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A repeated text key is ambiguous. Equal values do not make the second copy legal. */
export function rejectDuplicateFields(entries: { key: CborNode; value: CborNode }[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.key.type !== "text" || typeof entry.key.value !== "string") continue;
    if (seen.has(entry.key.value)) throw new CborError(`duplicate field \`${entry.key.value}\``);
    seen.add(entry.key.value);
  }
}

class Reader {
  pos = 0;
  bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(depth: number): CborNode {
    if (depth > 64) throw new CborError("CBOR is nested deeper than 64 levels");
    if (this.pos >= this.bytes.length) throw new CborError(`truncated at ${this.pos}`);
    const start = this.pos;
    const initial = this.u8();
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (info === 31) throw new CborError(`indefinite length at ${start} is not used by these fixtures`);
    if (major === 0) {
      const value = this.integer(info);
      return { type: "uint", start, end: this.pos, value };
    }
    if (major === 1) {
      const value = this.signed(info);
      return { type: "nint", start, end: this.pos, value };
    }
    if (major === 2) {
      const size = this.count(info);
      const value = this.bytes.slice(this.pos, this.pos + size);
      this.pos += size;
      return { type: "bytes", start, end: this.pos, value };
    }
    if (major === 3) {
      const size = this.count(info);
      let value: string;
      try {
        value = utf8.decode(this.bytes.subarray(this.pos, this.pos + size));
      } catch {
        throw new CborError("invalid UTF-8 in CBOR text");
      }
      this.pos += size;
      return { type: "text", start, end: this.pos, value };
    }
    if (major === 4) {
      const count = this.count(info);
      const items: CborNode[] = [];
      for (let i = 0; i < count; i++) items.push(this.read(depth + 1));
      return { type: "array", start, end: this.pos, items };
    }
    if (major === 5) {
      const count = this.count(info);
      const entries: { key: CborNode; value: CborNode }[] = [];
      for (let i = 0; i < count; i++) entries.push({ key: this.read(depth + 1), value: this.read(depth + 1) });
      rejectDuplicateFields(entries);
      return { type: "map", start, end: this.pos, entries };
    }
    if (major === 6) {
      const tag = this.integer(info);
      if (typeof tag !== "number") throw new CborError(`tag ${tag} does not fit a safe integer`);
      const value = this.read(depth + 1);
      return { type: "tag", start, end: this.pos, tag, value };
    }
    return this.simple(info, start);
  }

  private simple(info: number, start: number): CborNode {
    if (info === 20) return { type: "bool", start, end: this.pos, value: false };
    if (info === 21) return { type: "bool", start, end: this.pos, value: true };
    if (info === 22) return { type: "null", start, end: this.pos, value: null };
    if (info === 23) return { type: "undefined", start, end: this.pos, value: undefined };
    if (info === 25) {
      const value = halfToNumber(this.u16());
      return { type: "float", start, end: this.pos, value };
    }
    if (info === 26) {
      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
      const value = view.getFloat32(0, false);
      this.pos += 4;
      return { type: "float", start, end: this.pos, value };
    }
    if (info === 27) {
      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
      const value = view.getFloat64(0, false);
      this.pos += 8;
      return { type: "float", start, end: this.pos, value };
    }
    throw new CborError(`unsupported simple/float additional info ${info} at ${start}`);
  }

  /** Integer argument. Safe values stay numbers. Wider values stay bigint and are not rounded. */
  private integer(info: number): number | bigint {
    if (info < 24) return info;
    if (info === 24) return this.u8();
    if (info === 25) return this.u16();
    if (info === 26) return this.u32();
    if (info === 27) {
      const raw = this.u64();
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(raw);
      return raw;
    }
    throw new CborError(`unsupported additional info ${info} at ${this.pos}`);
  }

  /** CBOR negative integer: -1 minus the unsigned argument. */
  private signed(info: number): number | bigint {
    const magnitude = this.integer(info);
    if (typeof magnitude === "bigint") {
      const value = -1n - magnitude;
      if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
      return value;
    }
    const value = -1 - magnitude;
    if (!Number.isSafeInteger(value)) return BigInt(value);
    return value;
  }

  /** Byte length or item count. A claim past the unread bytes is refused before any array is built. */
  private count(info: number): number {
    const raw = this.integer(info);
    const left = this.bytes.length - this.pos;
    if (typeof raw !== "number" || raw > left) {
      throw new CborError(`length ${raw} exceeds the ${left} bytes left at ${this.pos}`);
    }
    return raw;
  }

  private u8(): number {
    const value = this.bytes[this.pos];
    if (value === undefined) throw new CborError(`truncated at ${this.pos}`);
    this.pos += 1;
    return value;
  }

  private u16(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 2);
    this.pos += 2;
    return view.getUint16(0, false);
  }

  private u32(): number {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
    this.pos += 4;
    return view.getUint32(0, false);
  }

  private u64(): bigint {
    if (this.pos + 8 > this.bytes.length) throw new CborError(`truncated at ${this.pos}`);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8);
    const value = view.getBigUint64(0, false);
    this.pos += 8;
    return value;
  }
}

export function encodeMajor(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  if (length < 65536) {
    const out = new Uint8Array(3);
    const view = new DataView(out.buffer);
    out[0] = (major << 5) | 25;
    view.setUint16(1, length, false);
    return out;
  }
  const out = new Uint8Array(5);
  const view = new DataView(out.buffer);
  out[0] = (major << 5) | 26;
  view.setUint32(1, length, false);
  return out;
}

export function encodeText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  return concat(encodeMajor(3, body.length), body);
}

export function encodeBytes(body: Uint8Array): Uint8Array {
  return concat(encodeMajor(2, body.length), body);
}

/** Smallest IEEE encoding that round-trips to the same f64. Does not round a wider value down to float16. */
export function encodeFloat(value: number): Uint8Array {
  if (!Number.isFinite(value)) throw new CborError(`cannot encode non-finite ${value}`);
  const canonical = Object.is(value, -0) ? 0 : value;
  const half = numberToHalf(canonical);
  if (halfToNumber(half) === canonical) {
    const out = new Uint8Array(3);
    const view = new DataView(out.buffer);
    out[0] = 0xf9;
    view.setUint16(1, half, false);
    return out;
  }
  if (Math.fround(canonical) === canonical) {
    const out = new Uint8Array(5);
    const view = new DataView(out.buffer);
    out[0] = 0xfa;
    view.setFloat32(1, canonical, false);
    return out;
  }
  const out = new Uint8Array(9);
  const view = new DataView(out.buffer);
  out[0] = 0xfb;
  view.setFloat64(1, canonical, false);
  return out;
}

export function spliceBytes(source: Uint8Array, edits: { start: number; end: number; next: Uint8Array }[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const edit of sorted) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > source.length) {
      throw new CborError(`splice ${edit.start}:${edit.end} is outside ${cursor}..${source.length}`);
    }
    parts.push(source.subarray(cursor, edit.start));
    parts.push(edit.next);
    cursor = edit.end;
  }
  parts.push(source.subarray(cursor));
  return concat(...parts);
}

export function encodeUint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new CborError(`cannot encode ${value} as an unsigned integer`);
  return encodeMajor(0, value);
}

export function encodeNull(): Uint8Array {
  return Uint8Array.of(0xf6);
}

export function encodeArray(items: Uint8Array[]): Uint8Array {
  return concat(encodeMajor(4, items.length), ...items);
}

export function encodeMap(entries: Array<[string, Uint8Array]>): Uint8Array {
  return concat(encodeMajor(5, entries.length), ...entries.flatMap(([key, value]) => [encodeText(key), value]));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
