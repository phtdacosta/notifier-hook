//! platform/linux.rs — Linux org.freedesktop.Notifications implementation.
//!
//! ## D-Bus interface
//!
//!   All notification work is done via direct calls to the
//!   `org.freedesktop.Notifications` D-Bus service. We intentionally do NOT
//!   use `notify-rust` — it is itself an abstraction layer that hides the raw
//!   hints dict, `replaces_id`, signal subscription control, and raw
//!   `GetCapabilities` results that notifier-hook needs to expose.
//!
//! ## Threading model — the Tokio starvation fix (CRITICAL)
//!
//!   WRONG (the original bug): calling an `async fn` that `await`s blocking
//!   `std::io::stdin` on the Tokio executor starves all other tasks. The
//!   `listen_action_invoked` and `listen_notification_closed` tasks never get
//!   polled. User clicks a button → D-Bus signal fires → daemon ignores it.
//!
//!   CORRECT (this implementation):
//!     • `std::thread::spawn` owns the blocking stdin read loop entirely
//!       outside the Tokio executor.
//!     • A `tokio::sync::mpsc::unbounded_channel` bridges lines into async.
//!     • The async command loop `await`s the channel receive, which yields
//!       cooperatively so signal listener tasks run freely between commands.
//!
//!   This is the canonical Tokio pattern for mixing blocking I/O with async.
//!
//! ## init command — pre-runtime blocking read
//!
//!   The mandatory `init` command is read synchronously on the OS thread before
//!   `#[tokio::main]` starts the executor. This avoids any risk of blocking the
//!   executor during startup and keeps the pre-runtime preamble simple.
//!
//!   To safely perform blocking I/O inside an already-running Tokio runtime
//!   (e.g. in tests), use `tokio::task::spawn_blocking` instead.
//!
//! ## id_map — UUID ↔ D-Bus uint32 correlation
//!
//!   The `Notify` D-Bus method returns a server-assigned `uint32` notification
//!   id. Our JS layer uses UUID strings. We maintain a bidirectional map:
//!     our UUID (String) → D-Bus uint32
//!   Used for:
//!     • `update()`  — pass as `replaces_id` so server replaces in-place
//!     • `dismiss()` — pass to `CloseNotification`
//!     • Signal correlation — `ActionInvoked` / `NotificationClosed` carry the
//!       D-Bus `uint32`; reverse-lookup to find our UUID
//!
//! ## Capability detection
//!
//!   `GetCapabilities` returns a string array from the running notification
//!   server (dunst, GNOME Shell, KDE Plasma, etc.). We use it to populate the
//!   `capabilities` object sent in `ready` so the JS caller can gate features
//!   (especially `actions`) at runtime.
//!
//! ## Known limitations (see README)
//!
//!   • `get_delivered` is not supported by the freedesktop spec — always
//!     returns `[]` with a `warn` event.
//!   • GNOME Shell may not reliably emit `ActionInvoked` even when
//!     `GetCapabilities` reports `actions: true`. `dunst`, KDE, XFCE are
//!     fully reliable.

#![cfg(target_os = "linux")]

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::{mpsc, Arc, Mutex};

use futures_util::StreamExt;
use zbus::{Connection, MatchRule, MessageStream};

use crate::ipc::{
    Capabilities, Command, DeliveredNotification, InitCommand, LinuxOptions,
    ShowCommand, REASON_APP_CLOSED, REASON_TIMED_OUT, REASON_UNKNOWN,
    REASON_USER_DISMISSED,
};
use crate::output::{
    self, evt_action, evt_dismissed, evt_ready, evt_shown, evt_warn,
    spawn_stdout_writer,
};

// ─── D-Bus destination / path / interface — single source of truth ─────────────

const NOTIF_DEST:  &str = "org.freedesktop.Notifications";
const NOTIF_PATH:  &str = "/org/freedesktop/Notifications";
const NOTIF_IFACE: &str = "org.freedesktop.Notifications";

