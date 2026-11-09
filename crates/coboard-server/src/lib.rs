//! Loopback-only resource gateway. Document editing remains in the application
//! session, not in unauthenticated HTTP endpoints. LAN sync belongs to M4.
use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use coboard_storage::AssetStore;
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{Semaphore, oneshot},
    task::JoinHandle,
};
use tower_http::cors::CorsLayer;

#[derive(Clone)]
struct GatewayState {
    assets: AssetStore,
    authorization: String,
    limit: Arc<Semaphore>,
}

pub fn router(assets: AssetStore, token: &str) -> Router {
    let origins = [
        "tauri://localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
    ]
    .into_iter()
    .filter_map(|v| v.parse().ok())
    .collect::<Vec<_>>();
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/assets/{hash}", get(asset))
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET])
                .allow_headers([header::AUTHORIZATION, header::RANGE])
                .expose_headers([header::CONTENT_RANGE, header::ACCEPT_RANGES]),
        )
        .with_state(GatewayState {
            assets,
            authorization: format!("Bearer {token}"),
            limit: Arc::new(Semaphore::new(4)),
        })
}

/// A single, bounded byte range. Multi-range requests deliberately return 416.
fn range(header: Option<&str>, len: u64) -> Result<(u64, u64, bool), ()> {
    let Some(value) = header else {
        return Ok((0, len, false));
    };
    if len == 0 {
        return Err(());
    }
    let spec = value.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = spec.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let count = suffix.min(len);
        return Ok((len - count, count, true));
    }
    let start: u64 = start.parse().map_err(|_| ())?;
    let end: u64 = if end.is_empty() {
        len - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if start >= len || end < start {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}

async fn asset(
    State(state): State<GatewayState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Response {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some(state.authorization.as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(permit) = state.limit.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let assets = state.assets.clone();
    let (file, permit) = match tokio::task::spawn_blocking(move || {
        assets.open_verified(&hash).map(|file| (file, permit))
    })
    .await
    {
        Ok(Ok(value)) => value,
        Ok(Err(_)) => return StatusCode::NOT_FOUND.into_response(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let range_header = match headers.get(header::RANGE).map(|h| h.to_str()).transpose() {
        Ok(h) => h,
        Err(_) => return StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
    };
    let (start, count, partial) = match range(range_header, len) {
        Ok(r) => r,
        Err(()) => {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{len}"))],
            )
                .into_response();
        }
    };
    let mut file = tokio::fs::File::from_std(file);
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let stream = tokio_util::io::ReaderStream::new(file.take(count));
    // Keep the concurrency permit until EOF or client disconnect, not just until
    // verification finishes. A slow client cannot create unbounded open files.
    let stream =
        futures_util::stream::unfold((stream, permit), |(mut stream, permit)| async move {
            stream.next().await.map(|chunk| (chunk, (stream, permit)))
        });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("private, no-store"),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        header::HeaderValue::from_static("nosniff"),
    );
    if let Ok(v) = count.to_string().parse() {
        h.insert(header::CONTENT_LENGTH, v);
    }
    if partial && let Ok(v) = format!("bytes {start}-{}/{len}", start + count - 1).parse() {
        h.insert(header::CONTENT_RANGE, v);
    }
    response
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayInfo {
    pub base_url: String,
    pub token: String,
}

pub struct Gateway {
    info: GatewayInfo,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<std::io::Result<()>>,
}

impl Gateway {
    pub async fn start(assets: AssetStore) -> std::io::Result<Self> {
        let token = uuid::Uuid::new_v4().to_string();
        let listener =
            tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let info = GatewayInfo {
            base_url: format!("http://{}", listener.local_addr()?),
            token,
        };
        let app = router(assets, &info.token);
        let (shutdown, receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await
        });
        Ok(Self {
            info,
            shutdown: Some(shutdown),
            task,
        })
    }
    pub fn info(&self) -> GatewayInfo {
        self.info.clone()
    }
    pub async fn shutdown(mut self) -> std::io::Result<()> {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        match tokio::time::timeout(std::time::Duration::from_secs(2), &mut self.task).await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => Err(std::io::Error::other(e)),
            Err(_) => {
                self.task.abort();
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "gateway shutdown timed out",
                ))
            }
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn assets_require_token_and_support_ranges() {
        let temp = tempfile::tempdir().unwrap();
        let package =
            coboard_storage::Package::create(temp.path().join("test.coboard"), "test").unwrap();
        let hash = package.assets().put(b"0123456789").unwrap();
        let app = router(package.assets().clone(), "secret");
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/assets/{hash}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/assets/{hash}"))
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::RANGE, "bytes=2-4")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(
            &to_bytes(response.into_body(), 100).await.unwrap()[..],
            b"234"
        );
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/assets/{hash}"))
                    .header(header::AUTHORIZATION, "Bearer secret")
                    .header(header::RANGE, "bytes=99-")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }
    #[test]
    fn range_boundaries() {
        assert_eq!(range(Some("bytes=-3"), 10), Ok((7, 3, true)));
        assert_eq!(range(Some("bytes=3-"), 10), Ok((3, 7, true)));
        assert!(range(Some("bytes=0-1,3-4"), 10).is_err());
        assert!(range(Some("bytes=-0"), 10).is_err());
        assert_eq!(range(None, 0), Ok((0, 0, false)));
    }
    #[tokio::test]
    async fn gateway_binds_only_loopback_and_stops() {
        let temp = tempfile::tempdir().unwrap();
        let p = coboard_storage::Package::create(temp.path().join("a.coboard"), "test").unwrap();
        let gateway = Gateway::start(p.assets().clone()).await.unwrap();
        assert!(gateway.info().base_url.starts_with("http://127.0.0.1:"));
        gateway.shutdown().await.unwrap();
    }
}
