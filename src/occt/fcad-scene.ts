import { isUuidV7 } from "./fcad.ts";
import type { CborNode } from "./cbor.ts";
import type { PortableScene, SceneDiagnostic } from "../xde/types";

const COLOURS = ["none", "instance", "definition"] as const;
const STAGES = ["load", "transfer", "identity", "validation"] as const;
const SEVERITIES = ["warning", "fail"] as const;
const COLOUR_SET = new Set<string>(COLOURS);

/**
 * Unicode White_Space, the set Rust `char::is_whitespace` / `str::trim` uses.
 * It is not the ECMAScript `String.prototype.trim` set: U+0085 is included and
 * U+FEFF is not. The stored characters are not removed.
 */
function rustWhiteSpace(code: number): boolean {
  return code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d
    || code === 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680
    || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** True when Rust `str::trim` would leave an empty string. */
export function rustTrimmedEmpty(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined || !rustWhiteSpace(code)) return false;
  }
  return true;
}

/** Structural checks for a schema-3 persisted scene. Throws when it cannot be bound. */
export function assertPortableScene(scene: PortableScene) {
  if (!scene || typeof scene.sourceUnit !== "string" || typeof scene.schema !== "string") {
    throw new Error("imported scene is missing its source unit or schema");
  }
  if (!Array.isArray(scene.definitions) || scene.definitions.length === 0) throw new Error("imported scene has no definitions");
  const keys = new Set<string>();
  for (const definition of scene.definitions) {
    if (!definition.key || typeof definition.key !== "string") throw new Error("imported definition has no key");
    if (keys.has(definition.key)) throw new Error(`${definition.key} is used by two definitions`);
    keys.add(definition.key);
    if (typeof definition.name !== "string") throw new Error(`${definition.key} has no name`);
    if (!Number.isInteger(definition.solids) || definition.solids < 0) throw new Error(`${definition.key} has no solid count`);
  }
  if (!Array.isArray(scene.instances) || scene.instances.length === 0) throw new Error("imported scene has no instances");
  const occurrences = new Set<string>();
  scene.instances.forEach((instance, index) => {
    if (!(instance.occurrence instanceof Uint8Array) || !isUuidV7(instance.occurrence)) {
      throw new Error(`instance ${index} occurrence is not an RFC 4122 UUIDv7`);
    }
    const hex = [...instance.occurrence].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (occurrences.has(hex)) throw new Error(`instance ${index} repeats occurrence ${hex}`);
    occurrences.add(hex);
    if (!keys.has(instance.definition)) throw new Error(`instance ${index} names missing definition ${instance.definition}`);
    if (instance.parent !== null && (!Number.isInteger(instance.parent) || instance.parent < 0 || instance.parent >= index)) {
      throw new Error(`instance ${index} parent is not an earlier instance`);
    }
    if (typeof instance.name !== "string") throw new Error(`instance ${index} has no name`);
    if (!Array.isArray(instance.placement) || instance.placement.length !== 12 || instance.placement.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`instance ${index} placement is not 12 finite numbers`);
    }
    if (!COLOUR_SET.has(instance.colourSource)) throw new Error(`instance ${index} colour source is not known`);
    if (!Array.isArray(instance.colour) || instance.colour.length !== 3 || instance.colour.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`instance ${index} colour is not 3 finite numbers`);
    }
  });
  for (const diagnostic of scene.diagnostics) assertDiagnostic(diagnostic);
}

function assertDiagnostic(diagnostic: SceneDiagnostic) {
  if (!STAGES.includes(diagnostic.stage)) throw new Error("import diagnostic stage is not known");
  if (!SEVERITIES.includes(diagnostic.severity)) throw new Error("import diagnostic severity is not known");
  if (typeof diagnostic.entity !== "string" || typeof diagnostic.message !== "string") throw new Error("import diagnostic is not text");
}