// ─── Shared state ─────────────────────────────────────────────────────────────

/// Bidirectional map: our UUID → D-Bus server-assigned uint32.
/// Wrapped in Arc<Mutex<>> so it can be shared between the async command loop
/// and the two signal listener tasks.
type IdMap = Arc<Mutex<HashMap<String, u32>>>;

// ─── Public entry point ────────────────────────────────────────────────────────

#[tokio::main]
pub async fn run() {
    // ── Step 1: MPSC + stdout-writer ──────────────────────────────────────────
    // std::sync::mpsc — cloneable from both the blocking stdin OS thread and
    // async Tokio tasks without bridging overhead.
    let (event_tx, event_rx) = mpsc::channel::<String>();
    spawn_stdout_writer(event_rx);

    // ── Step 2: Read init command synchronously ───────────────────────────────
    // Called before any tasks are spawned. Uses blocking I/O on the current
    // thread, which is acceptable here because the Tokio executor has started
    // but no tasks have been spawned yet — there is nothing to starve.
    //
    // If this ever needs to move inside a running executor, replace with:
    //   tokio::task::spawn_blocking(read_init_blocking).await.unwrap()
    let init = read_init_blocking();
    let app_name = init
        .app_name
        .clone()
        .unwrap_or_else(|| "notifier-hook".to_string());

    // ── Step 3: D-Bus session connection ─────────────────────────────────────
    let connection = match Connection::session().await {
        Ok(c)  => c,
        Err(e) => {
            eprintln!(
                "notifier-hook: failed to connect to D-Bus session bus: {}",
                e
            );
            std::process::exit(1);
        }
    };

    // ── Step 4: GetCapabilities ───────────────────────────────────────────────
    let caps = get_capabilities(&connection).await;

    // ── Step 5: Emit ready ────────────────────────────────────────────────────
    event_tx.send(evt_ready("granted", &caps)).ok();

    // ── Step 6: Shared id_map ─────────────────────────────────────────────────
    let id_map: IdMap = Arc::new(Mutex::new(HashMap::new()));

    // ── Step 7: Signal listener tasks ────────────────────────────────────────
    // Spawned as Tokio tasks — they run concurrently with the command loop
    // and are polled freely because stdin lives on a separate OS thread.
    //
    // ActionInvoked is only subscribed if the server reports actions capability.
    // NotificationClosed is always subscribed — needed for dismiss correlation.
    if caps.actions {
        tokio::spawn(listen_action_invoked(
            connection.clone(),
            Arc::clone(&id_map),
            event_tx.clone(),
        ));
    }
    tokio::spawn(listen_notification_closed(
        connection.clone(),
        Arc::clone(&id_map),
        event_tx.clone(),
    ));

    // ── Step 8: Blocking stdin on its own OS thread ───────────────────────────
    // THE FIX: blocking I/O lives entirely outside the Tokio executor.
    // The unbounded_channel bridges it into async land. The executor freely
    // polls signal listener tasks between each command received.
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    std::thread::Builder::new()
        .name("notifier-hook-stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines().flatten() {
                let trimmed = line.trim().to_string();
                if !trimmed.is_empty() {
                    if cmd_tx.send(trimmed).is_err() {
                        // Receiver dropped — async side shut down. Exit cleanly.
                        break;
                    }
                }
            }
        })
        .expect("notifier-hook: failed to spawn stdin thread");

    // ── Step 9: Async command loop ────────────────────────────────────────────
    // Between each `cmd_rx.recv().await` the Tokio executor polls signal tasks,
    // timer tasks, and any other pending work. This is the cooperative yield
    // point that makes the whole threading model work correctly.
    while let Some(line) = cmd_rx.recv().await {
        match serde_json::from_str::<Command>(&line) {
            Ok(cmd) => {
                handle_command(
                    cmd,
                    &connection,
                    &id_map,
                    &event_tx,
                    &app_name,
                )
                .await;
            }
            Err(e) => {
                event_tx
                    .send(evt_warn(&format!(
                        "failed to parse command: {} — raw: {}",
                        e, line
                    )))
                    .ok();
            }
        }
    }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

