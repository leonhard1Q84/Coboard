use coboard_domain::{Document, EditRequest};
use coboard_macos::{BackdropConfig, OverlayState};
use coboard_server::{Gateway, GatewayInfo};
use coboard_storage::{AssetStore, Package, RecoveryReport, StorageError};
use coboard_vision_ml::recognition::{
    HandwritingRecognizer, IncrementalRequest, IncrementalResponse, RecognitionError,
};
use serde::Serialize;
use std::{
    path::PathBuf,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tokio::sync::Semaphore;

struct DesktopState {
    path: PathBuf,
    session: Arc<Mutex<Option<Package>>>,
    gate: Arc<Semaphore>,
    gateway: tokio::sync::Mutex<Option<Gateway>>,
    overlay_state: Arc<Mutex<OverlayState>>,
    /// Spotlight polling runs only while the overlay is visible and click-through.
    cursor_active: Arc<AtomicBool>,
    hwr: Arc<Mutex<HandwritingRecognizer>>,
    hwr_gate: Arc<Semaphore>,
}

#[derive(Debug, Clone, Serialize)]
struct CursorPoint {
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
struct ApiError {
    code: String,
    message: String,
}

impl ApiError {
    fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<StorageError> for ApiError {
    fn from(error: StorageError) -> Self {
        let code = error.code();
        let message = match code {
            "disk_full" => "磁盘空间不足。当前操作尚未保存，请释放空间后重试。",
            "permission_denied" => "没有文档写入权限。当前操作尚未保存，请恢复目录权限后重试。",
            "document_locked" => "文档正由另一个进程写入，请关闭另一个实例后重试。",
            "revision_conflict" => "文档已有新版本，请重新载入后再编辑。",
            "unsupported_version" => "此文档由较新版本创建，已阻止写入。请保留原件并升级应用。",
            "document_corrupt" => "文档校验未通过，已保留原件并阻止写入。",
            "missing_asset" => "引用的原图缺失或校验失败。当前操作尚未保存，请检查原始资源。",
            "input_too_large" => "内容超过当前版本的大小上限，请缩小后重试。",
            "invalid_edit" => "操作无效或内容超出限制，请调整后重试。",
            "request_conflict" => "同一请求标识对应了不同内容，请重新载入会话。",
            _ => "本地保存失败，当前操作尚未确认保存。请检查存储设备后重试。",
        };
        Self::new(code, message)
    }
}

#[derive(Serialize)]
struct SessionView {
    document: Document,
    package_path: String,
    can_undo: bool,
    can_redo: bool,
    recovery: RecoveryReport,
    gateway: Option<GatewayInfo>,
    gateway_unavailable: bool,
}

fn view(p: &Package) -> SessionView {
    SessionView {
        document: p.document().clone(),
        package_path: p.path().display().to_string(),
        can_undo: p.can_undo(),
        can_redo: p.can_redo(),
        recovery: p.recovery().clone(),
        gateway: None,
        gateway_unavailable: false,
    }
}

/// The sole application writer. No blocking I/O or long-held lock on the UI thread.
/// One in-flight job bounds backlog; rejected requests retain their frontend draft.
async fn session_job<T: Send + 'static>(
    state: &DesktopState,
    job: impl FnOnce(&mut Package) -> Result<T, StorageError> + Send + 'static,
) -> Result<T, ApiError> {
    let permit = state
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new("busy", "上一项本地操作仍在进行，请稍后重试。"))?;
    let session = state.session.clone();
    let path = state.path.clone();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut guard = session.lock().map_err(|_| ApiError::new("session_unavailable", "文档会话异常，请重新启动以恢复已提交内容。"))?;
        if guard.is_none() {
            let p = if path.try_exists().map_err(StorageError::from)? { Package::open(&path)? }
            else {
                let parent = path.parent().ok_or(StorageError::UnsafePath)?;
                std::fs::create_dir_all(parent).map_err(StorageError::from)?;
                Package::create(&path, "未命名推导")?
            };
            eprintln!("{{\"operation\":\"document_open\",\"revision\":{},\"replayed_updates\":{},\"recovery_ms\":{:.2}}}", p.document().revision, p.recovery().replayed_updates, p.recovery().elapsed_ms);
            *guard = Some(p);
        }
        let p = guard.as_mut().ok_or_else(|| ApiError::new("session_unavailable", "文档会话尚未就绪，请重试。"))?;
        job(p).map_err(ApiError::from)
    }).await.map_err(|_| ApiError::new("task_failed", "本地任务中断，请重试或重新启动以恢复已提交内容。"))?
}

