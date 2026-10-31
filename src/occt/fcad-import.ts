import { blake3 } from "@noble/hashes/blake3";
import { encodeArray, encodeBytes, encodeFloat, encodeMap, encodeNull, encodeText, encodeUint } from "./cbor.ts";
import { assertPortableScene } from "./fcad-scene.ts";
import { FCAD_APPLICATION_ID } from "./fcad.ts";
import type { SqlDb } from "./sql.ts";
import { uuidV7 } from "./uuid.ts";
import type { PortableScene, SceneDiagnostic } from "../xde/types";

/** This web runtime. Not the native bridge identity. */
export const WEB_IMPORTER = {
  id: "opencascade.js",
  version: "3.0.0-beta.3",
  build: "web single-thread @taucad/opencascade.js dist/opencascade_full",
};

/** Experimental placement mode. Still this WASM, not native FerriteCAD. */
export const EXPERIMENTAL_PLACEMENT_IMPORTER = {
  id: "opencascade.js",
  version: "3.0.0-beta.3",
  build: "web single-thread opencascade_full; experimental placement compatibility",
};

export const WEB_GENERATOR = "FerriteCAD web opencascade.js 3.0.0-beta.3";

/**
 * Schema SQL taken verbatim from the attached document migrations, applied in
 * order onto an empty database. A plate file is not used as a template.
 * Comments inside a CREATE are part of sqlite_master; comments between
 * statements are not.
 */
/** Historical schema 4 / format 1 writer SQL. Not used for new documents. */
export const HISTORICAL_MIGRATIONS = [
  `
CREATE TABLE meta (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    format_version         INTEGER NOT NULL,
    minimum_reader_version INTEGER NOT NULL,
    document_id            BLOB    NOT NULL CHECK (length(document_id) = 16),
    display_length_unit    TEXT    NOT NULL,
    display_angle_unit     TEXT    NOT NULL,
    created_at             TEXT    NOT NULL,
    modified_at            TEXT    NOT NULL,
    generator              TEXT    NOT NULL
) STRICT;

-- Denormalised index of capabilities a reader must implement to write this
-- document. It is rebuilt after every successful edit; opening verifies the
-- envelope declarations too, because a hand-edited index is not authoritative.
CREATE TABLE capabilities (
    name     TEXT    PRIMARY KEY NOT NULL,
    required INTEGER NOT NULL CHECK (required IN (0, 1))
) STRICT;

-- Features, sketches, bodies, parameters and datums. \`payload\` is a CBOR
-- envelope; for an object type this build does not know, it is stored and
-- returned unchanged.
CREATE TABLE objects (
    id             BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    kind           TEXT    NOT NULL,
    schema_version INTEGER NOT NULL,
    parent_id      BLOB    REFERENCES objects(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL DEFAULT 0,
    name           TEXT,
    payload        BLOB    NOT NULL,
    payload_hash   BLOB    NOT NULL CHECK (length(payload_hash) = 32)
) STRICT;

CREATE INDEX objects_by_parent ON objects(parent_id, ordinal);
CREATE INDEX objects_by_kind ON objects(kind);

-- Directed edges of the feature DAG. RESTRICT on the dependency side stops a
-- delete from silently orphaning a dependent feature.
CREATE TABLE deps (
    dependent_id  BLOB NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    dependency_id BLOB NOT NULL REFERENCES objects(id) ON DELETE RESTRICT,
    role          TEXT NOT NULL,
    PRIMARY KEY (dependent_id, dependency_id, role)
) STRICT, WITHOUT ROWID;

CREATE INDEX deps_by_dependency ON deps(dependency_id);

-- Stable semantic names for produced geometry. The binding of a name to a
-- concrete kernel sub-shape is cache and lives in the sidecar; what is stored
-- here is the intent that survives a rebuild.
CREATE TABLE topology_refs (
    id                BLOB PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    owner_id          BLOB NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    producer_feature  BLOB NOT NULL REFERENCES objects(id) ON DELETE RESTRICT,
    expected_kind     TEXT NOT NULL,
    payload           BLOB NOT NULL
) STRICT;

CREATE INDEX topology_refs_by_owner ON topology_refs(owner_id);
CREATE INDEX topology_refs_by_producer ON topology_refs(producer_feature);
`,
  `
ALTER TABLE topology_refs
    ADD COLUMN payload_hash BLOB CHECK (payload_hash IS NULL OR length(payload_hash) = 32);
`,
  `
CREATE TABLE imported_sources (
    id           BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    -- A project-owned tag rather than a media type: what this names is how
    -- FerriteCAD reads the bytes, which is a narrower claim than what the
    -- bytes are, and one this project is entitled to make.
    format       TEXT    NOT NULL,
    bytes        BLOB    NOT NULL,
    -- BLAKE3-256, the same digest as objects.payload_hash and
    -- topology_refs.payload_hash. Checked on every read, before the bytes
    -- reach anything that would interpret them.
    content_hash BLOB    NOT NULL CHECK (length(content_hash) = 32),
    byte_len     INTEGER NOT NULL CHECK (byte_len >= 0),
    created_at   TEXT    NOT NULL,
    -- A length that disagrees with the blob is corruption SQLite can catch
    -- without help, so it does.
    CHECK (length(bytes) = byte_len)
) STRICT;

-- One file, one row, however many objects were imported from it. A source is
-- immutable, so identical content is the same source rather than a copy.
CREATE UNIQUE INDEX imported_sources_by_content ON imported_sources(format, content_hash);

-- What makes a source reachable, as a row rather than a field inside a CBOR
-- payload. SQLite can enforce a row: deleting an object drops its claim on the
-- bytes even when this build cannot decode that object, and an object this
-- build has never heard of keeps its source alive for the build that can.
CREATE TABLE imported_source_refs (
    object_id BLOB NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    source_id BLOB NOT NULL REFERENCES imported_sources(id) ON DELETE RESTRICT,
    PRIMARY KEY (object_id, source_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX imported_source_refs_by_source ON imported_source_refs(source_id);
`,
  `
CREATE TABLE checkpoints (
    id         BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    created_at TEXT    NOT NULL,
    -- \`Document::model_without_checkpoints\` of the image.
    model      BLOB    NOT NULL CHECK (length(model) = 32),
    byte_len   INTEGER NOT NULL CHECK (byte_len > 0),
    -- BLAKE3-256 of \`image\`, checked before the bytes are used.
    image_hash BLOB    NOT NULL CHECK (length(image_hash) = 32),
    image      BLOB    NOT NULL,
    CHECK (length(image) = byte_len)
) STRICT;
`,
];

