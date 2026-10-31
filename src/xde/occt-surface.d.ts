/**
 * Narrow surface of the single-thread Open CASCADE WASM used by the
 * experimental placement path. Only the constructors and methods this
 * boundary calls are named. It is not a full OCCT binding.
 *
 * Methods are required on the handle type so call sites do not need a
 * blanket any. Callers that hold a possibly-null wrapper still narrow first.
 */
export interface OcHandle {
  IsNull: () => boolean;
  isNull: () => boolean;
  IsRoot: () => boolean;
  Tag: () => number;
  Father: () => OcHandle;
  ToCString: () => string;
  SetValue: (row: number, column: number, value: number) => void;
  NbDirectionRatios: () => number;
  DirectionRatiosValue: (index: number) => number;
  NbCoordinates: () => number;
  CoordinatesValue: (index: number) => number;
  IsKind: (descriptor: unknown) => boolean;
  Number: (entity: unknown) => number;
  NbEntities: () => number;
  NbItems: () => number;
  ItemsValue: (index: number) => OcHandle;
  ContextOfItems: () => OcHandle;
  NbUnits: () => number;
  UnitsValue: (index: number) => OcHandle;
  HasPrefix: () => boolean;
  Prefix: () => unknown;
  Name: () => unknown;
  TypeName: (...args: unknown[]) => string;
  Length: () => number;
  Definition: () => OcHandle;
  ProductDefinitionRelationship: () => OcHandle;
  RepresentationRelation: () => OcHandle;
  RepresentedProductRelation: () => OcHandle;
  delete: () => void;
  SetForm: () => void;
  Trsf: () => OcHandle;
  SetScaleFactor: (factor: number) => void;
  Main: () => OcHandle;
  Transformation: () => OcHandle;
  UpdateAssemblies: () => void;
  GetLocation: (label: OcHandle) => OcHandle;
  GetShape: (label: OcHandle) => OcHandle;
  SetLocation: (label: OcHandle, location: OcHandle) => void;
  IsReference: (label: OcHandle) => boolean;
  ChangeReader: () => OcHandle;
  GetShapeLabelMap: () => OcHandle;
  StepModel: () => OcHandle;
  WS: () => OcHandle;
  IsIdentity: () => boolean;
  FirstPower: () => number;
  FirstDatum: () => OcHandle;
  NextLocation: () => OcHandle;
  Location: () => OcHandle;
  HasAxis: () => boolean;
  Axis: () => OcHandle;
  HasRefDirection: () => boolean;
  RefDirection: () => OcHandle;
  TransformationOperator: () => OcHandle;
  ItemDefinedTransformation: () => OcHandle;
  TransformItem1: () => OcHandle;
  TransformItem2: () => OcHandle;
  GetFreeShapes: (...args: unknown[]) => void;
  Value: ((index: number) => OcHandle) & ((row: number, column: number) => number);
}

export interface OcCtor {
  new (...args: unknown[]): OcHandle;
}

export interface Oc {
  TCollection_AsciiString: OcCtor;
  TDF_Tool: { Entry: (label: OcHandle, ascii: OcHandle) => void };
  gp_Mat: OcCtor;
  gp_XYZ: new (x: number, y: number, z: number) => OcHandle;
  gp_GTrsf: new (matrix: OcHandle, translation: OcHandle) => OcHandle;
  TopLoc_Location: new (trsf?: OcHandle) => OcHandle;
  StepRepr_Representation: { get_type_descriptor: () => unknown };
  StepBasic_SiUnitAndLengthUnit: { get_type_descriptor: () => unknown };
  StepBasic_SiUnit: { get_type_descriptor: () => unknown };
  StepBasic_ConversionBasedUnit: { get_type_descriptor: () => unknown };
  StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx: { get_type_descriptor: () => unknown };
  XCAFDoc_Location: { Set: (label: OcHandle, location: OcHandle) => void };
  XCAFDoc_DocumentTool: { ShapeTool: (main: OcHandle) => OcHandle };
  XCAFDoc_ShapeTool: {
    UpdateAssemblies: (tool: OcHandle) => void;
    GetLocation: (label: OcHandle) => OcHandle;
    GetShape: (label: OcHandle) => OcHandle;
    IsReference: (label: OcHandle) => boolean;
    GetReferredShape: (...args: unknown[]) => boolean;
    GetComponents: (label: OcHandle, out: OcHandle, compound?: boolean) => boolean;
    GetFreeShapes: (...args: unknown[]) => void;
  };
  STEPConstruct_Tool: new (ws: OcHandle) => OcHandle;
  TDF_Label: new () => OcHandle;

  StepRepr_NextAssemblyUsageOccurrence: { get_type_descriptor: () => unknown };
  StepShape_ContextDependentShapeRepresentation: { get_type_descriptor: () => unknown };
  StepRepr_RepresentationRelationshipWithTransformation: { get_type_descriptor: () => unknown };
  StepGeom_Axis2Placement3d: { get_type_descriptor: () => unknown };
  STEPCAFControl_Reader: { new (): OcHandle; FindInstance: (nauo: unknown, shapes: unknown, tool: unknown, map: unknown) => OcHandle | null };
  NCollection_Sequence_TDF_Label: new () => OcHandle;
}

export interface PlacementRow {
  index: number;
  parent: number;
  entry: string;
  labelKey: string;
  label: OcHandle;
  covered: boolean;
  candidate: number[] | null;
  reason: string | null;
  kind: string;
}

export interface PlacementPlan {
  refused: string | null;
  rows: PlacementRow[];
  mode?: string;
  occurrences?: number;
}