#[tauri::command]
async fn get_session(state: tauri::State<'_, DesktopState>) -> Result<SessionView, ApiError> {
    let (mut result, assets): (SessionView, AssetStore) =
        session_job(&state, |p| Ok((view(p), p.assets().clone()))).await?;
    let mut gateway = state.gateway.lock().await;
    if gateway.is_none() {
        *gateway = Gateway::start(assets).await.ok();
    }
    result.gateway = gateway.as_ref().map(Gateway::info);
    result.gateway_unavailable = gateway.is_none();
    Ok(result)
}

#[tauri::command]
async fn apply_edit(
    state: tauri::State<'_, DesktopState>,
    request: EditRequest,
) -> Result<SessionView, ApiError> {
    let mut result = session_job(&state, move |p| {
        let start = Instant::now(); let receipt = p.commit(&request)?;
        eprintln!("{{\"operation\":\"document_commit\",\"revision\":{},\"duplicate\":{},\"elapsed_ms\":{:.2}}}", receipt.revision, receipt.duplicate, start.elapsed().as_secs_f64()*1000.0);
        Ok(view(p))
    }).await?;
    let gateway = state.gateway.lock().await;
    result.gateway = gateway.as_ref().map(Gateway::info);
    result.gateway_unavailable = gateway.is_none();
    Ok(result)
}

fn window_error(_: impl std::fmt::Display) -> ApiError {
    ApiError::new(
        "overlay_unavailable",
        "屏幕控制未完成，已保留标注。请重试或重新呼出。",
    )
}

// AppKit window mutations run only on the main thread, including calls from async IPC.
async fn on_ui<T: Send + 'static>(
    app: tauri::AppHandle,
    work: impl FnOnce(&tauri::AppHandle) -> Result<T, ApiError> + Send + 'static,
) -> Result<T, ApiError> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(work(&handle));
    })
    .map_err(window_error)?;
    receiver.await.map_err(window_error)?
}

fn sync_overlay_visibility(
    app: &tauri::AppHandle,
    state: &DesktopState,
    visible: bool,
) -> Result<OverlayState, ApiError> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or_else(|| window_error("missing canvas"))?;
    let toolbar = app
        .get_webview_window("overlay-toolbar")
        .ok_or_else(|| window_error("missing controls"))?;
    let mut current = *state.overlay_state.lock().map_err(window_error)?;
    if visible {
        let monitor = app
            .get_webview_window("main")
            .and_then(|w| w.current_monitor().ok().flatten())
            .or(overlay.primary_monitor().map_err(window_error)?);
        if let Some(monitor) = monitor {
            overlay
                .set_position(*monitor.position())
                .map_err(window_error)?;
            overlay.set_size(*monitor.size()).map_err(window_error)?;
            let scale = monitor.scale_factor();
            current.display = coboard_macos::DisplayFrame {
                x: monitor.position().x as f64 / scale,
                y: monitor.position().y as f64 / scale,
                width: monitor.size().width as f64 / scale,
                height: monitor.size().height as f64 / scale,
                scale_factor: scale,
            };
            let size = toolbar.outer_size().map_err(window_error)?;
            toolbar
                .set_position(tauri::PhysicalPosition::new(
                    monitor.position().x + (monitor.size().width as i32 - size.width as i32) / 2,
                    monitor.position().y + monitor.size().height as i32
                        - size.height as i32
                        - (24.0 * scale) as i32,
                ))
                .map_err(window_error)?;
        }
        #[cfg(target_os = "macos")]
        coboard_macos::set_window_passthrough(overlay.ns_window().map_err(window_error)?, false)
            .map_err(window_error)?;
        overlay.show().map_err(window_error)?;
        toolbar.show().map_err(window_error)?;
    } else {
        toolbar.hide().map_err(window_error)?;
        overlay.hide().map_err(window_error)?;
    }
    if !visible {
        sync_esc_shortcut(app, false);
    }
    current.visible = visible;
    current.passthrough = false;
    current.backdrop.peek_through = false;
    *state.overlay_state.lock().map_err(window_error)? = current;
    state.cursor_active.store(false, Ordering::Relaxed);
    app.emit("overlay-state-changed", current)
        .map_err(window_error)?;
    Ok(current)
}

