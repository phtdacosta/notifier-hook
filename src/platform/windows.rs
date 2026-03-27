//! platform/windows.rs — Windows Toast Notification implementation.
//!
//! ## Boot sequence (ordering is MANDATORY — do not reorder)
//!
//!   1. `CoInitializeEx(COINIT_APARTMENTTHREADED)` — absolute first call.
//!      Every subsequent COM/WinRT operation silently returns
//!      CO_E_NOTINITIALIZED without it. No panic, no error — just dead toasts.
//!   2. Read `init` command from stdin (blocks until JS sends it).
//!   3. Resolve / register AUMID in the registry.
//!   4. Create `ToastNotifier` bound to the resolved AUMID.
//!   5. Spawn stdout-writer thread.
//!   6. Emit `ready`.
//!   7. Enter stdin command loop on this thread (no run-loop conflict on Windows).
//!
//! ## Threading model
//!
//!   Main thread      → CoInitialize → create notifier → stdin reader loop.
//!   COM thread pool  → Activated / Dismissed / Failed event handlers fire here.
//!                      Each handler holds a cloned `mpsc::Sender<String>` and
//!                      pushes serialised JSON into the channel without ever
//!                      touching stdout directly.
//!   stdout-writer    → Sole writer to stdout. Drains `mpsc::Receiver<String>`.
//!
//! ## AUMID and Action Center attribution
//!
//!   Without a registered AUMID the notification still appears but is attributed
//!   to "Windows PowerShell" in Action Center. To get correct app-name attribution:
//!
//!     HKCU\Software\Classes\AppUserModelId\{app_id}\DisplayName = app_name
//!
//!   The daemon writes this on first run when `windows_app_id` is provided in
//!   the `init` command. The key is opened with REG_OPTION_NON_VOLATILE so
//!   subsequent launches re-open the existing key without rewriting.
//!
//! ## XML injection vs. baseline XML
//!
//!   When `windows.xml` is present in a `show` / `update` command, ALL baseline
//!   fields (title, body, icon, sound) are ENTIRELY IGNORED. The raw string is
//!   loaded via `XmlDocument::LoadXml()` and handed directly to `ToastNotification`.
//!   When `windows.xml` is absent, a minimal ToastGeneric XML is constructed from
//!   the baseline fields.
//!
//! ## Known platform constraints (see README)
//!
//!   • Post-exit Action Center activations require a persistent COM server —
//!     host application responsibility, not this library's.
//!   • `delivered_at` in `get_delivered` is approximate (WinRT does not expose
//!     original delivery timestamps via ToastNotificationHistory).
//!   • Tagless notifications are skipped in `get_delivered` results.

#![cfg(target_os = "windows")]

use std::collections::HashMap;
use std::io::BufRead;
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

use windows::{
    core::{HSTRING, IInspectable, Interface},
    Data::Xml::Dom::{IXmlNode, XmlDocument},
    Foundation::{
        Collections::{IIterable, IKeyValuePair, ValueSet},
        IPropertyValue,
        IReference,
        PropertyValue,
        TypedEventHandler,
    },
    UI::Notifications::{
        ToastActivatedEventArgs,
        ToastDismissalReason,
        ToastDismissedEventArgs,
        ToastFailedEventArgs,
        ToastNotification,
        ToastNotificationHistory,
        ToastNotificationManager,
        ToastNotifier,
    },
    Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
    Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW,
        HKEY_CURRENT_USER, KEY_WRITE,
        REG_CREATE_KEY_DISPOSITION,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    },
};

use crate::ipc::{
    Capabilities, Command, DeliveredNotification, InitCommand, ShowCommand,
    REASON_APP_CLOSED, REASON_TIMED_OUT, REASON_UNKNOWN, REASON_USER_DISMISSED,
};
use crate::output::{
    self, evt_failed, evt_ready, evt_shown, evt_warn,
    evt_action, evt_dismissed, evt_reply, spawn_stdout_writer,
};

// ─── Public entry point ────────────────────────────────────────────────────────

