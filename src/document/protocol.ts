/**
 * Wire shapes of the Rust document facade (`wasm/document/src/facade.rs`).
 *
 * TypeScript checks only the *shape* of a reply so a corrupted frame cannot be
 * mistaken for a document. FCAD rules, CBOR, SQL, hashes and expression
 * semantics stay in Rust: nothing here classifies a native message, and values
 * the inspector does not use stay `unknown`.
 */

/** Native `ExpressionSlot` (serde tag `kind`). Sent back to Rust exactly as received. */
export interface NativeExpressionSlot {
  readonly kind: string;
  readonly constraint?: string;
  readonly [field: string]: unknown;
}

export interface NativeExpression {
  readonly source: string;
  readonly value: number;
}

export interface NativeSlot {
  readonly object: string;
  readonly name: string | null;
  readonly slot: NativeExpressionSlot;
  readonly expression: NativeExpression;
  /** Native dimension name; the unit of `value_mm` follows it. */
  readonly dimension: string;
  /** Why Rust will not edit this slot, or null. */
  readonly refusal: string | null;
}

export interface NativeObject {
  readonly id: string;
  readonly parent: string | null;
  readonly kind: string;
  readonly name: string;
  /** Decimal string: the native ordinal is an i64 and must not pass through Number. */
  readonly ordinal: string;
  readonly payload: unknown;
  readonly payload_hash: string;
  readonly reencoded_hash: string;
}

export interface NativeDependency {
  readonly dependent: string;
  readonly dependency: string;
  readonly role: string;
}

export interface NativeDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly object: string | null;
}

export interface NativeValidation {
  readonly ok: boolean;
  readonly diagnostics: readonly NativeDiagnostic[];
}

/**
 * What Rust read from a file. A reply that carries an inspection is a
 * *successful read*; the document is usable only when `validation.ok` is true.
 */
export interface NativeInspection {
  readonly document_id: string;
  readonly objects: readonly NativeObject[];
  readonly dependencies: readonly NativeDependency[];
  readonly expression_slots: readonly NativeSlot[];
  readonly content_version: string;
  readonly model_version: string;
  readonly validation: NativeValidation;
}

/** The request body of `fcad_set_expression`; Rust denies unknown fields. */
export interface ExpressionChange {
  readonly object: string;
  readonly slot: NativeExpressionSlot;
  /** Native units: mm, radians or a scalar, according to the slot's dimension. */
  readonly value_mm: number;
}

/** Rust declined the call. `kind` and `message` are the native wording. */
export interface RustRefusal {
  readonly kind: string;
  readonly message: string;
}

export interface ReplyTiming {
  readonly initMs: number;
  readonly operationMs: number;
}

export type OpenReply =
  | { readonly ok: false; readonly refusal: RustRefusal; readonly timing: ReplyTiming }
  | { readonly ok: true; readonly inspection: NativeInspection; readonly timing: ReplyTiming };

export type EditReply =
  | { readonly ok: false; readonly refusal: RustRefusal; readonly timing: ReplyTiming }
  | {
      readonly ok: true;
      readonly inspection: NativeInspection;
      /** The complete FCAD that Rust wrote. */
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly timing: ReplyTiming;
    };

export type WorkerRequest =
  | { readonly id: number; readonly operation: "open"; readonly bytes: ArrayBuffer }
  | {
      readonly id: number;
      readonly operation: "set_expression";
      readonly bytes: ArrayBuffer;
      readonly request: ExpressionChange;
    };

export type WorkerReply =
  | {
      readonly id: number;
      readonly json: unknown;
      readonly bytes: ArrayBuffer;
      readonly initMs: number;
      readonly operationMs: number;
    }
  | { readonly id: number; readonly transportError: string };

