/** JSON report from one XDE read. No Open CASCADE objects leave the worker. */

export type LinearRgb = {
  space: "linear-rgb";
  /** Quantity_Color RGB, which is linear, not sRGB. */
  rgb: [number, number, number];
};

export type XdeColor = {
  instance: LinearRgb | null;
  definition: LinearRgb | null;
  effective: LinearRgb | null;
  origin: "instance" | "definition" | "none";
};

export type XdeNode = {
  path: string;
  parent: string | null;
  /** Stable only inside this open scene. Not a document UUID. */
  occurrenceId: string;
  parentOccurrenceId: string | null;
  definitionName: string;
  occurrenceName: string;
  /** Same number means the same definition label inside this document. Not stable across exports. */
  definitionId: number;
  isAssembly: boolean;
  isOccurrence: boolean;
  /** Row-major 3×4. Translation is the 4th column. */
  local: number[];
  world: number[];
  color: XdeColor;
  solids: number;
  invalidSolids: number;
  /** Definition solids only. Assembly compounds include children and are not added into the leaf total. */
  volumeMm3: number;
  cylindricalFaces: number;
  /** Definition frame, not the occurrence placement. */
  localBox: number[] | null;
  worldBox: number[] | null;
};

export type FileUnits =
  | { available: true; length: string[]; angle: string[]; solidAngle: string[] }
  | { available: false; reason: string };

export type XdeReport = {
  readStatus: string;
  transferred: boolean;
  fileUnits: FileUnits;
  nodes: XdeNode[];
  leafVolumeMm3: number;
  partDefinitions: number;
  partOccurrences: number;
  assemblyDefinitions: number;
  apis: string[];
};

export type XdeStats = {
  initMs: number;
  heapBytes: number | null;
  session: number;
};

/** Definition-frame triangles. The viewer applies each occurrence world matrix once. */
export type DefinitionMesh = {
  definitionId: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

/** A definition identity that came from the STEP file, not from this reading. */
export type PortableDefinition = {
  key: string;
  name: string;
  solids: number;
};

export type SceneDiagnostic = {
  stage: "load" | "transfer" | "identity" | "validation";
  severity: "warning" | "fail";
  entity: string;
  message: string;
};

/**
 * What a document stores about one STEP reading. No session ids, no cleaned
 * numbers, no accumulated world matrix, no viewer highlight.
 */
export type PortableScene = {
  sourceUnit: string;
  schema: string;
  definitions: PortableDefinition[];
  instances: Array<{
    definition: string;
    parent: number | null;
    name: string;
    placement: number[];
    colourSource: "none" | "instance" | "definition";
    colour: [number, number, number];
    /** Present only after a document mints one. Never derived from the index. */
    occurrence?: Uint8Array;
  }>;
  diagnostics: SceneDiagnostic[];
};
