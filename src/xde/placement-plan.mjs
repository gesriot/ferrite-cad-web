/**
 * @typedef {import("./occt-surface").Oc} Oc
 * @typedef {import("./occt-surface").OcHandle} OcHandle
 * @typedef {import("./occt-surface").PlacementPlan} PlacementPlan
 */

/**
 * Placement plan for one open STEP document.
 *
 * Same accepted slice as the audit: an empty location chain is the constructed
 * identity, and one power-1 datum with one unambiguous axis2 pair is
 * SetTransformation(item2, item1). Anything else is refused. A missing STEP
 * link is not turned into identity. This module does not read files or oracles.
 */
import { emptyLocationMatrix, evaluateCase } from "./placement-math/gp-contract.mjs";
import { hexOf } from "./placement-math/f64.mjs";

/** @param {{ isNull?: () => boolean, IsNull?: () => boolean, ToCString?: () => string } | null | undefined} value */
function dead(value) {
  if (!value) return true;
  try {
    if (typeof value.isNull === "function" && value.isNull()) return true;
  } catch { /* not every wrapper has isNull */ }
  try {
    if (typeof value.IsNull === "function" && value.IsNull()) return true;
  } catch { /* shapes and labels use IsNull */ }
  return false;
}

/** @param {OcHandle | null | undefined} value */
function textOf(value) {
  if (dead(value)) return "";
  try { return String(value && value.ToCString()); } catch { return ""; }
}

/** @param {OcHandle} label */
function labelKey(label) {
  const tags = [];
  let cursor = label;
  while (cursor && !cursor.IsNull() && !cursor.IsRoot()) {
    tags.push(cursor.Tag());
    cursor = cursor.Father();
  }
  return tags.reverse().join(":");
}

/** @param {Oc} oc @param {OcHandle} label */
function entryOf(oc, label) {
  const ascii = new oc.TCollection_AsciiString();
  oc.TDF_Tool.Entry(label, ascii);
  const entry = textOf(ascii);
  ascii.delete?.();
  return entry;
}

/** @param {OcHandle} transform */
function matrixOf(transform) {
  const values = [];
  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 4; column += 1) values.push(transform.Value(row, column));
  }
  return values;
}

/** @param {OcHandle} direction */
function ratiosOf(direction) {
  const count = direction.NbDirectionRatios();
  const values = [];
  for (let index = 1; index <= count; index += 1) values.push(direction.DirectionRatiosValue(index));
  return { count, values };
}

/** @param {OcHandle} point */
function pointOf(point) {
  const count = point.NbCoordinates();
  const values = [];
  for (let index = 1; index <= count; index += 1) values.push(point.CoordinatesValue(index));
  return { count, values };
}

/** @param {{ unavailable?: string | null, location?: { count: number, values: number[] }, axis?: { count: number, values: number[] }, ref?: { count: number, values: number[] } } | null} item */
function placementNumbers(item) {
  if (!item || item.unavailable) return null;
  if (item.location?.count !== 3 || item.axis?.count !== 3 || item.ref?.count !== 3) return null;
  return { location: item.location.values, axis: item.axis.values, ref: item.ref.values };
}

/**
 * Structural millimetre proof for one axis2 item.
 * Looks only at the representation that contains that item. A file-level
 * FileUnits() string is not used. Conversion is not applied: anything that is
 * not SI milli-metre is a refusal, before any location is written.
 */
/** @param {Oc} oc @param {OcHandle} model @param {OcHandle} item */
function proveMillimetre(oc, model, item) {
  const reprType = oc.StepRepr_Representation.get_type_descriptor();
  const siLengthType = oc.StepBasic_SiUnitAndLengthUnit.get_type_descriptor();
  const siType = oc.StepBasic_SiUnit.get_type_descriptor();
  const conversionType = oc.StepBasic_ConversionBasedUnit.get_type_descriptor();
  const combinedContextType = oc.StepGeom_GeomRepContextAndGlobUnitAssCtxAndGlobUncertaintyAssCtx.get_type_descriptor();
  const itemNumber = model.Number(item);
  const contexts = [];
  for (let index = 1; index <= model.NbEntities(); index += 1) {
    const entity = model.Value(index);
    if (!entity.IsKind(reprType)) continue;
    let contains = false;
    try {
      const count = entity.NbItems();
      for (let at = 1; at <= count; at += 1) {
        if (model.Number(entity.ItemsValue(at)) === itemNumber) {
          contains = true;
          break;
        }
      }
    } catch {
      continue;
    }
    if (!contains) continue;
    let context = null;
    try { context = entity.ContextOfItems(); } catch { context = null; }
    if (!context || !context.IsKind(combinedContextType)) {
      return { ok: false, reason: "the representation that contains this axis2 has no GeomRepContextAndGlobUnitAssCtx" };
    }
    contexts.push(context);
  }
  if (!contexts.length) return { ok: false, reason: "this axis2 is not an item of a representation with units" };
  for (const context of contexts) {
    const proof = lengthProof(context, siLengthType, siType, conversionType);
    if (!proof.ok) return proof;
  }
  return { ok: true, unit: "SI_UNIT(.MILLI.,.METRE.)" };
}

