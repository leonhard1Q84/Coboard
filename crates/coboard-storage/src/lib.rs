//! Single-writer package storage. SQLite commit is the publication point.
mod assets;
mod crdt;
mod error;
pub use assets::{AssetStore, MAX_ASSET_BYTES};
pub use error::{Result, StorageError};

use assets::{check_path, sync_dir};
use coboard_domain::{Document, EditRequest, Editor, valid_id};
use fs2::FileExt;
use loro::LoroDoc;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub const FORMAT_VERSION: u32 = 1;
pub const MAX_DOCUMENT_BYTES: u64 = 64 * 1024 * 1024;
pub const SNAPSHOT_INTERVAL: u64 = 128;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    format_version: u32,
    document_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommitReceipt {
    pub revision: u64,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryReport {
    pub snapshot_revision: u64,
    pub replayed_updates: u64,
    pub elapsed_ms: f64,
    pub missing_assets: Vec<String>,
}

pub struct Package {
    root: PathBuf,
    connection: Connection,
    _lock: File,
    assets: AssetStore,
    editor: Editor,
    loro: LoroDoc,
    recovery: RecoveryReport,
}

fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
fn revision(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let n: i64 = row.get(index)?;
    u64::try_from(n).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, n))
}
fn verify(bytes: &[u8], expected: &str, label: &str) -> Result<()> {
    if hash(bytes) != expected {
        return Err(StorageError::Corrupt(format!("{label} checksum mismatch")));
    }
    Ok(())
}

fn validate_package_path(path: &Path) -> Result<()> {
    if path.extension().and_then(|s| s.to_str()) != Some("coboard") {
        return Err(StorageError::UnsafePath);
    }
    check_path(path)?;
    Ok(())
}

fn lock(root: &Path) -> Result<File> {
    let path = root.join(".writer.lock");
    check_path(&path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    file.try_lock_exclusive().map_err(|e| {
        if e.kind() == std::io::ErrorKind::WouldBlock {
            StorageError::Locked
        } else {
            e.into()
        }
    })?;
    Ok(file)
}

fn database_paths(root: &Path) -> Result<()> {
    for name in [
        "document.db",
        "document.db-wal",
        "document.db-shm",
        "manifest.json",
        "assets",
    ] {
        check_path(&root.join(name))?;
    }
    Ok(())
}

fn configure(connection: &Connection) -> Result<()> {
    connection.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        MAX_DOCUMENT_BYTES as i32,
    )?;
    connection.busy_timeout(Duration::from_millis(250))?;
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA wal_autocheckpoint=1000;")?;
    let mode: String = connection.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
    if mode != "wal" {
        return Err(StorageError::Corrupt(
            "WAL mode unavailable on this filesystem".into(),
        ));
    }
    #[cfg(target_os = "macos")]
    connection.execute_batch("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;")?;
    Ok(())
}

fn write_snapshot(
    transaction: &rusqlite::Transaction<'_>,
    doc: &Document,
    loro: &LoroDoc,
) -> Result<()> {
    let ast = serde_json::to_vec(doc)?;
    if ast.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let snapshot = crdt::export_snapshot(loro)?;
    if snapshot.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let compressed = zstd::stream::encode_all(ast.as_slice(), 3)?;
    transaction.execute(
        "INSERT OR REPLACE INTO snapshots VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            doc.revision as i64,
            compressed,
            hash(&ast),
            snapshot,
            hash(&snapshot)
        ],
    )?;
    Ok(())
}