pub fn run() {
    // ── Step 1: COM initialisation ────────────────────────────────────────────
    // MANDATORY FIRST CALL. Without this, every ToastNotificationManager call
    // returns CO_E_NOTINITIALIZED. The failure is completely silent — no panic,
    // no error event, just dead notifications with no feedback to the caller.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .expect("notifier-hook: CoInitializeEx failed — cannot continue");
    }

    // ── Step 2: Read init command ─────────────────────────────────────────────
    // Block on stdin until JS sends the mandatory `init` command.
    // No notification work can proceed without knowing app_name / windows_app_id.
    let init = read_init_from_stdin();

    // ── Step 3: MPSC channel — must exist before any event can be emitted ─────
    let (event_tx, event_rx) = mpsc::channel::<String>();

    // ── Step 4: Resolve AUMID ─────────────────────────────────────────────────
    let aumid = match &init.windows_app_id {
        Some(app_id) => {
            let display_name = init.app_name.as_deref().unwrap_or(app_id.as_str());
            ensure_aumid_registered(app_id, display_name);
            app_id.clone()
        }
        None => {
            // Fallback: PowerShell AUMID. Notifications work but are attributed
            // to "Windows PowerShell" in Action Center. Always warn so the
            // developer knows to pass windowsAppId in production.
            event_tx
                .send(evt_warn(
                    "No windowsAppId provided — notifications will appear attributed \
                     to 'Windows PowerShell' in Action Center. Pass windowsAppId in \
                     createNotifier() options for correct attribution.",
                ))
                .ok();
            // PowerShell v5 AUMID — universally present on Windows 10 / 11.
            "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\\
             WindowsPowerShell\\v1.0\\powershell.exe"
                .to_string()
        }
    };

    // ── Step 5: Create the ToastNotifier ─────────────────────────────────────
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(
        &HSTRING::from(aumid.as_str()),
    )
    .expect("notifier-hook: failed to create ToastNotifier");

    // ── Step 6: Spawn stdout-writer ───────────────────────────────────────────
    // Must be started before any event is sent on event_tx.
    spawn_stdout_writer(event_rx);

    // ── Step 7: Emit ready ────────────────────────────────────────────────────
    event_tx
        .send(evt_ready("granted", &Capabilities::windows()))
        .ok();

    // ── Step 8: Stdin command loop ────────────────────────────────────────────
    let app_name = init
        .app_name
        .unwrap_or_else(|| "notifier-hook".to_string());
    let mut id_map: HashMap<String, (String, String)> = HashMap::new();

    stdin_loop(&notifier, &aumid, &app_name, &event_tx, &mut id_map);
}

// ─── stdin reader loop ─────────────────────────────────────────────────────────

fn stdin_loop(
    notifier: &ToastNotifier,
    aumid:    &str,
    app_name: &str,
    tx:       &mpsc::Sender<String>,
    id_map:   &mut HashMap<String, (String, String)>,
) {
    for line in std::io::stdin().lock().lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(trimmed) {
            Ok(cmd) => handle_command(cmd, notifier, aumid, app_name, tx, id_map),
            Err(e) => {
                tx.send(evt_warn(&format!(
                    "failed to parse command: {} — raw: {}",
                    e, trimmed
                )))
                .ok();
            }
        }
    }
}

// ─── Command dispatch ─────────────────────────────────────────────────────────

fn handle_command(
    cmd:      Command,
    notifier: &ToastNotifier,
    aumid:    &str,
    _app_name: &str, // app_name is passed into handle_command but not yet used on Windows (it's a macOS/Linux concept for now)
    tx:       &mpsc::Sender<String>,
    id_map:   &mut HashMap<String, (String, String)>,
) {
    match cmd {
        Command::Show(c) => {
            show(c, notifier, tx, id_map);
        }
        Command::Update(c) => {
            let has_tag   = c.windows.as_ref().and_then(|w| w.tag.as_ref()).is_some();
            let has_group = c.windows.as_ref().and_then(|w| w.group.as_ref()).is_some();
            if !has_tag || !has_group {
                tx.send(evt_failed(
                    &c.id,
                    "update() requires windows.tag and windows.group — \
                     without them the notification cannot be replaced in-place",
                )).ok();
                return;
            }
            show(c, notifier, tx, id_map);
        }
        Command::Dismiss(c) => {
            dismiss(&c.id, aumid, tx, id_map);
        }
        Command::GetDelivered => {
            get_delivered(aumid, tx);
        }
        Command::ClearDelivered => {
            clear_delivered(aumid, tx);
        }
        Command::RegisterCategories(_) => {
            // Silent no-op on Windows — categories are a macOS-only concept.
        }
        Command::Quit => {
            // The stdout-writer thread will exit naturally when all senders are
            // dropped as we fall off the end of run(). Exit cleanly.
            std::process::exit(0);
        }
        Command::Init(_) => {
            // init is consumed before we enter this loop. A second init command
            // is unexpected but harmless — warn and continue.
            tx.send(evt_warn("unexpected second init command — ignored"))
                .ok();
        }
    }
}

