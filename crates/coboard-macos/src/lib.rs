//! M1 platform boundary: NSPanel / NSWindow non-activating overlay configuration,
//! mouse passthrough (`ignoresMouseEvents`), and multi-display geometry.
//! No ScreenCaptureKit or system recording permissions are requested during M1 startup.

use serde::{Deserialize, Serialize};
use std::ffi::c_void;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MacosError {
    #[error("native window handle is null")]
    NullWindowHandle,
    #[error("invalid backdrop config: {0}")]
    InvalidBackdrop(&'static str),
    #[error("invalid display frame")]
    InvalidDisplayFrame,
    #[error("platform operation unavailable on non-macOS target")]
    UnsupportedPlatform,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DisplayFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

impl DisplayFrame {
    pub fn valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.scale_factor.is_finite()
            && self.width > 0.0
            && self.height > 0.0
            && self.scale_factor > 0.0
    }
}

/// Three-layer overlay backdrop configuration (OVR-16):
/// Bottom (passthrough desktop) -> Middle (adjustable dim/desaturate/blur backdrop) -> Top (cards & ink).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BackdropConfig {
    /// Dimming opacity in `[0.0, 0.95]`.
    pub dim_opacity: f64,
    /// Desaturation ratio in `[0.0, 1.0]`.
    pub desaturate: f64,
    /// Backdrop blur radius in px `[0.0, 32.0]`.
    pub blur_px: f64,
    /// Hold-to-peek shortcut temporarily zeroes the backdrop without losing slider values.
    pub peek_through: bool,
}

impl Default for BackdropConfig {
    fn default() -> Self {
        Self {
            dim_opacity: 0.25,
            desaturate: 0.0,
            blur_px: 0.0,
            peek_through: false,
        }
    }
}

impl BackdropConfig {
    pub fn validate(self) -> Result<Self, MacosError> {
        if !self.dim_opacity.is_finite() || !(0.0..=0.95).contains(&self.dim_opacity) {
            return Err(MacosError::InvalidBackdrop(
                "dim_opacity must be in 0.0..=0.95",
            ));
        }
        if !self.desaturate.is_finite() || !(0.0..=1.0).contains(&self.desaturate) {
            return Err(MacosError::InvalidBackdrop(
                "desaturate must be in 0.0..=1.0",
            ));
        }
        if !self.blur_px.is_finite() || !(0.0..=32.0).contains(&self.blur_px) {
            return Err(MacosError::InvalidBackdrop("blur_px must be in 0.0..=32.0"));
        }
        Ok(self)
    }