async fn handle_command(
    cmd:      Command,
    conn:     &Connection,
    id_map:   &IdMap,
    event_tx: &mpsc::Sender<String>,
    app_name: &str,
) {
    match cmd {
        Command::Show(c) | Command::Update(c) => {
            notify(c, conn, id_map, event_tx, app_name).await;
        }
        Command::Dismiss(c) => {
            dismiss(&c.id, conn, id_map, event_tx).await;
        }
        Command::GetDelivered => {
            // org.freedesktop.Notifications defines no history API.
            // Always return empty array + warn so the JS Promise resolves
            // cleanly rather than timing out.
            event_tx
                .send(evt_warn(
                    "getDelivered is not supported on Linux — \
                     org.freedesktop.Notifications defines no history API. \
                     Returning empty array.",
                ))
                .ok();
            event_tx
                .send(output::evt_delivered(&[]))
                .ok();
        }
        Command::ClearDelivered => {
            clear_delivered(conn, id_map, event_tx).await;
        }
        Command::RegisterCategories(_) => {
            // Silent no-op on Linux — categories are a macOS-only concept.
        }
        Command::Quit => {
            std::process::exit(0);
        }
        Command::Init(_) => {
            event_tx
                .send(evt_warn("unexpected second init command — ignored"))
                .ok();
        }
    }
}

// ─── Notify (show + update share this function) ───────────────────────────────

async fn notify(
    cmd:      ShowCommand,
    conn:     &Connection,
    id_map:   &IdMap,
    event_tx: &mpsc::Sender<String>,
    app_name: &str,
) {
    let linux = cmd.linux.as_ref();

    // ── Build hints dict ──────────────────────────────────────────────────────
    // The Notify method accepts hints as a D-Bus dict<string, variant>.
    // zbus serialises HashMap<String, zbus::zvariant::OwnedValue> correctly.
    let mut hints: HashMap<String, zbus::zvariant::OwnedValue> = HashMap::new();

    // Top-level urgency field — may be overridden by hints dict entry.
    if let Some(u) = linux.and_then(|l| l.urgency) {
        if let Ok(v) = zbus::zvariant::Value::U8(u).try_to_owned() {
            hints.insert("urgency".to_string(), v);
        }
    }

    // Arbitrary hints from linux.hints dict.
    if let Some(raw_hints) = linux.and_then(|l| l.hints.as_ref()) {
        for (key, val) in raw_hints {
            match json_value_to_dbus(val) {
                Some(v) => {
                    hints.insert(key.clone(), v);
                }
                None => {
                    event_tx
                        .send(evt_warn(&format!(
                            "hint '{}' has unsupported type {:?} — skipped. \
                             Supported types: bool, string, integer, float.",
                            key, val
                        )))
                        .ok();
                }
            }
        }
    }

    // Baseline icon field → image-path hint if not already set in hints dict.
    // This means `icon` works on Linux without requiring the caller to
    // repeat the path in linux.hints.
    if !hints.contains_key("image-path") {
        if let Some(icon) = &cmd.icon {
            if let Some(v) = json_value_to_dbus(
                &serde_json::Value::String(icon.clone())
            ) {
                hints.insert("image-path".to_string(), v);
            }
        }
    }

    // ── Build actions flat array ──────────────────────────────────────────────
    // D-Bus Notify expects: ["id1", "label1", "id2", "label2", ...]
    let actions: Vec<String> = linux
        .and_then(|l| l.actions.as_ref())
        .map(|acts| {
            acts.iter()
                .flat_map(|a| [a.id.clone(), a.label.clone()])
                .collect()
        })
        .unwrap_or_default();

    // ── Timeout ───────────────────────────────────────────────────────────────
    // -1 = server decides, 0 = never expires, positive = milliseconds.
    let timeout: i32 = linux.and_then(|l| l.timeout).unwrap_or(-1);

    // ── replaces_id ───────────────────────────────────────────────────────────
    // 0 = new notification, existing uint32 = replace in-place.
    let replaces_id: u32 = id_map
        .lock()
        .unwrap()
        .get(&cmd.id)
        .copied()
        .unwrap_or(0);

    let effective_app_name = cmd
        .app_name
        .as_deref()
        .unwrap_or(app_name);

    // ── D-Bus Notify call ─────────────────────────────────────────────────────
    // Notify(app_name, replaces_id, app_icon, summary, body,
    //        actions, hints, expire_timeout) → uint32
    let result = conn
        .call_method(
            Some(NOTIF_DEST),
            NOTIF_PATH,
            Some(NOTIF_IFACE),
            "Notify",
            &(
                effective_app_name,
                replaces_id,
                cmd.icon.as_deref().unwrap_or(""),
                cmd.title.as_str(),
                cmd.body.as_deref().unwrap_or(""),
                actions,
                hints,
                timeout,
            ),
        )
        .await;

    match result {
        Ok(msg) => {
            let dbus_id: u32 = msg.body().unwrap_or(0);
            if dbus_id != 0 {
                id_map.lock().unwrap().insert(cmd.id.clone(), dbus_id);
            }
            event_tx.send(evt_shown(&cmd.id)).ok();
        }
        Err(e) => {
            event_tx
                .send(crate::output::evt_failed(&cmd.id, &e.to_string()))
                .ok();
        }
    }
}

