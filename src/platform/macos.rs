//! platform/macos.rs — macOS UNUserNotificationCenter implementation.
//!
//! ## Threading model (CRITICAL — do not change without reading this)
//!
//!   Main thread   → NSApplication::sharedApplication().run()
//!                   Owns the CFRunLoop.
//!                   UNUserNotificationCenter DELEGATE CALLBACKS fire here.
//!                   This is the ONLY reason NSApp.run() must be called.
//!                   The main thread is not used for sending — only receiving.
//!
//!   Thread 2      → stdin reader (std::thread::spawn).
//!                   Calls UNUserNotificationCenter API directly.
//!                   UNUserNotificationCenter is thread-safe per Apple docs.
//!                   NO dispatch_async to main queue is needed for the send path.
//!
//!   Thread 3      → stdout-writer (mpsc::Receiver loop).
//!                   Sole writer to stdout. Receives serialised JSON events
//!                   from both the main thread (delegate callbacks) and
//!                   Thread 2 (shown/failed/warn from completion handlers).
//!
//! ## Permission flow
//!
//!   `ready` is NOT emitted until `requestAuthorizationWithOptions` completion
//!   handler fires. This may be immediate (permission already resolved) or take
//!   30+ seconds (user reading the system dialog). `start()` in JS awaits the
//!   `ready` event, so it correctly waits for the real system answer.
//!
//! ## Completion handler discipline (CRITICAL)
//!
//!   EVERY call to `didReceiveNotificationResponse:withCompletionHandler:` MUST
//!   call the completion handler exactly once before returning. If it is not
//!   called, macOS silently stops delivering ALL future notification delegate
//!   callbacks — no error, no warning, permanent silence. See delegate impl.
//!
//! ## will_present and sound
//!
//!   `userNotificationCenter:willPresentNotification:withCompletionHandler:`
//!   fires when a notification arrives while the app is in the foreground.
//!   Because this daemon runs under NSApplicationActivationPolicy::Accessory
//!   (no Dock icon, no menu bar), it is almost never "in the foreground" in
//!   the UNUserNotifications sense. The handler is implemented for correctness
//!   but will rarely fire in practice.
//!
//!   The presentation options in will_present do NOT override the caller's
//!   `sound: false` or `macos.sound_name: null` preferences — those control
//!   the UNNotificationSound set on the content object, which takes precedence
//!   over the presentation options at the OS level when the content has no sound.

#![cfg(target_os = "macos")]

use std::collections::HashSet;
use std::io::BufRead;
use std::sync::{mpsc, Arc, Mutex};