export type DecodedImport = {
  source: Uint8Array;
  sourceHash: Uint8Array;
  sourceByteLen: number;
  sourceName: string | null;
  /**
   * Schema 3, or schema 2 keyed by definition. Schema 1 has no definition keys,
   * so it is not returned as a portable scene and must not be key-bound.
   */
  scene: PortableScene | null;
  importer: { id: string; version: string; build: string };
  /** Historical diagnostics from the file. Not a fresh reading. */
  diagnostics: SceneDiagnostic[];
};

/**
 * Decodes one known `StoredImport` before the source may be confirmed.
 * CBOR integer and float stay distinct. Unknown fields are ignored, not stripped
 * from the stored bytes. Missing `Option` fields are None; missing required fields are not.
 */
export function decodeImportedPayload(node: CborNode, schema: number): DecodedImport {
  const entries = entriesOf(node, "imported payload");
  const source = bytesOf(need(entries, "source", "imported payload"), "source", 16);
  if (!isUuidV7(source)) throw new Error("source is not an RFC 4122 UUIDv7");
  const sourceHash = bytesOf(need(entries, "source_hash", "imported payload"), "source_hash", 32);
  const sourceByteLen = u64Of(need(entries, "source_byte_len", "imported payload"), "source_byte_len");
  const sourceName = optionText(entries, "source_name", "source_name");
  const sceneNode = need(entries, "scene", "imported payload");
  const importer = decodeImporter(need(entries, "imported_by", "imported payload"));
  const diagnostics = decodeDiagnostics(need(entries, "diagnostics_at_import", "imported payload"));
  const scene = decodeStoredScene(sceneNode, schema, diagnostics);
  return { source, sourceHash, sourceByteLen, sourceName, scene, importer, diagnostics };
}

function decodeImporter(node: CborNode): DecodedImport["importer"] {
  const entries = entriesOf(node, "imported_by");
  const id = textOfNode(need(entries, "id", "imported_by"), "imported_by.id");
  const version = textOfNode(need(entries, "version", "imported_by"), "imported_by.version");
  const build = textOfNode(need(entries, "build", "imported_by"), "imported_by.build");
  if (rustTrimmedEmpty(id)) throw new Error("imported_by.id is empty");
  if (rustTrimmedEmpty(version)) throw new Error("imported_by.version is empty");
  return { id, version, build };
}

function decodeDiagnostics(node: CborNode): SceneDiagnostic[] {
  return itemsOf(node, "diagnostics_at_import").map((item, index) => {
    const label = `diagnostics_at_import[${index}]`;
    const entries = entriesOf(item, label);
    const stage = oneOf(need(entries, "stage", label), `${label}.stage`, STAGES);
    const severity = oneOf(need(entries, "severity", label), `${label}.severity`, SEVERITIES);
    return {
      stage,
      severity,
      entity: textOfNode(need(entries, "entity", label), `${label}.entity`),
      message: textOfNode(need(entries, "message", label), `${label}.message`),
    };
  });
}

function decodeStoredScene(node: CborNode, schema: number, diagnostics: SceneDiagnostic[]): PortableScene | null {
  const entries = entriesOf(node, "scene");
  const sourceUnit = textOfNode(need(entries, "source_unit", "scene"), "scene.source_unit");
  const schemaName = textOfNode(need(entries, "schema", "scene"), "scene.schema");
  const definitions = need(entries, "definitions", "scene");
  const instances = need(entries, "instances", "scene");
  if (schema === 1) {
    decodeLegacyScene(definitions, instances);
    return null;
  }
  if (schema === 2 || schema === 3) {
    return decodeKeyedScene(sourceUnit, schemaName, definitions, instances, diagnostics, schema === 3);
  }
  throw new Error(`schema ${schema} is not a known imported scene layout`);
}

function decodeLegacyScene(definitions: CborNode, instances: CborNode) {
  const defs = itemsOf(definitions, "definitions");
  if (defs.length > 0xffffffff) throw new Error("a scene of this many definitions is beyond what this format addresses");
  defs.forEach((item, index) => {
    const entries = entriesOf(item, `definition ${index}`);
    textOfNode(need(entries, "name", `definition ${index}`), `definition ${index}.name`);
    u32Of(need(entries, "solids", `definition ${index}`), `definition ${index}.solids`);
  });
  decodeCommonInstances(instances, (entries, index) => {
    const definition = u32Of(need(entries, "definition", `instance ${index}`), `instance ${index} definition`);
    if (definition >= defs.length) throw new Error(`instance ${index} names missing definition ${definition}`);
    return { definition };
  });
}