/** A reply whose shape is wrong. The transport treats it as a transport failure. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Fields {
  if (!isRecord(value)) throw new ProtocolError(`${path}: expected an object`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ProtocolError(`${path}: expected a string`);
  return value;
}

function textOrNull(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`${path}: expected a finite number`);
  }
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${path}: expected an array`);
  return value;
}

function parseSlot(value: unknown, path: string): NativeExpressionSlot {
  const slot = record(value, path);
  text(slot.kind, `${path}.kind`);
  if (slot.constraint !== undefined) text(slot.constraint, `${path}.constraint`);
  // Kept whole: Rust denies unknown fields, so a re-sent slot must be the native object.
  return { ...slot } as NativeExpressionSlot;
}

function parseInspection(json: Fields): NativeInspection {
  const validation = record(json.validation, "validation");
  if (typeof validation.ok !== "boolean") throw new ProtocolError("validation.ok: expected a boolean");
  return {
    document_id: text(json.document_id, "document_id"),
    objects: list(json.objects, "objects").map((item, index) => {
      const path = `objects[${index}]`;
      const object = record(item, path);
      return {
        id: text(object.id, `${path}.id`),
        parent: textOrNull(object.parent, `${path}.parent`),
        kind: text(object.kind, `${path}.kind`),
        name: text(object.name, `${path}.name`),
        ordinal: text(object.ordinal, `${path}.ordinal`),
        payload: object.payload,
        payload_hash: text(object.payload_hash, `${path}.payload_hash`),
        reencoded_hash: text(object.reencoded_hash, `${path}.reencoded_hash`),
      };
    }),
    dependencies: list(json.dependencies, "dependencies").map((item, index) => {
      const path = `dependencies[${index}]`;
      const dependency = record(item, path);
      return {
        dependent: text(dependency.dependent, `${path}.dependent`),
        dependency: text(dependency.dependency, `${path}.dependency`),
        role: text(dependency.role, `${path}.role`),
      };
    }),
    expression_slots: list(json.expression_slots, "expression_slots").map((item, index) => {
      const path = `expression_slots[${index}]`;
      const slot = record(item, path);
      const expression = record(slot.expression, `${path}.expression`);
      return {
        object: text(slot.object, `${path}.object`),
        name: textOrNull(slot.name, `${path}.name`),
        slot: parseSlot(slot.slot, `${path}.slot`),
        expression: {
          source: text(expression.source, `${path}.expression.source`),
          value: finite(expression.value, `${path}.expression.value`),
        },
        dimension: text(slot.dimension, `${path}.dimension`),
        refusal: textOrNull(slot.refusal, `${path}.refusal`),
      };
    }),
    content_version: text(json.content_version, "content_version"),
    model_version: text(json.model_version, "model_version"),
    validation: {
      ok: validation.ok,
      diagnostics: list(validation.diagnostics, "validation.diagnostics").map((item, index) => {
        const path = `validation.diagnostics[${index}]`;
        const diagnostic = record(item, path);
        return {
          severity: text(diagnostic.severity, `${path}.severity`),
          code: text(diagnostic.code, `${path}.code`),
          message: text(diagnostic.message, `${path}.message`),
          object: textOrNull(diagnostic.object, `${path}.object`),
        };
      }),
    },
  };
}

function parseRefusal(json: Fields): RustRefusal {
  return { kind: text(json.kind, "kind"), message: text(json.message, "message") };
}

/** `ok:true` is a successful read, not a promise that the document is valid. */
export function parseOpenReply(json: unknown, bytes: Uint8Array, timing: ReplyTiming): OpenReply {
  const reply = record(json, "reply");
  if (bytes.length !== 0) throw new ProtocolError("open reply carries FCAD bytes");
  if (reply.ok === false) return { ok: false, refusal: parseRefusal(reply), timing };
  if (reply.ok === true) return { ok: true, inspection: parseInspection(reply), timing };
  throw new ProtocolError("reply.ok: expected a boolean");
}

export function parseEditReply(
  json: unknown,
  bytes: Uint8Array<ArrayBuffer>,
  timing: ReplyTiming,
): EditReply {
  const reply = record(json, "reply");
  if (reply.ok === false) {
    if (bytes.length !== 0) throw new ProtocolError("refused edit carries FCAD bytes");
    return { ok: false, refusal: parseRefusal(reply), timing };
  }
  if (reply.ok !== true) throw new ProtocolError("reply.ok: expected a boolean");
  if (bytes.length === 0) throw new ProtocolError("edit reply carries no FCAD bytes");
  return { ok: true, inspection: parseInspection(reply), bytes, timing };
}

/** Shape of a message the Worker posted back. */
export function parseWorkerReply(data: unknown): WorkerReply {
  const reply = record(data, "message");
  if (typeof reply.id !== "number" || !Number.isSafeInteger(reply.id)) {
    throw new ProtocolError("message.id: expected an integer");
  }
  if ("transportError" in reply) {
    return { id: reply.id, transportError: text(reply.transportError, "message.transportError") };
  }
  if (!(reply.bytes instanceof ArrayBuffer)) throw new ProtocolError("message.bytes: expected an ArrayBuffer");
  return {
    id: reply.id,
    json: reply.json,
    bytes: reply.bytes,
    initMs: finite(reply.initMs, "message.initMs"),
    operationMs: finite(reply.operationMs, "message.operationMs"),
  };
}

