import { readCadFile } from "./file-limits.ts";
import { download, safeName } from "@/lib/cad/stl.ts";
import { useCad, type DocumentGate, type ExchangeView } from "@/lib/cad/store";
import type { Inspect } from "./brep.ts";
import { OcctSession, StaleWorkerResult } from "./client.ts";
import { bytesEqual } from "./fcad.ts";
import { kernelCurves, type FcadDocument, type PartModel } from "./fcad-doc.ts";

type Mesh = { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
type Staged = { info: Inspect; solids?: Inspect[] } & Mesh & { step: Uint8Array };
type Exported = { info: Inspect; solids?: Inspect[]; step: Uint8Array };
type GateChoice = DocumentGate["actions"][number]["id"];

/**
 * One worker owns SQLite, CBOR and OCCT.
 *
 * A document revision is fixed only when kernel geometry and the bytes/model
 * the UI exports are the same snapshot. `commit-staged` swaps `current` but
 * keeps the previous shape until `ack-commit` or `rollback-commit`. A successful
 * commit stays done even if its reply is delivered after a newer intent: a
 * height edit of the still-open part adopts that snapshot, and a superseded
 * open rolls the kernel back instead of publishing. Epoch bumps when Open,
 * New or Close is requested, before any await and even if nothing is on screen,
 * so a late read cannot install over the newer intent.
 *
 * `release` deletes the worker solid immediately and is not undone by a late
 * reply. Close and an unsupported replacement therefore commit that loss:
 * if no newer revision was published, the old view is cleared instead of
 * staying on screen without a body. A close that has not sent `release` yet
 * leaves the previous snapshot intact when a newer intent wins.
 */
class ExchangeController {
  private epoch = 0;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private session: OcctSession | null = null;
  private original: Uint8Array | null = null;
  private working: Uint8Array | null = null;
  private view: ExchangeView | null = null;
  private model: PartModel | null = null;
  private needsRevive = false;
  /** Bumps only when the accepted snapshot changes, not on a mere intent. */
  private revision = 0;
  private gate: ((id: GateChoice) => void) | null = null;

  isDirty() {
    return Boolean(this.original && this.working && !bytesEqual(this.original, this.working));
  }

  openFcad(file: File) {
    const epoch = this.bump();
    return this.guard(async () => {
      const bytes = await readCadFile(file);
      if (!this.live(epoch)) return;
      const doc = await this.readDocument(bytes);
      if (!this.live(epoch)) return;
      if (!doc.ok) {
        useCad.getState().flash(doc.error);
        return;
      }
      await this.idle();
      if (!this.live(epoch)) return;
      if (!doc.editable) {
        await this.offerUnsupported(epoch, file.name, bytes, doc.reason);
        return;
      }
      if (!(await this.confirmReplace(epoch, "Opening another file will close it."))) return;
      if (!this.live(epoch)) return;
      await this.enqueue(() => this.installPart(epoch, file.name, bytes, doc.model));
    });
  }

  openStep(file: File) {
    const epoch = this.bump();
    return this.guard(async () => {
      const bytes = await readCadFile(file);
      if (!this.live(epoch)) return;
      await this.idle();
      if (!this.live(epoch)) return;
      if (!(await this.confirmReplace(epoch, "Importing STEP will close it."))) return;
      if (!this.live(epoch)) return;
      await this.enqueue(() => this.installStep(epoch, file.name, bytes));
    });
  }

  setHeight(source: string) {
    const revision = this.revision;
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (this.revision !== revision || !this.view || this.view.kind !== "fcad" || !this.view.editable || !this.working || !this.model) {
        throw new Error("height can be changed only on an open FCAD part");
      }
      if (source.trim() === this.model.distanceSource) return;
      const previous = this.working;
      const previousModel = this.model;
      const fileName = this.view.fileName;
      try {
        const next = await this.writeHeight(previous, source);
        if (this.revision !== revision) return;
        const doc = await this.readKept(next);
        if (this.revision !== revision) return;
        if (!doc.ok || !doc.editable) {
          const message = !doc.ok ? doc.error : doc.reason;
          useCad.getState().flash(message);
          throw new Error(message);
        }
        await this.revive();
        if (this.revision !== revision) return;
        const staged = await this.stageProfile(doc.model);
        if (!acceptable(staged.info)) throw new Error("the solid did not build");
        if (this.revision !== revision || this.epoch !== epoch) {
          await this.discard();
          return;
        }
        await this.invoke("commit-staged");
        if (this.revision !== revision) {
          await this.rollbackCommit();
          return;
        }
        this.working = next;
        this.model = doc.model;
        this.needsRevive = false;
        this.revision += 1;
        this.view = viewFromPart(fileName, doc.model, staged.info, null, this.isDirty(), doc.basis);
        this.publish(meshOf(staged), this.view.message);
        await this.ack();
      } catch (error) {
        await this.discard();
        await this.rollbackCommit();
        this.working = previous;
        this.model = previousModel;
        if (error instanceof StaleWorkerResult) return;
        useCad.getState().flash(textOf(error));
        throw error;
      }
    });
  }

  saveFcad() {
    return this.enqueue(async () => {
      try {
        if (!this.view) {
          useCad.getState().flash("Document closed: nothing to export.");
          return;
        }
        if (this.view.kind !== "fcad") {
          useCad.getState().flash("Saving imported STEP as .fcad is not supported yet.");
          return;
        }
        const bytes = this.view.editable ? this.working : this.original;
        if (!bytes) return;
        const name = this.view.fileName || "part.fcad";
        download(name, fileBytes(bytes), "application/octet-stream");
        if (!this.view.editable) useCad.getState().flash("Downloaded the original file unchanged.");
      } catch (error) {
        useCad.getState().flash(textOf(error));
      }
    });
  }

  saveStep() {
    return this.enqueue(async () => {
      try {
        if (!this.view) {
          useCad.getState().flash("Document closed: nothing to export.");
          return;
        }
        if (this.view.volume == null) {
          useCad.getState().flash("There is no OCCT body to export as STEP.");
          return;
        }
        await this.revive();
        if (!this.view || this.view.volume == null) return;
        if (this.needsRevive) {
          useCad.getState().flash("Could not restore the body for STEP.");
          return;
        }
        const exported = await this.occt().call<Exported>("export-step");
        const base = safeName(this.view.fileName.replace(/\.(fcad|step|stp)$/i, "")) || "part";
        download(`${base}.step`, fileBytes(exported.step), "model/step");
      } catch (error) {
        if (error instanceof StaleWorkerResult) return;
        useCad.getState().flash(textOf(error));
      }
    });
  }

  requestClose() {
    const epoch = this.bump();
    return this.guard(async () => {
      await this.idle();
      if (!this.live(epoch)) return;
      if (!this.view) return;
      if (!(await this.confirmReplace(epoch, "Closing the document will drop it from the screen."))) return;
      if (!this.live(epoch)) return;
      await this.finishClose(epoch);
    });
  }

  leaveForLegacy(action: () => void) {
    const epoch = this.bump();
    return this.guard(async () => {
      await this.idle();
      if (!this.live(epoch)) return;
      if (this.view) {
        if (!(await this.confirmReplace(epoch, "Switching will close it."))) return;
        if (!this.live(epoch)) return;
        await this.finishClose(epoch);
        if (!this.live(epoch)) return;
      }
      action();
    });
  }

  choose(id: GateChoice) {
    const settle = this.gate;
    this.gate = null;
    useCad.getState().setTransition(null);
    settle?.(id);
  }

  debugCrash() {
    return this.occt().call("debug-crash");
  }

  debugFailSql() {
    return this.occt().call("debug-fail-sql");
  }

  debugFailExtrude() {
    return this.occt().call("debug-fail-extrude");
  }

  debugFailImport() {
    return this.occt().call("debug-fail-import");
  }

  private async offerUnsupported(epoch: number, name: string, bytes: Uint8Array, reason: string) {
    if (this.view && this.isDirty()) {
      const choice = await this.ask({
        title: "File is not supported",
        body: `${reason} The unsaved part stays until you discard it.`,
        actions: [
          { id: "download-source", label: "Download Original File" },
          { id: "download", label: "Download Changes" },
          { id: "discard", label: "Discard" },
          { id: "cancel", label: "Cancel" },
        ],
      });
      if (!this.live(epoch) || choice === "cancel") return;
      if (choice === "download-source") {
        download(name, fileBytes(bytes), "application/octet-stream");
        useCad.getState().flash("Downloaded the original file unchanged.");
        return;
      }
      if (choice === "download") {
        await this.saveFcad();
        return;
      }
    }
    if (!this.live(epoch)) return;
    await this.enqueue(() => this.installUnsupported(epoch, name, bytes, reason));
  }

  private async confirmReplace(epoch: number, consequence: string) {
    if (!this.view || !this.isDirty()) return this.live(epoch);
    const choice = await this.ask({
      title: "Unsaved changes",
      body: `The open part height has changed. ${consequence}`,
      actions: [
        { id: "download", label: "Download Changes" },
        { id: "cancel", label: "Cancel" },
        { id: "discard", label: "Discard" },
      ],
    });
    if (!this.live(epoch) || choice === "cancel" || choice === "download-source") return false;
    if (choice === "download") await this.saveFcad();
    return this.live(epoch);
  }

  private ask(gate: DocumentGate) {
    if (this.gate) this.choose("cancel");
    return new Promise<GateChoice>((resolve) => {
      this.gate = resolve;
      useCad.getState().setTransition(gate);
    });
  }

  private async installPart(epoch: number, fileName: string, bytes: Uint8Array, model: PartModel) {
    if (!this.live(epoch)) return;
    await this.discard();
    const staged = await this.stageProfile(model);
    if (!acceptable(staged.info)) throw new Error("the solid did not build");
    if (!this.live(epoch)) {
      await this.discard();
      return;
    }
    if (!(await this.commitOwned(epoch))) return;
    this.original = bytes.slice();
    this.working = bytes.slice();
    this.model = model;
    this.needsRevive = false;
    this.revision += 1;
    this.view = viewFromPart(fileName, model, staged.info, null, false);
    this.publish(meshOf(staged), this.view.message);
    await this.ack();
  }

  private async installStep(epoch: number, fileName: string, bytes: Uint8Array) {
    const copy = bytes.slice();
    const staged = await this.occt().call<Staged>("import-step", { step: copy.buffer, stage: true }, [copy.buffer]);
    if (!acceptable(staged.info)) throw new Error("STEP does not contain a usable solid");
    if (!this.live(epoch)) {
      await this.discard();
      return;
    }
    if (!(await this.commitOwned(epoch))) return;
    this.original = bytes.slice();
    this.working = null;
    this.model = null;
    this.needsRevive = false;
    this.revision += 1;
    this.view = {
      kind: "step",
      fileName,
      editable: false,
      dirty: false,
      busy: this.pending > 0,
      refusal: "B-rep geometry only: the assembly tree, names, and colors are neither read nor written.",
      message: volumeMessage(staged.info),
      volume: staged.info.volume,
      bounds: staged.info.bounds,
      model: null,
    };
    this.publish(meshOf(staged), this.view.message);
    await this.ack();
  }

  private async installUnsupported(epoch: number, fileName: string, bytes: Uint8Array, reason: string) {
    if (!this.live(epoch)) return;
    const revision = this.revision;
    await this.occt().call("release").catch(() => undefined);
    if (this.revision !== revision) return;
    if (!this.live(epoch)) {
      this.resetQuiet();
      this.publish(null, "");
      return;
    }
    this.original = bytes.slice();
    this.working = bytes.slice();
    this.model = null;
    this.needsRevive = false;
    this.revision += 1;
    this.view = {
      kind: "fcad",
      fileName,
      editable: false,
      dirty: false,
      busy: this.pending > 0,
      refusal: reason,
      message: reason,
      volume: null,
      bounds: null,
      model: null,
    };
    this.publish(null, reason);
  }

  private finishClose(epoch: number) {
    return this.enqueue(async () => {
      if (!this.live(epoch)) return;
      const revision = this.revision;
      await this.occt().call("release").catch(() => undefined);
      if (this.revision !== revision) return;
      this.resetQuiet();
      this.publish(null, "");
    });
  }

  private async revive() {
    const died = !this.session || this.session.dead;
    if (!died && !this.needsRevive) return;
    if (!this.view) throw new Error("could not restore the body for export");
    if (this.view.kind === "fcad" && this.view.editable && this.model) {
      await this.restoreExtrude(this.model);
      return;
    }
    if (this.view.kind === "step" && this.original) {
      await this.restoreStep(this.original);
      return;
    }
    throw new Error("could not restore the body for export");
  }

  private async restoreExtrude(model: PartModel) {
    const revision = this.revision;
    const fileName = this.view?.fileName ?? "part.fcad";
    this.occt();
    const staged = await this.stageProfile(model);
    if (!acceptable(staged.info)) throw new Error("could not restore the body after the crash");
    if (this.revision !== revision) {
      await this.discard();
      return;
    }
    if (!(await this.commitOwned(this.epoch))) return;
    if (this.revision !== revision || !this.view || !this.model) {
      await this.rollbackCommit();
      return;
    }
    this.needsRevive = false;
    this.view = viewFromPart(fileName, this.model, staged.info, this.view.refusal, this.isDirty());
    this.publish(meshOf(staged), this.view.message);
    await this.ack();
  }

  private async restoreStep(bytes: Uint8Array) {
    const revision = this.revision;
    this.occt();
    const copy = bytes.slice();
    const staged = await this.occt().call<Staged>("import-step", { step: copy.buffer, stage: true }, [copy.buffer]);
    if (!acceptable(staged.info)) throw new Error("could not restore STEP");
    if (this.revision !== revision) {
      await this.discard();
      return;
    }
    if (!(await this.commitOwned(this.epoch))) return;
    if (this.revision !== revision || this.view?.kind !== "step") {
      await this.rollbackCommit();
      return;
    }
    this.needsRevive = false;
    this.view = {
      ...this.view,
      dirty: false,
      volume: staged.info.volume,
      bounds: staged.info.bounds,
      message: volumeMessage(staged.info),
    };
    this.publish(meshOf(staged), this.view.message);
    await this.ack();
  }

  private bump() {
    this.epoch += 1;
    if (this.session && !this.session.dead) this.session.generation = this.epoch;
    return this.epoch;
  }

  private live(epoch: number) {
    return epoch === this.epoch;
  }

  private resetQuiet() {
    this.original = null;
    this.working = null;
    this.model = null;
    this.view = null;
    this.needsRevive = false;
    this.revision += 1;
  }

  private guard<T>(job: () => Promise<T>) {
    this.enter();
    return job()
      .catch((error: unknown) => {
        if (error instanceof StaleWorkerResult) return undefined as T;
        useCad.getState().flash(textOf(error));
        return undefined as T;
      })
      .finally(() => this.leave());
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.enter();
    const run = this.tail.then(job);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => this.leave());
  }

  private enter() {
    this.pending += 1;
    this.publishBusy();
  }

  private leave() {
    this.pending = Math.max(0, this.pending - 1);
    this.publishBusy();
  }

  private publishBusy() {
    if (!this.view) return;
    const busy = this.pending > 0;
    const dirty = this.isDirty();
    if (this.view.busy === busy && this.view.dirty === dirty) return;
    this.view = { ...this.view, busy, dirty };
    useCad.getState().setExchange(this.view);
  }

  private publish(mesh: Mesh | null, status: string) {
    if (this.view) this.view = { ...this.view, busy: this.pending > 0, dirty: this.isDirty() };
    const state = useCad.getState();
    state.setOcct(mesh, status);
    state.setExchange(this.view);
    if (this.view) state.setTool("select");
    if (mesh) state.frame("all");
  }

  private occt() {
    const died = Boolean(this.session?.dead);
    if (!this.session || this.session.dead) {
      this.session = new OcctSession();
      const step = this.view?.kind === "step" && this.original;
      const part = this.view?.kind === "fcad" && this.view.editable && this.model;
      if (died && (step || part)) this.needsRevive = true;
    }
    this.session.generation = this.epoch;
    return this.session;
  }

  private readDocument(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return this.occt().call<FcadDocument>("read-fcad", { bytes: copy.buffer }, [copy.buffer]);
  }

  private readKept(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return this.invoke<FcadDocument>("read-fcad", { bytes: copy.buffer }, [copy.buffer]);
  }

  private async writeHeight(bytes: Uint8Array, source: string) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const saved = await this.invoke<{ bytes: Uint8Array }>("save-height", { bytes: copy.buffer, source }, [copy.buffer]);
    return saved.bytes;
  }

  private stageProfile(model: PartModel) {
    return this.invoke<Staged>("extrude-profile", {
      curves: kernelCurves(model.curves),
      height: model.distanceMm,
    });
  }

  /** A successful reply is returned even when a newer intent has moved the epoch. */
  private async invoke<T>(op: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []): Promise<T> {
    try {
      return await this.occt().call<T>(op, payload, transfer);
    } catch (error) {
      if (error instanceof StaleWorkerResult && error.committed) return error.result as T;
      throw error;
    }
  }

  private commit() {
    return this.occt().call("commit-staged");
  }

  /**
   * Commit for a document replacement. A late success is rolled back: the
   * newer intent owns the kernel, and this open must not publish.
   */
  private async commitOwned(epoch: number) {
    try {
      await this.commit();
    } catch (error) {
      if (error instanceof StaleWorkerResult && error.committed) {
        await this.rollbackCommit();
        return false;
      }
      await this.discard();
      throw error;
    }
    if (!this.live(epoch)) {
      await this.rollbackCommit();
      return false;
    }
    return true;
  }

  private ack() {
    return this.occt().call("ack-commit").catch(() => undefined);
  }

  private rollbackCommit() {
    return this.occt().call("rollback-commit").catch(() => undefined);
  }

  private idle() {
    return this.enqueue(async () => undefined);
  }

  private discard() {
    return this.occt()
      .call("discard-staged")
      .catch(() => undefined);
  }
}