// ─── show / update ────────────────────────────────────────────────────────────

fn show(
    cmd:      ShowCommand,
    notifier: &ToastNotifier,
    tx:       &mpsc::Sender<String>,
    id_map:   &mut HashMap<String, (String, String)>,
) {
    // ── Build XmlDocument ─────────────────────────────────────────────────────
    let xml_doc = match build_xml(&cmd) {
        Ok(doc)  => doc,
        Err(msg) => {
            tx.send(evt_failed(&cmd.id, &msg)).ok();
            return;
        }
    };

    // ── Create ToastNotification ──────────────────────────────────────────────
    let toast = match ToastNotification::CreateToastNotification(&xml_doc) {
        Ok(t)  => t,
        Err(e) => {
            tx.send(evt_failed(&cmd.id, &e.to_string())).ok();
            return;
        }
    };

    // ── Apply Windows-specific options ────────────────────────────────────────
    if let Some(w) = &cmd.windows {
        // tag + group are required for update() and dismiss() to function.
        // Stored in id_map so dismiss() can look them up by our UUID later.
        if let (Some(tag), Some(group)) = (&w.tag, &w.group) {
            let _ = toast.SetTag(&HSTRING::from(tag.as_str()));
            let _ = toast.SetGroup(&HSTRING::from(group.as_str()));
            id_map.insert(cmd.id.clone(), (tag.clone(), group.clone()));
        }

        // scenario — applied to the root <toast> element attribute.
        // Only meaningful when NOT using raw XML (caller owns attributes there).
        if w.xml.is_none() {
            if let Some(scenario) = &w.scenario {
                if let Ok(root) = xml_doc.DocumentElement() {
                    let _ = root.SetAttribute(
                        &HSTRING::from("scenario"),
                        &HSTRING::from(scenario.as_str()),
                    );
                }
            }
        }

        // expiration_ms — absolute ExpirationTime computed from now + delta.
        if let Some(ms) = w.expiration_ms.filter(|&m| m > 0) {
            if let Some(expiry) = compute_expiration(ms) {
                // SetExpirationTime requires IReference<DateTime>, not a bare DateTime.
                // Box it via PropertyValue::CreateDateTime then cast.
                if let Ok(pv) = PropertyValue::CreateDateTime(expiry) {
                    if let Ok(iref) = pv.cast::<IReference<windows::Foundation::DateTime>>() {
                        let _ = toast.SetExpirationTime(&iref);
                    }
                }
            }
        }
    }

    // ── Activated callback ────────────────────────────────────────────────────
    // Fires on a COM thread pool thread when the user clicks the notification
    // body or an action button. We inspect UserInput first to detect text replies.
    let tx1 = tx.clone();
    let id1 = cmd.id.clone();
    let _ = toast.Activated(&TypedEventHandler::new(
        move |_: &Option<ToastNotification>, args: &Option<IInspectable>| {
            if let Some(args) = args {
                if let Ok(activated) = args.cast::<ToastActivatedEventArgs>() {
                    let arguments: String = activated
                        .Arguments()
                        .map(|s: HSTRING| s.to_string())
                        .unwrap_or_default();

                    // Inspect UserInput for inline text-reply fields.
                    // UserInput() returns a ValueSet. Cast to IIterable to walk entries,
                    // then cast each IInspectable value to IPropertyValue to call GetString().
                    if let Ok(inputs) = activated.UserInput() {
                        let inputs: ValueSet = inputs;
                        if let Ok(iterable) = inputs.cast::<IIterable<IKeyValuePair<HSTRING, IInspectable>>>() {
                            if let Ok(iter) = iterable.First() {
                                while iter.HasCurrent().unwrap_or(false) {
                                    if let Ok(kv) = iter.Current() {
                                        if let (Ok(key), Ok(val)) = (kv.Key(), kv.Value()) {
                                            let text = val
                                                .cast::<IPropertyValue>()
                                                .and_then(|pv| pv.GetString())
                                                .map(|s: HSTRING| s.to_string())
                                                .unwrap_or_default();
                                            if !text.is_empty() {
                                                tx1.send(evt_reply(
                                                    &id1,
                                                    &key.to_string(),
                                                    &text,
                                                ))
                                                .ok();
                                                return Ok(());
                                            }
                                        }
                                    }
                                    let _ = iter.MoveNext();
                                }
                            }
                        }
                    }

                    // No text reply — standard action or body click.
                    tx1.send(evt_action(&id1, &arguments)).ok();
                }
            }
            Ok(())
        },
    ));

    // ── Dismissed callback ────────────────────────────────────────────────────
    let tx2 = tx.clone();
    let id2 = cmd.id.clone();
    let _ = toast.Dismissed(&TypedEventHandler::new(
        move |_: &Option<ToastNotification>, args: &Option<ToastDismissedEventArgs>| {
            let reason = args
                .as_ref()
                .and_then(|a: &ToastDismissedEventArgs| a.Reason().ok())
                .map(|r| match r {
                    ToastDismissalReason::UserCanceled      => REASON_USER_DISMISSED,
                    ToastDismissalReason::TimedOut          => REASON_TIMED_OUT,
                    ToastDismissalReason::ApplicationHidden => REASON_APP_CLOSED,
                    _                                       => REASON_UNKNOWN,
                })
                .unwrap_or(REASON_UNKNOWN);
            tx2.send(evt_dismissed(&id2, reason)).ok();
            Ok(())
        },
    ));

    // ── Failed callback ───────────────────────────────────────────────────────
    let tx3 = tx.clone();
    let id3 = cmd.id.clone();
    let _ = toast.Failed(&TypedEventHandler::new(
        move |_: &Option<ToastNotification>, args: &Option<ToastFailedEventArgs>| {
            let error = args
                .as_ref()
                .and_then(|a: &ToastFailedEventArgs| a.ErrorCode().ok())
                .map(|e| format!("{:?}", e))
                .unwrap_or_else(|| "unknown error".to_string());
            tx3.send(evt_failed(&id3, &error)).ok();
            Ok(())
        },
    ));

    // ── Show ──────────────────────────────────────────────────────────────────
    // "shown" = "OS accepted the command", NOT "user saw the notification".
    // The notification may still be queued, rate-limited, or suppressed by
    // Focus Assist / notification server policy.
    match notifier.Show(&toast) {
        Ok(_)  => { tx.send(evt_shown(&cmd.id)).ok(); }
        Err(e) => { tx.send(evt_failed(&cmd.id, &e.to_string())).ok(); }
    }
}