function decodeKeyedScene(
  sourceUnit: string,
  schemaName: string,
  definitions: CborNode,
  instances: CborNode,
  diagnostics: SceneDiagnostic[],
  requireOccurrence: boolean,
): PortableScene {
  const defs = itemsOf(definitions, "definitions");
  if (defs.length > 0xffffffff) throw new Error("a scene of this many definitions is beyond what this format addresses");
  const keys = new Set<string>();
  const parsedDefs = defs.map((item, index) => {
    const entries = entriesOf(item, `definition ${index}`);
    const key = textOfNode(need(entries, "key", `definition ${index}`), `definition ${index}.key`);
    if (key.length === 0) throw new Error(`definition ${index} has no key`);
    if (keys.has(key)) throw new Error(`definition ${index} repeats key ${key}`);
    keys.add(key);
    return {
      key,
      name: textOfNode(need(entries, "name", `definition ${index}`), `definition ${index}.name`),
      solids: u32Of(need(entries, "solids", `definition ${index}`), `definition ${index}.solids`),
    };
  });
  const occurrences = new Set<string>();
  const parsedInstances = decodeCommonInstances(instances, (entries, index) => {
    const definition = textOfNode(need(entries, "definition", `instance ${index}`), `instance ${index} definition`);
    if (!keys.has(definition)) throw new Error(`instance ${index} names missing definition ${definition}`);
    if (!requireOccurrence) return { definition };
    const occurrence = bytesOf(need(entries, "occurrence", `instance ${index}`), `instance ${index} occurrence`, 16);
    if (!isUuidV7(occurrence)) throw new Error(`instance ${index} occurrence is not an RFC 4122 UUIDv7`);
    const hex = [...occurrence].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (occurrences.has(hex)) throw new Error(`instance ${index} repeats occurrence ${hex}`);
    occurrences.add(hex);
    return { definition, occurrence };
  });
  return {
    sourceUnit,
    schema: schemaName,
    definitions: parsedDefs,
    instances: parsedInstances,
    diagnostics,
  };
}

function decodeCommonInstances<T extends { definition: string | number; occurrence?: Uint8Array }>(
  node: CborNode,
  identify: (entries: { key: CborNode; value: CborNode }[], index: number) => T,
): Array<T & { parent: number | null; name: string; placement: number[]; colourSource: "none" | "instance" | "definition"; colour: [number, number, number] }> {
  const items = itemsOf(node, "instances");
  if (items.length > 0xffffffff) throw new Error("a scene of this many instances is beyond what this format addresses");
  return items.map((item, index) => {
    const entries = entriesOf(item, `instance ${index}`);
    const identity = identify(entries, index);
    const parent = optionU32(entries, "parent", `instance ${index} parent`);
    if (parent !== null && parent >= index) throw new Error(`instance ${index} parent is not an earlier instance`);
    const colourSource = oneOf(need(entries, "colour_source", `instance ${index}`), `instance ${index} colour_source`, COLOURS);
    const colour = floatArray(need(entries, "colour", `instance ${index}`), `instance ${index} colour`, 3);
    return {
      ...identity,
      parent,
      name: textOfNode(need(entries, "name", `instance ${index}`), `instance ${index} name`),
      placement: floatArray(need(entries, "placement", `instance ${index}`), `instance ${index} placement`, 12),
      colourSource,
      colour: [colour[0]!, colour[1]!, colour[2]!],
    };
  });
}