export type ImportedDocumentInput = {
  step: Uint8Array;
  sourceName: string;
  objectName: string;
  scene: PortableScene;
  /** Reuse these occurrence ids for a repeated save of the same revision. */
  occurrences?: Uint8Array[];
  createdAt?: string;
  documentId?: Uint8Array;
  objectId?: Uint8Array;
  sourceId?: Uint8Array;
  /** Negative probes only. A normal save refuses an invalid scene. */
  trustScene?: boolean;
  /** Defaults to this WASM. The experiment names itself and does not claim native FerriteCAD. */
  importer?: { id: string; version: string; build: string };
};

/**
 * Current native schema, copied from DOCUMENT_SCHEMA at main
 * dd51dc381941af1631511a365c2d4802939118af. user_version is not set: a fresh
 * file has 0 because SQLite's default is 0, not because this is "schema v0".
 */
export const CURRENT_SCHEMA = `
CREATE TABLE meta (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    document_id            BLOB    NOT NULL CHECK (length(document_id) = 16),
    display_length_unit    TEXT    NOT NULL,
    display_angle_unit     TEXT    NOT NULL,
    created_at             TEXT    NOT NULL,
    modified_at            TEXT    NOT NULL,
    generator              TEXT    NOT NULL
) STRICT;

CREATE TABLE objects (
    id             BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    kind           TEXT    NOT NULL,
    parent_id      BLOB    REFERENCES objects(id) ON DELETE CASCADE,
    ordinal        INTEGER NOT NULL DEFAULT 0,
    name           TEXT,
    payload        BLOB    NOT NULL,
    payload_hash   BLOB    NOT NULL CHECK (length(payload_hash) = 32)
) STRICT;

CREATE INDEX objects_by_parent ON objects(parent_id, ordinal);
CREATE INDEX objects_by_kind ON objects(kind);

CREATE TABLE deps (
    dependent_id  BLOB NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    dependency_id BLOB NOT NULL REFERENCES objects(id) ON DELETE RESTRICT,
    role          TEXT NOT NULL,
    PRIMARY KEY (dependent_id, dependency_id, role)
) STRICT, WITHOUT ROWID;

CREATE INDEX deps_by_dependency ON deps(dependency_id);

CREATE TABLE imported_sources (
    id           BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    format       TEXT    NOT NULL,
    bytes        BLOB    NOT NULL,
    content_hash BLOB    NOT NULL CHECK (length(content_hash) = 32),
    byte_len     INTEGER NOT NULL CHECK (byte_len >= 0),
    created_at   TEXT    NOT NULL,
    CHECK (length(bytes) = byte_len)
) STRICT;

CREATE UNIQUE INDEX imported_sources_by_content ON imported_sources(format, content_hash);

CREATE TABLE imported_source_refs (
    object_id BLOB NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
    source_id BLOB NOT NULL REFERENCES imported_sources(id) ON DELETE RESTRICT,
    PRIMARY KEY (object_id, source_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX imported_source_refs_by_source ON imported_source_refs(source_id);

CREATE TABLE checkpoints (
    id         BLOB    PRIMARY KEY NOT NULL CHECK (length(id) = 16),
    name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    created_at TEXT    NOT NULL,
    model      BLOB    NOT NULL CHECK (length(model) = 32),
    byte_len   INTEGER NOT NULL CHECK (byte_len > 0),
    image_hash BLOB    NOT NULL CHECK (length(image_hash) = 32),
    image      BLOB    NOT NULL,
    CHECK (length(image) = byte_len)
) STRICT;
`;