function acceptable(info: Inspect) {
  return info.valid && info.solidValid && info.volume > 0 && info.solids >= 1;
}

function viewFromPart(fileName: string, model: PartModel, info: Inspect, refusal: string | null, dirty: boolean, basis?: string): ExchangeView {
  return {
    kind: "fcad",
    fileName,
    editable: true,
    dirty,
    busy: false,
    refusal,
    message: basis === "historical" ? `${volumeMessage(info)} · historical base 56b3c61, not the current native format` : basis === "current" ? `${volumeMessage(info)} · current native format` : volumeMessage(info),
    volume: info.volume,
    bounds: info.bounds,
    model: {
      planeName: model.planeName,
      sketchName: model.sketchName,
      curveCount: model.curves.length,
      extrudeName: model.extrudeName,
      distanceSource: model.distanceSource,
      distanceMm: model.distanceMm,
      bodyName: model.bodyName,
      area: model.area,
    },
  };
}

function volumeMessage(info: Inspect) {
  const box = info.bounds;
  return `OCCT ${trim(info.volume)} mm³ · ${trim(box.min[0])}…${trim(box.max[0])} × ${trim(box.min[1])}…${trim(box.max[1])} × ${trim(box.min[2])}…${trim(box.max[2])}`;
}

function trim(value: number) {
  return String(Math.round(value * 1000) / 1000);
}

function textOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileBytes(bytes: Uint8Array): BlobPart {
  return Uint8Array.from(bytes);
}

function meshOf(staged: Mesh): Mesh {
  return { positions: staged.positions, normals: staged.normals, indices: staged.indices };
}

const controller = new ExchangeController();

export function openExchangeFcad(file: File) {
  return controller.openFcad(file);
}

export function openExchangeStep(file: File) {
  return controller.openStep(file);
}

export function commitExchangeHeight(source: string) {
  return controller.setHeight(source);
}

export function downloadExchangeFcad() {
  return controller.saveFcad();
}

export function downloadExchangeStep() {
  return controller.saveStep();
}

export function closeExchange() {
  return controller.requestClose();
}

export function leaveExchangeForLegacy(action: () => void) {
  return controller.leaveForLegacy(action);
}

export function chooseDocumentGate(id: GateChoice) {
  controller.choose(id);
}

export function exchangeDirty() {
  return controller.isDirty();
}

export function debugCrashWorker() {
  return controller.debugCrash();
}

export function debugFailSql() {
  return controller.debugFailSql();
}

export function debugFailExtrude() {
  return controller.debugFailExtrude();
}

export function debugFailImport() {
  return controller.debugFailImport();
}