use block2::StackBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{
    declare_class, msg_send_id, mutability, ClassType, DeclaredClass,
};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSError, NSNumber, NSSet, NSString, NSURL,
};
use objc2_user_notifications::{
    UNAuthorizationOptions,
    UNMutableNotificationContent,
    UNNotificationAction,
    UNNotificationActionOptions,
    UNNotificationAttachment,
    UNNotificationCategory,
    UNNotificationCategoryOptions,
    UNNotificationInterruptionLevel,
    UNNotificationPresentationOptions,
    UNNotificationRequest,
    UNNotificationResponse,
    UNNotificationSound,
    UNTextInputNotificationAction,
    UNTextInputNotificationResponse,
    UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

use crate::ipc::{
    ActionDefinition, Capabilities, CategoryDefinition, Command, DeliveredNotification,
    InitCommand, ShowCommand, REASON_DEFAULT_ACTION, REASON_USER_DISMISSED,
};
use crate::output::{
    evt_delivered, evt_failed, evt_ready, evt_shown, evt_warn,
    evt_action, evt_dismissed, evt_reply, spawn_stdout_writer,
};

// ─── Delegate ivars ───────────────────────────────────────────────────────────

/// State owned by the Objective-C delegate object.
/// Allocated once at startup; never mutated after creation.
pub struct DelegateIvars {
    tx: mpsc::Sender<String>,
}

// ─── Delegate class declaration ───────────────────────────────────────────────

declare_class!(
    struct NotificationDelegate;

    unsafe impl ClassType for NotificationDelegate {
        type Super      = objc2::runtime::NSObject;
        type Mutability = mutability::MainThreadOnly;
        const NAME: &'static str = "NotifierHookDelegate";
    }

    impl DeclaredClass for NotificationDelegate {
        type Ivars = DelegateIvars;
    }

    /// UNUserNotificationCenterDelegate protocol implementation.
    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {

        /// Called when a notification is delivered while the app is in the
        /// foreground. We present banner + sound + badge so foreground
        /// delivery is visible even for accessory-policy daemons.
        ///
        /// Note: the sound and badge options here are advisory — they do NOT
        /// override `sound: false` set on the notification content object.
        #[method(userNotificationCenter:willPresentNotification:withCompletionHandler:)]
        fn will_present(
            &self,
            _center:       &UNUserNotificationCenter,
            _notification: &objc2_user_notifications::UNNotification,
            completion:    &block2::Block<
                dyn Fn(UNNotificationPresentationOptions)
            >,
        ) {
            completion.call((
                UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::Sound
                    | UNNotificationPresentationOptions::Badge,
            ));
        }

        /// Called when the user interacts with a delivered notification.
        ///
        /// ⚠️  MANDATORY: `completion()` MUST be called exactly once.
        ///    If it is not called, macOS permanently silences all future
        ///    delegate callbacks with no error, no log, no recovery path.
        #[method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:)]
        fn did_receive_response(
            &self,
            _center:    &UNUserNotificationCenter,
            response:   &UNNotificationResponse,
            completion: &block2::Block<dyn Fn()>,
        ) {
            let id = unsafe {
                response
                    .notification()
                    .request()
                    .identifier()
                    .to_string()
            };

            let action_id = unsafe {
                response.actionIdentifier().to_string()
            };

            let event = match action_id.as_str() {
                // User clicked the notification body (not any button).
                "com.apple.UNNotificationDefaultActionIdentifier" => {
                    evt_dismissed(&id, REASON_DEFAULT_ACTION)
                }
                // User swiped / explicitly dismissed without acting.
                // Only fires when category has `custom_dismiss_action` option.
                "com.apple.UNNotificationDismissActionIdentifier" => {
                    evt_dismissed(&id, REASON_USER_DISMISSED)
                }
                _ => {
                    // Attempt downcast to text-input response first.
                    // UNTextInputNotificationResponse is a subclass of
                    // UNNotificationResponse — downcast_ref is safe here.
                    let text_response = unsafe {
                        response.downcast_ref::<UNTextInputNotificationResponse>()
                    };
                    if let Some(tr) = text_response {
                        let text = unsafe { tr.userText().to_string() };
                        evt_reply(&id, &action_id, &text)
                    } else {
                        evt_action(&id, &action_id)
                    }
                }
            };

            self.ivars().tx.send(event).ok();

            // ── MANDATORY completion call ──────────────────────────────────
            // Failure to call this exactly once permanently disables all
            // future notification callbacks for this process lifetime.
            completion.call(());
        }
    }
);

impl NotificationDelegate {
    fn new(tx: mpsc::Sender<String>, mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<NotificationDelegate>();
        let this = this.set_ivars(DelegateIvars { tx });
        unsafe { msg_send_id![super(this), init] }
    }
}

// ─── Public entry point ────────────────────────────────────────────────────────

pub fn run() {
    // ── Step 1: MPSC + stdout-writer ──────────────────────────────────────────
    // Start the writer first — the authorisation completion handler (step 4)
    // sends the `ready` event through it.
    let (tx, rx) = mpsc::channel::<String>();
    spawn_stdout_writer(rx);

    // Main thread marker — required by objc2 for MainThreadOnly types.
    // SAFETY: `run()` is called from `main()` which is the main thread.
    let mtm = unsafe { MainThreadMarker::new_unchecked() };

    // ── Step 2: NSApplication — Accessory policy ──────────────────────────────
    // Accessory: no Dock icon, no menu bar entry. The daemon runs headlessly.
    // NSApp.run() (step 6) starts the CFRunLoop that drives delegate callbacks.
    let app = NSApplication::sharedApplication(mtm);
    unsafe {
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    }

    // ── Step 3: UNUserNotificationCenter + delegate ───────────────────────────
    let center   = unsafe { UNUserNotificationCenter::currentNotificationCenter() };
    let delegate = NotificationDelegate::new(tx.clone(), mtm);
    unsafe {
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }

    // ── Step 4: Request authorisation ────────────────────────────────────────
    // `ready` is NOT emitted until this completion handler fires.
    // May take 0 ms (permission already resolved) or 30+ seconds (dialog).
    {
        let tx_ready = tx.clone();
        let options  = UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge;

        let handler = StackBlock::new(
            move |granted: bool, error: *mut NSError| {
                let permission = if !error.is_null() {
                    // System error during authorisation — treat as not_determined
                    // rather than crashing; the caller can inspect and retry.
                    "not_determined"
                } else if granted {
                    "granted"
                } else {
                    "denied"
                };
                tx_ready
                    .send(evt_ready(permission, &Capabilities::macos()))
                    .ok();
            },
        );

        unsafe {
            center.requestAuthorizationWithOptions_completionHandler(
                options,
                &handler.copy(),
            );
        }
    }

    // ── Step 5: Stdin reader on a background thread ───────────────────────────
    // UNUserNotificationCenter API (addNotificationRequest, setCategories, etc.)
    // is thread-safe per Apple documentation. NO dispatch_async to the main
    // queue is needed for the send path. The main thread must remain free for
    // NSApp.run() so CFRunLoop-driven delegate callbacks fire correctly.
    {
        let tx_stdin   = tx.clone();
        let center_bg  = center.clone();
        let registered: Arc<Mutex<HashSet<String>>> =
            Arc::new(Mutex::new(HashSet::new()));

        std::thread::Builder::new()
            .name("notifier-hook-stdin".into())
            .spawn(move || {
                stdin_loop(tx_stdin, center_bg, registered);
            })
            .expect("notifier-hook: failed to spawn stdin thread");
    }

    // ── Step 6: NSApp run loop — blocks main thread ───────────────────────────
    // CFRunLoop active = delegate callbacks fire. This never returns.
    unsafe { app.run() };
}

// ─── stdin reader loop ─────────────────────────────────────────────────────────

fn stdin_loop(
    tx:         mpsc::Sender<String>,
    center:     Retained<UNUserNotificationCenter>,
    registered: Arc<Mutex<HashSet<String>>>,
) {
    for line in std::io::stdin().lock().lines().flatten() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(trimmed) {
            Ok(cmd) => handle_command(cmd, &center, &tx, &registered),
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
    cmd:        Command,
    center:     &UNUserNotificationCenter,
    tx:         &mpsc::Sender<String>,
    registered: &Arc<Mutex<HashSet<String>>>,
) {
    match cmd {
        Command::Show(c) | Command::Update(c) => {
            show(c, center, tx, registered);
        }
        Command::Dismiss(c) => {
            dismiss(&c.id, center);
        }
        Command::RegisterCategories(c) => {
            register_categories(c.categories, center, registered, tx);
        }
        Command::GetDelivered => {
            get_delivered(center, tx);
        }
        Command::ClearDelivered => {
            clear_delivered(center);
        }
        Command::Quit => {
            std::process::exit(0);
        }
        Command::Init(_) => {
            tx.send(evt_warn("unexpected second init command — ignored"))
                .ok();
        }
    }
}

// ─── show / update ────────────────────────────────────────────────────────────

fn show(
    cmd:        ShowCommand,
    center:     &UNUserNotificationCenter,
    tx:         &mpsc::Sender<String>,
    registered: &Arc<Mutex<HashSet<String>>>,
) {
    let content = unsafe { UNMutableNotificationContent::new() };

    // ── Baseline fields ───────────────────────────────────────────────────────
    unsafe {
        content.setTitle(&NSString::from_str(&cmd.title));

        if let Some(body) = &cmd.body {
            content.setBody(&NSString::from_str(body));
        }

        // Baseline sound: true / absent = default system sound.
        // This may be overridden below by macos.sound_name.
        match cmd.sound {
            Some(false) => content.setSound(None),
            _           => content.setSound(Some(&UNNotificationSound::defaultSound())),
        }
    }

    // ── macOS escape hatch ────────────────────────────────────────────────────
    if let Some(m) = &cmd.macos {
        unsafe {
            if let Some(s) = &m.subtitle {
                content.setSubtitle(&NSString::from_str(s));
            }

            if let Some(t) = &m.thread_identifier {
                content.setThreadIdentifier(&NSString::from_str(t));
            }

            if let Some(cat) = &m.category_identifier {
                // Warn if category not yet registered — show proceeds without
                // action buttons rather than failing entirely.
                if !registered.lock().unwrap().contains(cat.as_str()) {
                    tx.send(evt_warn(&format!(
                        "category '{}' not registered via registerCategories() \
                         — notification will show without action buttons. \
                         Call registerCategories() before show().",
                        cat
                    )))
                    .ok();
                }
                content.setCategoryIdentifier(&NSString::from_str(cat));
            }

            if let Some(r) = m.relevance_score {
                content.setRelevanceScore(r);
            }

            if let Some(b) = m.badge {
                content.setBadgeCount(Some(&NSNumber::new_u32(b)));
            }

            if let Some(level) = &m.interruption_level {
                let lvl = match level.as_str() {
                    "passive"       => UNNotificationInterruptionLevel::Passive,
                    "timeSensitive" => UNNotificationInterruptionLevel::TimeSensitive,
                    "critical"      => UNNotificationInterruptionLevel::Critical,
                    _               => UNNotificationInterruptionLevel::Active,
                };
                content.setInterruptionLevel(lvl);
            }

            // sound_name overrides the baseline sound set above.
            match &m.sound_name {
                Some(None) => {
                    // explicit null → silent
                    content.setSound(None);
                }
                Some(Some(sn)) => {
                    let sound = if sn == "default" {
                        UNNotificationSound::defaultSound()
                    } else {
                        UNNotificationSound::soundNamed(&NSString::from_str(sn))
                    };
                    content.setSound(Some(&sound));
                }
                None => {
                    // field absent → baseline sound: true/false already set above, leave it
                }
            }

            // Attachments — invalid paths are skipped with warn, not fatal.
            for path in m.attachments.iter().flatten() {
                let url = NSURL::fileURLWithPath(&NSString::from_str(path));
                match UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(
                    &NSString::from_str(path),
                    &url,
                    None,
                ) {
                    Ok(att) => {
                        // NSArray is immutable — rebuild with the new element.
                        let existing = content.attachments();
                        let mut vec: Vec<Retained<UNNotificationAttachment>> =
                            existing.iter().map(|a| a.retain()).collect();
                        vec.push(att);
                        let arr = NSArray::from_retained_slice(&vec);
                        content.setAttachments(&arr);
                    }
                    Err(e) => {
                        tx.send(evt_warn(&format!(
                            "attachment '{}' failed to load: {} — skipped",
                            path, e
                        )))
                        .ok();
                    }
                }
            }
        }
    }

    // nil trigger = deliver immediately.
    let request = unsafe {
        UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&cmd.id),
            &content,
            None,
        )
    };

    // addNotificationRequest completion handler fires on an internal
    // UNUserNotificationCenter queue. Thread-safe to send into mpsc from here.
    let tx2 = tx.clone();
    let id2 = cmd.id.clone();
    let handler = StackBlock::new(move |error: *mut NSError| {
        if error.is_null() {
            tx2.send(evt_shown(&id2)).ok();
        } else {
            let msg = unsafe {
                (*error).localizedDescription().to_string()
            };
            tx2.send(evt_failed(&id2, &msg)).ok();
        }
    });

    unsafe {
        center.addNotificationRequest_withCompletionHandler(
            &request,
            Some(&handler.copy()),
        );
    }
}