impl Package {
    /// The final manifest is the package-creation commit marker. An interrupted
    /// creation without that marker is never silently opened or overwritten.
    pub fn create(path: impl AsRef<Path>, title: &str) -> Result<Self> {
        let path = path.as_ref();
        validate_package_path(path)?;
        let document = Document::new(uuid::Uuid::new_v4().to_string(), title)?;
        fs::create_dir(path)?;
        let root = path.canonicalize()?;
        let file_lock = lock(&root)?;
        fs::create_dir(root.join("assets"))?;
        let assets = AssetStore::new(root.join("assets"))?;
        let mut connection = Connection::open(root.join("document.db"))?;
        configure(&connection)?;
        let loro = LoroDoc::new();
        crdt::write_document(&loro, None, &document)?;
        let tx = connection.transaction()?;
        tx.execute_batch(include_str!("schema.sql"))?;
        tx.execute(
            "INSERT INTO document_head VALUES (1, 0, ?1)",
            [hash(&serde_json::to_vec(&document)?)],
        )?;
        write_snapshot(&tx, &document, &loro)?;
        tx.commit()?;
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let manifest = Manifest {
            format: "coboard".into(),
            format_version: FORMAT_VERSION,
            document_id: document.id.clone(),
        };
        let mut temp = tempfile::Builder::new()
            .prefix(".manifest-")
            .tempfile_in(&root)?;
        temp.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(root.join("manifest.json"))
            .map_err(|e| e.error)?;
        sync_dir(&root)?;
        if let Some(parent) = root.parent() {
            sync_dir(parent)?;
        }
        Ok(Self {
            root,
            connection,
            _lock: file_lock,
            assets,
            editor: Editor::new(document)?,
            loro,
            recovery: RecoveryReport {
                snapshot_revision: 0,
                replayed_updates: 0,
                elapsed_ms: 0.0,
                missing_assets: vec![],
            },
        })
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let start = Instant::now();
        let path = path.as_ref();
        validate_package_path(path)?;
        let root = path.canonicalize()?;
        database_paths(&root)?;
        let manifest_file = File::open(root.join("manifest.json"))?;
        if manifest_file.metadata()?.len() > 65536 {
            return Err(StorageError::TooLarge);
        }
        let value: serde_json::Value = serde_json::from_reader(manifest_file)?;
        let version = value["format_version"]
            .as_u64()
            .ok_or_else(|| StorageError::Corrupt("manifest version missing".into()))?;
        if version != FORMAT_VERSION as u64 {
            return Err(StorageError::UnsupportedVersion(
                version.min(u32::MAX as u64) as u32,
            ));
        }
        let manifest: Manifest = serde_json::from_value(value)?;
        if manifest.format != "coboard" {
            return Err(StorageError::Corrupt("wrong package format".into()));
        }
        if fs::metadata(root.join("document.db"))?
            .permissions()
            .readonly()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "document database is read-only",
            )
            .into());
        }
        let file_lock = lock(&root)?;
        let mut connection = Connection::open_with_flags(
            root.join("document.db"),
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.set_limit(
            rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
            MAX_DOCUMENT_BYTES as i32,
        )?;
        let db_version: u32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if db_version != FORMAT_VERSION {
            return Err(StorageError::UnsupportedVersion(db_version));
        }
        let check: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Err(StorageError::Corrupt(
                "SQLite integrity check failed".into(),
            ));
        }
        let (doc, loro, snapshot_revision, replayed_updates) = recover(&connection)?;
        if doc.id != manifest.document_id {
            return Err(StorageError::Corrupt(
                "manifest/document identity mismatch".into(),
            ));
        }
        let assets = AssetStore::new(root.join("assets"))?;
        let missing_assets = doc
            .asset_hashes()
            .into_iter()
            .filter(|hash| assets.open_verified(hash).is_err())
            .map(String::from)
            .collect();
        // Do not configure a database for writing until its format and content passed validation.
        configure(&connection)?;
        // Recovering does not prune historical operations or assets. Undo is session-local.
        let editor = Editor::new(doc)?;
        // Check that an interrupted SQL transaction cannot leave a reserved writer.
        connection.transaction()?.rollback()?;
        Ok(Self {
            root,
            connection,
            _lock: file_lock,
            assets,
            editor,
            loro,
            recovery: RecoveryReport {
                snapshot_revision,
                replayed_updates,
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                missing_assets,
            },
        })
    }

    pub fn document(&self) -> &Document {
        self.editor.document()
    }
    pub fn assets(&self) -> &AssetStore {
        &self.assets
    }
    pub fn path(&self) -> &Path {
        &self.root
    }
    pub fn recovery(&self) -> &RecoveryReport {
        &self.recovery
    }
    pub fn can_undo(&self) -> bool {
        self.editor.can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.editor.can_redo()
    }

    /// Idempotence precedes the version check, so a lost reply can safely retry
    /// the exact request even after later edits. A reused ID with new content fails.
    pub fn commit(&mut self, request: &EditRequest) -> Result<CommitReceipt> {
        if !valid_id(&request.request_id) {
            return Err(coboard_domain::DomainError::Invalid("invalid request id".into()).into());
        }
        let request_bytes = serde_json::to_vec(request)?;
        if request_bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(StorageError::TooLarge);
        }
        let request_hash = hash(&request_bytes);
        let previous: Option<(u64, String)> = self
            .connection
            .query_row(
                "SELECT revision, request_hash FROM oplog WHERE request_id=?1",
                [&request.request_id],
                |r| Ok((revision(r, 0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((revision, digest)) = previous {
            if digest != request_hash {
                return Err(StorageError::RequestConflict);
            }
            // Reconcile an uncertain COMMIT reply before acknowledging its retry.
            if self.document().revision < revision {
                let (doc, loro, _, _) = recover(&self.connection)?;
                self.editor = Editor::new(doc)?;
                self.loro = loro;
            }
            return Ok(CommitReceipt {
                revision,
                duplicate: true,
            });
        }
        let mut next_editor = self.editor.clone();
        next_editor.apply(&request.action, request.expected_revision)?;
        let next = next_editor.document();
        let ast = serde_json::to_vec(next)?;
        if ast.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(StorageError::TooLarge);
        }
        // Verify all references before publishing the database transaction.
        for hash in next.asset_hashes() {
            self.assets.open_verified(hash)?;
        }
        // Loro's transactions cannot roll back. Isolate tentative changes in a
        // fork; preserve the local peer ID because the old branch is never edited.
        let next_loro = self.loro.fork();
        next_loro
            .set_peer_id(self.loro.peer_id())
            .map_err(|e| StorageError::Crdt(e.to_string()))?;
        let from = self.loro.oplog_vv();
        crdt::write_document(&next_loro, Some(self.document()), next)?;
        let update = next_loro
            .export(loro::ExportMode::updates(&from))
            .map_err(|e| StorageError::Crdt(e.to_string()))?;
        if update.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(StorageError::TooLarge);
        }
        let before = self.editor.document();
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let durable_revision: u64 = tx.query_row(
            "SELECT revision FROM document_head WHERE singleton=1",
            [],
            |r| revision(r, 0),
        )?;
        if durable_revision != before.revision {
            return Err(coboard_domain::DomainError::Conflict {
                expected: before.revision,
                actual: durable_revision,
            }
            .into());
        }
        tx.execute(
            "INSERT INTO oplog VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                next.revision as i64,
                request.request_id,
                request_hash,
                update,
                hash(&update),
                hash(&ast)
            ],
        )?;
        tx.execute(
            "UPDATE document_head SET revision=?1, state_hash=?2 WHERE singleton=1",
            params![next.revision as i64, hash(&ast)],
        )?;
        for id in before
            .nodes
            .keys()
            .filter(|id| !next.nodes.contains_key(*id))
        {
            tx.execute("DELETE FROM fts_index WHERE node_id=?1", [id])?;
        }
        for (id, node) in &next.nodes {
            if before.nodes.get(id) != Some(node) {
                tx.execute("DELETE FROM fts_index WHERE node_id=?1", [id])?;
                tx.execute(
                    "INSERT INTO fts_index(node_id, content) VALUES (?1, ?2)",
                    params![id, node.search_text()],
                )?;
            }
        }
        if next.revision.is_multiple_of(SNAPSHOT_INTERVAL) {
            write_snapshot(&tx, next, &next_loro)?;
        }
        tx.commit()?;
        // In-memory document/history become visible only after durable SQL commit.
        let revision = next.revision;
        self.editor = next_editor;
        self.loro = next_loro;
        Ok(CommitReceipt {
            revision,
            duplicate: false,
        })
    }

    pub fn checkpoint(&mut self) -> Result<()> {
        let tx = self.connection.transaction()?;
        write_snapshot(&tx, self.editor.document(), &self.loro)?;
        tx.commit()?;
        Ok(())
    }

    pub fn search(&self, query: &str) -> Result<Vec<String>> {
        if query.len() > 1024 {
            return Err(StorageError::TooLarge);
        }
        let mut stmt = self
            .connection
            .prepare("SELECT node_id FROM fts_index WHERE fts_index MATCH ?1 LIMIT 100")?;
        Ok(stmt
            .query_map([query], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?)
    }
}