// ─── XML construction ─────────────────────────────────────────────────────────

/// Build the `XmlDocument` for a toast notification.
///
/// Two paths:
///   1. **Raw XML injection** — `windows.xml` is present: load verbatim via
///      `XmlDocument::LoadXml()`. All baseline fields are ignored entirely.
///   2. **Baseline XML** — construct a minimal `ToastGeneric` template from
///      `title`, `body`, `icon`, and `sound` fields.
fn build_xml(cmd: &ShowCommand) -> Result<XmlDocument, String> {
    let doc = XmlDocument::new()
        .map_err(|e| format!("XmlDocument::new failed: {}", e))?;

    // ── Raw XML injection path ─────────────────────────────────────────────
    if let Some(raw_xml) = cmd.windows.as_ref().and_then(|w| w.xml.as_ref()) {
        doc.LoadXml(&HSTRING::from(raw_xml.as_str()))
            .map_err(|e| format!("invalid Toast XML: {}", e))?;
        return Ok(doc);
    }

    // ── Baseline XML construction ──────────────────────────────────────────
    let title = xml_escape(&cmd.title);

    let body_part = cmd
        .body
        .as_ref()
        .map(|b| format!("<text>{}</text>", xml_escape(b)))
        .unwrap_or_default();

    // appLogoOverride places the icon in the top-left square of the toast banner.
    let icon_part = cmd
        .icon
        .as_ref()
        .map(|p| format!(
            r#"<image placement="appLogoOverride" src="{}"/>"#,
            xml_escape(p)
        ))
        .unwrap_or_default();

    // sound: false → explicit <audio silent="true"/>.
    // sound: true or absent → no <audio> override, OS default applies.
    let audio_part = match cmd.sound {
        Some(false) => r#"<audio silent="true"/>"#.to_string(),
        _           => String::new(),
    };

    let xml = format!(
        "<toast>\
           <visual>\
             <binding template=\"ToastGeneric\">\
               <text>{title}</text>\
               {body}\
               {icon}\
             </binding>\
           </visual>\
           {audio}\
         </toast>",
        title = title,
        body  = body_part,
        icon  = icon_part,
        audio = audio_part,
    );

    doc.LoadXml(&HSTRING::from(xml.as_str()))
        .map_err(|e| format!("failed to load baseline XML: {}", e))?;

    Ok(doc)
}