function entriesOf(node: CborNode, label: string) {
  if (node.type !== "map") throw new Error(`${label} is ${shown(node)}, expected map`);
  // Only this struct's field names must be text. An unknown field's value is not
  // inspected here, so a nested map may use non-text keys.
  const seen = new Set<string>();
  for (const entry of node.entries) {
    if (entry.key.type !== "text" || typeof entry.key.value !== "string") {
      throw new Error(`${label} field name is ${shown(entry.key)}, expected text`);
    }
    if (seen.has(entry.key.value)) throw new Error(`${label} repeats ${entry.key.value}`);
    seen.add(entry.key.value);
  }
  return node.entries;
}

function need(entries: { key: CborNode; value: CborNode }[], key: string, label: string): CborNode {
  const found = entries.find((entry) => entry.key.type === "text" && entry.key.value === key);
  if (!found) throw new Error(`${label} is missing ${key}`);
  return found.value;
}

function itemsOf(node: CborNode, label: string): CborNode[] {
  if (node.type !== "array") throw new Error(`${label} is ${shown(node)}, expected array`);
  return node.items;
}

function shown(node: CborNode): string {
  if (node.type === "uint" || node.type === "nint") return `integer ${node.value}`;
  if (node.type === "float") return `float ${node.value}`;
  if (node.type === "bool") return `boolean ${node.value}`;
  if (node.type === "text") return "text";
  if (node.type === "bytes") return "bytes";
  if (node.type === "array") return "array";
  if (node.type === "map") return "map";
  if (node.type === "null") return "null";
  if (node.type === "tag") return `tag ${node.tag}`;
  return node.type;
}

function textOfNode(node: CborNode, label: string): string {
  if (node.type !== "text" || typeof node.value !== "string") throw new Error(`${label} is ${shown(node)}, expected text`);
  return node.value;
}

function oneOf<T extends string>(node: CborNode, label: string, allowed: readonly T[]): T {
  const value = textOfNode(node, label);
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${label} is ${JSON.stringify(value)}, expected ${allowed.join("|")}`);
  return value as T;
}

function bytesOf(node: CborNode, label: string, size: number): Uint8Array {
  if (node.type !== "bytes") throw new Error(`${label} is ${shown(node)}, expected bytes`);
  if (node.value.byteLength !== size) throw new Error(`${label} is ${node.value.byteLength} bytes, expected ${size}`);
  return node.value;
}

function uintBits(node: CborNode): bigint | null {
  if (node.type !== "uint") return null;
  if (typeof node.value === "bigint") return node.value >= 0n ? node.value : null;
  if (typeof node.value === "number" && Number.isInteger(node.value) && node.value >= 0) return BigInt(node.value);
  return null;
}

function u32Of(node: CborNode, label: string): number {
  const raw = uintBits(node);
  if (raw === null || raw > 0xffffffffn) throw new Error(`${label} is ${shown(node)}, expected u32`);
  return Number(raw);
}

function u64Of(node: CborNode, label: string): number {
  const raw = uintBits(node);
  if (raw === null || raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is ${shown(node)}, expected u64`);
  return Number(raw);
}

function optionU32(entries: { key: CborNode; value: CborNode }[], key: string, label: string): number | null {
  const found = entries.find((entry) => entry.key.type === "text" && entry.key.value === key);
  if (!found || found.value.type === "null") return null;
  return u32Of(found.value, label);
}

function optionText(entries: { key: CborNode; value: CborNode }[], key: string, label: string): string | null {
  const found = entries.find((entry) => entry.key.type === "text" && entry.key.value === key);
  if (!found || found.value.type === "null") return null;
  return textOfNode(found.value, label);
}

function floatArray(node: CborNode, label: string, size: number): number[] {
  const items = itemsOf(node, label);
  if (items.length !== size) throw new Error(`${label} has ${items.length} values, expected ${size}`);
  return items.map((item, index) => finiteFloat(item, `${label}[${index}]`));
}

function finiteFloat(node: CborNode, label: string): number {
  if (node.type !== "float" || typeof node.value !== "number") throw new Error(`${label} is ${shown(node)}, expected float`);
  if (!Number.isFinite(node.value)) throw new Error(`${label} is not finite`);
  return node.value;
}

