import { projectBytes, projectOpen } from "./identity.ts";
import { installPlacements } from "./placement-install.mjs";
import { planOpenDocument } from "./placement-plan.mjs";
import { fromRows, then } from "./placement-math/transform.mjs";
import type { DefinitionMesh, FileUnits, LinearRgb, PortableScene, XdeNode, XdeReport } from "./types";

/**
 * STEP/XDE session inside one WASM instance.
 *
 * `oc` is one `@taucad/opencascade.js` module. Its TopoDS and TDF handles are
 * not meaningful in any other module, including the replicad worker, so this
 * object never returns them. Callers only see plain JSON and STEP bytes.
 *
 * Documents are created with TDocStd_Application. XCAFApp_Application.GetApplication
 * aborts this build (TPrsStd_DriverTable::Get is not linked).
 *
 * Export uses STEPCAFControl_Writer.Perform. Transfer's string argument switches
 * on multi-file mode even when the string is empty, which writes sibling part
 * files. Perform writes one STEP.
 *
 * XCAFDoc_ShapeTool.SetLocation stores `theLoc * current` for a reference, so a
 * placement edit passes `desired * current.inverted()`.
 */

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

type Oc = any;

export class XdeEngine {
  private oc: Oc;
  private app: any = null;
  private doc: any = null;
  private opened: any = null;
  private seq = 0;
  private readonly used = new Set<string>();
  private experimentalPlacement = false;
  private placementKept: unknown[] = [];
  /** Absolute virtual directory owned by this session. Nothing outside it is deleted. */
  private readonly ownedDir: string;
  private dirReady = false;

  constructor(oc: Oc) {
    this.oc = oc;
    const suffix = Math.random().toString(36).slice(2, 10);
    this.ownedDir = `/xde-own-${Date.now().toString(36)}-${suffix}`;
  }

  heapBytes(): number | null {
    const heap = this.oc.HEAPU8 as { byteLength?: number } | undefined;
    return typeof heap?.byteLength === "number" ? heap.byteLength : null;
  }

  release(): { released: true; temporaryFiles: string[] } {
    if (this.app && this.doc) {
      this.api("CDF_Application.Close");
      try {
        this.app.Close(this.doc);
      } catch {
        // The document may already have been closed on a failed read.
      }
    }
    this.opened = null;
    this.doc = null;
    this.app = null;
    this.experimentalPlacement = false;
    this.placementKept = [];
    this.removeTemporary();
    return { released: true, temporaryFiles: this.temporaryFiles() };
  }

  /**
   * Names still inside this session's directory.
   * Files elsewhere, whether created before or after this engine, are not listed.
   * Heap size is unavailable in this glue (`n/a`).
   */
  temporaryFiles(): string[] {
    return this.ownedEntries();
  }

