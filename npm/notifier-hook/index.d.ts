/**
 * notifier-hook — enterprise-grade native notifications for Bun and Node.js.
 *
 * One API. Every OS. No build step. No compromises.
 *
 * @module notifier-hook
 */

import { EventEmitter } from 'events';

// ═══════════════════════════════════════════════════════════════════════════════
// Platform escape hatch — Windows
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Windows-specific notification options.
 *
 * Every field maps directly to a native WinRT API call — no transformation,
 * no normalisation, no least-common-denominator abstraction.
 *
 * All fields are optional. Omitting `windows` entirely uses the baseline
 * cross-platform fields (`title`, `body`, `icon`, `sound`).
 */
export interface WindowsOptions {
    /**
     * Raw Toast XML payload.
     *
     * **When this field is present, ALL baseline fields (`title`, `body`,
     * `icon`, `sound`) are ENTIRELY IGNORED.** The string is loaded verbatim
     * via `XmlDocument::LoadXml()` and passed directly to `ToastNotification`.
     *
     * The full Toast schema supports: progress bars, hero images, inline reply
     * text inputs, adaptive content, scenario modes, custom audio, app logo
     * override, attribution text, header grouping, and more.
     *
     * @see https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/adaptive-interactive-toasts
     * @see https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/toast-schema
     */
    xml?: string;

    /**
     * Toast tag — required alongside `group` for `update()` and `dismiss()`.
     *
     * The daemon stores `notification_id → (tag, group)` for later correlation.
     * Without `tag` + `group`, `update()` emits `'failed'` and `dismiss()`
     * emits `'warn'` and silently does nothing.
     *
     * Must be paired with `group`. Together they uniquely identify a
     * notification within your app's Action Center entries.
     */
    tag?: string;

    /**
     * Toast group — required alongside `tag` for `update()` and `dismiss()`.
     * Pairs with `tag` to form a unique notification identity in Action Center.
     */
    group?: string;

    /**
     * Toast scenario. Controls on-screen persistence and UI chrome.
     *
     * - `'default'`       Standard auto-dismiss behaviour (default).
     * - `'alarm'`         Stays on screen until user acts; shows snooze/dismiss buttons.
     * - `'reminder'`      Stays on screen until user acts.
     * - `'incomingCall'`  Full-screen incoming call UI with answer/decline.
     *
     * When using raw `xml`, set `scenario` as an attribute on the `<toast>`
     * element directly — this field is ignored when `xml` is present.
     */
    scenario?: 'default' | 'alarm' | 'reminder' | 'incomingCall';

    /**
     * Auto-remove the notification from Action Center after this many
     * milliseconds. Computed as an absolute expiration time from the moment
     * `show()` is called.
     *
     * Absent or `0` = OS default retention policy applies.
     */
    expiration_ms?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Platform escape hatch — macOS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * macOS-specific notification options.
 *
 * Every field maps 1:1 to `UNMutableNotificationContent` properties or
 * `UNNotificationRequest` configuration.
 *
 * All fields are optional. Omitting `macos` entirely uses the baseline
 * cross-platform fields (`title`, `body`, `icon`, `sound`).
 */
export interface MacOSOptions {
    /**
     * Secondary line shown between the title and body in the notification
     * banner. macOS-only UI element — no equivalent on other platforms.
     */
    subtitle?: string;

    /**
     * Groups notifications from the same logical conversation or thread in
     * Notification Center. Multiple notifications with the same
     * `thread_identifier` are shown as a collapsible stack.
     */
    thread_identifier?: string;

    /**
     * Controls Do Not Disturb / Focus mode penetration.
     *
     * - `'passive'`        Delivered quietly: no sound, no banner, no screen wake.
     *                      Appears only in Notification Center.
     * - `'active'`         Default: plays sound, shows banner, wakes screen.
     * - `'timeSensitive'`  Breaks through most Focus modes (Time Sensitive category).
     * - `'critical'`       Breaks through ALL Focus modes including Do Not Disturb.
     *                      Requires the `com.apple.developer.usernotifications.critical-alerts`
     *                      entitlement from Apple.
     */
    interruption_level?: 'passive' | 'active' | 'timeSensitive' | 'critical';

