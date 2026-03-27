//! ipc.rs — All IPC types for notifier-hook.
//!
//! Every struct in this file is the authoritative definition of the wire
//! protocol between the JS layer and the Rust daemon. Changes here must be
//! mirrored in `index.d.ts`.
//!
//! Protocol rules:
//!   • All messages are newline-delimited JSON (\n terminated).
//!   • JS → Rust: `Command` enum, tagged by the `"action"` field.
//!   • Rust → JS: `Event` enum, tagged by the `"event"` field.
//!   • Unknown action strings → emit `warn`, never crash.
//!   • Unknown fields in known structs are silently ignored (default serde
//!     behaviour) — forward-compatible on both sides.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ═══════════════════════════════════════════════════════════════════════════════
// INBOUND — JS → Rust
// ═══════════════════════════════════════════════════════════════════════════════

/// Top-level command envelope. Serde dispatches on the `"action"` field.
///
/// All variants are snake_case on the wire:
///   `"init"`, `"show"`, `"update"`, `"dismiss"`,
///   `"register_categories"`, `"get_delivered"`, `"clear_delivered"`, `"quit"`
#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Command {
    /// First command after spawn. Must arrive before any other command.
    Init(InitCommand),

    /// Display a new notification.
    Show(ShowCommand),

    /// Replace an existing notification in-place (same id).
    /// Wire shape is identical to ShowCommand — id is required and must match
    /// a previously shown notification.
    Update(ShowCommand),

    /// Programmatically remove a notification.
    Dismiss(DismissCommand),

    /// Register macOS UNNotificationCategory objects.
    /// Silent no-op on Windows and Linux.
    RegisterCategories(RegisterCategoriesCommand),

    /// Request the list of currently delivered (visible) notifications.
    /// Linux: always returns empty array + warn.
    GetDelivered,

    /// Remove all delivered notifications.
    /// Linux: calls CloseNotification for each tracked id.
    ClearDelivered,

    /// Graceful shutdown. Daemon performs OS cleanup, exits with code 0.
    Quit,
}

// ─── init ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct InitCommand {
    /// Human-readable application name.
    /// Windows: shown in Action Center attribution if no windows_app_id.
    /// Linux:   passed as first argument to every org.freedesktop.Notifications
    ///          Notify call.
    /// macOS:   unused by the OS (bundle name is used), kept for symmetry.
    #[serde(default)]
    pub app_name: Option<String>,

    /// Windows AUMID (App User Model ID).
    /// Example: "com.thypress.app"
    /// If provided: daemon registers it in HKCU\Software\Classes\AppUserModelId\{id}
    ///              on first run, then creates ToastNotifier with this id.
    /// If omitted:  daemon falls back to the PowerShell AUMID and emits `warn`.
    ///              Notifications work but appear attributed to "Windows PowerShell".
    #[serde(default)]
    pub windows_app_id: Option<String>,
}

// ─── show / update ─────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct ShowCommand {
    /// Caller-generated UUID v4. Used to correlate events (shown/failed/action/
    /// dismissed/reply) back to the originating show() call in JS.
    /// For update(): must match the id used in the original show() call.
    pub id: String,

    /// Notification title. Always required.
    /// Ignored on Windows when `windows.xml` is present.
    pub title: String,

    /// Notification body text. Optional.
    /// Ignored on Windows when `windows.xml` is present.
    #[serde(default)]
    pub body: Option<String>,

    /// Absolute path to an icon image.
    /// Supported formats: PNG, ICO (Windows), JPEG.
    /// Ignored on Windows when `windows.xml` is present.
    #[serde(default)]
    pub icon: Option<String>,

    /// Play the default notification sound. Baseline cross-platform field.
    /// Platform escape hatches offer finer control (sound_name on macOS,
    /// sound-file hint on Linux, <audio> element in Windows XML).
    #[serde(default)]
    pub sound: Option<bool>,

    /// Forwarded from InitCommand.app_name so the Linux Notify call has it
    /// available without needing global state.
    #[serde(default)]
    pub app_name: Option<String>,

    /// Windows-specific options. Silently ignored on other platforms.
    #[serde(default)]
    pub windows: Option<WindowsOptions>,

    /// macOS-specific options. Silently ignored on other platforms.
    #[serde(default)]
    pub macos: Option<MacOSOptions>,

    /// Linux-specific options. Silently ignored on other platforms.
    #[serde(default)]
    pub linux: Option<LinuxOptions>,
}

/// Windows escape hatch — every field maps directly to a native WinRT API call.
#[derive(Deserialize, Debug, Clone)]
pub struct WindowsOptions {
    /// Raw Toast XML payload.
    ///
    /// IMPORTANT: When this field is present, ALL baseline fields (title, body,
    /// icon, sound) are ENTIRELY IGNORED. The XML string is loaded verbatim via
    /// XmlDocument::LoadXml() and handed to ToastNotification.
    ///
    /// Full schema supports: progress bars, hero images, inline reply inputs,
    /// adaptive content, scenario modes, custom audio, app logos.
    /// Spec: https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/adaptive-interactive-toasts
    #[serde(default)]
    pub xml: Option<String>,