// ─── dismiss ──────────────────────────────────────────────────────────────────

async fn dismiss(
    id:       &str,
    conn:     &Connection,
    id_map:   &IdMap,
    event_tx: &mpsc::Sender<String>,
) {
    let dbus_id = id_map.lock().unwrap().get(id).copied();

    let Some(dbus_id) = dbus_id else {
        event_tx
            .send(evt_warn(&format!(
                "dismiss: id '{}' not in id_map — notification may not have \
                 been shown yet, may have already closed, or was shown on a \
                 previous daemon instance",
                id
            )))
            .ok();
        return;
    };

    let result = conn
        .call_method(
            Some(NOTIF_DEST),
            NOTIF_PATH,
            Some(NOTIF_IFACE),
            "CloseNotification",
            &(dbus_id,),
        )
        .await;

    match result {
        Ok(_)  => { id_map.lock().unwrap().remove(id); }
        Err(e) => {
            event_tx
                .send(evt_warn(&format!(
                    "CloseNotification failed for id '{}' (dbus_id={}): {}",
                    id, dbus_id, e
                )))
                .ok();
        }
    }
}

// ─── clear_delivered ──────────────────────────────────────────────────────────

/// `org.freedesktop.Notifications` has no "clear all" method.
/// We snapshot the id_map and call `CloseNotification` for each tracked entry.
/// The snapshot avoids holding the Mutex lock across `await` points.
async fn clear_delivered(
    conn:     &Connection,
    id_map:   &IdMap,
    event_tx: &mpsc::Sender<String>,
) {
    // Snapshot — release the lock before any await.
    let snapshot: Vec<(String, u32)> = {
        let map = id_map.lock().unwrap();
        map.iter().map(|(k, v)| (k.clone(), *v)).collect()
    };

    for (our_id, dbus_id) in snapshot {
        let result = conn
            .call_method(
                Some(NOTIF_DEST),
                NOTIF_PATH,
                Some(NOTIF_IFACE),
                "CloseNotification",
                &(dbus_id,),
            )
            .await;

        match result {
            Ok(_) => {
                id_map.lock().unwrap().remove(&our_id);
            }
            Err(e) => {
                event_tx
                    .send(evt_warn(&format!(
                        "clear_delivered: CloseNotification failed for \
                         id '{}' (dbus_id={}): {}",
                        our_id, dbus_id, e
                    )))
                    .ok();
            }
        }
    }
}