/// Escape the five XML special characters for safe embedding in text nodes
/// and attribute values constructed by the baseline XML path.
#[inline]
fn xml_escape(s: &str) -> String {
    // Process in a single pass rather than five chained replace() calls so we
    // allocate only once for strings that contain multiple special characters.
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&'  => out.push_str("&amp;"),
            '<'  => out.push_str("&lt;"),
            '>'  => out.push_str("&gt;"),
            '"'  => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _    => out.push(ch),
        }
    }
    out
}

// ─── Expiration time ──────────────────────────────────────────────────────────

/// Compute an absolute WinRT `DateTime` value of `now + delta_ms`.
///
/// WinRT `DateTime` stores 100-nanosecond ticks since January 1, 1601 UTC.
/// We compute it by converting the current Unix epoch milliseconds to ticks
/// and adding the Windows epoch offset (11_644_473_600 seconds).
///
/// Returns `None` if the system clock is unavailable (extremely rare) or if
/// the arithmetic overflows (would require a delta of ~29,000 years).
fn compute_expiration(delta_ms: u64) -> Option<windows::Foundation::DateTime> {
    const EPOCH_OFFSET_TICKS: i64 = 116_444_736_000_000_000; // Jan 1601 → Jan 1970

    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;

    let now_ticks = unix_ms
        .checked_mul(10_000)?
        .checked_add(EPOCH_OFFSET_TICKS)?;

    let expiry_ticks = now_ticks
        .checked_add(delta_ms as i64 * 10_000)?;

    Some(windows::Foundation::DateTime { UniversalTime: expiry_ticks })
}

// ─── dismiss ──────────────────────────────────────────────────────────────────

fn dismiss(
    id:     &str,
    aumid:  &str,
    tx:     &mpsc::Sender<String>,
    id_map: &mut HashMap<String, (String, String)>,
) {
    let Some((tag, group)) = id_map.get(id) else {
        tx.send(evt_warn(&format!(
            "dismiss: id '{}' not in id_map — show() must include \
             windows.tag + windows.group for programmatic dismiss to work",
            id
        )))
        .ok();
        return;
    };

    // RemoveGroupedTagWithId(tag, group, applicationId) removes a specific
    // notification identified by all three components from Action Center.
    let result = ToastNotificationManager::History().and_then(|history: ToastNotificationHistory| {
        history.RemoveGroupedTagWithId(
            &HSTRING::from(tag.as_str()),
            &HSTRING::from(group.as_str()),
            &HSTRING::from(aumid),
        )
    });

    match result {
        Ok(_)  => { id_map.remove(id); }
        Err(e) => {
            tx.send(evt_warn(&format!(
                "dismiss failed for id '{}': {}",
                id, e
            )))
            .ok();
        }
    }
}

// ─── get_delivered ────────────────────────────────────────────────────────────

fn get_delivered(aumid: &str, tx: &mpsc::Sender<String>) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    // NOTE: WinRT ToastNotificationHistory does not expose the original
    // delivery timestamp. `delivered_at` is set to the moment getDelivered()
    // was called. This is documented in the README and index.d.ts.
    let notifications = ToastNotificationManager::History()
        .and_then(|h: ToastNotificationHistory| h.GetHistoryWithId(&HSTRING::from(aumid)))
        .map(|list| {
            let mut result: Vec<DeliveredNotification> = Vec::new();
            let mut skipped = 0usize;

            for item in &list {
                // We correlate via tag. Notifications shown without windows.tag
                // cannot be identified — skip them and report the count.
                let tag = item.Tag()
                    .map(|s| s.to_string())
                    .unwrap_or_default();

                if tag.is_empty() {
                    skipped += 1;
                    continue;
                }

                let title = extract_xml_text_nth(&item, "text", 0)
                    .unwrap_or_default();
                let body = extract_xml_text_nth(&item, "text", 1)
                    .filter(|s| !s.is_empty());

                result.push(DeliveredNotification {
                    id: tag,
                    title,
                    body,
                    delivered_at: now_ms,
                });
            }

            if skipped > 0 {
                tx.send(evt_warn(&format!(
                    "get_delivered: {} notification(s) skipped because they \
                     were shown without windows.tag set and cannot be \
                     identified by notifier-hook",
                    skipped
                )))
                .ok();
            }

            result
        })
        .unwrap_or_default();

    tx.send(output::evt_delivered(&notifications)).ok();
}