  read(bytes: Uint8Array, options: { experimental?: boolean } = {}): { report: XdeReport; meshes: DefinitionMesh[]; scene: PortableScene | null; sceneError: string | null; sceneNotes: string[]; placement: ExperimentalPlacement | null } {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      throw new Error("STEP reader received no bytes");
    }
    this.release();
    const oc = this.oc;
    const experimental = options.experimental === true;
    this.api("TDocStd_Application.NewDocument");
    this.api("TCollection_ExtendedString");
    let reader: any = null;
    let app: any = null;
    let doc: any = null;
    let adopted = false;
    try {
      const opened = new oc.TDocStd_Application();
      app = opened;
      const created = app.NewDocument(new oc.TCollection_ExtendedString("BinXCAF", true));
      doc = created.aDoc;
      if (!doc?.Main) throw new Error("NewDocument did not return an XCAF document");
      const path = this.ownPath(`in-${++this.seq}.step`);
      this.api("FS.writeFile");
      oc.FS.writeFile(path, bytes);
      this.api("STEPCAFControl_Reader");
      this.api("STEPCAFControl_Reader.SetNameMode");
      this.api("STEPCAFControl_Reader.SetColorMode");
      this.api("STEPCAFControl_Reader.ReadFile");
      this.api("STEPCAFControl_Reader.Transfer");
      reader = new oc.STEPCAFControl_Reader();
      reader.SetNameMode(true);
      reader.SetColorMode(true);
      const status = String(reader.ReadFile(path));
      if (status !== "IFSelect_RetDone") throw new Error(`STEP reader rejected the file (${status})`);
      const transferred = reader.Transfer(doc, new oc.Message_ProgressRange()) === true;
      if (!transferred) throw new Error("STEP transfer failed");
      let placement: ExperimentalPlacement | null = null;
      if (experimental) {
        this.api("XCAFDoc_Location.Set");
        this.api("gp_GTrsf.SetForm");
        this.api("gp_GTrsf.Trsf");
        this.api("gp_Trsf.SetScaleFactor");
        this.api("XCAFDoc_ShapeTool.UpdateAssemblies");
        const plan = planOpenDocument(oc, reader, doc);
        const installed = installPlacements(oc, doc, plan);
        this.placementKept = installed.kept;
        placement = {
          mode: installed.mode,
          occurrences: installed.occurrences,
          labelsWritten: installed.labelsWritten,
          rawBoundaryDifferences: installed.rawBoundaryDifferences,
          rows: installed.rows,
          world: installed.world,
        };
      }
      this.experimentalPlacement = experimental;
      let scene: PortableScene | null = null;
      let sceneError: string | null = null;
      let sceneNotes: string[] = [];
      try {
        const projected = projectOpen(oc, reader, doc);
        scene = projected.scene;
        sceneNotes = projected.notes;
        if (experimental) {
          sceneNotes = [
            "Experimental placement compatibility installed rigid locations in this XDE document before projection. This is not a native FerriteCAD check.",
            ...sceneNotes,
          ];
        }
      } catch (error) {
        sceneError = error instanceof Error ? error.message : String(error);
      }
      this.app = app;
      this.doc = doc;
      this.opened = created;
      adopted = true;
      const inspected = this.inspect(status, true, this.fileUnits(reader));
      return { ...inspected, scene, sceneError, sceneNotes, placement };
    } catch (error) {
      if (!adopted && app && doc) {
        try {
          app.Close(doc);
        } catch {
          // Already closed or never fully open.
        }
      }
      throw error;
    } finally {
      // The reader is owned. Labels, shapes and the XCAF document are not.
      try {
        reader?.delete?.();
      } catch {
        // delete is a no-op once the reader is gone
      }
      this.removeTemporary();
    }
  }

  shift(definitionName: string, dz: number): { report: XdeReport; meshes: DefinitionMesh[] } {
    if (!this.doc) throw new Error("No STEP document is open");
    if (!definitionName || !Number.isFinite(dz)) throw new Error("Shift needs a definition name and a finite distance");
    const oc = this.oc;
    this.api("XCAFDoc_ShapeTool.SetLocation");
    this.api("XCAFDoc_ShapeTool.UpdateAssemblies");
    this.api("gp_Trsf.SetTranslation");
    this.api("TopLoc_Location");
    const shapes = this.shapeTool();
    const hits = this.componentLabels().filter((item) => item.definitionName === definitionName);
    if (hits.length !== 1) throw new Error(`${definitionName} matched ${hits.length} occurrences, expected 1`);
    const child = hits[0]!.label;
    const current = oc.XCAFDoc_ShapeTool.GetLocation(child);
    const part = current.Transformation().TranslationPart();
    const expected: [number, number, number] = [part.X(), part.Y(), part.Z() + dz];
    const desiredTr = new oc.gp_Trsf();
    desiredTr.SetTranslation(new oc.gp_Vec(expected[0], expected[1], expected[2]));
    const delta = new oc.TopLoc_Location(desiredTr).Multiplied(current.Inverted());
    const ref = new oc.TDF_Label();
    const ok = shapes.SetLocation(child, delta, ref);
    if (!ok) throw new Error(`SetLocation rejected ${definitionName}`);
    shapes.UpdateAssemblies();
    const after = oc.XCAFDoc_ShapeTool.GetLocation(child).Transformation().TranslationPart();
    const got: [number, number, number] = [after.X(), after.Y(), after.Z()];
    if (got.some((value, index) => Math.abs(value - expected[index]!) > 1e-6)) {
      throw new Error(`SetLocation left ${definitionName} at ${got.join(", ")} instead of ${expected.join(", ")}`);
    }
    return this.inspect("modified", true, { available: false, reason: "Units were not re-read after an in-session edit" });
  }

  exportStep(): { bytes: Uint8Array; byteLength: number } {
    if (!this.doc) throw new Error("No STEP document is open");
    const oc = this.oc;
    this.api("STEPCAFControl_Writer");
    this.api("STEPCAFControl_Writer.SetNameMode");
    this.api("STEPCAFControl_Writer.SetColorMode");
    this.api("STEPCAFControl_Writer.Perform");
    this.api("FS.readFile");
    let writer: any = null;
    try {
      writer = new oc.STEPCAFControl_Writer();
      writer.SetNameMode(true);
      writer.SetColorMode(true);
      const name = `out-${++this.seq}.step`;
      const path = this.ownPath(name);
      const wrote = writer.Perform(this.doc, path, new oc.Message_ProgressRange());
      if (!wrote) throw new Error("STEP writer failed");
      const extra = this.ownedEntries().filter((entry) => entry !== name);
      if (extra.length > 0) throw new Error(`STEP writer emitted extra files: ${extra.join(", ")}`);
      const stored = oc.FS.readFile(path) as Uint8Array;
      const bytes = new Uint8Array(stored.byteLength);
      bytes.set(stored);
      if (bytes.byteLength < 20 || !new TextDecoder().decode(bytes.subarray(0, 13)).includes("ISO-10303-21")) {
        throw new Error("STEP writer did not produce a STEP file");
      }
      return { bytes, byteLength: bytes.byteLength };
    } finally {
      try {
        writer?.delete?.();
      } catch {
        // delete is a no-op once the writer is gone
      }
      this.removeTemporary();
    }
  }

  private inspect(readStatus: string, transferred: boolean, fileUnits: FileUnits): { report: XdeReport; meshes: DefinitionMesh[] } {
    const oc = this.oc;
    this.api("XCAFDoc_DocumentTool.ShapeTool");
    this.api("XCAFDoc_DocumentTool.ColorTool");
    this.api("XCAFDoc_ShapeTool.GetFreeShapes");
    this.api("XCAFDoc_ShapeTool.GetComponents");
    this.api("XCAFDoc_ShapeTool.GetReferredShape");
    this.api("XCAFDoc_ShapeTool.GetLocation");
    this.api("XCAFDoc_ShapeTool.GetShape");
    this.api("XCAFDoc_ShapeTool.IsAssembly");
    this.api("XCAFDoc_ShapeTool.IsReference");
    this.api("TDF_Label.FindAttribute");
    this.api("TDataStd_Name.Get");
    this.api("TCollection_AsciiString");
    this.api("XCAFDoc_ColorTool.GetColor");
    this.api("Quantity_Color.Red");
    this.api("BRepCheck_Analyzer.IsValid");
    this.api("BRepGProp.VolumeProperties");
    this.api("BRepBndLib.Add");
    this.api("BRep_Tool.Surface");
    this.api("Geom_Surface.IsKind");
    this.api("TopExp_Explorer");
    this.api("TDF_Label.IsEqual");
    const shapes = this.shapeTool();
    const pending: Array<Omit<XdeNode, "definitionId"> & { definition: any }> = [];
    let nextOccurrence = 1;
    const visit = (label: any, parentPath: string | null, parentOccurrenceId: string | null, parentWorld: number[]) => {
      const isOccurrence = oc.XCAFDoc_ShapeTool.IsReference(label) === true;
      let definition = label;
      if (isOccurrence) {
        const slot = new oc.TDF_Label();
        if (!oc.XCAFDoc_ShapeTool.GetReferredShape(label, slot)) throw new Error("Reference has no referred shape");
        definition = slot;
      }
      const definitionName = this.nameOf(definition);
      const occurrenceName = this.nameOf(label);
      const local = isOccurrence
        ? (this.experimentalPlacement ? rawMatrix(oc.XCAFDoc_ShapeTool.GetLocation(label).Transformation()) : this.matrixOf(oc.XCAFDoc_ShapeTool.GetLocation(label).Transformation()))
        : IDENTITY.slice();
      const world = this.experimentalPlacement ? experimentalWorld(parentWorld, local) : multiply(parentWorld, local);
      const path = parentPath ? `${parentPath}/${definitionName || "(unnamed)"}` : definitionName || "(unnamed)";
      const isAssembly = oc.XCAFDoc_ShapeTool.IsAssembly(definition) === true;
      const occurrenceId = `o${nextOccurrence++}`;
      const shape = oc.XCAFDoc_ShapeTool.GetShape(definition);
      const geometry = shape.IsNull() ? emptyGeometry() : this.measure(shape);
      const localBox = geometry.box;
      pending.push({
        path,
        parent: parentPath,
        occurrenceId,
        parentOccurrenceId,
        definitionName,
        occurrenceName,
        isAssembly,
        isOccurrence,
        local,
        world,
        color: this.colorOf(label, definition, isOccurrence),
        solids: geometry.solids,
        invalidSolids: geometry.invalidSolids,
        volumeMm3: geometry.volume,
        cylindricalFaces: geometry.cylinders,
        localBox,
        worldBox: localBox ? transformBox(localBox, world) : null,
        definition,
      });
      if (!isAssembly) return;
      const kids = new oc.NCollection_Sequence_TDF_Label();
      oc.XCAFDoc_ShapeTool.GetComponents(definition, kids, false);
      for (let index = 1; index <= kids.Length(); index += 1) visit(kids.Value(index), path, occurrenceId, world);
    };
    const roots = new oc.NCollection_Sequence_TDF_Label();
    shapes.GetFreeShapes(roots);
    for (let index = 1; index <= roots.Length(); index += 1) visit(roots.Value(index), null, null, this.experimentalPlacement ? experimentalIdentity() : IDENTITY.slice());
    const definitions: any[] = [];
    const nodes: XdeNode[] = pending.map((node) => {
      let definitionId = definitions.findIndex((known) => known.IsEqual(node.definition));
      if (definitionId < 0) {
        definitions.push(node.definition);
        definitionId = definitions.length - 1;
      }
      const { definition: _definition, ...plain } = node;
      return { ...plain, definitionId: definitionId + 1 };
    });
    const meshes: DefinitionMesh[] = [];
    const meshed = new Set<number>();
    for (let index = 0; index < pending.length; index += 1) {
      const node = nodes[index]!;
      if (node.isAssembly || meshed.has(node.definitionId)) continue;
      meshed.add(node.definitionId);
      meshes.push(this.tessellate(pending[index]!.definition, node.definitionId));
    }
    const parts = nodes.filter((node) => !node.isAssembly);
    const assemblies = nodes.filter((node) => node.isAssembly);
    return {
      report: {
        readStatus,
        transferred,
        fileUnits,
        nodes,
        leafVolumeMm3: parts.reduce((sum, node) => sum + node.volumeMm3, 0),
        partDefinitions: new Set(parts.map((node) => node.definitionId)).size,
        partOccurrences: parts.length,
        assemblyDefinitions: new Set(assemblies.map((node) => node.definitionId)).size,
        apis: [...this.used].sort(),
      },
      meshes,
    };
  }

  private fileUnits(reader: any): FileUnits {
    this.api("STEPCAFControl_Reader.ChangeReader");
    this.api("STEPControl_Reader.FileUnits");
    try {
      const oc = this.oc;
      const lengths = new oc.NCollection_Sequence_TCollection_AsciiString();
      const angles = new oc.NCollection_Sequence_TCollection_AsciiString();
      const solids = new oc.NCollection_Sequence_TCollection_AsciiString();
      reader.ChangeReader().FileUnits(lengths, angles, solids);
      const take = (seq: any) => {
        const values: string[] = [];
        for (let index = 1; index <= seq.Length(); index += 1) values.push(String(seq.Value(index).ToCString()));
        return values;
      };
      return { available: true, length: take(lengths), angle: take(angles), solidAngle: take(solids) };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private componentLabels(): { label: any; definitionName: string }[] {
    const oc = this.oc;
    const found: { label: any; definitionName: string }[] = [];
    const shapes = this.shapeTool();
    const walk = (label: any) => {
      let definition = label;
      if (oc.XCAFDoc_ShapeTool.IsReference(label)) {
        const slot = new oc.TDF_Label();
        oc.XCAFDoc_ShapeTool.GetReferredShape(label, slot);
        definition = slot;
        found.push({ label, definitionName: this.nameOf(definition) });
      }
      if (!oc.XCAFDoc_ShapeTool.IsAssembly(definition)) return;
      const kids = new oc.NCollection_Sequence_TDF_Label();
      oc.XCAFDoc_ShapeTool.GetComponents(definition, kids, false);
      for (let index = 1; index <= kids.Length(); index += 1) walk(kids.Value(index));
    };
    const roots = new oc.NCollection_Sequence_TDF_Label();
    shapes.GetFreeShapes(roots);
    for (let index = 1; index <= roots.Length(); index += 1) walk(roots.Value(index));
    return found;
  }

  private shapeTool() {
    this.api("TDocStd_Document.Main");
    return this.oc.XCAFDoc_DocumentTool.ShapeTool(this.doc.Main());
  }

  private nameOf(label: any): string {
    const found = label.FindAttribute(this.oc.TDataStd_Name.GetID());
    if (!found?.returnValue) return "";
    // The one-argument binding resolves to the AsciiString overload and rejects
    // an ExtendedString. The false flag is the UTF-8 conversion, proven on
    // 組立て, Кронштейн and Épaisseur — 30µm. A replacement character drops them.
    return new this.oc.TCollection_AsciiString(found.anAttribute.Get(), false).ToCString();
  }

  private colorOf(occurrence: any, definition: any, isOccurrence: boolean) {
    const instance = isOccurrence ? this.surf(occurrence) : null;
    const defined = this.surf(definition);
    const effective = instance ?? defined;
    const origin = instance ? "instance" : defined ? "definition" : "none";
    return { instance, definition: defined, effective, origin } as const;
  }

  private surf(label: any): LinearRgb | null {
    const color = new this.oc.Quantity_Color();
    const ok = this.oc.XCAFDoc_ColorTool.GetColor(label, this.oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf, color);
    if (!ok) return null;
    return { space: "linear-rgb", rgb: [color.Red(), color.Green(), color.Blue()] };
  }

  private matrixOf(trsf: any): number[] {
    const values: number[] = [];
    for (let row = 1; row <= 3; row += 1) {
      for (let column = 1; column <= 4; column += 1) values.push(clean(trsf.Value(row, column)));
    }
    return values;
  }

  private measure(shape: any) {
    const oc = this.oc;
    let solids = 0;
    let invalidSolids = 0;
    let volume = 0;
    const solidExp = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (solidExp.More()) {
      solids += 1;
      const solid = solidExp.Current();
      const analyzer = new oc.BRepCheck_Analyzer(solid, true, false, false);
      if (!analyzer.IsValid()) invalidSolids += 1;
      analyzer.delete?.();
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
      volume += props.Mass();
      props.delete?.();
      solidExp.Next();
    }
    solidExp.delete?.();
    let cylinders = 0;
    const faces = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    while (faces.More()) {
      const surface = oc.BRep_Tool.Surface(oc.TopoDS.Face(faces.Current()));
      if (surface.IsKind("Geom_CylindricalSurface")) cylinders += 1;
      faces.Next();
    }
    faces.delete?.();
    const box = new oc.Bnd_Box();
    oc.BRepBndLib.Add(shape, box, false);
    let bounds: number[] | null = null;
    if (!box.IsVoid()) {
      const min = box.CornerMin();
      const max = box.CornerMax();
      bounds = [min.X(), min.Y(), min.Z(), max.X(), max.Y(), max.Z()].map(clean);
    }
    return { solids, invalidSolids, volume, cylinders, box: bounds };
  }

  plantOwned(relative: string, bytes: Uint8Array) {
    if (!relative || relative.startsWith("/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("a planted file must stay inside this session directory");
    }
    this.ensureDir();
    const parts = relative.split("/");
    let dir = this.ownedDir;
    for (const part of parts.slice(0, -1)) {
      dir = `${dir}/${part}`;
      try {
        this.oc.FS.mkdir(dir);
      } catch {
        // The directory is already there.
      }
    }
    this.api("FS.writeFile");
    this.oc.FS.writeFile(`${this.ownedDir}/${relative}`, bytes);
  }

  /** Read `bytes` in a second document. The assembly already open stays open. */
  projectStep(bytes: Uint8Array): { scene: PortableScene | null; sceneError: string | null; sceneNotes: string[] } {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      return { scene: null, sceneError: "STEP projection received no bytes", sceneNotes: [] };
    }
    try {
      const projected = projectBytes(this.oc, bytes, (name) => this.ownPath(name));
      return { scene: projected.scene, sceneError: null, sceneNotes: projected.notes };
    } catch (error) {
      return { scene: null, sceneError: error instanceof Error ? error.message : String(error), sceneNotes: [] };
    } finally {
      this.removeTemporary();
    }
  }

  private ownPath(name: string): string {
    this.ensureDir();
    return `${this.ownedDir}/${name}`;
  }

  private ensureDir() {
    if (this.dirReady) return;
    this.api("FS.mkdir");
    this.oc.FS.mkdir(this.ownedDir);
    this.dirReady = true;
  }

  private ownedEntries(): string[] {
    if (!this.dirReady) return [];
    const nested = this.leftovers(this.ownedDir, "");
    return nested.length > 0 ? nested : [this.ownedDir];
  }

  private leftovers(dir: string, prefix: string): string[] {
    let names: string[] = [];
    try {
      this.api("FS.readdir");
      names = (this.oc.FS.readdir(dir) as string[]).filter((name) => name !== "." && name !== "..");
    } catch {
      return prefix ? [prefix] : [];
    }
    const out: string[] = [];
    for (const name of names) {
      const path = `${dir}/${name}`;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (this.isDirectory(path)) {
        const nested = this.leftovers(path, rel);
        out.push(...(nested.length > 0 ? nested : [`${rel}/`]));
      } else out.push(rel);
    }
    return out;
  }

  private isDirectory(path: string): boolean {
    try {
      this.oc.FS.readdir(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete this session directory, including nested leftovers.
   * A failed rmdir leaves dirReady set, so temporaryFiles() cannot come back empty.
   * Nothing outside ownedDir is unlinked.
   */
  private removeTemporary() {
    if (!this.dirReady) return;
    this.purge(this.ownedDir);
    try {
      this.api("FS.rmdir");
      this.oc.FS.rmdir(this.ownedDir);
      this.dirReady = false;
    } catch {
      this.dirReady = true;
    }
  }

  private purge(dir: string) {
    let names: string[] = [];
    try {
      names = (this.oc.FS.readdir(dir) as string[]).filter((name) => name !== "." && name !== "..");
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      if (this.isDirectory(path)) {
        this.purge(path);
        try {
          this.oc.FS.rmdir(path);
        } catch {
          // Still inside the owned directory.
        }
      } else {
        try {
          this.api("FS.unlink");
          this.oc.FS.unlink(path);
        } catch {
          // Still inside the owned directory.
        }
      }
    }
  }

  /**
   * Tessellate one definition in its own frame. The occurrence world matrix is
   * applied once by the viewer, not baked into these vertices.
   */
  private tessellate(definition: any, definitionId: number): DefinitionMesh {
    const oc = this.oc;
    this.api("BRepMesh_IncrementalMesh");
    this.api("BRep_Tool.Triangulation");
    this.api("Poly_Triangulation.Node");
    this.api("Poly_Triangulation.Triangle");
    const shape = oc.XCAFDoc_ShapeTool.GetShape(definition);
    const mesher = new oc.BRepMesh_IncrementalMesh(shape, 0.2, false, 0.35, false);
    try {
      mesher.Perform(new oc.Message_ProgressRange());
      const positions: number[] = [];
      const indices: number[] = [];
      const faces = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      try {
        while (faces.More()) {
          const face = oc.TopoDS.Face(faces.Current());
          const loc = new oc.TopLoc_Location();
          let triangulation: any = null;
          try {
            triangulation = oc.BRep_Tool.Triangulation(face, loc, 0);
          } catch {
            triangulation = null;
          }
          if (triangulation && triangulation.NbNodes?.() > 0 && triangulation.NbTriangles?.() > 0) {
            const xform = this.experimentalPlacement ? rawMatrix(loc.Transformation()) : this.matrixOf(loc.Transformation());
            const reversed = String(face.Orientation?.() ?? "").includes("REVERSED");
            const base = positions.length / 3;
            for (let index = 1; index <= triangulation.NbNodes(); index += 1) {
              const point = triangulation.Node(index);
              const placed = applyMatrix(xform, point.X(), point.Y(), point.Z());
              positions.push(placed[0], placed[1], placed[2]);
            }
            for (let index = 1; index <= triangulation.NbTriangles(); index += 1) {
              const triangle = triangulation.Triangle(index);
              const a = triangle.Value(1) - 1;
              let b = triangle.Value(2) - 1;
              let c = triangle.Value(3) - 1;
              if (reversed) {
                const swap = b;
                b = c;
                c = swap;
              }
              indices.push(base + a, base + b, base + c);
            }
          }
          faces.Next();
        }
      } finally {
        faces.delete?.();
      }
      if (indices.length === 0) throw new Error(`definition ${definitionId} produced no triangles`);
      const normalValues = vertexNormals(positions, indices);
      return {
        definitionId,
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normalValues),
        indices: Uint32Array.from(indices),
      };
    } finally {
      mesher.delete?.();
    }
  }

  private api(name: string) {
    this.used.add(name);
  }
}

function experimentalIdentity(): number[] {
  return fromRows([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]).flat();
}

function experimentalWorld(parent: number[] | null, local: number[]): number[] {
  const localRows = fromRows([local.slice(0, 4), local.slice(4, 8), local.slice(8, 12)]);
  if (!parent) return localRows.flat();
  return then(localRows, [parent.slice(0, 4), parent.slice(4, 8), parent.slice(8, 12)]).flat();
}

function rawMatrix(trsf: { Value: (row: number, column: number) => number }): number[] {
  const values: number[] = [];
  for (let row = 1; row <= 3; row += 1) {
    for (let column = 1; column <= 4; column += 1) values.push(trsf.Value(row, column));
  }
  return values;
}

type ExperimentalPlacement = {
  mode: string;
  occurrences: number;
  labelsWritten: number;
  rawBoundaryDifferences: number;
  rows: Array<{ index: number; parent: number; entry: string; kind: string; candidate: string[]; getLocation: string[]; shapeLocation: string[] }>;
  world: Array<{ index: number; parent: number; entry: string; world: string[]; boundary: string[]; raw: string[] }>;
};

function emptyGeometry() {
  return { solids: 0, invalidSolids: 0, volume: 0, cylinders: 0, box: null as number[] | null };
}

function clean(value: number): number {
  return Math.abs(value) < 1e-12 ? 0 : value;
}

function applyMatrix(matrix: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
    matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
    matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!,
  ];
}

function vertexNormals(positions: number[], indices: number[]): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    const abx = positions[b]! - positions[a]!;
    const aby = positions[b + 1]! - positions[a + 1]!;
    const abz = positions[b + 2]! - positions[a + 2]!;
    const acx = positions[c]! - positions[a]!;
    const acy = positions[c + 1]! - positions[a + 1]!;
    const acz = positions[c + 2]! - positions[a + 2]!;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (const offset of [a, b, c]) {
      normals[offset] = (normals[offset] ?? 0) + nx;
      normals[offset + 1] = (normals[offset + 1] ?? 0) + ny;
      normals[offset + 2] = (normals[offset + 2] ?? 0) + nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] ?? 0;
    const y = normals[index + 1] ?? 0;
    const z = normals[index + 2] ?? 0;
    const length = Math.hypot(x, y, z);
    if (length < 1e-12) {
      normals[index] = 0;
      normals[index + 1] = 0;
      normals[index + 2] = 1;
    } else {
      normals[index] = x / length;
      normals[index + 1] = y / length;
      normals[index + 2] = z / length;
    }
  }
  return normals;
}

function multiply(left: number[], right: number[]): number[] {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      out[row * 4 + column] =
        left[row * 4]! * right[column]! + left[row * 4 + 1]! * right[4 + column]! + left[row * 4 + 2]! * right[8 + column]!;
    }
    out[row * 4 + 3] =
      left[row * 4]! * right[3]! + left[row * 4 + 1]! * right[7]! + left[row * 4 + 2]! * right[11]! + left[row * 4 + 3]!;
  }
  return out.map(clean);
}

function transformBox(box: number[], matrix: number[]): number[] {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const x of [box[0]!, box[3]!]) {
    for (const y of [box[1]!, box[4]!]) {
      for (const z of [box[2]!, box[5]!]) {
        const point = [
          matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
          matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
          matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!,
        ];
        min = min.map((value, index) => Math.min(value, point[index]!));
        max = max.map((value, index) => Math.max(value, point[index]!));
      }
    }
  }
  return [...min, ...max].map(clean);
}