/// Esc exits passthrough back to drawing. Registered only while passthrough is
/// on so the key is swallowed at most once and never hijacked from other apps.
fn sync_esc_shortcut(app: &tauri::AppHandle, register: bool) {
    if let Ok(esc) = Shortcut::from_str("Escape") {
        let shortcuts = app.global_shortcut();
        let _ = if register {
            shortcuts.register(esc)
        } else {
            shortcuts.unregister(esc)
        };
    }
}

fn sync_overlay_passthrough(
    app: &tauri::AppHandle,
    state: &DesktopState,
    passthrough: bool,
) -> Result<OverlayState, ApiError> {
    let overlay = app
        .get_webview_window("overlay")
        .ok_or_else(|| window_error("missing canvas"))?;
    #[cfg(target_os = "macos")]
    coboard_macos::set_window_passthrough(overlay.ns_window().map_err(window_error)?, passthrough)
        .map_err(window_error)?;
    sync_esc_shortcut(app, passthrough);
    let mut current = state.overlay_state.lock().map_err(window_error)?;
    current.passthrough = passthrough;
    current.backdrop.peek_through = false;
    let result = *current;
    drop(current);
    state
        .cursor_active
        .store(passthrough && result.visible, Ordering::Relaxed);
    app.emit("overlay-state-changed", result)
        .map_err(window_error)?;
    Ok(result)
}