export function applyDocumentSchema(db: SqlDb) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(CURRENT_SCHEMA);
  db.exec(`PRAGMA application_id = ${FCAD_APPLICATION_ID}`);
}

export function writeImportedDocument(db: SqlDb, input: ImportedDocumentInput): Uint8Array {
  const scene = withOccurrences(input.scene, input.occurrences);
  if (!input.trustScene) assertPortableScene(scene);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const documentId = input.documentId ?? uuidV7();
  const objectId = input.objectId ?? uuidV7();
  const sourceId = input.sourceId ?? uuidV7();
  const sourceHash = blake3(input.step);
  const importer = input.importer ?? WEB_IMPORTER;
  const envelope = encodeEnvelope(sourceId, sourceHash, input.step.byteLength, input.sourceName, scene, importer);
  const payloadHash = blake3(envelope);
  applyDocumentSchema(db);
  db.run(
    "INSERT INTO meta (id, document_id, display_length_unit, display_angle_unit, created_at, modified_at, generator) VALUES (1, ?, 'mm', 'deg', ?, ?, ?)",
    [documentId, createdAt, createdAt, WEB_GENERATOR],
  );
  db.run(
    "INSERT INTO objects (id, kind, parent_id, ordinal, name, payload, payload_hash) VALUES (?, 'exchange.step.imported', NULL, 0, ?, ?, ?)",
    [objectId, input.objectName, envelope, payloadHash],
  );
  db.run(
    "INSERT INTO imported_sources (id, format, bytes, content_hash, byte_len, created_at) VALUES (?, 'exchange.step', ?, ?, ?, ?)",
    [sourceId, input.step, sourceHash, input.step.byteLength, createdAt],
  );
  db.run("INSERT INTO imported_source_refs (object_id, source_id) VALUES (?, ?)", [objectId, sourceId]);
  return db.export();
}

export function withOccurrences(scene: PortableScene, reuse?: Uint8Array[]): PortableScene {
  if (reuse && reuse.length !== scene.instances.length) throw new Error("occurrence ids do not match the scene");
  return {
    ...scene,
    instances: scene.instances.map((instance, index) => ({ ...instance, occurrence: reuse?.[index] ?? instance.occurrence ?? uuidV7() })),
  };
}

function encodeEnvelope(sourceId: Uint8Array, sourceHash: Uint8Array, byteLength: number, sourceName: string, scene: PortableScene, importer = WEB_IMPORTER): Uint8Array {
  const payload = encodeMap([
    ["source", encodeBytes(sourceId)],
    ["source_hash", encodeBytes(sourceHash)],
    ["source_byte_len", encodeUint(byteLength)],
    ["source_name", encodeText(sourceName)],
    ["scene", encodeScene(scene)],
    ["imported_by", encodeMap([
      ["id", encodeText(importer.id)],
      ["version", encodeText(importer.version)],
      ["build", encodeText(importer.build)],
    ])],
    ["diagnostics_at_import", encodeArray(scene.diagnostics.map(encodeDiagnostic))],
  ]);
  return encodeMap([
    ["type", encodeText("exchange.step.imported")],
    ["payload", encodeBytes(payload)],
  ]);
}

function encodeScene(scene: PortableScene): Uint8Array {
  return encodeMap([
    ["source_unit", encodeText(scene.sourceUnit)],
    ["schema", encodeText(scene.schema)],
    ["definitions", encodeArray(scene.definitions.map((definition) => encodeMap([
      ["key", encodeText(definition.key)],
      ["name", encodeText(definition.name)],
      ["solids", encodeUint(definition.solids)],
    ])))],
    ["instances", encodeArray(scene.instances.map((instance) => encodeMap([
      ["occurrence", encodeBytes(instance.occurrence ?? new Uint8Array())],
      ["definition", encodeText(instance.definition)],
      ["parent", instance.parent === null ? encodeNull() : encodeUint(instance.parent)],
      ["name", encodeText(instance.name)],
      ["placement", encodeArray(instance.placement.map((value) => encodeFloat(value)))],
      ["colour_source", encodeText(instance.colourSource)],
      ["colour", encodeArray(instance.colour.map((value) => encodeFloat(value)))],
    ])))],
  ]);
}

function encodeDiagnostic(diagnostic: SceneDiagnostic): Uint8Array {
  return encodeMap([
    ["stage", encodeText(diagnostic.stage)],
    ["severity", encodeText(diagnostic.severity)],
    ["entity", encodeText(diagnostic.entity)],
    ["message", encodeText(diagnostic.message)],
  ]);
}