// ─── dismiss ──────────────────────────────────────────────────────────────────

fn dismiss(id: &str, center: &UNUserNotificationCenter) {
    // Remove both delivered and pending (not-yet-delivered) requests with
    // this identifier. Covering both cases costs nothing extra.
    unsafe {
        let ids = NSArray::from_slice(&[NSString::from_str(id)]);
        center.removeDeliveredNotificationsWithIdentifiers(&ids);
        center.removePendingNotificationRequestsWithIdentifiers(&ids);
    }
}

// ─── register_categories ──────────────────────────────────────────────────────

fn register_categories(
    categories: Vec<CategoryDefinition>,
    center:     &UNUserNotificationCenter,
    registered: &Arc<Mutex<HashSet<String>>>,
    tx:         &mpsc::Sender<String>,
) {
    let mut cat_objects: Vec<Retained<UNNotificationCategory>> = Vec::new();
    let mut reg = registered.lock().unwrap();

    for cat_def in &categories {
        let actions  = build_actions(&cat_def.actions, tx);
        let action_arr = NSArray::from_retained_slice(&actions);
        let options  = build_category_options(cat_def.options.as_deref());

        let category = unsafe {
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(&cat_def.id),
                &action_arr,
                &NSArray::new(),   // intentIdentifiers — not used
                options,
            )
        };

        cat_objects.push(category);
        reg.insert(cat_def.id.clone());
    }

    let set = unsafe { NSSet::from_retained_slice(&cat_objects) };
    unsafe { center.setNotificationCategories(&set) };
}