#[tauri::command]
async fn resize_overlay_toolbar(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
) -> Result<(), ApiError> {
    if !width.is_finite() || !height.is_finite() {
        return Err(window_error("invalid geometry"));
    }
    on_ui(app, move |app| {
        let toolbar = app
            .get_webview_window("overlay-toolbar")
            .ok_or_else(|| window_error("missing controls"))?;
        let monitor = toolbar
            .current_monitor()
            .map_err(window_error)?
            .or(toolbar.primary_monitor().map_err(window_error)?);
        let Some(monitor) = monitor else {
            return Err(window_error("missing display"));
        };
        let scale = monitor.scale_factor();
        let width = width.clamp(300.0, monitor.size().width as f64 / scale);
        let height = height.clamp(
            60.0,
            (monitor.size().height as f64 / scale - 48.0).max(60.0),
        );
        let old = toolbar.outer_size().map_err(window_error)?;
        let position = toolbar.outer_position().map_err(window_error)?;
        toolbar
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(window_error)?;
        toolbar
            .set_position(tauri::PhysicalPosition::new(
                position.x.clamp(
                    monitor.position().x,
                    monitor.position().x + monitor.size().width as i32 - (width * scale) as i32,
                ),
                (position.y + old.height as i32 - (height * scale) as i32)
                    .max(monitor.position().y),
            ))
            .map_err(window_error)?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn get_overlay_state(
    state: tauri::State<'_, DesktopState>,
) -> Result<OverlayState, ApiError> {
    let current = state
        .overlay_state
        .lock()
        .map_err(|_| ApiError::new("overlay_unavailable", "覆盖层状态异常，请重试。"))?;
    Ok(*current)
}

#[tauri::command]
async fn toggle_overlay(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    visible: Option<bool>,
) -> Result<OverlayState, ApiError> {
    let target = match visible {
        Some(v) => v,
        None => {
            let current = state
                .overlay_state
                .lock()
                .map_err(|_| ApiError::new("overlay_unavailable", "覆盖层状态异常，请重试。"))?;
            !current.visible
        }
    };
    let _ = state;
    on_ui(app, move |app| {
        let state = app.state::<DesktopState>();
        sync_overlay_visibility(app, &state, target)
    })
    .await
}

#[tauri::command]
async fn set_overlay_passthrough(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    passthrough: bool,
) -> Result<OverlayState, ApiError> {
    let _ = state;
    on_ui(app, move |app| {
        let state = app.state::<DesktopState>();
        sync_overlay_passthrough(app, &state, passthrough)
    })
    .await
}

#[tauri::command]
async fn set_backdrop_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    backdrop: BackdropConfig,
) -> Result<OverlayState, ApiError> {
    let validated = backdrop
        .validate()
        .map_err(|e| ApiError::new("invalid_backdrop", &format!("蒙版参数无效: {}", e)))?;
    let mut current = state
        .overlay_state
        .lock()
        .map_err(|_| ApiError::new("overlay_unavailable", "覆盖层状态异常，请重试。"))?;
    current.backdrop = validated;
    let res = *current;
    drop(current);

    app.emit("overlay-state-changed", res)
        .map_err(window_error)?;
    Ok(res)
}

#[tauri::command]
async fn clear_overlay_ink(app: tauri::AppHandle) -> Result<(), ApiError> {
    app.emit_to("overlay", "overlay-edit", "clear")
        .map_err(window_error)?;
    Ok(())
}

#[tauri::command]
async fn recognize_handwriting(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    request: IncrementalRequest,
    on_update: tauri::ipc::Channel<IncrementalResponse>,
) -> Result<(), ApiError> {
    let permit = state
        .hwr_gate
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::new("hwr_unavailable", "手写识别已暂停，已保留原笔迹。"))?;
    let hwr_slot = state.hwr.clone();
    let label = window.label().to_owned();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut recognizer = hwr_slot
            .lock()
            .map_err(|_| ApiError::new("hwr_unavailable", "手写识别状态异常，已保留原笔迹。"))?;
        let output = recognizer.recognize(&label, &request).map_err(|e| {
            let code = match e {
                RecognitionError::SequenceConflict => "hwr_conflict",
                RecognitionError::ModelUnavailable => "hwr_unavailable",
                RecognitionError::InvalidInput => "hwr_input_limit",
                RecognitionError::Decode(_) => "hwr_failed",
            };
            ApiError::new(code, &e.to_string())
        })?;
        on_update
            .send(output)
            .map_err(|_| ApiError::new("hwr_cancelled", "识别结果已取消，已保留原笔迹。"))
    })
    .await
    .map_err(|_| ApiError::new("task_failed", "手写识别任务中断，已保留原笔迹。"))?
}

pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let overlay_state = Arc::new(Mutex::new(OverlayState::default()));
            let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let text = shortcut.to_string().to_lowercase();
                        if let Some(state) = app.try_state::<DesktopState>() {
                            if text.contains("space") {
                                let is_vis = state
                                    .overlay_state
                                    .lock()
                                    .map(|s| s.visible)
                                    .unwrap_or(false);
                                let handle = app.clone();
                                let _ = app.run_on_main_thread(move || {
                                    let state = handle.state::<DesktopState>();
                                    if let Err(error) = sync_overlay_visibility(&handle, &state, !is_vis) { let _ = handle.emit("overlay-control-error", error.message); }
                                });
                            } else if text.contains("escape") {
                                let is_pt = state
                                    .overlay_state
                                    .lock()
                                    .map(|s| s.passthrough)
                                    .unwrap_or(false);
                                if is_pt {
                                    let handle = app.clone();
                                    let _ = app.run_on_main_thread(move || {
                                        let state = handle.state::<DesktopState>();
                                        if let Err(error) = sync_overlay_passthrough(&handle, &state, false) { let _ = handle.emit("overlay-control-error", error.message); }
                                    });
                                }
                            } else if text.contains("p") {
                                let is_vis = state
                                    .overlay_state
                                    .lock()
                                    .map(|s| s.visible)
                                    .unwrap_or(false);
                                if is_vis {
                                    let is_pt = state
                                        .overlay_state
                                        .lock()
                                        .map(|s| s.passthrough)
                                        .unwrap_or(false);
                                    let handle = app.clone();
                                    let _ = app.run_on_main_thread(move || {
                                        let state = handle.state::<DesktopState>();
                                        if let Err(error) = sync_overlay_passthrough(&handle, &state, !is_pt) { let _ = handle.emit("overlay-control-error", error.message); }
                                    });
                                }
                            }
                        }
                    }
                })
                .build();
            app.handle().plugin(shortcut_plugin)?;

            if let Ok(toggle_sc) = Shortcut::from_str("Alt+Space")
                && app.global_shortcut().register(toggle_sc).is_err() { eprintln!("{{\"operation\":\"register_overlay_shortcut\",\"code\":\"shortcut_unavailable\"}}");
            }
            if let Ok(pt_sc) = Shortcut::from_str("Alt+P")
                && app.global_shortcut().register(pt_sc).is_err() { eprintln!("{{\"operation\":\"register_passthrough_shortcut\",\"code\":\"shortcut_unavailable\"}}");
            }

            let overlay = tauri::WebviewWindowBuilder::new(
                app,
                "overlay",
                tauri::WebviewUrl::App("index.html?window=overlay".into()),
            )
            .transparent(true)
            .decorations(false)
            .visible(false)
            .shadow(false)
            .always_on_top(true)
            .build()?;

            let toolbar = tauri::WebviewWindowBuilder::new(
                app,
                "overlay-toolbar",
                tauri::WebviewUrl::App("index.html?window=overlay-toolbar".into()),
            )
            .transparent(true)
            .decorations(false)
            .visible(false)
            .shadow(false)
            .resizable(false)
            .inner_size(760.0, 420.0)
            .always_on_top(true)
            .build()?;

            #[cfg(target_os = "macos")]
            {
                if let Ok(ns_win) = overlay.ns_window() {
                    coboard_macos::configure_overlay_window(ns_win, false)?;
                }
                if let Ok(ns_win) = toolbar.ns_window() {
                    coboard_macos::configure_overlay_toolbar_window(ns_win)?;
                }
            }

            let path = app.path().app_data_dir()?.join("workspace.coboard");
            // Passthrough spotlight: the overlay webview receives no pointer events while
            // click-through, so poll the global cursor via CoreGraphics and emit its
            // position (~60 Hz, only on movement) for the frontend spotlight hole.
            let cursor_active = Arc::new(AtomicBool::new(false));
            let poll_flag = cursor_active.clone();
            let poll_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last = (f64::NAN, f64::NAN);
                loop {
                    if !poll_flag.load(Ordering::Relaxed) {
                        last = (f64::NAN, f64::NAN);
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        continue;
                    }
                    tokio::time::sleep(Duration::from_millis(16)).await;
                    if let Some((x, y)) = coboard_macos::mouse_location_points()
                        && ((x - last.0).abs() > 0.5 || (y - last.1).abs() > 0.5)
                    {
                        last = (x, y);
                        let _ = poll_app.emit_to("overlay", "overlay-cursor", CursorPoint { x, y });
                    }
                }
            });
            app.manage(DesktopState {
                path,
                session: Arc::new(Mutex::new(None)),
                gate: Arc::new(Semaphore::new(1)),
                gateway: tokio::sync::Mutex::new(None),
                overlay_state,
                cursor_active,
                hwr: Arc::new(Mutex::new(HandwritingRecognizer::default())),
                hwr_gate: Arc::new(Semaphore::new(1)),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && let Some(state) = window.try_state::<DesktopState>()
                && state.gate.available_permits() == 0
            {
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_session,
            apply_edit,
            get_overlay_state,
            toggle_overlay,
            set_overlay_passthrough,
            set_backdrop_config,
            clear_overlay_ink,
            resize_overlay_toolbar,
            recognize_handwriting
        ])
        .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(|handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event
                && let Some(state) = handle.try_state::<DesktopState>()
                && state.gate.available_permits() == 0
            {
                api.prevent_exit();
            }
        }),
        Err(_) => {
            eprintln!("{{\"operation\":\"desktop_start\",\"code\":\"startup_failed\"}}");
            std::process::exit(1);
        }
    }
}