fn recover(connection: &Connection) -> Result<(Document, LoroDoc, u64, u64)> {
    let (snapshot_rev, compressed, ast_hash, snapshot, loro_hash): (u64, Vec<u8>, String, Vec<u8>, String) = connection.query_row("SELECT revision, ast_zstd, ast_hash, loro_snapshot, loro_hash FROM snapshots ORDER BY revision DESC LIMIT 1", [], |r| Ok((revision(r, 0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?;
    if compressed.len() as u64 > MAX_DOCUMENT_BYTES || snapshot.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(StorageError::TooLarge);
    }
    let mut ast = Vec::new();
    zstd::stream::read::Decoder::new(compressed.as_slice())?
        .take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut ast)?;
    if ast.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(StorageError::TooLarge);
    }
    verify(&ast, &ast_hash, "AST snapshot")?;
    verify(&snapshot, &loro_hash, "CRDT snapshot")?;
    let doc: Document = serde_json::from_slice(&ast)?;
    doc.validate()?;
    if doc.revision != snapshot_rev {
        return Err(StorageError::Corrupt("snapshot revision mismatch".into()));
    }
    let loro = LoroDoc::new();
    crdt::import(&loro, &snapshot)?;
    if crdt::read_document(&loro)? != doc {
        return Err(StorageError::Corrupt(
            "AST and CRDT snapshots differ".into(),
        ));
    }
    let mut stmt = connection.prepare("SELECT revision, update_bytes, update_hash, state_hash FROM oplog WHERE revision > ?1 ORDER BY revision")?;
    let rows = stmt.query_map([snapshot_rev as i64], |r| {
        Ok((
            revision(r, 0)?,
            r.get::<_, Vec<u8>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })?;
    let mut expected = snapshot_rev;
    let mut final_hash = ast_hash;
    for row in rows {
        let (rev, bytes, update_hash, state_hash) = row?;
        if rev != expected + 1 {
            return Err(StorageError::Corrupt("operation log revision gap".into()));
        }
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(StorageError::TooLarge);
        }
        verify(&bytes, &update_hash, "operation log")?;
        crdt::import(&loro, &bytes)?;
        expected = rev;
        final_hash = state_hash;
    }
    // A separate committed head catches removal of the final oplog rows too.
    let head: (u64, String) = connection.query_row(
        "SELECT revision, state_hash FROM document_head WHERE singleton=1",
        [],
        |r| Ok((revision(r, 0)?, r.get(1)?)),
    )?;
    if head != (expected, final_hash.clone()) {
        return Err(StorageError::Corrupt(
            "operation log does not match committed head".into(),
        ));
    }
    let restored = crdt::read_document(&loro)?;
    if restored.revision != expected {
        return Err(StorageError::Corrupt("recovered revision mismatch".into()));
    }
    verify(
        &serde_json::to_vec(&restored)?,
        &final_hash,
        "recovered state",
    )?;
    Ok((restored, loro, snapshot_rev, expected - snapshot_rev))
}

#[cfg(test)]
mod tests;
