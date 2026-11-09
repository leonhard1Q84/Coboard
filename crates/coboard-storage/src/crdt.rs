use crate::{Result, StorageError};
use coboard_domain::Document;
use loro::{LoroDoc, ToJson};

fn crdt_error(e: impl std::fmt::Display) -> StorageError {
    StorageError::Crdt(e.to_string())
}

pub(crate) fn write_document(
    loro: &LoroDoc,
    before: Option<&Document>,
    next: &Document,
) -> Result<()> {
    let meta = loro.get_map("meta");
    meta.insert("id", next.id.as_str()).map_err(crdt_error)?;
    meta.insert("title", next.title.as_str())
        .map_err(crdt_error)?;
    meta.insert("schema_version", next.schema_version.to_string())
        .map_err(crdt_error)?;
    meta.insert("revision", next.revision.to_string())
        .map_err(crdt_error)?;
    let nodes = loro.get_map("nodes");
    if let Some(before) = before {
        for id in before
            .nodes
            .keys()
            .filter(|id| !next.nodes.contains_key(*id))
        {
            nodes.delete(id).map_err(crdt_error)?;
        }
    }
    for (id, node) in &next.nodes {
        if before.and_then(|d| d.nodes.get(id)) != Some(node) {
            nodes
                .insert(id, serde_json::to_string(node)?)
                .map_err(crdt_error)?;
        }
    }
    loro.commit();
    Ok(())
}

pub(crate) fn read_document(loro: &LoroDoc) -> Result<Document> {
    let value = loro.get_deep_value().to_json_value();
    let meta = &value["meta"];
    let string = |key: &str| -> Result<String> {
        meta[key]
            .as_str()
            .map(String::from)
            .ok_or_else(|| StorageError::Corrupt(format!("missing CRDT {key}")))
    };
    let mut doc = Document::new(string("id")?, string("title")?)?;
    doc.schema_version = string("schema_version")?
        .parse()
        .map_err(|_| StorageError::Corrupt("invalid CRDT schema".into()))?;
    doc.revision = string("revision")?
        .parse()
        .map_err(|_| StorageError::Corrupt("invalid CRDT revision".into()))?;
    if let Some(nodes) = value["nodes"].as_object() {
        for (id, node) in nodes {
            let json = node
                .as_str()
                .ok_or_else(|| StorageError::Corrupt("invalid CRDT node".into()))?;
            doc.nodes.insert(id.clone(), serde_json::from_str(json)?);
        }
    } else if !value["nodes"].is_null() {
        return Err(StorageError::Corrupt("invalid CRDT nodes map".into()));
    }
    doc.validate()?;
    Ok(doc)
}

pub(crate) fn export_snapshot(loro: &LoroDoc) -> Result<Vec<u8>> {
    loro.export(loro::ExportMode::Snapshot).map_err(crdt_error)
}
pub(crate) fn import(loro: &LoroDoc, bytes: &[u8]) -> Result<()> {
    let status = loro.import(bytes).map_err(crdt_error)?;
    if status.pending.is_some() {
        return Err(StorageError::Corrupt(
            "CRDT update has missing dependencies".into(),
        ));
    }
    Ok(())
}
