//! main.rs — notifier-hook-daemon entry point.
//!
//! ## Responsibility
//!
//! This file is intentionally minimal. Its only jobs are:
//!   1. Declare the crate's modules so `rustc` knows about them.
//!   2. Install a panic handler that writes to stderr (never stdout) so a
//!      Rust panic cannot corrupt the JS layer's JSON stream.
//!   3. Call `platform::run()` — everything else happens there.
//!
//! ## Why panic → stderr, not stdout?
//!
//! The JS layer reads stdout as a stream of newline-delimited JSON. If a
//! panic printed its backtrace to stdout it would inject non-JSON bytes
//! into the stream, causing the JS JSON parser to throw and potentially
//! crashing the host process. By routing panics to stderr (which the JS
//! layer passes through to the parent process's stderr via `stdio: inherit`)
//! the JSON stream on stdout stays clean regardless of what goes wrong
//! inside the daemon.
//!
//! ## Stdout ownership
//!
//! After `platform::run()` is entered, stdout is exclusively owned by the
//! stdout-writer thread started inside each platform module. Nothing in
//! this file (or anywhere else outside output.rs) ever writes to stdout.

// ─── Module declarations ───────────────────────────────────────────────────────

/// IPC types: Command enum (JS → Rust) and Event helpers (Rust → JS).
pub mod ipc;

/// Stdout-writer thread and pre-serialised event constructors.
pub mod output;

/// Platform-specific notification implementations.
pub mod platform;

// ─── Entry point ──────────────────────────────────────────────────────────────

fn main() {
    // ── Install panic handler ─────────────────────────────────────────────────
    // Default panic handler writes to stdout on some platforms / configs.
    // We override it to guarantee stderr-only output so the JSON stream
    // on stdout is never corrupted by a Rust panic or backtrace.
    std::panic::set_hook(Box::new(|info| {
        // location() is Option — may be None in release builds with stripped
        // debug info, so we handle both cases gracefully.
        let location = info
            .location()
            .map(|l| format!(" at {}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();

        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic payload".to_string()
        };

        eprintln!(
            "notifier-hook-daemon: panic{}: {}",
            location, message
        );
    }));

    // ── Dispatch to platform ──────────────────────────────────────────────────
    // platform::run() owns the rest of the process lifetime.
    // It blocks (Windows/macOS) or drives an async runtime (Linux) until
    // a `quit` command is received or stdin is closed by the parent process.
    platform::run();
}
