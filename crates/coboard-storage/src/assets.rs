use crate::{Result, StorageError};
use coboard_domain::valid_asset;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;

/// Reject symlinks at managed boundaries. The package must not be mutated by an
/// adversarial process concurrently; macOS file coordination is a later adapter.
pub(crate) fn check_path(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(StorageError::UnsafePath),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn sync_dir(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct AssetStore {
    root: PathBuf,
}

impl AssetStore {
    pub(crate) fn new(root: PathBuf) -> Result<Self> {
        check_path(&root)?;
        if !root.is_dir() {
            return Err(StorageError::Corrupt("assets directory missing".into()));
        }
        Ok(Self { root })
    }

    fn path(&self, hash: &str) -> Result<PathBuf> {
        if !valid_asset(hash) {
            return Err(StorageError::UnsafePath);
        }
        check_path(&self.root)?;
        let shard = self.root.join(&hash[..2]);
        check_path(&shard)?;
        let path = shard.join(hash);
        check_path(&path)?;
        Ok(path)
    }

    /// Resource bytes are durable before any database commit can reference them.
    /// An interruption leaves at worst an unreferenced blob or .tmp staging file.
    /// Neither is automatically collected until history-aware GC is implemented.
    pub fn put(&self, bytes: &[u8]) -> Result<String> {
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(StorageError::TooLarge);
        }
        let hash = blake3::hash(bytes).to_hex().to_string();
        let path = self.path(&hash)?;
        if path.exists() {
            self.open_verified(&hash)?;
            return Ok(hash);
        }
        let parent = path.parent().ok_or(StorageError::UnsafePath)?;
        match fs::create_dir(parent) {
            Ok(()) => sync_dir(&self.root)?,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                check_path(parent)?;
            }
            Err(e) => return Err(e.into()),
        }
        let mut temp = tempfile::Builder::new()
            .prefix(".asset-")
            .suffix(".tmp")
            .tempfile_in(parent)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.as_file_mut().seek(SeekFrom::Start(0))?;
        let mut hasher = blake3::Hasher::new();
        hasher.update_reader(temp.as_file_mut())?;
        if hasher.finalize().to_hex().as_str() != hash {
            return Err(StorageError::Corrupt(
                "asset staging checksum mismatch".into(),
            ));
        }
        match temp.persist_noclobber(&path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.open_verified(&hash)?;
            }
            Err(e) => return Err(e.error.into()),
        }
        sync_dir(parent)?;
        Ok(hash)
    }

    /// Verify using the same file handle subsequently streamed by the gateway.
    pub fn open_verified(&self, hash: &str) -> Result<File> {
        let path = self.path(hash)?;
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(StorageError::MissingAsset(hash.into()));
            }
            Err(e) => return Err(e.into()),
        };
        let meta = file.metadata()?;
        if !meta.is_file() || meta.len() > MAX_ASSET_BYTES {
            return Err(StorageError::TooLarge);
        }
        let mut hasher = blake3::Hasher::new();
        hasher.update_reader((&mut file).take(MAX_ASSET_BYTES + 1))?;
        if hasher.finalize().to_hex().as_str() != hash {
            return Err(StorageError::MissingAsset(hash.into()));
        }
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }
    pub fn read(&self, hash: &str) -> Result<Vec<u8>> {
        let mut file = self.open_verified(hash)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }
}