// ─── GetCapabilities ──────────────────────────────────────────────────────────

async fn get_capabilities(conn: &Connection) -> Capabilities {
    let result = conn
        .call_method(
            Some(NOTIF_DEST),
            NOTIF_PATH,
            Some(NOTIF_IFACE),
            "GetCapabilities",
            &(),
        )
        .await;

    let caps_vec: Vec<String> = result
        .and_then(|m| m.body::<Vec<String>>())
        .unwrap_or_default();

    Capabilities {
        actions:         caps_vec.contains(&"actions".to_string()),
        body:            caps_vec.contains(&"body".to_string()),
        body_hyperlinks: caps_vec.contains(&"body-hyperlinks".to_string()),
        body_images:     caps_vec.contains(&"body-images".to_string()),
        body_markup:     caps_vec.contains(&"body-markup".to_string()),
        icon_static:     caps_vec.contains(&"icon-static".to_string()),
        icon_multi:      caps_vec.contains(&"icon-multi".to_string()),
        persistence:     caps_vec.contains(&"persistence".to_string()),
        sound:           caps_vec.contains(&"sound".to_string()),
        // update and dismiss are always available via replaces_id and
        // CloseNotification — these are not part of the GetCapabilities spec.
        update:  true,
        dismiss: true,
    }
}

// ─── Signal: ActionInvoked ────────────────────────────────────────────────────

async fn listen_action_invoked(
    conn:     Connection,
    id_map:   IdMap,
    event_tx: mpsc::Sender<String>,
) {
    // Build a match rule scoped to the exact interface, member, and path
    // to avoid false matches from other notification-like services.
    let rule = match MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(NOTIF_IFACE)
        .and_then(|b| b.path(NOTIF_PATH))
        .and_then(|b| b.member("ActionInvoked"))
    {
        Ok(b)  => b.build(),
        Err(e) => {
            event_tx
                .send(evt_warn(&format!(
                    "ActionInvoked: failed to build match rule: {}",
                    e
                )))
                .ok();
            return;
        }
    };

    let mut stream =
        match MessageStream::for_match_rule(rule, &conn, None).await {
            Ok(s)  => s,
            Err(e) => {
                event_tx
                    .send(evt_warn(&format!(
                        "ActionInvoked: failed to subscribe to signal: {}",
                        e
                    )))
                    .ok();
                return;
            }
        };

    while let Some(msg_result) = stream.next().await {
        let Ok(msg) = msg_result else { continue };

        // ActionInvoked(uint id, string action_key)
        let Ok((dbus_id, action_key)) = msg.body::<(u32, String)>() else {
            continue;
        };

        if let Some(our_id) = reverse_lookup(&id_map, dbus_id) {
            event_tx
                .send(crate::output::evt_action(&our_id, &action_key))
                .ok();
        }
    }
}

// ─── Signal: NotificationClosed ───────────────────────────────────────────────