    /// Toast tag — required for update() and programmatic dismiss().
    /// Daemon stores `notification_id → (tag, group)` for correlation.
    /// Pair always with `group`.
    #[serde(default)]
    pub tag: Option<String>,

    /// Toast group — required alongside `tag` for update() and dismiss().
    #[serde(default)]
    pub group: Option<String>,

    /// Toast scenario. Controls how long the notification stays on screen.
    ///   "default"      — standard auto-dismiss behaviour
    ///   "alarm"        — stays until user dismisses (with snooze/dismiss buttons)
    ///   "reminder"     — stays until user dismisses
    ///   "incomingCall" — full-screen incoming call UI
    #[serde(default)]
    pub scenario: Option<String>,

    /// Auto-remove from Action Center after this many milliseconds.
    /// 0 or absent = OS default retention policy.
    #[serde(default)]
    pub expiration_ms: Option<u64>,
}

/// macOS escape hatch — every field maps 1:1 to UNMutableNotificationContent
/// properties or UNNotificationRequest configuration.
#[derive(Deserialize, Debug, Clone)]
pub struct MacOSOptions {
    /// Secondary line shown below the title, above the body. macOS-only UI element.
    #[serde(default)]
    pub subtitle: Option<String>,

    /// Groups notifications from the same logical conversation/thread in
    /// Notification Center. Shown as a stack when multiple arrive.
    #[serde(default)]
    pub thread_identifier: Option<String>,

    /// Interruption level. Controls Do Not Disturb / Focus mode penetration.
    ///   "passive"       — delivered quietly, no sound, no screen wake
    ///   "active"        — default, plays sound, wakes screen
    ///   "timeSensitive" — breaks through most Focus modes
    ///   "critical"      — breaks through ALL Focus modes (requires entitlement)
    #[serde(default)]
    pub interruption_level: Option<String>,

    /// Must reference a category registered via register_categories BEFORE
    /// this show() call. If unregistered, notification shows without actions
    /// and a `warn` event is emitted. Never crashes.
    #[serde(default)]
    pub category_identifier: Option<String>,

    /// 0.0–1.0. macOS uses this to rank notifications when grouping summaries.
    /// Higher = more prominent placement in summary.
    #[serde(default)]
    pub relevance_score: Option<f64>,

    /// Absolute file paths to attach as rich media.
    /// Supported types: JPEG, PNG, GIF, MPEG4, MP3, M4V, MP4, HEIC, HEIF.
    /// Daemon creates UNNotificationAttachment per path. Invalid paths are
    /// skipped with a `warn` — they do not fail the whole show() call.
    #[serde(default)]
    pub attachments: Option<Vec<String>>,

    /// Set the app badge count. Pass 0 to clear the badge.
    #[serde(default)]
    pub badge: Option<u32>,

    /// Sound name string.
    ///   "default"          → system default notification sound
    ///   null / absent      → no sound
    ///   any other string   → UNNotificationSoundName (custom app sound)
    // Option<Option<String>>:
    //   None         = field absent (respect baseline `sound` field)
    //   Some(None)   = explicit null (silent)
    //   Some(Some(s))= named sound
    #[serde(default)]
    pub sound_name: Option<Option<String>>,
}

/// Linux escape hatch — maps directly to org.freedesktop.Notifications Notify
/// parameters and the hints dict.
#[derive(Deserialize, Debug, Clone)]
pub struct LinuxOptions {
    /// Urgency level, passed as D-Bus byte hint "urgency".
    ///   0 = Low, 1 = Normal, 2 = Critical
    /// Critical urgency typically ignores the timeout and requires explicit
    /// user dismissal. Behaviour is notification server dependent.
    #[serde(default)]
    pub urgency: Option<u8>,

    /// Display timeout in milliseconds.
    ///   -1 → notification server decides
    ///    0 → notification never expires automatically
    ///   >0 → auto-dismiss after this many milliseconds
    /// Passed directly as the `expire_timeout` parameter to Notify.
    #[serde(default)]
    pub timeout: Option<i32>,

    /// Arbitrary D-Bus hints dict.
    /// Values may be bool, string, i64, or f64 JSON scalars.
    /// Other types emit a `warn` and are skipped.
    ///
    /// Well-known hint keys (freedesktop spec):
    ///   "category"        – notification category string
    ///   "desktop-entry"   – .desktop file name without extension
    ///   "image-path"      – absolute path or file:// URI to an image
    ///   "resident"        – bool, keep in tray after action
    ///   "transient"       – bool, bypass persistence
    ///   "sound-file"      – absolute path to sound file (.oga/.wav)
    ///   "suppress-sound"  – bool
    ///   "x" / "y"         – screen position hints (i32)
    ///   "urgency"         – byte (prefer the top-level `urgency` field)
    #[serde(default)]
    pub hints: Option<HashMap<String, serde_json::Value>>,

    /// Action buttons. Only rendered if the notification server reports the
    /// "actions" capability in GetCapabilities.
    /// JS layer gates this on `notifier.capabilities.actions`.
    #[serde(default)]
    pub actions: Option<Vec<LinuxAction>>,
}