fn build_actions(
    defs: &[ActionDefinition],
    tx:   &mpsc::Sender<String>,
) -> Vec<Retained<UNNotificationAction>> {
    let mut actions: Vec<Retained<UNNotificationAction>> = Vec::new();

    for def in defs {
        let action_id = NSString::from_str(&def.id);
        let title     = NSString::from_str(&def.title);

        let mut opts = UNNotificationActionOptions::empty();
        if def.destructive == Some(true) {
            opts |= UNNotificationActionOptions::Destructive;
        }
        if def.authentication_required == Some(true) {
            opts |= UNNotificationActionOptions::AuthenticationRequired;
        }
        // Foreground is intentionally NOT applied by default.
        // This daemon runs under NSApplicationActivationPolicy::Accessory
        // (no Dock icon, no menu bar). Applying Foreground unconditionally
        // would bring an invisible daemon to the front, producing a ghost
        // window / unwanted focus steal.
        // Only set when the caller explicitly opts in via foreground: true.
        if def.foreground == Some(true) {
            opts |= UNNotificationActionOptions::Foreground;
        }

        let action: Retained<UNNotificationAction> =
            if def.action_type.as_deref() == Some("text_input") {
                let placeholder = NSString::from_str(
                    def.placeholder.as_deref().unwrap_or(""),
                );
                let btn_title = NSString::from_str(
                    def.button_title.as_deref().unwrap_or("Send"),
                );
                unsafe {
                    let text_action =
                        UNTextInputNotificationAction::actionWithIdentifier_title_options_textInputButtonTitle_textInputPlaceholder(
                            &action_id,
                            &title,
                            opts,
                            &btn_title,
                            &placeholder,
                        );
                    // UNTextInputNotificationAction is a subclass of
                    // UNNotificationAction. into_super() is the correct
                    // safe upcast in objc2.
                    Retained::into_super(text_action)
                }
            } else {
                unsafe {
                    UNNotificationAction::actionWithIdentifier_title_options(
                        &action_id,
                        &title,
                        opts,
                    )
                }
            };

        actions.push(action);
    }

    // Emit a warn (non-fatal) if no actions were produced for a definition
    // that had entries — indicates every entry had an unrecognised type.
    if actions.is_empty() && !defs.is_empty() {
        tx.send(evt_warn(
            "register_categories: all action definitions produced no actions — \
             check that action type is 'button' or 'text_input'"
        ))
        .ok();
    }

    actions
}

