//! A byte transport around the pinned document crate; no format rules live here.
use ferritecad_document::{Document, EditChange, ExpressionSlot, ObjectPayload};
use ferritecad_types::{CadError, ContentHash, ObjectId, Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

const MAX_INPUT: usize = 32 * 1024 * 1024;
static SEQUENCE: AtomicU32 = AtomicU32::new(0);

// Each Worker owns its MEMFS. Host invocations use separate process directories.
struct Input(PathBuf);
impl Input {
    fn new(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_INPUT {
            return Err(CadError::input("probe input exceeds 32 MiB"));
        }
        let directory = std::env::temp_dir().join(format!(
            "ferrite-document-probe-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory)?;
        let input = Self(directory);
        std::fs::write(input.path(), bytes)?;
        Ok(input)
    }
    fn path(&self) -> PathBuf {
        self.0.join("input.fcad")
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn payload(value: &ObjectPayload) -> Result<Value> {
    let result = match value {
        ObjectPayload::Parameter(v) => serde_json::to_value(v),
        ObjectPayload::DatumPlane(v) => serde_json::to_value(v),
        ObjectPayload::Sketch(v) => serde_json::to_value(v),
        ObjectPayload::Body(v) => serde_json::to_value(v),
        ObjectPayload::Extrude(v) => serde_json::to_value(v),
        ObjectPayload::Revolve(v) => serde_json::to_value(v),
        ObjectPayload::Fillet(v) => serde_json::to_value(v),
        ObjectPayload::Chamfer(v) => serde_json::to_value(v),
        ObjectPayload::KeepSolids(v) => serde_json::to_value(v),
        ObjectPayload::ImportedStep(v) => serde_json::to_value(v),
        _ => {
            return Err(CadError::unsupported(
                "probe JSON adapter needs the new payload variant",
            ));
        }
    };
    result.map_err(|e| CadError::input_because("serializing native payload as JSON", e))
}

fn inspect(path: &Path) -> Result<Value> {
    let document = Document::open_read_only(path)?;
    let validation = document.validate()?;
    let objects = document.objects()?.into_iter().map(|object| {
        let encoded = object.payload.to_storage_bytes()?;
        Ok(json!({"id": object.id, "parent": object.parent, "kind": object.payload.type_name(),
            "name": object.name, "ordinal": object.ordinal.to_string(), "payload": payload(&object.payload)?,
            "payload_hash": object.payload_hash.to_string(),
            "reencoded_hash": ContentHash::of_bytes(&encoded).to_string(), "reencoded_bytes": encoded}))
    }).collect::<Result<Vec<Value>>>()?;
    let dependencies: Vec<Value> = document
        .dependencies()?
        .iter()
        .map(|d| {
            json!({
                "dependent": d.dependent, "dependency": d.dependency, "role": d.role.as_str()
            })
        })
        .collect();
    let slots: Vec<Value> = document
        .expression_slots()?
        .iter()
        .map(|s| {
            json!({
                "object": s.object, "name": s.name, "slot": s.slot, "expression": s.expression,
                "dimension": s.dimension, "refusal": s.refusal
            })
        })
        .collect();
    let diagnostics: Vec<Value> = validation.diagnostics.iter().map(|d| json!({
        "severity": d.severity.as_str(), "code": d.code, "message": d.message, "object": d.object
    })).collect();
    let result = json!({"ok": true, "document_id": document.meta().document_id,
        "objects": objects, "dependencies": dependencies, "expression_slots": slots,
        "content_version": document.content_version()?.to_string(),
        "model_version": document.model_version()?.to_string(),
        "validation": {"ok": validation.is_ok(), "diagnostics": diagnostics}});
    document.close()?;
    Ok(result)
}

fn response(result: Result<(Value, Option<Vec<u8>>)>) -> (Value, Option<Vec<u8>>) {
    match result {
        Ok(result) => result,
        Err(error) => (
            json!({"ok": false, "kind": error.kind().as_str(), "message": error.to_string()}),
            None,
        ),
    }
}

pub fn open(bytes: &[u8]) -> (Value, Option<Vec<u8>>) {
    response((|| {
        let input = Input::new(bytes)?;
        Ok((inspect(&input.path())?, None))
    })())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetExpression {
    object: ObjectId,
    slot: ExpressionSlot,
    value_mm: f64,
}

pub fn set_expression(bytes: &[u8], request: &[u8]) -> (Value, Option<Vec<u8>>) {
    response((|| {
        let request: SetExpression = serde_json::from_slice(request)
            .map_err(|e| CadError::input_because("invalid probe set_expression request", e))?;
        let change = EditChange::constant(request.object, request.slot, request.value_mm)?;
        let input = Input::new(bytes)?;
        let mut document = Document::open(input.path())?;
        document.write_changes(&[change])?;
        document.close()?;
        Ok((inspect(&input.path())?, Some(std::fs::read(input.path())?)))
    })())
}