async fn listen_notification_closed(
    conn:     Connection,
    id_map:   IdMap,
    event_tx: mpsc::Sender<String>,
) {
    let rule = match MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(NOTIF_IFACE)
        .and_then(|b| b.path(NOTIF_PATH))
        .and_then(|b| b.member("NotificationClosed"))
    {
        Ok(b)  => b.build(),
        Err(e) => {
            event_tx
                .send(evt_warn(&format!(
                    "NotificationClosed: failed to build match rule: {}",
                    e
                )))
                .ok();
            return;
        }
    };

    let mut stream =
        match MessageStream::for_match_rule(rule, &conn, None).await {
            Ok(s)  => s,
            Err(e) => {
                event_tx
                    .send(evt_warn(&format!(
                        "NotificationClosed: failed to subscribe to signal: {}",
                        e
                    )))
                    .ok();
                return;
            }
        };

    while let Some(msg_result) = stream.next().await {
        let Ok(msg) = msg_result else { continue };

        // NotificationClosed(uint id, uint reason)
        // Reason codes per freedesktop spec:
        //   1 — expired (timed out by the server)
        //   2 — dismissed by the user
        //   3 — closed by a CloseNotification call
        //   4 — undefined / reserved
        let Ok((dbus_id, reason_code)) = msg.body::<(u32, u32)>() else {
            continue;
        };

        let reason = match reason_code {
            1 => REASON_TIMED_OUT,
            2 => REASON_USER_DISMISSED,
            3 => REASON_APP_CLOSED,
            _ => REASON_UNKNOWN,
        };

        if let Some(our_id) = reverse_lookup(&id_map, dbus_id) {
            // Remove from map — the notification is definitively gone.
            id_map.lock().unwrap().remove(&our_id);
            event_tx
                .send(crate::output::evt_dismissed(&our_id, reason))
                .ok();
        }
    }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/// Reverse-lookup: D-Bus server uint32 → our UUID string.
/// Used by signal listeners to correlate server-assigned ids back to JS ids.
///
/// Linear scan over the map. In practice the map contains at most a few dozen
/// entries (one per live notification) so this is cheaper than maintaining a
/// second inverse map.
fn reverse_lookup(id_map: &IdMap, dbus_id: u32) -> Option<String> {
    id_map
        .lock()
        .unwrap()
        .iter()
        .find(|(_, v)| **v == dbus_id)
        .map(|(k, _)| k.clone())
}

/// Convert a `serde_json::Value` scalar to a `zbus::zvariant::OwnedValue`
/// (D-Bus variant).
///
/// Mapping:
///   JSON `bool`    → D-Bus `Boolean`
///   JSON `string`  → D-Bus `String`
///   JSON integer   → D-Bus `Int32`  (i64 truncated to i32)
///   JSON float     → D-Bus `Double` (f64)
///   anything else  → `None` (caller emits `warn`)
///
/// The narrowing from `i64` → `i32` covers all practical hint values.
/// The freedesktop spec uses `byte`, `int32`, and `string` for all well-known
/// hints; `i32` is the widest integer type needed.
fn json_value_to_dbus(
    v: &serde_json::Value,
) -> Option<zbus::zvariant::OwnedValue> {
    use zbus::zvariant::Value;

    let owned = match v {
        serde_json::Value::Bool(b) => {
            Value::Bool(*b).try_to_owned().ok()?
        }
        serde_json::Value::String(s) => {
            Value::Str(s.as_str().into()).try_to_owned().ok()?
        }
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::I32(i as i32).try_to_owned().ok()?
            } else if let Some(f) = n.as_f64() {
                Value::F64(f).try_to_owned().ok()?
            } else {
                return None;
            }
        }
        // Arrays, objects, null — not valid D-Bus hint scalar values.
        _ => return None,
    };

    Some(owned)
}

// ─── Init reader (blocking, called before runtime starts tasks) ───────────────

/// Read the mandatory `init` command from stdin synchronously.
///
/// Called once, before the Tokio executor has spawned any tasks, so blocking
/// here is safe — there is nothing to starve. Returns a default `InitCommand`
/// if stdin closes before an init command arrives so the daemon exits cleanly.
fn read_init_blocking() -> InitCommand {
    for line in std::io::stdin().lock().lines().flatten() {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(&trimmed) {
            Ok(Command::Init(init)) => return init,
            Ok(other) => {
                eprintln!(
                    "notifier-hook: expected init, got {:?} — discarding",
                    other
                );
            }
            Err(e) => {
                eprintln!(
                    "notifier-hook: failed to parse pre-init command: \
                     {} — raw: {}",
                    e, trimmed
                );
            }
        }
    }

    InitCommand {
        app_name:       None,
        windows_app_id: None,
    }
}