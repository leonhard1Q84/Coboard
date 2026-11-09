use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error(transparent)]
    Domain(#[from] coboard_domain::DomainError),
    #[error("filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("database operation failed: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("invalid JSON data: {0}")]
    Json(#[from] serde_json::Error),
    #[error("document is already open for writing")]
    Locked,
    #[error("unsupported package or database version: {0}")]
    UnsupportedVersion(u32),
    #[error("document integrity check failed: {0}")]
    Corrupt(String),
    #[error("unsafe package path")]
    UnsafePath,
    #[error("asset not found or corrupt: {0}")]
    MissingAsset(String),
    #[error("input exceeds size budget")]
    TooLarge,
    #[error("request id reused with different content")]
    RequestConflict,
    #[error("CRDT operation failed: {0}")]
    Crdt(String),
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Domain(coboard_domain::DomainError::Conflict { .. }) => "revision_conflict",
            Self::Domain(_) => "invalid_edit",
            Self::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "permission_denied",
            Self::Io(e) if e.raw_os_error() == Some(28) => "disk_full",
            Self::Io(_) => "io_failed",
            Self::Sql(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::DiskFull =>
            {
                "disk_full"
            }
            Self::Sql(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ReadOnly =>
            {
                "permission_denied"
            }
            Self::Sql(_) => "database_failed",
            Self::Json(_) | Self::Corrupt(_) | Self::Crdt(_) => "document_corrupt",
            Self::Locked => "document_locked",
            Self::UnsupportedVersion(_) => "unsupported_version",
            Self::UnsafePath => "unsafe_path",
            Self::MissingAsset(_) => "missing_asset",
            Self::TooLarge => "input_too_large",
            Self::RequestConflict => "request_conflict",
        }
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;