/** @param {OcHandle} context @param {unknown} siLengthType @param {unknown} siType @param {unknown} conversionType */
function lengthProof(context, siLengthType, siType, conversionType) {
  const lengths = [];
  const count = context.NbUnits();
  for (let index = 1; index <= count; index += 1) {
    const unit = context.UnitsValue(index);
    if (unit.IsKind(siLengthType) || unit.IsKind(conversionType)) lengths.push(unit);
  }
  if (lengths.length !== 1) return { ok: false, reason: `representation context has ${lengths.length} length units` };
  const unit = lengths[0];
  if (unit.IsKind(conversionType)) return { ok: false, reason: "length unit is conversion-based; this experiment does not convert" };
  if (!unit.IsKind(siLengthType) || !unit.IsKind(siType)) return { ok: false, reason: "length unit is not an SI milli-metre unit" };
  const prefix = unit.HasPrefix() ? String(unit.Prefix()) : "absent";
  const name = String(unit.Name());
  if (prefix !== "StepBasic_spMilli" || name !== "StepBasic_sunMetre") {
    return { ok: false, reason: `length unit is ${prefix} ${name}, not milli metre` };
  }
  return { ok: true, unit: "SI_UNIT(.MILLI.,.METRE.)" };
}

/** @param {{ index: number, chain: { power: number, bits: string[] }[], datumDiffersFromLocation: boolean, bits: string[] }} node @param {{ ambiguous?: boolean, linkReason?: string, item1?: unknown, item2?: unknown, unitProof?: { ok: boolean, reason?: string, unit?: string } } | null} link */
function decide(node, link) {
  const powers = node.chain.map((item) => item.power);
  if (node.chain.length === 0) {
    return { covered: true, kind: "empty-location", reason: null, candidate: emptyLocationMatrix() };
  }
  if (node.chain.length !== 1 || powers.some((power) => power !== 1)) {
    return {
      covered: false,
      kind: "uncovered",
      reason: `location is a chain of ${node.chain.length} datum(s) with powers ${powers.join(",")}; this experiment does not compose it`,
      candidate: null,
    };
  }
  if (node.datumDiffersFromLocation) {
    return { covered: false, kind: "uncovered", reason: "location.Transformation() differs from its single datum", candidate: null };
  }
  if (!link || link.ambiguous || !link.item1 || !link.item2) {
    return { covered: false, kind: "uncovered", reason: link?.linkReason ?? "no NextAssemblyUsageOccurrence is linked to this occurrence label", candidate: null };
  }
  const from = placementNumbers(link.item1);
  const to = placementNumbers(link.item2);
  if (!from || !to) {
    return { covered: false, kind: "uncovered", reason: link.linkReason ?? "ItemDefinedTransformation is not two complete axis2_placement_3d values", candidate: null };
  }
  const evaluated = evaluateCase({ index: node.index, item1: { present: true, ...from }, item2: { present: true, ...to } }, "contracted");
  if (!link.unitProof?.ok) {
    const raw = to.location.map((value) => value).join(", ");
    const kernel = node.bits.filter((_, index) => index % 4 === 3).join(", ");
    return {
      covered: false,
      kind: "uncovered",
      reason: `units are not a proven millimetre context (${link.unitProof?.reason ?? "no unit proof"}). Raw STEP translation [${raw}]; kernel location translation hex [${kernel}]. Nothing is installed`,
      candidate: null,
    };
  }
  return {
    covered: true,
    kind: "axis2-pair",
    reason: null,
    candidate: evaluated["SetTransformation(item2, item1)"],
    unitProof: link.unitProof.unit,
  };
}

/**
 * Plan every free-shape occurrence in the open document.
 * `labels` stay valid until the document is closed. Nothing is written.
 */