/// A single action button in a Linux notification.
#[derive(Deserialize, Debug, Clone)]
pub struct LinuxAction {
    /// Action identifier string. Returned verbatim in the `action` event.
    pub id: String,
    /// Human-readable button label shown in the notification.
    pub label: String,
}

// ─── dismiss ───────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct DismissCommand {
    /// The notification id to remove.
    pub id: String,
}

// ─── register_categories ───────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct RegisterCategoriesCommand {
    pub categories: Vec<CategoryDefinition>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CategoryDefinition {
    /// Category identifier. Referenced by ShowCommand.macos.category_identifier.
    pub id: String,

    /// Action buttons / text inputs for this category.
    pub actions: Vec<ActionDefinition>,

    /// UNNotificationCategoryOptions flags.
    /// Supported string values:
    ///   "custom_dismiss_action"         – fires dismissed event on swipe-away
    ///   "allow_in_car_play"             – show in CarPlay
    ///   "hidden_previews_show_title"    – show title when previews are hidden
    ///   "hidden_previews_show_subtitle_body"
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ActionDefinition {
    /// Unique action identifier. Returned in `action` and `reply` events.
    pub id: String,

    /// Button label text.
    pub title: String,

    /// "button" (default) or "text_input".
    /// text_input → creates UNTextInputNotificationAction.
    #[serde(default, rename = "type")]
    pub action_type: Option<String>,

    /// Placeholder text for text_input actions.
    #[serde(default)]
    pub placeholder: Option<String>,

    /// Send button title for text_input actions. Default: "Send".
    #[serde(default)]
    pub button_title: Option<String>,

    /// Renders the action in a destructive (red) style on macOS.
    #[serde(default)]
    pub destructive: Option<bool>,

    /// Require device authentication (Face ID / Touch ID) before invoking.
    #[serde(default)]
    pub authentication_required: Option<bool>,

    /// macOS only. When true, tapping this action brings the application to
    /// the foreground (UNNotificationActionOptions::Foreground).
    ///
    /// DEFAULT IS FALSE. This daemon runs under
    /// NSApplicationActivationPolicy::Accessory (no Dock icon, no menu bar).
    /// Applying Foreground unconditionally on every action tap produces an
    /// unwanted ghost window / focus steal for headless background processes.
    ///
    /// Only set to true for actions that genuinely need the app visible
    /// ("Open", "View"). Never set for "Archive", "Delete", "Reply".
    #[serde(default)]
    pub foreground: Option<bool>,
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTBOUND — Rust → JS
// ═══════════════════════════════════════════════════════════════════════════════

/// Platform capabilities. Populated from OS introspection where available,
/// synthesised from known platform behaviour elsewhere.
///
/// JS exposes this as `notifier.capabilities` after `ready` fires.
/// Developers should gate advanced features on these flags.
#[derive(Serialize, Debug, Clone)]
pub struct Capabilities {
    /// Server supports action buttons on notifications.
    pub actions: bool,
    /// Server renders notification body text.
    pub body: bool,
    /// Server renders hyperlinks in body text.
    pub body_hyperlinks: bool,
    /// Server renders inline images in body text.
    pub body_images: bool,
    /// Server renders markup (bold/italic) in body text.
    pub body_markup: bool,
    /// Server renders a static icon.
    pub icon_static: bool,
    /// Server supports multiple simultaneous icons.
    pub icon_multi: bool,
    /// Notifications persist after display timeout.
    pub persistence: bool,
    /// Server plays sounds.
    pub sound: bool,
    /// In-place update is available (replaces_id / tag+group).
    pub update: bool,
    /// Programmatic dismiss is available.
    pub dismiss: bool,
}

/// Delivered notification entry returned by get_delivered.
#[derive(Serialize, Debug, Clone)]
pub struct DeliveredNotification {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Unix epoch milliseconds.
    pub delivered_at: u64,
}

// ─── Helper: synthesised Windows capability set ────────────────────────────────

impl Capabilities {
    pub fn windows() -> Self {
        Capabilities {
            actions:         true,
            body:            true,
            body_hyperlinks: false,
            body_images:     false,
            body_markup:     false,
            icon_static:     true,
            icon_multi:      false,
            persistence:     true,
            sound:           true,
            update:          true,
            dismiss:         true,
        }
    }

    pub fn macos() -> Self {
        Capabilities {
            actions:         true,
            body:            true,
            body_hyperlinks: false,
            body_images:     false,
            body_markup:     false,
            icon_static:     true,
            icon_multi:      false,
            persistence:     true,
            sound:           true,
            update:          true,
            dismiss:         true,
        }
    }
}

// ─── Dismiss reason — normalised across all platforms ─────────────────────────

/// Wire string values for the `reason` field of the `dismissed` event.
pub const REASON_USER_DISMISSED:  &str = "user_dismissed";
pub const REASON_TIMED_OUT:       &str = "timed_out";
pub const REASON_APP_CLOSED:      &str = "app_closed";
pub const REASON_DEFAULT_ACTION:  &str = "default_action";
pub const REASON_UNKNOWN:         &str = "unknown";