    /**
     * References a category registered via `registerCategories()`.
     *
     * **Must be registered BEFORE calling `show()`.** If the category is not
     * registered, the notification displays without action buttons and a
     * `'warn'` event fires. The `show()` call itself never rejects due to an
     * unregistered category.
     */
    category_identifier?: string;

    /**
     * Relevance score for notification summary ordering.
     *
     * Range: `0.0` (least relevant) to `1.0` (most relevant).
     * macOS uses this value to rank notifications when grouping into summaries.
     * Higher scores receive more prominent placement.
     */
    relevance_score?: number;

    /**
     * Absolute file paths to attach as rich media previews in the notification.
     *
     * Supported types: JPEG, PNG, GIF, HEIC, HEIF, MPEG4, MP3, M4V, MP4.
     *
     * Invalid paths are skipped individually with a `'warn'` event — they do
     * not cause the entire `show()` call to fail.
     */
    attachments?: string[];

    /**
     * Set the app badge count on the app icon in the Dock.
     * Pass `0` to clear the badge.
     */
    badge?: number;

    /**
     * Notification sound override.
     *
     * - `'default'`   System default notification sound.
     * - `null`        Silent notification (no sound).
     * - any string    `UNNotificationSoundName` (custom sound in app bundle).
     *
     * When present, this takes precedence over the baseline `sound` field.
     */
    sound_name?: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Platform escape hatch — Linux
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Well-known `org.freedesktop.Notifications` hint keys with typed values.
 *
 * All values must be JSON scalars (boolean, string, or number).
 * Unsupported value types (arrays, objects, null) are skipped with a `'warn'`.
 *
 * @see https://specifications.freedesktop.org/notification-spec/latest/hints.html
 */
export interface LinuxHints {
    /**
     * Notification category string.
     * @see https://specifications.freedesktop.org/notification-spec/latest/categories.html
     */
    category?: string;

    /**
     * Name of the `.desktop` file for the sending application, without the
     * `.desktop` extension. Used by the notification server for icon lookup
     * and application identification.
     */
    'desktop-entry'?: string;

    /**
     * Absolute path or `file://` URI to an image to display in the notification.
     * Takes precedence over the icon parameter passed to `Notify`.
     * Also populated automatically from the baseline `icon` field when not set.
     */
    'image-path'?: string;

    /**
     * When `true`, the notification stays resident in the notification area
     * after being activated. Only removed via an explicit `CloseNotification`
     * call. Behaviour is notification server dependent.
     */
    resident?: boolean;

    /**
     * When `true`, the notification is transient — bypasses the notification
     * server's persistence capability (not stored in notification history).
     */
    transient?: boolean;

    /**
     * Absolute path to a sound file (`.oga` or `.wav`) to play when the
     * notification is displayed. Overrides the server's default sound.
     */
    'sound-file'?: string;

    /**
     * When `true`, suppress notification sounds from the server for this
     * notification regardless of server defaults.
     */
    'suppress-sound'?: boolean;

    /** Desired screen x-coordinate hint for notification placement. */
    x?: number;

    /** Desired screen y-coordinate hint for notification placement. */
    y?: number;

    /**
     * Additional arbitrary hint keys.
     * Values must be JSON scalars: `boolean`, `string`, or `number`.
     * Other value types are skipped with a `'warn'` event.
     */
    [key: string]: boolean | string | number | undefined;
}

/** A single action button in a Linux notification. */
export interface LinuxAction {
    /**
     * Action identifier string.
     * Returned verbatim as `actionId` in the `'action'` event.
     */
    id: string;

    /** Human-readable button label shown in the notification. */
    label: string;
}

/**
 * Linux-specific notification options.
 *
 * Maps directly to `org.freedesktop.Notifications` `Notify` D-Bus method
 * parameters and the hints dictionary.
 *
 * All fields are optional. Omitting `linux` entirely uses the baseline
 * cross-platform fields (`title`, `body`, `icon`, `sound`).
 */
export interface LinuxOptions {
    /**
     * Urgency level passed as D-Bus `byte` hint `"urgency"`.
     *
     * - `0`  Low      — quiet, non-intrusive.
     * - `1`  Normal   — default.
     * - `2`  Critical — typically ignores `timeout`, requires explicit dismiss.
     *
     * Behaviour at each urgency level is notification server dependent.
     */
    urgency?: 0 | 1 | 2;