/** @param {Oc} oc @param {OcHandle} reader @param {OcHandle} doc @returns {PlacementPlan & Record<string, unknown>} */
export function planOpenDocument(oc, reader, doc) {
  const basic = reader.ChangeReader();
  const model = basic.StepModel();
  const shapes = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main());
  const map = reader.GetShapeLabelMap();
  const tool = new oc.STEPConstruct_Tool(basic.WS());
  /** @type {Array<{ index: number, chain: { power: number, bits: string[] }[], datumDiffersFromLocation: boolean, bits: string[], parent: number, entry: string, labelKey: string, label: OcHandle }>} */
  const nodes = [];
  /** @param {OcHandle} label @param {OcHandle} location @param {number} parent */
  const walk = (label, location, parent) => {
    const index = nodes.length;
    const chain = [];
    let rest = location;
    while (!rest.IsIdentity()) {
      if (chain.length > 64) throw new Error("location chain exceeds the accepted placement limit");
      chain.push({ power: rest.FirstPower(), bits: matrixOf(rest.FirstDatum().Transformation()).map(hexOf) });
      rest = rest.NextLocation();
    }
    const values = matrixOf(location.Transformation());
    const bits = values.map(hexOf);
    nodes.push({
      index,
      parent,
      entry: entryOf(oc, label),
      labelKey: labelKey(label),
      label,
      bits,
      chain,
      datumDiffersFromLocation: chain.length > 0 && chain[0].bits.join(" ") !== bits.join(" "),
    });
    let definition = label;
    if (oc.XCAFDoc_ShapeTool.IsReference(label)) {
      definition = new oc.TDF_Label();
      if (!oc.XCAFDoc_ShapeTool.GetReferredShape(label, definition)) throw new Error(`instance ${index} has no referred shape`);
    }
    const kids = new oc.NCollection_Sequence_TDF_Label();
    oc.XCAFDoc_ShapeTool.GetComponents(definition, kids, false);
    for (let child = 1; child <= kids.Length(); child += 1) {
      walk(kids.Value(child), oc.XCAFDoc_ShapeTool.GetShape(kids.Value(child)).Location(), index);
    }
  };
  const roots = new oc.NCollection_Sequence_TDF_Label();
  shapes.GetFreeShapes(roots);
  for (let index = 1; index <= roots.Length(); index += 1) walk(roots.Value(index), new oc.TopLoc_Location(), -1);

  const nauoType = oc.StepRepr_NextAssemblyUsageOccurrence.get_type_descriptor();
  const cdsrType = oc.StepShape_ContextDependentShapeRepresentation.get_type_descriptor();
  const xformType = oc.StepRepr_RepresentationRelationshipWithTransformation.get_type_descriptor();
  const a2Type = oc.StepGeom_Axis2Placement3d.get_type_descriptor();
  const nauos = [];
  const cdsrs = [];
  for (let index = 1; index <= model.NbEntities(); index += 1) {
    const entity = model.Value(index);
    if (entity.IsKind(nauoType)) nauos.push(entity);
    if (entity.IsKind(cdsrType)) cdsrs.push(entity);
  }
  const nauoByLabel = new Map();
  for (const nauo of nauos) {
    let instance = null;
    try {
      instance = oc.STEPCAFControl_Reader.FindInstance(nauo, shapes, tool, map);
    } catch (error) {
      throw new Error(`FindInstance failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (dead(instance) || !instance) continue;
    const key = labelKey(instance);
    const list = nauoByLabel.get(key) ?? [];
    list.push(nauo);
    nauoByLabel.set(key, list);
  }
  const cdsrByNauo = new Map();
  for (const cdsr of cdsrs) {
    let relation = null;
    let productRelation = null;
    try {
      relation = cdsr.RepresentationRelation();
      productRelation = cdsr.RepresentedProductRelation();
    } catch (error) {
      throw new Error(`CDSR fields unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let relationship = null;
    try {
      relationship = productRelation?.Definition?.()?.ProductDefinitionRelationship?.() ?? null;
    } catch (error) {
      throw new Error(`ProductDefinitionRelationship unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (dead(relationship)) continue;
    const key = model.Number(relationship);
    const list = cdsrByNauo.get(key) ?? [];
    list.push({ cdsr, relation });
    cdsrByNauo.set(key, list);
  }
  /** @param {OcHandle} entity */
  const typeName = (entity) => {
    try { return model.TypeName(entity, true); } catch { return "unknown"; }
  };
  /** @param {OcHandle} item */
  const describePlacement = (item) => {
    if (dead(item)) return { unavailable: "transform item is null" };
    if (!item.IsKind(a2Type)) return { unavailable: `transform item is ${typeName(item)}, not axis2_placement_3d` };
    const location = pointOf(item.Location());
    let axis = null;
    let ref = null;
    let axisGap = null;
    let refGap = null;
    try {
      if (!item.HasAxis()) axisGap = "Axis2Placement3d has no Axis";
      else axis = ratiosOf(item.Axis());
    } catch (error) {
      axisGap = `Axis() unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    try {
      if (!item.HasRefDirection()) refGap = "Axis2Placement3d has no RefDirection";
      else ref = ratiosOf(item.RefDirection());
    } catch (error) {
      refGap = `RefDirection() unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      location,
      axis,
      ref,
      unavailable: axisGap ?? refGap ?? (location.count !== 3 || axis?.count !== 3 || ref?.count !== 3 ? "placement coordinates are not three binary64 values" : null),
    };
  };
  /** @param {OcHandle} relation */
  const describeRelation = (relation) => {
    if (dead(relation)) return { unavailable: "representation relation is null" };
    if (!relation.IsKind(xformType)) return { unavailable: `relation is ${typeName(relation)}, not RepresentationRelationshipWithTransformation` };
    let defined = null;
    try {
      defined = relation.TransformationOperator()?.ItemDefinedTransformation?.() ?? null;
    } catch (error) {
      return { unavailable: `TransformationOperator().ItemDefinedTransformation() unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (dead(defined)) return { unavailable: "transformation operator is not an ItemDefinedTransformation" };
    const raw1 = defined.TransformItem1();
    const raw2 = defined.TransformItem2();
    const item1 = describePlacement(raw1);
    const item2 = describePlacement(raw2);
    if (item1.unavailable || item2.unavailable) return { unavailable: item1.unavailable ?? item2.unavailable, item1, item2 };
    const unit1 = proveMillimetre(oc, model, raw1);
    const unit2 = proveMillimetre(oc, model, raw2);
    if (!unit1.ok || !unit2.ok || !("unit" in unit1) || !("unit" in unit2) || unit1.unit !== unit2.unit) {
      return {
        unavailable: null,
        item1,
        item2,
        unitProof: { ok: false, reason: unit1.ok ? unit2.reason : unit1.reason },
      };
    }
    if (!unit1.ok || !unit1.unit) return { unavailable: null, item1, item2, unitProof: { ok: false, reason: unit1.reason ?? "no unit" } };
    return { unavailable: null, item1, item2, unitProof: { ok: true, unit: unit1.unit } };
  };
  const links = nodes.map((node) => {
    const nauoList = nauoByLabel.get(node.labelKey) ?? [];
    if (!nauoList.length) return { ambiguous: false, linkReason: "no NextAssemblyUsageOccurrence is linked to this occurrence label", item1: null, item2: null };
    const complete = [];
    const problems = [];
    for (const nauo of nauoList) {
      const number = model.Number(nauo);
      const representations = cdsrByNauo.get(number) ?? [];
      if (!representations.length) problems.push(`NAUO #${number} has no ContextDependentShapeRepresentation`);
      for (const { relation } of representations) {
        const described = describeRelation(relation);
        if (described.unavailable || !described.item1 || !described.item2) {
          problems.push(described.unavailable ?? "relation has no placement pair");
          continue;
        }
        complete.push(described);
      }
    }
    if (complete.length !== 1) {
      return {
        ambiguous: complete.length > 1,
        linkReason: complete.length > 1
          ? `${complete.length} ItemDefinedTransformation links for one occurrence; not chosen by name`
          : (problems[0] ?? "no complete axis2 pair"),
        item1: null,
        item2: null,
      };
    }
    return { ambiguous: false, linkReason: undefined, ...complete[0] };
  });
  try { tool.delete?.(); } catch { /* local tool */ }

  const rows = nodes.map((node, index) => {
    const decision = decide(node, links[index]);
    return {
      index: node.index,
      parent: node.parent,
      entry: node.entry,
      labelKey: node.labelKey,
      label: node.label,
      kind: decision.kind,
      covered: decision.covered,
      reason: decision.reason,
      candidate: decision.candidate,
      unitProof: decision.unitProof ?? (decision.kind === "empty-location" ? "not-required" : null),
    };
  });
  const uncovered = rows.find((row) => !row.covered);
  return {
    rows,
    refused: uncovered ? `occurrence ${uncovered.index} ${uncovered.entry} is not in the accepted placement slice: ${uncovered.reason}` : null,
  };
}