function finite(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

/**
 * The native bind: a fresh reading of the same STEP bytes must reproduce the
 * stored scene exactly after -0 is normalised. Occurrence ids are document
 * identity and are not part of this comparison.
 */
export function requireSameScene(stored: PortableScene, fresh: PortableScene) {
  const differ = (detail: string): never => {
    throw new Error(`this file does not import as the scene stored beside it, so nothing was bound: ${detail}`);
  };
  if (stored.sourceUnit !== fresh.sourceUnit) differ(`unit was ${stored.sourceUnit} and is now ${fresh.sourceUnit}`);
  if (stored.schema !== fresh.schema) differ(`schema was ${stored.schema} and is now ${fresh.schema}`);
  const storedDefs = new Map<string, PortableScene["definitions"][number]>();
  for (const definition of stored.definitions) {
    if (storedDefs.has(definition.key)) differ(`this document describes ${definition.key} more than once`);
    storedDefs.set(definition.key, definition);
  }
  const freshDefs = new Map<string, PortableScene["definitions"][number]>();
  for (const definition of fresh.definitions) {
    if (freshDefs.has(definition.key)) differ(`this file describes ${definition.key} more than once`);
    freshDefs.set(definition.key, definition);
  }
  for (const [key, definition] of storedDefs) {
    const now = freshDefs.get(key);
    if (!now) differ(`it no longer describes ${key}, which was stored as ${JSON.stringify(definition.name)}`);
    else {
      if (now.name !== definition.name) differ(`the name of ${key} was ${JSON.stringify(definition.name)} and is now ${JSON.stringify(now.name)}`);
      if (now.solids !== definition.solids) differ(`the solid count of ${key} was ${definition.solids} and is now ${now.solids}`);
    }
  }
  for (const [key, definition] of freshDefs) {
    if (!storedDefs.has(key)) differ(`it now describes ${key} as ${JSON.stringify(definition.name)}, and nothing was stored under that identity`);
  }
  if (stored.instances.length !== fresh.instances.length) {
    differ(`it placed ${stored.instances.length} instance(s) and now places ${fresh.instances.length}`);
  }
  stored.instances.forEach((row, index) => {
    const now = fresh.instances[index]!;
    if (row.definition !== now.definition) differ(`the definition placed by instance ${index} was ${row.definition} and is now ${now.definition}`);
    const parent = (value: number | null) => (value === null ? "the top of the scene" : `instance ${value}`);
    if (row.parent !== now.parent) differ(`the parent of instance ${index} was ${parent(row.parent)} and is now ${parent(now.parent)}`);
    if (row.name !== now.name) differ(`the name of instance ${index} was ${JSON.stringify(row.name)} and is now ${JSON.stringify(now.name)}`);
    const placement = (values: number[]) => values.map(finite);
    const storedPlacement = placement(row.placement);
    const freshPlacement = placement(now.placement);
    if (storedPlacement.length !== 12 || freshPlacement.some((value, at) => value !== storedPlacement[at])) {
      differ(`the placement of instance ${index} was [${storedPlacement.join(", ")}] and is now [${freshPlacement.join(", ")}]`);
    }
    if (row.colourSource !== now.colourSource) differ(`the colour source of instance ${index} was ${row.colourSource} and is now ${now.colourSource}`);
    const storedColour = placement(row.colour);
    const freshColour = placement(now.colour);
    if (freshColour.some((value, at) => value !== storedColour[at])) {
      differ(`the colour of instance ${index} was [${storedColour.join(", ")}] and is now [${freshColour.join(", ")}]`);
    }
  });
}

/** A stored scene is confirmed only when a fresh projection is the same scene. */
export function bindImportedScene(stored: PortableScene | null, fresh: PortableScene | null): { confirmed: boolean; error: string | null } {
  if (!stored || !fresh) {
    return { confirmed: false, error: "the stored scene was not confirmed because a fresh reading produced no portable scene" };
  }
  try {
    requireSameScene(stored, fresh);
    return { confirmed: true, error: null };
  } catch (error) {
    return { confirmed: false, error: error instanceof Error ? error.message : String(error) };
  }
}