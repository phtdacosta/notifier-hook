//! output.rs — The single stdout-writer thread for notifier-hook.
//!
//! ## Why a dedicated thread?
//!
//! Every platform spawns OS callback threads that fire independently and
//! concurrently:
//!   • Windows: COM thread pool threads for Activated / Dismissed / Failed
//!   • macOS:   CFRunLoop callbacks on the main thread for delegate methods
//!   • Linux:   Tokio tasks for ActionInvoked and NotificationClosed signals
//!
//! If any of those threads wrote to stdout directly, their output could
//! interleave — partial JSON lines would arrive at the JS layer and cause
//! parse errors.
//!
//! The MPSC channel is the single synchronisation point. Every thread that
//! needs to emit an event sends a fully-serialised JSON string into the
//! channel. This thread is the ONLY place `stdout` is ever written. It
//! processes messages one at a time, in channel order, with no interleaving
//! possible.
//!
//! ## Flush discipline
//!
//! Each line is flushed immediately after writing. The JS layer uses a
//! line-buffered `data` event handler — if we did not flush, events could
//! sit in the OS pipe buffer for hundreds of milliseconds before the JS
//! side sees them. Real-time delivery of `shown`, `action`, `dismissed`
//! events requires per-line flushing.
//!
//! ## Shutdown
//!
//! When all `Sender` halves are dropped (daemon is shutting down), the
//! `Receiver` iterator ends naturally and this thread exits cleanly.
//! No explicit shutdown signal is needed.

use std::io::Write;
use std::sync::mpsc;

/// Spawn the stdout-writer thread and return a `Sender` handle.
///
/// The returned `Sender` is `Clone` — every platform callback thread,
/// signal listener task, and stdin handler clones it to obtain its own
/// independent sending handle. The channel is unbounded, so senders never
/// block.
///
/// # Panics
///
/// Panics only if `stdout` cannot be locked, which would indicate a
/// catastrophic OS-level failure.
pub fn spawn_stdout_writer(rx: mpsc::Receiver<String>) {
    std::thread::Builder::new()
        .name("notifier-hook-stdout-writer".into())
        .spawn(move || {
            let stdout = std::io::stdout();
            let mut handle = stdout.lock();

            for line in rx {
                // Write the JSON event line. On broken pipe (JS process
                // exited, parent killed, etc.) we stop silently.
                if writeln!(handle, "{}", line).is_err() {
                    break;
                }

                // Flush immediately — JS must receive events in real time.
                // A single un-flushed `shown` event means show() Promise
                // never resolves, hanging the caller indefinitely.
                if handle.flush().is_err() {
                    break;
                }
            }

            // Receiver exhausted (all senders dropped) or pipe broken.
            // Thread exits here. The daemon process will exit via its own
            // main-thread path (quit command or stdin EOF).
        })
        .expect("notifier-hook: failed to spawn stdout-writer thread");
}

// ─── Convenience: pre-serialised event constructors ───────────────────────────
//
// These functions build the JSON strings that platform modules send into
// the MPSC channel. Centralising serialisation here means:
//   1. Platform code never manually constructs JSON strings (no typos in
//      field names, no missing fields, no inconsistent casing).
//   2. All wire-format changes live in one place.
//   3. Unit tests can validate the exact bytes emitted per event.

use serde_json::json;

/// `{"event":"ready","permission":"...","capabilities":{...}}`
pub fn evt_ready(permission: &str, caps: &crate::ipc::Capabilities) -> String {
    json!({
        "event":        "ready",
        "permission":   permission,
        "capabilities": caps,
    })
    .to_string()
}

/// `{"event":"shown","id":"..."}`
///
/// Emitted immediately after the OS accepts the show/update command without
/// error. Resolves the JS `show()` / `update()` Promise.
///
/// ⚠️  "OS accepted it" ≠ "user saw it". The notification may still be
///    queued, rate-limited, or suppressed by Focus / Do Not Disturb.
pub fn evt_shown(id: &str) -> String {
    json!({ "event": "shown", "id": id }).to_string()
}

/// `{"event":"failed","id":"...","error":"..."}`
///
/// Emitted when the OS rejects a show/update command. The `error` string
/// is the raw OS error — passed through without transformation so developers
/// can look it up in platform documentation.
/// Rejects the JS `show()` / `update()` Promise.
pub fn evt_failed(id: &str, error: &str) -> String {
    json!({ "event": "failed", "id": id, "error": error }).to_string()
}

/// `{"event":"action","id":"...","action_id":"..."}`
///
/// User clicked a notification action button (not the notification body
/// itself, and not the text-input send button — those are `dismissed` with
/// `default_action` and `reply` respectively).
pub fn evt_action(id: &str, action_id: &str) -> String {
    json!({ "event": "action", "id": id, "action_id": action_id }).to_string()
}

/// `{"event":"reply","id":"...","action_id":"...","text":"..."}`
///
/// User submitted an inline text-input action.
///   • Windows: `<input type="text">` element in Toast XML
///   • macOS:   UNTextInputNotificationAction
///   • Linux:   extremely rare, server-dependent
pub fn evt_reply(id: &str, action_id: &str, text: &str) -> String {
    json!({
        "event":     "reply",
        "id":        id,
        "action_id": action_id,
        "text":      text,
    })
    .to_string()
}

/// `{"event":"dismissed","id":"...","reason":"..."}`
///
/// Reason values (see ipc::REASON_* constants):
///   "user_dismissed"  – user explicitly swiped / closed
///   "timed_out"       – notification auto-expired
///   "app_closed"      – programmatic dismiss via our dismiss() call
///   "default_action"  – user clicked the notification body (not a button)
///   "unknown"         – unrecognised platform reason code
pub fn evt_dismissed(id: &str, reason: &str) -> String {
    json!({ "event": "dismissed", "id": id, "reason": reason }).to_string()
}

/// `{"event":"delivered","notifications":[...]}`
///
/// Response to the `get_delivered` command. `notifications` is an array of
/// objects with `id`, `title`, optional `body`, and `delivered_at` (unix ms).
pub fn evt_delivered(notifications: &[crate::ipc::DeliveredNotification]) -> String {
    json!({ "event": "delivered", "notifications": notifications }).to_string()
}

/// `{"event":"warn","message":"..."}`
///
/// Non-fatal informational event. Never rejects a JS Promise.
///
/// Common triggers:
///   • AUMID fallback (Windows, no windowsAppId provided)
///   • category_identifier used before register_categories (macOS)
///   • Unsupported D-Bus hint value type (Linux)
///   • get_delivered called on Linux (not supported by the spec)
///   • Any unexpected-but-recoverable condition
pub fn evt_warn(message: &str) -> String {
    json!({ "event": "warn", "message": message }).to_string()
}