    /**
     * Display timeout in milliseconds, passed as `expire_timeout` to `Notify`.
     *
     * - `-1`  Server decides (default).
     * - `0`   Never expires automatically.
     * - `>0`  Auto-dismiss after N milliseconds.
     */
    timeout?: number;

    /**
     * Arbitrary D-Bus hints dictionary.
     * Values must be JSON scalars: `boolean`, `string`, or `number`.
     * Unsupported value types are skipped with a `'warn'` event.
     */
    hints?: LinuxHints;

    /**
     * Action buttons to display on the notification.
     *
     * **Always gate this on `notifier.capabilities.actions === true`.**
     * Not all notification servers support action buttons even on Linux.
     * `dunst`, KDE Plasma, and XFCE are fully reliable. GNOME Shell may be
     * unreliable — see known limitations in the README.
     */
    actions?: LinuxAction[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Notification options
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Options for `show()` and `update()`.
 *
 * The `title` field is the only required field. All platform escape hatch
 * fields (`windows`, `macos`, `linux`) are silently ignored on platforms where
 * they do not apply.
 */
export interface NotificationOptions {
    /**
     * UUID v4 string identifying this notification.
     *
     * Auto-generated via `crypto.randomUUID()` if omitted. Pass explicitly to:
     *   - Correlate `'action'`, `'reply'`, `'dismissed'` events to a specific show().
     *   - Use `update()` or `dismiss()` later (requires the same id).
     */
    id?: string;

    /**
     * Notification title. Required.
     *
     * Ignored on Windows when `windows.xml` is present.
     */
    title: string;

    /**
     * Notification body text.
     *
     * Ignored on Windows when `windows.xml` is present.
     */
    body?: string;

    /**
     * Absolute path to an icon image (PNG recommended for cross-platform use).
     *
     * Ignored on Windows when `windows.xml` is present.
     * On Linux, also automatically sets the `image-path` hint if not already
     * provided in `linux.hints`.
     */
    icon?: string;

    /**
     * Play the default system notification sound.
     *
     * - `true`   Play default sound (default when omitted).
     * - `false`  Silent notification.
     *
     * Platform overrides:
     *   - macOS:   `macos.sound_name` takes precedence when present.
     *   - Linux:   `linux.hints['sound-file']` or `linux.hints['suppress-sound']`
     *              take precedence when present.
     *   - Windows: `<audio>` element in `windows.xml` takes precedence when present.
     */
    sound?: boolean;

    /** Windows-specific options. Silently ignored on macOS and Linux. */
    windows?: WindowsOptions;

    /** macOS-specific options. Silently ignored on Windows and Linux. */
    macos?: MacOSOptions;

    /** Linux-specific options. Silently ignored on Windows and macOS. */
    linux?: LinuxOptions;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Category / action types (macOS registerCategories)
// ═══════════════════════════════════════════════════════════════════════════════

/** Definition for a single action button or text-input within a macOS category. */
export interface ActionDefinition {
    /** Unique identifier. Returned as `actionId` in `'action'` and `'reply'` events. */
    id: string;

    /** Button label text shown to the user. */
    title: string;

    /**
     * Action type.
     *
     * - `'button'`      (default) Standard tap/click action button.
     * - `'text_input'`  Inline text input — creates `UNTextInputNotificationAction`.
     *                   Triggers a `'reply'` event instead of `'action'`.
     */
    type?: 'button' | 'text_input';

    /** Placeholder text for `text_input` actions. */
    placeholder?: string;

    /**
     * Send button title for `text_input` actions.
     * Default: `"Send"`.
     */
    button_title?: string;

    /**
     * Render the action in a destructive (red) style on macOS.
     * Use for irreversible actions like "Delete" or "Remove".
     * Default: `false`.
     */
    destructive?: boolean;

    /**
     * Require device authentication (Face ID / Touch ID / passcode) before
     * invoking this action.
     * Default: `false`.
     */
    authentication_required?: boolean;

    /**
     * When `true`, tapping this action brings the application to the foreground
     * (`UNNotificationActionOptions.Foreground`).
     *
     * **Default: `false`.**
     *
     * notifier-hook runs as a headless daemon under
     * `NSApplicationActivationPolicy.Accessory` (no Dock icon, no menu bar).
     * Setting `foreground: true` on actions like "Archive", "Delete", or "Reply"
     * would bring the invisible daemon process to the front, producing an
     * unwanted ghost window or focus steal.
     *
     * Only set `true` for actions that genuinely require the app visible —
     * typically "Open" or "View".
     */
    foreground?: boolean;
}

/**
 * `UNNotificationCategoryOptions` flag string values.
 *
 * @see https://developer.apple.com/documentation/usernotifications/unnotificationcategoryoptions
 */
export type CategoryOption =
    | 'custom_dismiss_action'
    | 'allow_in_car_play'
    | 'hidden_previews_show_title'
    | 'hidden_previews_show_subtitle_body';

/**
 * A macOS notification category registered via `registerCategories()`.
 *
 * Categories define which action buttons appear on a notification. A category
 * must be registered before any `show()` call that references it via
 * `macos.category_identifier`.
 */
export interface CategoryDefinition {
    /**
     * Category identifier. Must match the value used in
     * `show({ macos: { category_identifier: '...' } })`.
     * Must be unique within the set of registered categories.
     */
    id: string;

    /** Action buttons and text inputs available in this category. */
    actions: ActionDefinition[];

    /** `UNNotificationCategoryOptions` flags to apply to this category. */
    options?: CategoryOption[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// State / event payload types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * System notification permission state.
 * Windows and Linux always return `'granted'`.
 * macOS returns the actual system authorisation result.
 */
export type Permission = 'granted' | 'denied' | 'not_determined';

/**
 * Platform notification capability flags.
 *
 * Populated from `GetCapabilities` on Linux, or synthesised from known
 * platform behaviour on Windows and macOS. Exposed on `notifier.capabilities`
 * after `start()` resolves.
 *
 * **Always gate advanced features on these flags**, especially `actions` on
 * Linux where support varies by notification server.
 */
export interface Capabilities {
    /** Server supports action buttons on notifications. */
    actions: boolean;
    /** Server renders notification body text. */
    body: boolean;
    /** Server renders hyperlinks within body text. */
    body_hyperlinks: boolean;
    /** Server renders inline images within body text. */
    body_images: boolean;
    /** Server renders markup (bold, italic) within body text. */
    body_markup: boolean;
    /** Server renders a static app icon. */
    icon_static: boolean;
    /** Server supports multiple simultaneous notification icons. */
    icon_multi: boolean;
    /** Notifications persist in the notification area after display timeout. */
    persistence: boolean;
    /** Server plays notification sounds. */
    sound: boolean;
    /** In-place update is available (`replaces_id` / `tag`+`group`). */
    update: boolean;
    /** Programmatic dismiss is available. */
    dismiss: boolean;
}

/**
 * A single notification entry returned by `getDelivered()`.
 *
 * ⚠️  **Windows:** `delivered_at` is the time `getDelivered()` was called,
 * not the original delivery time. WinRT's `ToastNotificationHistory` does not
 * expose delivery timestamps for historical entries. Record timestamps on the
 * JS side at `show()` time if precision is required on Windows.
 */
export interface DeliveredNotification {
    /** The notification id as provided to or generated by `show()`. */
    id: string;
    /** Notification title. */
    title: string;
    /** Notification body text, if any. */
    body?: string;
    /**
     * Delivery timestamp as Unix epoch milliseconds.
     * Approximate on Windows — see type-level warning above.
     */
    delivered_at: number;
}

/**
 * Reason a notification was dismissed.
 *
 * | Value              | Meaning                                                  |
 * |--------------------|----------------------------------------------------------|
 * | `'user_dismissed'` | User explicitly swiped away or clicked the close button. |
 * | `'timed_out'`      | Notification auto-expired after its timeout.             |
 * | `'app_closed'`     | Programmatic dismiss via `dismiss()`.                    |
 * | `'default_action'` | User clicked the notification body (not a button).       |
 * | `'unknown'`        | Unrecognised platform reason code.                       |
 */
export type DismissReason =
    | 'user_dismissed'
    | 'timed_out'
    | 'app_closed'
    | 'default_action'
    | 'unknown';

/** Payload of the `'ready'` event. */
export interface ReadyPayload {
    capabilities: Capabilities;
    permission: Permission;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constructor options
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Options accepted by `new Notifier()` and `createNotifier()`.
 */
export interface NotifierOptions {
    /**
     * Human-readable application name.
     *
     * - **Windows:** Used as Action Center attribution text when `windowsAppId`
     *   is not provided (PowerShell fallback). Also written as the
     *   `DisplayName` registry value when `windowsAppId` IS provided.
     * - **Linux:** Passed as the `app_name` parameter to every
     *   `org.freedesktop.Notifications` `Notify` D-Bus call.
     * - **macOS:** Informational only — the OS uses the bundle name from
     *   `Info.plist` for display.
     *
     * Default: `'notifier-hook'`
     */
    appName?: string;

    /**
     * Windows App User Model ID (AUMID).
     *
     * When provided: the daemon registers it in
     * `HKCU\Software\Classes\AppUserModelId\{windowsAppId}` on first run,
     * granting correct attribution (your app name) in Action Center instead
     * of "Windows PowerShell". A `'warn'` event fires when the fallback is
     * active (i.e. when this option is omitted).
     *
     * Format: reverse-DNS or GUID-style string, no spaces.
     * Example: `"com.yourcompany.yourapp"`
     *
     * macOS and Linux: ignored entirely.
     */
    windowsAppId?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Notifier class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Native system notification client.
 *
 * Spawns a pre-compiled Rust daemon as a child process and communicates with
 * it via newline-delimited JSON over stdin / stdout. The daemon owns all
 * platform-specific OS integration; this class is a thin `EventEmitter`
 * wrapper with a clean Promise-based API.
 *
 * ## Minimal usage
 *
 * ```typescript
 * import { createNotifier } from 'notifier-hook';
 *
 * const notifier = createNotifier({ appName: 'My App' });
 * notifier.on('error', console.error);
 * await notifier.start();
 * await notifier.show({ title: 'Hello', body: 'World' });
 * ```
 *
 * ## Events
 *
 * | Event        | Arguments                          | Description                          |
 * |--------------|------------------------------------|--------------------------------------|
 * | `'ready'`    | `ReadyPayload`                     | Daemon up, OS permission resolved.   |
 * | `'action'`   | `id, actionId`                     | User clicked an action button.       |
 * | `'reply'`    | `id, actionId, text`               | User submitted inline text input.    |
 * | `'dismissed'`| `id, reason`                       | Notification dismissed any reason.   |
 * | `'failed'`   | `id, error`                        | OS rejected show / update.           |
 * | `'delivered'`| `notifications[]`                  | Response to `getDelivered()`.        |
 * | `'warn'`     | `message`                          | Non-fatal daemon warning.            |
 * | `'exit'`     | `code, signal`                     | Daemon process exited.               |
 * | `'error'`    | `err`                              | Protocol error (malformed JSON).     |
 *
 * ⚠️  Per Node.js convention, an unhandled `'error'` event crashes the process.
 *     Always attach: `notifier.on('error', handler)`
 */
export declare class Notifier extends EventEmitter {

    /**
     * Platform capability flags. `null` before `start()` resolves.
     * Gate all advanced features on these values at runtime.
     */
    capabilities: Capabilities | null;

    /**
     * System notification permission state. `null` before `start()` resolves.
     * - Windows + Linux: always `'granted'`.
     * - macOS: actual system authorisation result — `start()` waits for it.
     */
    permission: Permission | null;

    constructor(options?: NotifierOptions);

    /**
     * Spawn the Rust daemon and wait for it to signal readiness.
     *
     * Idempotent — safe to call multiple times or concurrently. All callers
     * share the same `Promise` and the single daemon process.
     *
     * After this `Promise` resolves, `this.capabilities` and `this.permission`
     * are guaranteed to be populated.
     *
     * **macOS:** may wait 30+ seconds on first run while the system permission
     * dialog is shown to the user.
     *
     * @throws If the binary is not found, spawn fails, or the daemon exits
     *         before signalling ready.
     */
    start(): Promise<void>;

    /**
     * Display a notification.
     *
     * Resolves with the notification `id` string once the OS has accepted the
     * command.
     *
     * ⚠️  **"OS accepted" ≠ "user saw it."** The notification may still be
     * queued, rate-limited, or suppressed by Focus / Do Not Disturb.
     *
     * Rejects with the raw OS error string if the OS returns an error.
     */
    show(options: NotificationOptions): Promise<string>;

    /**
     * Replace an existing notification in-place without closing and reopening it.
     *
     * `options.id` is required and must match a previously shown notification.
     *
     * - **Windows:** requires the original `show()` to have included
     *   `windows.tag` and `windows.group`. Emits `'failed'` if they were absent.
     * - **macOS:** re-sends `addNotificationRequest` with the same identifier.
     *   The OS replaces the notification automatically.
     * - **Linux:** uses `replaces_id` D-Bus parameter. Falls back to a new
     *   notification if the id is not in the internal id_map.
     */
    update(options: NotificationOptions & { id: string }): Promise<string>;

    /**
     * Programmatically remove a displayed notification.
     *
     * Fire-and-forget — resolves immediately without waiting for a daemon ack.
     * A `'dismissed'` event with `reason: 'app_closed'` may follow
     * asynchronously on platforms that emit it.
     *
     * Windows: requires the original `show()` to have included
     * `windows.tag` + `windows.group`.
     */
    dismiss(id: string): Promise<void>;

    /**
     * Register macOS `UNNotificationCategory` objects.
     *
     * **Must be called before** any `show()` that uses `macos.category_identifier`.
     * If a `category_identifier` is used before registration, the notification
     * appears without action buttons and a `'warn'` event fires. The `show()`
     * call itself never rejects due to an unregistered category.
     *
     * Safe no-op on Windows and Linux — silently accepted, no OS calls made.
     */
    registerCategories(categories: CategoryDefinition[]): Promise<void>;

    /**
     * Request the list of currently delivered (visible) notifications.
     *
     * - Windows + macOS: resolves with an array of `DeliveredNotification`.
     * - Linux: always resolves with `[]` and emits a `'warn'` event —
     *   `org.freedesktop.Notifications` defines no history API.
     *
     * Concurrent calls are safe — responses are matched FIFO to callers.
     * Rejects if the daemon does not respond within 10 seconds.
     *
     * ⚠️  **Windows:** `delivered_at` is approximate — see `DeliveredNotification`.
     */
    getDelivered(): Promise<DeliveredNotification[]>;

    /**
     * Remove all delivered notifications.
     *
     * - Windows + macOS: clears Action Center / Notification Center entirely.
     * - Linux: calls `CloseNotification` for each tracked notification id.
     *
     * Fire-and-forget — returns `void`, not a `Promise`.
     */
    clearDelivered(): void;

    /**
     * Gracefully shut down the daemon.
     *
     * Sends the `quit` command and resolves when the daemon process exits
     * (code 0). After this `Promise` resolves do not call any further methods.
     * To restart, call `start()` again.
     *
     * For an immediate, non-graceful kill prefer `destroy()`.
     */
    quit(): Promise<void>;

    /**
     * Immediately kill the daemon process (SIGKILL) and reject all in-flight
     * Promises. Synchronous — does not wait for OS confirmation of exit.
     *
     * The `'exit'` event fires when the OS confirms the process is gone.
     * After `destroy()` you may call `start()` again to restart the daemon.
     *
     * For a graceful shutdown that allows the daemon to clean up prefer `quit()`.
     */
    destroy(): void;

    // ─── on() overloads ───────────────────────────────────────────────────────

    /** Daemon is ready. `capabilities` and `permission` are now populated. */
    on(event: 'ready',     listener: (payload: ReadyPayload) => void): this;

    /**
     * User clicked a notification action button (not the notification body).
     * For body clicks see `'dismissed'` with `reason: 'default_action'`.
     */
    on(event: 'action',    listener: (id: string, actionId: string) => void): this;

    /**
     * User submitted an inline text-input action.
     * - Windows: `<input type="text">` in Toast XML.
     * - macOS:   `UNTextInputNotificationAction`.
     */
    on(event: 'reply',     listener: (id: string, actionId: string, text: string) => void): this;

    /**
     * Notification was dismissed for any reason.
     * See `DismissReason` for all possible values.
     */
    on(event: 'dismissed', listener: (id: string, reason: DismissReason) => void): this;

    /**
     * OS rejected a `show()` or `update()` command.
     * Also rejects the corresponding `Promise`.
     */
    on(event: 'failed',    listener: (id: string, error: string) => void): this;

    /** Response payload from `getDelivered()`. */
    on(event: 'delivered', listener: (notifications: DeliveredNotification[]) => void): this;

    /**
     * Non-fatal daemon warning. Never rejects a `Promise`.
     * Attach in development for visibility into daemon decisions.
     */
    on(event: 'warn',      listener: (message: string) => void): this;

    /**
     * Daemon process exited. `code` is `null` if killed by a signal.
     *
     * ⚠️  Per Node.js convention, an unhandled `'error'` event crashes the
     * process. Always attach: `notifier.on('error', handler)`
     */
    on(event: 'exit',      listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;

    /**
     * Protocol-level error (e.g. malformed JSON received from daemon stdout).
     *
     * ⚠️  Per Node.js convention, if no `'error'` listener is attached and
     * this event fires, Node.js will throw the error and crash the process.
     */
    on(event: 'error',     listener: (err: Error) => void): this;

    /** Forward-compatible catch-all for unknown event types from future daemon versions. */
    on(event: string,      listener: (...args: unknown[]) => void): this;

    // ─── once() overloads ─────────────────────────────────────────────────────

    once(event: 'ready',     listener: (payload: ReadyPayload) => void): this;
    once(event: 'action',    listener: (id: string, actionId: string) => void): this;
    once(event: 'reply',     listener: (id: string, actionId: string, text: string) => void): this;
    once(event: 'dismissed', listener: (id: string, reason: DismissReason) => void): this;
    once(event: 'failed',    listener: (id: string, error: string) => void): this;
    once(event: 'delivered', listener: (notifications: DeliveredNotification[]) => void): this;
    once(event: 'warn',      listener: (message: string) => void): this;
    once(event: 'exit',      listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    once(event: 'error',     listener: (err: Error) => void): this;
    once(event: string,      listener: (...args: unknown[]) => void): this;

    // ─── off() overloads ──────────────────────────────────────────────────────

    off(event: 'ready',     listener: (payload: ReadyPayload) => void): this;
    off(event: 'action',    listener: (id: string, actionId: string) => void): this;
    off(event: 'reply',     listener: (id: string, actionId: string, text: string) => void): this;
    off(event: 'dismissed', listener: (id: string, reason: DismissReason) => void): this;
    off(event: 'failed',    listener: (id: string, error: string) => void): this;
    off(event: 'delivered', listener: (notifications: DeliveredNotification[]) => void): this;
    off(event: 'warn',      listener: (message: string) => void): this;
    off(event: 'exit',      listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
    off(event: 'error',     listener: (err: Error) => void): this;
    off(event: string,      listener: (...args: unknown[]) => void): this;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory function
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new `Notifier` instance. Equivalent to `new Notifier(options)`.
 *
 * @example
 * ```typescript
 * import { createNotifier } from 'notifier-hook';
 *
 * const notifier = createNotifier({ appName: 'My App' });
 * notifier.on('error', (err) => console.error(err));
 * notifier.on('warn',  (msg) => console.warn(msg));
 * await notifier.start();
 * const id = await notifier.show({ title: 'Hello', body: 'World' });
 * ```
 */
export declare function createNotifier(options?: NotifierOptions): Notifier;