    pub fn effective_opacity(self) -> f64 {
        if self.peek_through {
            0.0
        } else {
            self.dim_opacity
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OverlayState {
    pub visible: bool,
    pub passthrough: bool,
    pub backdrop: BackdropConfig,
    pub display: DisplayFrame,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            visible: false,
            passthrough: false,
            backdrop: BackdropConfig::default(),
            display: DisplayFrame {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
                scale_factor: 2.0,
            },
        }
    }
}

/// Computes the bounding union across multiple displays (including negative coordinates).
pub fn union_display_bounds(displays: &[DisplayFrame]) -> Result<DisplayFrame, MacosError> {
    if displays.is_empty() || displays.iter().any(|d| !d.valid()) {
        return Err(MacosError::InvalidDisplayFrame);
    }
    let min_x = displays.iter().map(|d| d.x).fold(f64::INFINITY, f64::min);
    let min_y = displays.iter().map(|d| d.y).fold(f64::INFINITY, f64::min);
    let max_x = displays
        .iter()
        .map(|d| d.x + d.width)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_y = displays
        .iter()
        .map(|d| d.y + d.height)
        .fold(f64::NEG_INFINITY, f64::max);
    let max_scale = displays
        .iter()
        .map(|d| d.scale_factor)
        .fold(1.0_f64, f64::max);
    Ok(DisplayFrame {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
        scale_factor: max_scale,
    })
}

/// Converts a window-local logical coordinate into physical screen pixels.
pub fn window_to_device_px(
    local_x: f64,
    local_y: f64,
    display: DisplayFrame,
) -> Result<(f64, f64), MacosError> {
    if !display.valid() || !local_x.is_finite() || !local_y.is_finite() {
        return Err(MacosError::InvalidDisplayFrame);
    }
    Ok((
        (display.x + local_x) * display.scale_factor,
        (display.y + local_y) * display.scale_factor,
    ))
}

/// Configures a native macOS `NSWindow` / `NSPanel` pointer for a full-screen overlay:
/// - `NSWindowCollectionBehaviorCanJoinAllSpaces | FullScreenAuxiliary | Stationary`
/// - Status window level (`25`) so it floats above ordinary application windows
/// - Transparent background (`opaque = NO`, `clearColor`, `hasShadow = NO`)
/// - `NonactivatingPanel` style mask bit when supported by the window class
pub fn configure_overlay_window(
    ns_window: *mut c_void,
    passthrough: bool,
) -> Result<(), MacosError> {
    if ns_window.is_null() {
        return Err(MacosError::NullWindowHandle);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{ClassType, msg_send};
        use objc2_app_kit::{NSColor, NSPanel, NSWindowCollectionBehavior, NSWindowStyleMask};
        // SAFETY: `ns_window` is verified non-null and points to a valid AppKit `NSWindow`
        // provided by Tauri on the main/UI thread. Objective-C messages sent below are
        // standard `NSWindow` properties.
        unsafe {
            let window = &*(ns_window as *const AnyObject);
            // Tauri currently supplies an NSWindow subclass, not an NSPanel.
            // AppKit rejects this style on ordinary windows; do not change the
            // runtime class of a window owned by Tauri to work around that.
            let is_panel: bool = msg_send![window, isKindOfClass: NSPanel::class()];
            if is_panel {
                let current_mask: NSWindowStyleMask = msg_send![window, styleMask];
                let next_mask = current_mask | NSWindowStyleMask::NonactivatingPanel;
                let _: () = msg_send![window, setStyleMask: next_mask];
            }

            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary;
            let _: () = msg_send![window, setCollectionBehavior: behavior];

            let level: isize = 25; // NSStatusWindowLevel
            let _: () = msg_send![window, setLevel: level];
            let _: () = msg_send![window, setOpaque: false];
            let _: () = msg_send![window, setHasShadow: false];
            let clear = NSColor::clearColor();
            let _: () = msg_send![window, setBackgroundColor: Option::<&NSColor>::Some(&clear)];
            let _: () = msg_send![window, setIgnoresMouseEvents: passthrough];
            let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];
            // Ensure overlay canvas remains readable by screen sharing and recording (PRS-01)
            let sharing_read_only: usize = 1; // NSWindowSharingReadOnly
            let _: () = msg_send![window, setSharingType: sharing_read_only];
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = passthrough;
        Err(MacosError::UnsupportedPlatform)
    }
}

/// Configures a native macOS `NSWindow` / `NSPanel` pointer for the floating overlay toolbar:
/// - Non-activating panel style mask only for an actual `NSPanel`
/// - Can join all spaces, auxiliary, stationary
/// - Window level: 26 (StatusWindowLevel + 1), floats above overlay canvas (level 25)
/// - Transparent background so WebView HTML styles control the rounded floating pill
/// - Shadow enabled
/// - Excluded from screen capture (`sharingType = NSWindowSharingNone`, PRS-02)
/// - `ignoresMouseEvents = false` (always interactable)
pub fn configure_overlay_toolbar_window(ns_window: *mut c_void) -> Result<(), MacosError> {
    if ns_window.is_null() {
        return Err(MacosError::NullWindowHandle);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{ClassType, msg_send};
        use objc2_app_kit::{NSColor, NSPanel, NSWindowCollectionBehavior, NSWindowStyleMask};
        // SAFETY: `ns_window` is verified non-null and points to a live AppKit `NSWindow`
        // provided by Tauri on the main/UI thread.
        unsafe {
            let window = &*(ns_window as *const AnyObject);
            let is_panel: bool = msg_send![window, isKindOfClass: NSPanel::class()];
            if is_panel {
                let current_mask: NSWindowStyleMask = msg_send![window, styleMask];
                let next_mask = current_mask | NSWindowStyleMask::NonactivatingPanel;
                let _: () = msg_send![window, setStyleMask: next_mask];
            }

            let behavior = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Stationary;
            let _: () = msg_send![window, setCollectionBehavior: behavior];

            let level: isize = 26; // StatusWindowLevel + 1, above canvas overlay (25)
            let _: () = msg_send![window, setLevel: level];
            let _: () = msg_send![window, setOpaque: false];
            let _: () = msg_send![window, setHasShadow: true];
            let clear = NSColor::clearColor();
            let _: () = msg_send![window, setBackgroundColor: Option::<&NSColor>::Some(&clear)];
            let _: () = msg_send![window, setIgnoresMouseEvents: false];

            // Exclude from screen capture / recording (PRS-02)
            let sharing_none: usize = 0; // NSWindowSharingNone
            let _: () = msg_send![window, setSharingType: sharing_none];
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(MacosError::UnsupportedPlatform)
    }
}

/// Sets `NSWindow.sharingType` for excluding (`NSWindowSharingNone = 0`) or including
/// (`NSWindowSharingReadOnly = 1`) a window in screen capture (PRS-01, PRS-02).
pub fn set_window_sharing_type(
    ns_window: *mut c_void,
    sharing_none: bool,
) -> Result<(), MacosError> {
    if ns_window.is_null() {
        return Err(MacosError::NullWindowHandle);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        // SAFETY: `ns_window` is verified non-null and points to a live AppKit `NSWindow`.
        unsafe {
            let window = &*(ns_window as *const AnyObject);
            let sharing_type: usize = if sharing_none { 0 } else { 1 };
            let _: () = msg_send![window, setSharingType: sharing_type];
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = sharing_none;
        Err(MacosError::UnsupportedPlatform)
    }
}

/// Global pointer position in top-left-origin logical screen coordinates.
/// CoreGraphics, not AppKit: callable from background pollers while the overlay
/// window ignores mouse events (`ignoresMouseEvents`).
pub fn mouse_location_points() -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let event = CGEvent::new(source).ok()?;
        let p = event.location();
        Some((p.x, p.y))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Switches `NSWindow.setIgnoresMouseEvents` for instant draw/passthrough toggling (OVR-04).
pub fn set_window_passthrough(ns_window: *mut c_void, passthrough: bool) -> Result<(), MacosError> {
    if ns_window.is_null() {
        return Err(MacosError::NullWindowHandle);
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        // SAFETY: `ns_window` is verified non-null and points to a live AppKit `NSWindow`.
        unsafe {
            let window = &*(ns_window as *const AnyObject);
            let _: () = msg_send![window, setIgnoresMouseEvents: passthrough];
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = passthrough;
        Err(MacosError::UnsupportedPlatform)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backdrop_validation_and_peek_through() {
        let cfg = BackdropConfig {
            dim_opacity: 0.72,
            desaturate: 0.5,
            blur_px: 8.0,
            peek_through: false,
        }
        .validate()
        .unwrap();
        assert_eq!(cfg.effective_opacity(), 0.72);
        let peek = BackdropConfig {
            peek_through: true,
            ..cfg
        };
        assert_eq!(peek.effective_opacity(), 0.0);
        assert!(
            BackdropConfig {
                dim_opacity: 0.99,
                ..cfg
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn multi_display_union_supports_negative_coordinates_and_retina_scale() {
        let primary = DisplayFrame {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
            scale_factor: 2.0,
        };
        let secondary_left = DisplayFrame {
            x: -1920.0,
            y: -120.0,
            width: 1920.0,
            height: 1080.0,
            scale_factor: 1.0,
        };
        let union = union_display_bounds(&[primary, secondary_left]).unwrap();
        assert_eq!(union.x, -1920.0);
        assert_eq!(union.y, -120.0);
        assert_eq!(union.width, 3432.0);
        assert_eq!(union.height, 1102.0);
        assert_eq!(union.scale_factor, 2.0);
        let (px, py) = window_to_device_px(100.0, 50.0, secondary_left).unwrap();
        assert_eq!((px, py), (-1820.0, -70.0));
    }

    #[test]
    fn null_window_handle_fails_safely() {
        assert_eq!(
            configure_overlay_window(std::ptr::null_mut(), false),
            Err(MacosError::NullWindowHandle)
        );
        assert_eq!(
            configure_overlay_toolbar_window(std::ptr::null_mut()),
            Err(MacosError::NullWindowHandle)
        );
        assert_eq!(
            set_window_passthrough(std::ptr::null_mut(), true),
            Err(MacosError::NullWindowHandle)
        );
        assert_eq!(
            set_window_sharing_type(std::ptr::null_mut(), true),
            Err(MacosError::NullWindowHandle)
        );
    }
}