fn build_category_options(options: Option<&[String]>) -> UNNotificationCategoryOptions {
    let mut opts = UNNotificationCategoryOptions::empty();
    let Some(list) = options else { return opts };

    for opt in list {
        match opt.as_str() {
            "custom_dismiss_action" =>
                opts |= UNNotificationCategoryOptions::CustomDismissAction,
            "allow_in_car_play" =>
                opts |= UNNotificationCategoryOptions::AllowInCarPlay,
            "hidden_previews_show_title" =>
                opts |= UNNotificationCategoryOptions::HiddenPreviewsShowTitle,
            "hidden_previews_show_subtitle_body" =>
                opts |= UNNotificationCategoryOptions::HiddenPreviewsShowSubtitle,
            _ => {
                // Unknown option string — silently ignore for forward compat.
                // Future macOS versions may add new options; we should not
                // error on strings we don't yet recognise.
            }
        }
    }
    opts
}

// ─── get_delivered ────────────────────────────────────────────────────────────

fn get_delivered(center: &UNUserNotificationCenter, tx: &mpsc::Sender<String>) {
    let tx2 = tx.clone();
    let handler = StackBlock::new(
        move |raw: *mut NSArray<objc2_user_notifications::UNNotification>| {
            let mut result: Vec<DeliveredNotification> = Vec::new();

            if !raw.is_null() {
                let arr = unsafe { &*raw };

                for notif in arr {
                    let request = unsafe { notif.request() };
                    let content = unsafe { request.content() };

                    let id = unsafe { request.identifier().to_string() };
                    let title = unsafe { content.title().to_string() };
                    let body = {
                        let b = unsafe { content.body().to_string() };
                        if b.is_empty() { None } else { Some(b) }
                    };

                    // UNNotification.date is the delivery timestamp.
                    // timeIntervalSince1970 returns seconds as f64.
                    let delivered_at = unsafe {
                        use objc2_foundation::NSDate;
                        let date: Retained<NSDate> = notif.date();
                        (date.timeIntervalSince1970() * 1000.0) as u64
                    };

                    result.push(DeliveredNotification {
                        id,
                        title,
                        body,
                        delivered_at,
                    });
                }
            }

            tx2.send(evt_delivered(&result)).ok();
        },
    );

    unsafe {
        center.getDeliveredNotificationsWithCompletionHandler(&handler.copy());
    }
}

// ─── clear_delivered ──────────────────────────────────────────────────────────

fn clear_delivered(center: &UNUserNotificationCenter) {
    unsafe { center.removeAllDeliveredNotifications() };
}
