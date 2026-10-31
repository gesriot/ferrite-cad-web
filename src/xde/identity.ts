import type { PortableScene, SceneDiagnostic } from "./types";

type Oc = any;

/**
 * Portable scene for one STEP buffer.
 *
 * Definition keys follow the typed routes in the native `step_identity.hpp`.
 * A part key comes only from a non-transforming representation relationship.
 * An assembly key comes from the reader's own product-to-label association.
 * `TransferReader.ShapeResult` is that association for a root. In this WASM
 * build it is null for every non-root product, so a nested assembly uses
 * `STEPCAFControl_Reader.FindInstance`: the same shape-label map, the NAUO
 * the reader recorded, and that occurrence's referred definition. A missing
 * or ambiguous key throws. The viewer can still show the meshes.
 *
 * Matrices are the raw placement doubles. Nothing here applies `clean()`.
 */
export function projectOpen(oc: Oc, reader: any, doc: any): { scene: PortableScene; notes: string[] } {
  const notes = [
    "PrintCheckLoad and PrintCheckTransfer write to the process trace and this binding does not return that text, so those check counts are not stored.",
  ];
  const basic = reader.ChangeReader();
  const model = basic.StepModel();
  const transfer = basic.WS().TransferReader();
  const header = new oc.APIHeaderSection_MakeHeader(model);
  const schemaNames: string[] = [];
  if (header.HasFs()) {
    for (let index = 1; index <= header.NbSchemaIdentifiers(); index += 1) {
      schemaNames.push(String(header.SchemaIdentifiersValue(index).ToCString()));
    }
  }
  const lengths = new oc.NCollection_Sequence_TCollection_AsciiString();
  const angles = new oc.NCollection_Sequence_TCollection_AsciiString();
  const solidAngles = new oc.NCollection_Sequence_TCollection_AsciiString();
  basic.FileUnits(lengths, angles, solidAngles);
  const sourceUnit = lengths.Length() > 0 ? String(lengths.Value(1).ToCString()) : "";

  const pdType = oc.StepBasic_ProductDefinition.get_type_descriptor();
  const sdrType = oc.StepShape_ShapeDefinitionRepresentation.get_type_descriptor();
  const abrType = oc.StepShape_AdvancedBrepShapeRepresentation.get_type_descriptor();
  const relType = oc.StepRepr_ShapeRepresentationRelationship.get_type_descriptor();
  const xformType = oc.StepRepr_RepresentationRelationshipWithTransformation.get_type_descriptor();
  const pdsType = oc.StepRepr_ProductDefinitionShape.get_type_descriptor();
  const nauoType = oc.StepRepr_NextAssemblyUsageOccurrence.get_type_descriptor();

  const identOf = (entity: any) => {
    try {
      return Number(model.IdentLabel(entity));
    } catch {
      return 0;
    }
  };
  const same = (left: any, right: any) => {
    if (!left || !right) return false;
    const number = model.Number(left);
    return number !== 0 && number === model.Number(right);
  };
  const remember = (list: any[], product: any) => {
    if (!product || product.IsNull?.()) return;
    if (!list.some((known) => same(known, product))) list.push(product);
  };

  const breps: any[] = [];
  const shapeDefs: any[] = [];
  const relationships: any[] = [];
  const productDefs: any[] = [];
  const nauos: any[] = [];
  const identCounts = new Map<number, number>();
  const count = model.NbEntities();
  for (let index = 1; index <= count; index += 1) {
    const entity = model.Value(index);
    const ident = identOf(entity);
    if (ident > 0) identCounts.set(ident, (identCounts.get(ident) ?? 0) + 1);
    if (entity.IsKind(abrType)) breps.push(entity);
    if (entity.IsKind(sdrType)) shapeDefs.push(entity);
    if (entity.IsKind(relType)) {
      if (!entity.IsKind(xformType)) relationships.push(entity);
    }
    if (entity.IsKind(pdType)) productDefs.push(entity);
    if (entity.IsKind(nauoType)) nauos.push(entity);
  }

  const direct = new Map<number, any[]>();
  for (const shapeDefinition of shapeDefs) {
    const definition = shapeDefinition.Definition();
    const property = definition?.PropertyDefinition?.() ?? null;
    if (!property || !property.IsKind?.(pdsType)) continue;
    const product = property.Definition()?.ProductDefinition?.() ?? null;
    const representation = shapeDefinition.UsedRepresentation();
    if (!representation || !product) continue;
    const key = model.Number(representation);
    const list = direct.get(key) ?? [];
    remember(list, product);
    direct.set(key, list);
  }
  const propagated = new Map<number, any[]>();
  for (const [key, list] of direct) propagated.set(key, list.slice());
  for (const relationship of relationships) {
    const first = relationship.Rep1();
    const second = relationship.Rep2();
    if (!first || !second) continue;
    const firstProducts = direct.get(model.Number(first)) ?? [];
    const secondProducts = direct.get(model.Number(second)) ?? [];
    if (firstProducts.length) {
      const list = propagated.get(model.Number(second)) ?? [];
      for (const product of firstProducts) remember(list, product);
      propagated.set(model.Number(second), list);
    }
    if (secondProducts.length) {
      const list = propagated.get(model.Number(first)) ?? [];
      for (const product of secondProducts) remember(list, product);
      propagated.set(model.Number(first), list);
    }
  }
  const itemReps = new Map<number, any[]>();
  for (const brep of breps) {
    for (let item = 1; item <= brep.NbItems(); item += 1) {
      const value = brep.ItemsValue(item);
      if (!value) continue;
      const key = model.Number(value);
      const list = itemReps.get(key) ?? [];
      if (!list.some((known) => same(known, brep))) list.push(brep);
      itemReps.set(key, list);
    }
  }
  const productsFrom = (start: any) => {
    const found: any[] = [];
    if (!start) return found;
    for (const product of propagated.get(model.Number(start)) ?? []) remember(found, product);
    for (const representation of itemReps.get(model.Number(start)) ?? []) {
      for (const product of propagated.get(model.Number(representation)) ?? []) remember(found, product);
    }
    return found;
  };

  const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
  const roots = new oc.NCollection_Sequence_TDF_Label();
  shapes.GetFreeShapes(roots);
  const map = reader.GetShapeLabelMap();
  const tool = new oc.STEPConstruct_Tool(basic.WS());
  const definitions: Array<{ label: any; shape: any; assembly: boolean; solids: number; name: string; invalid: number }> = [];

  const definitionIndex = (label: any) => {
    const existing = definitions.findIndex((known) => labelsEqual(known.label, label));
    if (existing >= 0) return existing;
    const shape = oc.XCAFDoc_ShapeTool.GetShape(label);
    const assembly = oc.XCAFDoc_ShapeTool.IsAssembly(label) === true;
    let solids = 0;
    let invalid = 0;
    const explorer = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (explorer.More()) {
      solids += 1;
      if (!assembly) {
        const analyzer = new oc.BRepCheck_Analyzer(explorer.Current(), true, false, false);
        if (!analyzer.IsValid()) invalid += 1;
        analyzer.delete?.();
      }
      explorer.Next();
    }
    explorer.delete?.();
    definitions.push({ label, shape, assembly, solids, invalid, name: labelName(oc, label) });
    return definitions.length - 1;
  };

  const instances: PortableScene["instances"] = [];
  const walk = (label: any, parent: number | null, placement: any) => {
    let definition = label;
    if (oc.XCAFDoc_ShapeTool.IsReference(label)) {
      const referred = new oc.TDF_Label();
      oc.XCAFDoc_ShapeTool.GetReferredShape(label, referred);
      definition = referred;
    }
    const index = definitionIndex(definition);
    const self = instances.length;
    const transform = placement.Transformation();
    const matrix: number[] = [];
    for (let row = 1; row <= 3; row += 1) for (let column = 1; column <= 4; column += 1) matrix.push(transform.Value(row, column));
    let name = labelName(oc, label);
    if (!name) name = labelName(oc, definition);
    const color = new oc.Quantity_Color();
    let source: PortableScene["instances"][number]["colourSource"] = "none";
    let rgb: [number, number, number] = [0, 0, 0];
    if (oc.XCAFDoc_ColorTool.GetColor(label, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf, color)) source = "instance";
    else if (oc.XCAFDoc_ColorTool.GetColor(definition, oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf, color)) source = "definition";
    if (source !== "none") rgb = [color.Red(), color.Green(), color.Blue()];
    instances.push({ definition: "", parent, name, placement: matrix, colourSource: source, colour: rgb });
    if (!definitions[index]!.assembly) return;
    const kids = new oc.NCollection_Sequence_TDF_Label();
    oc.XCAFDoc_ShapeTool.GetComponents(definitions[index]!.label, kids, false);
    for (let indexChild = 1; indexChild <= kids.Length(); indexChild += 1) {
      const child = kids.Value(indexChild);
      walk(child, self, oc.XCAFDoc_ShapeTool.GetLocation(child));
    }
  };
  for (let index = 1; index <= roots.Length(); index += 1) walk(roots.Value(index), null, new oc.TopLoc_Location());

  const entitiesFrom = (shape: any) => {
    const found: any[] = [];
    if (!shape || shape.IsNull()) return found;
    const unplaced = shape.Located(new oc.TopLoc_Location());
    for (const candidate of [shape, unplaced]) {
      for (let mode = 0; mode <= 3; mode += 1) {
        let entity = null;
        try {
          entity = transfer.EntityFromShapeResult(candidate, mode);
        } catch {
          entity = null;
        }
        if (!entity || entity.IsNull?.()) continue;
        if (!found.some((known) => same(known, entity))) found.push(entity);
      }
    }
    return found;
  };
  const sourceIdent = (entity: any) => {
    const ident = identOf(entity);
    if (ident <= 0 || identCounts.get(ident) !== 1) return 0;
    return ident;
  };
  const xdeProducts = (definition: (typeof definitions)[number]) => {
    const fromShape: any[] = [];
    for (const product of productDefs) {
      let result = null;
      try {
        result = transfer.ShapeResult(product);
      } catch {
        result = null;
      }
      if (!result || result.IsNull()) continue;
      let bound = false;
      try {
        bound = map.IsBound(result) === true;
      } catch {
        bound = false;
      }
      if (!bound) continue;
      let label = null;
      try {
        label = map.Seek(result);
      } catch {
        label = null;
      }
      if (labelsEqual(definition.label, label)) remember(fromShape, product);
    }
    if (fromShape.length || !definition.assembly) return fromShape;
    const fromNauo: any[] = [];
    for (const nauo of nauos) {
      const related = nauo.RelatedProductDefinition();
      let instance = null;
      try {
        instance = oc.STEPCAFControl_Reader.FindInstance(nauo, shapes, tool, map);
      } catch (error) {
        throw new Error(`STEPCAFControl_Reader.FindInstance failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!instance || instance.IsNull?.() || !oc.XCAFDoc_ShapeTool.IsReference(instance)) continue;
      const referred = new oc.TDF_Label();
      oc.XCAFDoc_ShapeTool.GetReferredShape(instance, referred);
      if (labelsEqual(referred, definition.label)) remember(fromNauo, related);
    }
    if (fromNauo.length) {
      notes.push("A non-root assembly has no ShapeResult in this WASM build. Its product key comes from STEPCAFControl_Reader.FindInstance and the NAUO related product.");
    }
    return fromNauo;
  };

  const keys = definitions.map((definition, index) => {
    const candidates: any[] = [];
    if (definition.assembly) {
      for (const product of xdeProducts(definition)) remember(candidates, product);
    } else {
      for (const entity of entitiesFrom(definition.shape)) for (const product of productsFrom(entity)) remember(candidates, product);
      if (candidates.length === 0) return "";
      for (const product of xdeProducts(definition)) remember(candidates, product);
    }
    if (candidates.length !== 1) return candidates.length > 1 ? "ambiguous" : "";
    const ident = sourceIdent(candidates[0]);
    if (ident <= 0) return "";
    void index;
    return `step.product_definition#${ident}`;
  });
  const ambiguous = keys.findIndex((key) => key === "ambiguous");
  if (ambiguous >= 0) {
    const name = definitions[ambiguous]?.name || `definition ${ambiguous}`;
    throw new Error(`${name} matches more than one product definition, so it cannot be stored`);
  }
  const missing = keys.findIndex((key) => !key);
  if (missing >= 0) {
    const name = definitions[missing]?.name || `definition ${missing}`;
    throw new Error(`${name} has no unambiguous step.product_definition identity, so this reading cannot be stored`);
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`${key} is used by two definitions, so it cannot be stored`);
    seen.add(key);
  }

  const keyed = instances.map((instance) => ({ ...instance }));
  {
    let cursor = 0;
    const stamp = (label: any) => {
      let definition = label;
      if (oc.XCAFDoc_ShapeTool.IsReference(label)) {
        const referred = new oc.TDF_Label();
        oc.XCAFDoc_ShapeTool.GetReferredShape(label, referred);
        definition = referred;
      }
      const index = definitions.findIndex((known) => labelsEqual(known.label, definition));
      keyed[cursor] = { ...keyed[cursor]!, definition: keys[index]! };
      cursor += 1;
      if (!definitions[index]!.assembly) return;
      const kids = new oc.NCollection_Sequence_TDF_Label();
      oc.XCAFDoc_ShapeTool.GetComponents(definitions[index]!.label, kids, false);
      for (let child = 1; child <= kids.Length(); child += 1) stamp(kids.Value(child));
    };
    for (let index = 1; index <= roots.Length(); index += 1) stamp(roots.Value(index));
    if (cursor !== keyed.length) throw new Error("instance walk and definition keys diverged");
  }

  const diagnostics: SceneDiagnostic[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    if (definition.invalid === 0) continue;
    diagnostics.push({
      stage: "validation",
      severity: "fail",
      entity: keys[index]!,
      message: `Open CASCADE reports ${definition.invalid} of ${definition.solids} solid(s) invalid; the definition was retained`,
    });
  }

  try { header.delete?.(); } catch { /* header is a local tool */ }
  try { tool.delete?.(); } catch { /* tool is a local tool */ }

  return {
    scene: {
      sourceUnit,
      schema: schemaNames.join(" + "),
      definitions: definitions.map((definition, index) => ({ key: keys[index]!, name: definition.name, solids: definition.solids })),
      instances: keyed,
      diagnostics,
    },
    notes: [...new Set(notes)],
  };
}

export function projectBytes(oc: Oc, bytes: Uint8Array, ownPath: (name: string) => string): { scene: PortableScene; notes: string[] } {
  let stage = "application";
  const app = new oc.TDocStd_Application();
  let doc: any = null;
  let reader: any = null;
  const path = ownPath("project.step");
  try {
    stage = "document";
    const opened = app.NewDocument(new oc.TCollection_ExtendedString("BinXCAF", true));
    doc = opened.aDoc;
    if (!doc?.Main) throw new Error("NewDocument did not return an XCAF document");
    stage = "reader";
    reader = new oc.STEPCAFControl_Reader();
    reader.SetNameMode(true);
    reader.SetColorMode(true);
    stage = "write";
    oc.FS.writeFile(path, bytes);
    stage = "read";
    const status = String(reader.ReadFile(path));
    if (status !== "IFSelect_RetDone") throw new Error(`STEP reader rejected the file (${status})`);
    stage = "transfer";
    if (reader.Transfer(doc, new oc.Message_ProgressRange()) !== true) throw new Error("STEP transfer failed");
    stage = "project";
    return projectOpen(oc, reader, doc);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${message}`);
  } finally {
    try { reader?.delete?.(); } catch { /* already gone */ }
    try { if (doc) app.Close(doc); } catch { /* already closed */ }
    try { oc.FS.unlink(path); } catch { /* owned cleanup removes it */ }
  }
}

function labelKey(label: any): string {
  if (!label || label.IsNull?.()) return "";
  const tags: number[] = [];
  let cursor = label;
  while (cursor && !cursor.IsNull() && !cursor.IsRoot()) {
    tags.push(cursor.Tag());
    cursor = cursor.Father();
  }
  return tags.reverse().join(":");
}

function labelsEqual(left: any, right: any): boolean {
  if (!left || !right || left.IsNull?.() || right.IsNull?.()) return false;
  return labelKey(left) === labelKey(right);
}

function labelName(oc: Oc, label: any): string {
  const found = label.FindAttribute(oc.TDataStd_Name.GetID());
  if (!found?.returnValue) return "";
  return new oc.TCollection_AsciiString(found.anAttribute.Get(), false).ToCString();
}
