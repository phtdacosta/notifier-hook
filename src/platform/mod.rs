//! platform/mod.rs — Platform module declarations.
//!
//! Each sub-module is compiled only on its target OS via `#[cfg(...)]`
//! attributes on the module files themselves. This file simply declares
//! them and re-exports the single `run()` entry point under a unified name
//! so `main.rs` can call `platform::run()` without any cfg blocks there.
//!
//! Adding a new platform:
//!   1. Create `src/platform/{name}.rs` with a `pub fn run()` entry point.
//!   2. Add `pub mod {name};` below.
//!   3. Add a `#[cfg(target_os = "{name}")]` arm to `current::run()`.

#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "linux")]
pub mod linux;

// ─── Unified entry point ──────────────────────────────────────────────────────

/// Dispatch to the current platform's `run()` function.
///
/// This is the only function `main.rs` calls. All threading setup, IPC
/// initialisation, and OS-specific boot sequences live inside each
/// platform module's `run()`.
pub fn run() {
    #[cfg(target_os = "windows")]
    windows::run();

    #[cfg(target_os = "macos")]
    macos::run();

    #[cfg(target_os = "linux")]
    linux::run();

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
    )))]
    {
        eprintln!(
            "notifier-hook: unsupported platform '{}'. \
             Supported platforms: windows, macos, linux.",
            std::env::consts::OS
        );
        std::process::exit(1);
    }
}