/// Extract the inner text of the Nth element with `tag_name` from a
/// `ToastNotification`'s XML content.
fn extract_xml_text_nth(
    toast:    &ToastNotification,
    tag_name: &str,
    nth:      u32,
) -> Option<String> {
    // ToastNotification::Content() → XmlDocument
    // GetElementsByTagName() → IXmlNodeList
    // Item(nth) returns Result<Option<IXmlNode>> for nullable WinRT ref types.
    let doc   = toast.Content().ok()?;
    let nodes = doc.GetElementsByTagName(&HSTRING::from(tag_name)).ok()?;
    let node: IXmlNode = nodes.Item(nth).ok()?;
    node.InnerText().ok().map(|s: HSTRING| s.to_string())
}

// ─── clear_delivered ──────────────────────────────────────────────────────────

fn clear_delivered(aumid: &str, tx: &mpsc::Sender<String>) {
    let result = ToastNotificationManager::History()
        .and_then(|h: ToastNotificationHistory| h.ClearWithId(&HSTRING::from(aumid)));

    if let Err(e) = result {
        tx.send(evt_warn(&format!("clear_delivered failed: {}", e)))
            .ok();
    }
}

// ─── AUMID registry registration ──────────────────────────────────────────────

/// Ensure the AUMID key exists in
/// `HKCU\Software\Classes\AppUserModelId\{app_id}`
/// with `DisplayName = display_name`.
///
/// `RegCreateKeyExW` with `REG_OPTION_NON_VOLATILE` opens the existing key
/// if it already exists, so repeated daemon launches do not rewrite the value.
///
/// If the registry write fails (rare — permission edge case or locked hive)
/// we continue silently. Notifications will still be delivered; only the
/// Action Center attribution text may be wrong.
fn ensure_aumid_registered(app_id: &str, display_name: &str) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    /// Encode a &str as a null-terminated UTF-16 Vec<u16>.
    fn to_wide_nul(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0u16))
            .collect()
    }

    let key_path = format!(
        "Software\\Classes\\AppUserModelId\\{}",
        app_id
    );

    let key_path_w      = to_wide_nul(&key_path);
    let value_name_w    = to_wide_nul("DisplayName");
    let display_name_w  = to_wide_nul(display_name);

    unsafe {
        let mut hkey        = std::mem::zeroed();
        let mut disposition = REG_CREATE_KEY_DISPOSITION::default();

        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            windows::core::PCWSTR(key_path_w.as_ptr()),
            0,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            Some(&mut disposition),
        );

        if rc.is_ok() {
            // Write DisplayName as REG_SZ (null-terminated UTF-16 byte slice).
            let byte_len = display_name_w.len() * std::mem::size_of::<u16>();
            let byte_ptr = display_name_w.as_ptr() as *const u8;
            let byte_slice = std::slice::from_raw_parts(byte_ptr, byte_len);

            let _ = RegSetValueExW(
                hkey,
                windows::core::PCWSTR(value_name_w.as_ptr()),
                0,
                REG_SZ,
                Some(byte_slice),
            );

            let _ = RegCloseKey(hkey);
        }
        // Registry failure is non-fatal — see doc comment above.
    }
}

// ─── init reader ──────────────────────────────────────────────────────────────

/// Block on stdin until we receive and successfully parse the mandatory `init`
/// command. Any non-init or unparseable lines received before init are
/// discarded with a message to stderr (stdout-writer not yet started).
///
/// If stdin closes before an init command arrives, returns a default
/// `InitCommand` so the daemon can exit cleanly rather than panicking.
fn read_init_from_stdin() -> InitCommand {
    for line in std::io::stdin().lock().lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(trimmed) {
            Ok(Command::Init(init)) => return init,
            Ok(other) => {
                eprintln!(
                    "notifier-hook: expected init, got {:?} — discarding",
                    other
                );
            }
            Err(e) => {
                eprintln!(
                    "notifier-hook: failed to parse pre-init command: {} — raw: {}",
                    e, trimmed
                );
            }
        }
    }

    // stdin closed before init arrived — return defaults.
    InitCommand {
        app_name:       None,
        windows_app_id: None,
    }
}