# 🪝 notifier-hook

**Enterprise-grade native notifications for Bun and Node.js**

[![npm version](https://img.shields.io/npm/v/notifier-hook.svg)](https://www.npmjs.com/package/notifier-hook)
[![npm downloads](https://img.shields.io/npm/dm/notifier-hook.svg)](https://www.npmjs.com/package/notifier-hook)
[![license](https://img.shields.io/npm/l/notifier-hook.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/phtdacosta/notifier-hook?style=social)](https://github.com/phtdacosta/notifier-hook)

One API. Every OS. No build step. No compromises.

Send native system notifications from any Node.js or Bun application — with full access to every OS feature that your platform exposes. A lean Rust daemon handles the OS integration; you drive it entirely from JavaScript.

---

## Why notifier-hook?

Every other JS notification library (`node-notifier`, Electron's built-in, `@tauri-apps/plugin-notification`) hides 80% of OS capabilities behind a unified abstraction. notifier-hook hides nothing.

| Feature | notifier-hook | node-notifier | Electron built-in |
|---|---|---|---|
| Windows raw Toast XML | ✅ | ❌ | ❌ |
| Windows progress bars | ✅ | ❌ | ❌ |
| Windows inline text reply | ✅ | ❌ | ❌ |
| Windows in-place update | ✅ | ❌ | ❌ |
| macOS interruption levels | ✅ | ❌ | ❌ |
| macOS action categories | ✅ | ❌ | Partial |
| macOS text input actions | ✅ | ❌ | ❌ |
| macOS rich attachments | ✅ | ❌ | ❌ |
| Linux raw D-Bus hints | ✅ | ❌ | ❌ |
| Linux capability detection | ✅ | ❌ | ❌ |
| No native compilation | ✅ | ❌ | N/A |
| Works in Bun | ✅ | ⚠️ | ❌ |
| TypeScript typings | ✅ | Partial | ✅ |

---

## How it works

```
Your JS/TS code
      │
      │  newline-delimited JSON over stdin/stdout
      ▼
notifier-hook daemon  (pre-compiled Rust binary, ~4MB)
      │
      │  first-party OS APIs
      ▼
  Windows                  macOS                    Linux
  WinRT Toast API          UNUserNotification        org.freedesktop
  ToastNotificationManager Center + delegate         .Notifications
  COM / registry           NSApplication             D-Bus (zbus)
```

**Why Rust?** Native OS notification APIs require event loops that must own specific threads. Rust provides memory safety for the async callback architecture, tiny binary size, and direct access to first-party OS bindings.

**Why not N-API / native addons?** N-API addons break across Node/Bun version upgrades and require users to compile on install. The daemon model has zero build step for users and zero ABI compatibility concerns.

---

## Quick start

```sh
npm install notifier-hook
# or
bun add notifier-hook
```

```js
import { createNotifier } from 'notifier-hook';

const notifier = createNotifier({ appName: 'My App' });

notifier.on('error',     (err)          => console.error(err));
notifier.on('warn',      (msg)          => console.warn(msg));
notifier.on('action',    (id, actionId) => console.log('clicked:', actionId));
notifier.on('dismissed', (id, reason)   => console.log('dismissed:', reason));

await notifier.start();

await notifier.show({
    title: 'Build complete',
    body:  'Your site was generated in 420ms.',
    icon:  '/absolute/path/to/icon.png',
});
```

---

## Platform support

| Platform | Architecture | Status |
|---|---|---|
| Windows 10 / 11 | x64 | ✅ |
| Windows 10 / 11 | arm64 | ✅ |
| macOS 12+ | x64 (Intel) | ✅ |
| macOS 12+ | arm64 (Apple Silicon) | ✅ |
| Linux (glibc ≥ 2.35) | x64 | ✅ |
| Linux (glibc ≥ 2.35) | arm64 | ✅ |

> **Linux note:** Requires a running notification daemon. `dunst`, KDE Plasma, and XFCE work out of the box. GNOME users may experience unreliable action button callbacks — see [Known Limitations](#known-limitations).

---

## Installation details

The main package uses `optionalDependencies` to auto-select and install only the binary for your current platform. You never download binaries for platforms you don't use.

```sh
npm install notifier-hook          # installs only your platform's binary
bun add notifier-hook
```

To install a binary for a different platform (e.g. in CI):

```sh
npm install @phtdacosta/notifier-hook-linux-x64 --ignore-platform
```

---

## API reference

### `createNotifier(options?)` → `Notifier`

Factory function. Equivalent to `new Notifier(options)`.

```js
const notifier = createNotifier({
    appName:      'My App',           // shown in Action Center / D-Bus Notify
    windowsAppId: 'com.example.app',  // Windows only — proper AUMID attribution
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `appName` | `string` | `'notifier-hook'` | App name for Action Center (Windows) and D-Bus Notify (Linux) |
| `windowsAppId` | `string` | — | Windows AUMID. Omit → notifications attributed to "Windows PowerShell". A `'warn'` event fires when the fallback is active. |

---

### `notifier.start()` → `Promise<void>`

Spawns the daemon. Idempotent — safe to call multiple times or concurrently. All concurrent callers share the same Promise and the same daemon process.

After resolving, `notifier.capabilities` and `notifier.permission` are populated.

**Restartable:** `start()` may be called again after `quit()` or after the daemon exits unexpectedly. The internal state is reset on each exit.

**macOS:** may take 30+ seconds on first run if the system permission dialog is shown.

**Throws** if the platform binary package is not installed, if the daemon fails to spawn, or if the daemon exits before signalling ready. Always wrap in try-catch in production.

```js
try {
    await notifier.start();
} catch (err) {
    // Common causes:
    //   - '@phtdacosta/notifier-hook-{platform}-{arch}' not installed
    //   - Spawn failed (permissions, corrupt binary)
    //   - Daemon exited before emitting ready
    console.error('Failed to start:', err.message);
    process.exit(1);
}

console.log(notifier.permission);    // 'granted' | 'denied' | 'not_determined'
console.log(notifier.capabilities);  // { actions: true, body: true, … }
```

---

### `notifier.show(options)` → `Promise<string>`

Display a notification. Resolves with the notification `id` string once the OS accepts the command.

> ⚠️ **"OS accepted" ≠ "user saw it."** The notification may still be queued, rate-limited, or suppressed by Focus / Do Not Disturb / notification server policy.

```js
const id = await notifier.show({
    id:      'my-uuid-v4',      // auto-generated if omitted
    title:   'Hello',           // required
    body:    'World',
    icon:    '/path/to/icon.png',
    sound:   true,

    // Platform escape hatches — see sections below
    windows: { … },
    macos:   { … },
    linux:   { … },
});
```

---

### `notifier.update(options)` → `Promise<string>`

Replace an existing notification. `options.id` is required and must match a previously shown notification. Resolves with the same `id` that was passed in.

```js
const id = await notifier.show({ title: 'Step 1', windows: { tag: 'job', group: 'myapp' } });

await notifier.update({
    id,
    title: 'Step 2',
    windows: { tag: 'job', group: 'myapp' },
});
```

**Platform behaviour:**

- **Windows:** Re-shows the notification with the same `tag`+`group`, which replaces the Action Center entry. **The banner re-animates and sound replays on each update.** If `windows.tag` and `windows.group` are absent from the `update()` call, a second independent notification is shown instead — no error is emitted. For silent data-binding updates (e.g. progress bars that update every few hundred milliseconds) use the `<progress>` element's data-binding attributes in raw XML and update the binding source, rather than calling `update()` in a tight loop.
- **macOS:** Re-sends `addNotificationRequest` with the same identifier. The OS replaces the existing notification silently with no re-animation.
- **Linux:** Passes the stored D-Bus `uint32` as `replaces_id`. **If the id is not in the daemon's internal map (e.g. the notification was already dismissed or was shown on a previous daemon instance), a new independent notification is shown instead — no error is emitted.**

---

### `notifier.dismiss(id)` → `Promise<void>`

Programmatically remove a notification. Fire-and-forget — resolves immediately without waiting for OS confirmation.

A `'dismissed'` event with `reason: 'app_closed'` may follow asynchronously on platforms that emit it.

- **Windows:** requires original `show()` to have included `windows.tag` + `windows.group`. Emits `'warn'` and does nothing if they were absent.
- **macOS:** removes both delivered notifications and any pending (not-yet-displayed) requests with the given id.
- **Linux:** calls `CloseNotification` using the stored D-Bus uint32. Emits `'warn'` if the id is not in the internal map.

```js
await notifier.dismiss(id);
```

---

### `notifier.registerCategories(categories)` → `Promise<void>`

Register macOS action categories. **Must be called before** any `show()` that uses `macos.category_identifier`.

If a `category_identifier` is used before registration, the notification displays without action buttons and a `'warn'` event fires. The `show()` call itself never rejects due to an unregistered category.

Safe no-op on Windows and Linux — silently accepted, no OS calls made.

```js
await notifier.registerCategories([
    {
        id: 'build_complete',
        actions: [
            { id: 'open',   title: 'Open Site' },
            { id: 'deploy', title: 'Deploy Now' },
            {
                id:           'note',
                title:        'Add Note',
                type:         'text_input',
                placeholder:  'Write a note…',
                button_title: 'Save',
            },
        ],
        options: ['custom_dismiss_action'],
    },
]);
```

**`ActionDefinition` fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | `string` | — | Returned as `actionId` in `'action'` and `'reply'` events |
| `title` | `string` | — | Button label |
| `type` | `'button' \| 'text_input'` | `'button'` | `text_input` triggers a `'reply'` event instead of `'action'` |
| `placeholder` | `string` | — | Placeholder for `text_input` actions |
| `button_title` | `string` | `'Send'` | Submit button label for `text_input` actions |
| `destructive` | `boolean` | `false` | Renders button in red (destructive style) |
| `authentication_required` | `boolean` | `false` | Requires Face ID / Touch ID before invoking |
| `foreground` | `boolean` | `false` | Brings app to foreground on tap. **Leave `false` for headless daemons** — setting `true` on a process with no Dock icon produces an invisible focus steal. Only use for actions that genuinely require the app visible (e.g. "Open"). |

---

### `notifier.getDelivered()` → `Promise<DeliveredNotification[]>`

Returns currently visible notifications.

```js
const list = await notifier.getDelivered();
// [{ id, title, body?, delivered_at }]
```

- **Windows + macOS:** resolves with an array of `DeliveredNotification` objects.
- **Linux:** always resolves with `[]` and emits a `'warn'` event — `org.freedesktop.Notifications` defines no history API.
- **Rejects** after **10 seconds** if the daemon does not respond. Catch this in production:

```js
try {
    const list = await notifier.getDelivered();
} catch (err) {
    // err.message contains 'getDelivered() timed out after 10000ms'
}
```

Concurrent calls are safe — responses are matched FIFO to callers.

> ⚠️ **Windows:** `delivered_at` is the time `getDelivered()` was called, not the original delivery time. WinRT's `ToastNotificationHistory` does not expose delivery timestamps for historical entries. Record timestamps on the JS side at `show()` time if precision is required.

---

### `notifier.clearDelivered()` → `void`

Remove all delivered notifications. Fire-and-forget, returns `void`.

- **Windows + macOS:** clears Action Center / Notification Center entirely.
- **Linux:** calls `CloseNotification` for each tracked notification in the internal id map.

---

### `notifier.quit()` → `Promise<void>`

Graceful shutdown. Sends `quit` to the daemon, waits for the process to exit cleanly. After resolving, `start()` may be called again to restart.

---

### `notifier.destroy()` → `void`

Immediately kills the daemon (SIGKILL) and rejects all in-flight Promises. Synchronous. For graceful shutdown prefer `quit()`. After `destroy()`, `start()` may be called again.

---

## Events

**Attach all listeners before calling `start()`** so no event fired between spawn and your listener registration is silently lost.

```js
notifier.on('ready',     ({ capabilities, permission }) => { … });
notifier.on('action',    (id, actionId) => { … });
notifier.on('reply',     (id, actionId, text) => { … });
notifier.on('dismissed', (id, reason) => { … });
notifier.on('failed',    (id, error) => { … });
notifier.on('delivered', (notifications) => { … });
notifier.on('warn',      (message) => { … });
notifier.on('exit',      (code, signal) => { … });
notifier.on('error',     (err) => { … });  // ← always attach this one
```

| Event | Arguments | Description |
|---|---|---|
| `ready` | `{ capabilities, permission }` | Daemon up, permission resolved |
| `action` | `id, actionId` | User clicked an action button |
| `reply` | `id, actionId, text` | User submitted inline text input |
| `dismissed` | `id, reason` | Notification dismissed (any reason) |
| `failed` | `id, error` | OS rejected show/update |
| `delivered` | `notifications[]` | Response to `getDelivered()` |
| `warn` | `message` | Non-fatal daemon warning — never rejects a Promise |
| `exit` | `code, signal` | Daemon process exited |
| `error` | `err` | Protocol error (malformed daemon output) |

> ⚠️ Per Node.js convention, an unhandled `'error'` event crashes the process. Always attach `notifier.on('error', handler)`.

### Common `'warn'` triggers

| Trigger | Message contains |
|---|---|
| `windowsAppId` not provided | `"Windows PowerShell"` |
| `category_identifier` used before `registerCategories()` | `"not registered"` |
| Unsupported D-Bus hint value type | `"unsupported type"` |
| `getDelivered()` called on Linux | `"not supported on Linux"` |
| `dismiss()` called without prior `show()` tag+group (Windows) | `"not in id_map"` |
| `update()` called on unknown id (Linux) | `"not in id_map"` |

### Dismiss reasons

| Value | Meaning |
|---|---|
| `'user_dismissed'` | User explicitly swiped / clicked close |
| `'timed_out'` | Notification auto-expired after timeout |
| `'app_closed'` | Programmatic dismiss via `dismiss()` |
| `'default_action'` | User clicked notification body (not a button) |
| `'unknown'` | Unrecognised platform reason code |

---

## Capabilities

`notifier.capabilities` is populated after `start()` resolves. Always gate advanced features on these flags at runtime.

```js
await notifier.start();

if (notifier.capabilities.actions) {
    // safe to use action buttons
}
if (notifier.capabilities.body_markup) {
    // safe to use <b>bold</b> in body text (Linux)
}
```

| Flag | Description |
|---|---|
| `actions` | Action buttons supported |
| `body` | Body text rendered |
| `body_hyperlinks` | Hyperlinks in body text |
| `body_images` | Inline images in body text |
| `body_markup` | Bold/italic markup in body text |
| `icon_static` | Static icon rendered |
| `icon_multi` | Multiple simultaneous icons |
| `persistence` | Notifications persist after timeout |
| `sound` | Sound playback |
| `update` | In-place update supported |
| `dismiss` | Programmatic dismiss supported |

---

## Platform escape hatches

### Windows — `options.windows`

When `xml` is present, **all baseline fields (`title`, `body`, `icon`, `sound`) and the `scenario` field are entirely ignored** — the raw XML string is loaded verbatim. Set `scenario` as an attribute on the `<toast>` element directly when using raw XML.

```js
await notifier.show({
    // title/body/icon/sound are ignored when xml is set
    windows: {
        xml: `
          <toast launch="action=open" scenario="reminder">
            <visual>
              <binding template="ToastGeneric">
                <text>Deployment scheduled</text>
                <text>Runs at 03:00 UTC</text>
              </binding>
            </visual>
            <actions>
              <action content="Cancel" arguments="action=cancel"/>
            </actions>
            <audio src="ms-winsoundevent:Notification.Default"/>
          </toast>`,
        tag:           'deploy-1',
        group:         'myapp',
        expiration_ms: 60000,
    },
});
```

Without raw XML, the baseline fields are used and `scenario` applies:

```js
await notifier.show({
    title:   'Incoming call',
    body:    'Alice',
    windows: {
        scenario: 'incomingCall',   // 'default'|'alarm'|'reminder'|'incomingCall'
        tag:      'call-1',
        group:    'myapp',
    },
});
```

| Field | Type | Description |
|---|---|---|
| `xml` | `string` | Raw Toast XML. **Overrides all baseline fields and `scenario` when present.** |
| `tag` | `string` | Required for `update()` and `dismiss()`. Pair with `group`. |
| `group` | `string` | Required for `update()` and `dismiss()`. Pair with `tag`. |
| `scenario` | `string` | `'default'` \| `'alarm'` \| `'reminder'` \| `'incomingCall'`. **Ignored when `xml` is present.** |
| `expiration_ms` | `number` | Auto-remove from Action Center after N milliseconds. Must be > 0. |

Full Toast XML schema: https://learn.microsoft.com/windows/apps/design/shell/tiles-and-notifications/adaptive-interactive-toasts

---

### macOS — `options.macos`

```js
await notifier.show({
    title: 'Build Complete',
    body:  'Site generated in 420ms.',
    macos: {
        subtitle:            'thypress.org',
        thread_identifier:   'builds',
        interruption_level:  'timeSensitive',
        category_identifier: 'build_complete', // must be registered first
        relevance_score:     0.9,
        attachments:         ['/path/to/screenshot.png'],
        badge:               3,
        sound_name:          'default',
    },
});
```

| Field | Type | Description |
|---|---|---|
| `subtitle` | `string` | Secondary line below title |
| `thread_identifier` | `string` | Groups notifications as a collapsible stack |
| `interruption_level` | `string` | `'passive'` \| `'active'` \| `'timeSensitive'` \| `'critical'` |
| `category_identifier` | `string` | Action category. Must be registered via `registerCategories()` first. |
| `relevance_score` | `number` | `0.0–1.0`. Ranking in notification summaries. |
| `attachments` | `string[]` | Absolute paths to media (JPEG, PNG, GIF, MPEG4, MP3, M4V, MP4). Invalid paths emit `'warn'` and are skipped without failing the `show()`. |
| `badge` | `number` | App icon badge count. `0` clears the badge. |
| `sound_name` | `string` | `'default'` = system default sound; any other string = `UNNotificationSoundName`. To silence a macOS notification, omit `sound_name` and set the baseline `sound: false` instead. |



---

### Linux — `options.linux`

```js
await notifier.show({
    title: 'Build Complete',
    body:  notifier.capabilities.body_markup
               ? '<b>Site</b> generated in <i>420ms</i>.'
               : 'Site generated in 420ms.',
    linux: {
        urgency: 1,
        timeout: 8000,
        hints: {
            category:        'transfer.complete',
            'desktop-entry': 'myapp',
            'image-path':    '/path/to/logo.png',
            transient:       true,
        },
        // always gate on capabilities.actions
        actions: notifier.capabilities.actions
            ? [{ id: 'view', label: 'View' }, { id: 'dismiss', label: 'Dismiss' }]
            : [],
    },
});
```

| Field | Type | Description |
|---|---|---|
| `urgency` | `0 \| 1 \| 2` | Low / Normal / Critical |
| `timeout` | `number` | `-1` server decides, `0` never expires, `>0` milliseconds |
| `hints` | `object` | Raw D-Bus hints dict. Values must be `boolean`, `string`, or `number`. Other types emit `'warn'` and are skipped. |
| `actions` | `LinuxAction[]` | `[{ id, label }]`. Gate on `capabilities.actions`. |

Well-known hint keys:

| Hint key | Type | Description |
|---|---|---|
| `category` | `string` | Notification category (e.g. `'im.received'`, `'device.error'`) |
| `desktop-entry` | `string` | `.desktop` file name (no extension) |
| `image-path` | `string` | Absolute path or `file://` URI to image. Also auto-populated from the baseline `icon` field if not set. |
| `resident` | `boolean` | Stay in notification area after activation |
| `transient` | `boolean` | Bypass persistence, remove after display |
| `sound-file` | `string` | Absolute path to `.oga` or `.wav` sound file |
| `suppress-sound` | `boolean` | Disable server sound for this notification |
| `x` / `y` | `number` | Suggested screen position |

Freedesktop hints spec: https://specifications.freedesktop.org/notification-spec/latest/hints.html

---

## Recipes

### Progress bar (Windows)

```js
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Show the initial notification with a progress bar via raw XML.
// tag+group are required for the update() call to replace it.
const id = await notifier.show({
    windows: {
        xml: `<toast>
          <visual><binding template="ToastGeneric">
            <text>Uploading</text>
            <progress title="Upload" value="0"
                      valueStringOverride="0%" status="Starting…"/>
          </binding></visual>
        </toast>`,
        tag:   'upload',
        group: 'myapp',
    },
});

// Each update() re-shows the notification — banner re-animates and sound
// replays on every call. For a progress bar updating every few hundred
// milliseconds, mute sound in the XML: <audio silent="true"/>
for (let i = 1; i <= 5; i++) {
    await delay(800);
    const pct = i / 5;
    await notifier.update({
        id,
        windows: {
            xml: `<toast>
              <visual><binding template="ToastGeneric">
                <text>${i < 5 ? 'Uploading…' : 'Upload Complete ✓'}</text>
                <progress title="Upload" value="${pct}"
                          valueStringOverride="${i * 20}%"
                          status="${i < 5 ? 'Uploading…' : 'Done'}"/>
              </binding></visual>
              <audio silent="true"/>
            </toast>`,
            tag:   'upload',
            group: 'myapp',
        },
    });
}
```

### macOS with reply action

```js
await notifier.registerCategories([{
    id: 'message',
    actions: [
        { id: 'reply', title: 'Reply', type: 'text_input',
          placeholder: 'Type a reply…', button_title: 'Send' },
        { id: 'like', title: '👍' },
    ],
    options: ['custom_dismiss_action'],
}]);

await notifier.show({
    title: 'New Message',
    body:  'Hey, are you free tonight?',
    macos: { category_identifier: 'message', badge: 1 },
});

notifier.on('reply',  (id, _, text)   => sendReply(text));
notifier.on('action', (id, actionId)  => {
    if (actionId === 'like') sendLike();
});
```

### Linux with full capability gating

```js
await notifier.start();

const body = notifier.capabilities.body_markup
    ? '<b>Build</b> finished in <i>420ms</i>'
    : 'Build finished in 420ms';

const actions = notifier.capabilities.actions
    ? [{ id: 'open', label: 'Open' }, { id: 'close', label: 'Close' }]
    : [];

await notifier.show({
    title: 'Done',
    body,
    linux: { urgency: 1, timeout: 6000, actions },
});

notifier.on('action', (id, actionId) => {
    if (actionId === 'open') openApp();
});
```

### Graceful shutdown

```js
const notifier = createNotifier({ appName: 'My App' });

// Attach all listeners before start()
notifier.on('error', (err) => console.error('notifier-hook:', err.message));
notifier.on('warn',  (msg) => console.warn('notifier-hook:', msg));
notifier.on('exit',  (code) => {
    if (code !== 0) console.error(`Daemon exited with code ${code}`);
});

await notifier.start();

const shutdown = async () => {
    await notifier.quit();
    process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
```

### Error handling (production)

```js
const notifier = createNotifier({ appName: 'My App' });

// Always attach these before start()
notifier.on('error', (err) => logger.error('notifier-hook:', err.message));
notifier.on('warn',  (msg) => logger.warn('notifier-hook:', msg));

try {
    await notifier.start();
} catch (err) {
    // Binary not found, spawn failed, or daemon exited before ready
    logger.error('Failed to start notifier-hook:', err.message);
    process.exit(1);
}

// macOS only: check permission before trying to show anything
if (notifier.permission === 'denied') {
    logger.warn(
        'Notification permission denied. ' +
        'Direct user to System Settings → Notifications.'
    );
}

try {
    const id = await notifier.show({ title: 'Hello', body: 'World' });
    logger.info('Shown:', id);
} catch (err) {
    // OS rejected the notification — raw OS error string
    logger.error('Show failed:', err.message);
}
```

---

## Known limitations

### Cross-platform — notification body click behavior

Clicking the notification body (not a button) behaves differently per platform:
- **Windows:** fires `'action'` with an empty `actionId` string `""`
- **macOS:** fires `'dismissed'` with `reason: 'default_action'`
- **Linux:** fires nothing — body clicks are not reported by the D-Bus spec

If you need to handle body clicks, branch on platform or listen to both events.

### Windows — Action Center activation after daemon exit

If the daemon exits and the user later clicks a notification from Action Center, the activation is undeliverable. Handling post-exit activations requires a persistent COM server (`INotificationActivationCallback`) registered in the system. This is the host application's responsibility, not the library's.

### Windows — AUMID fallback attribution

When `windowsAppId` is not provided, notifications work but appear attributed to "Windows PowerShell" in Action Center. Always provide `windowsAppId` for distributed apps. A `'warn'` event fires when the fallback is active.

### Windows — Action Center icon

Writing to the registry grants correct attribution text but does not change the header icon. The icon shown in Action Center comes from the daemon `.exe` itself. To show a custom icon, your installer must create a Start Menu `.lnk` shortcut with the matching AUMID embedded via `IPropertyStore`. This is an installer concern.

### Windows — `update()` re-triggers the notification banner

Calling `update()` on Windows re-shows the notification, which re-animates the banner and replays the notification sound. This is a platform constraint — WinRT's true silent in-place update (`ToastNotificationHistory.Update()` with data bindings) is not yet implemented. For now, include `<audio silent="true"/>` in your XML when updating frequently to suppress the sound on each update.

### Windows — `delivered_at` is approximate in `getDelivered()`

WinRT's `ToastNotificationHistory` does not expose original delivery timestamps. `delivered_at` reflects the time `getDelivered()` was called. Record timestamps on the JS side at `show()` time if precision is required.

### Windows — `scenario` is ignored when `xml` is present

When a raw `xml` string is provided to `show()`, the `scenario` field is silently ignored. Set `scenario` as an attribute on the root `<toast>` element directly in your XML string.

### macOS — Permission denial is permanent until user acts

If `start()` resolves with `permission === 'denied'`, all `show()` calls emit `'failed'`. There is no programmatic re-prompt. Direct users to **System Settings → Notifications**.

### macOS — Completion handler is mandatory

The `withCompletionHandler` block in `didReceiveNotificationResponse` must be called after every delegate callback. If omitted, macOS silently stops delivering all future notification delegate callbacks. This is correctly implemented — do not modify the delegate.

### Linux — `update()` falls back to a new notification on unknown id

If `update()` is called with an id that isn't in the daemon's internal map (dismissed, from a previous daemon instance, or never shown), a new independent notification is displayed rather than an error being emitted.

### Linux — GNOME action callback reliability

Even when `GetCapabilities` reports `actions: true`, GNOME Shell's notification daemon may not reliably emit `ActionInvoked` for all cases. `dunst`, KDE Plasma, and XFCE are fully reliable. Always gate action display on `notifier.capabilities.actions` and test on your target desktop environment.

### Linux — No notification history

`org.freedesktop.Notifications` defines no history API. `getDelivered()` always resolves with `[]` on Linux and emits a `'warn'` event.

---

## Feature matrix

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Basic title + body | ✅ | ✅ | ✅ |
| App icon | ✅ | ✅ | ✅ |
| Sound control | ✅ XML `<audio>` | ✅ `sound: false` / `sound_name` / `sound_name: null` | ✅ `sound-file` hint |
| Custom action buttons | ✅ XML | ✅ categories | ✅ if server supports |
| Inline text reply | ✅ XML `<input>` | ✅ `text_input` action | ⚠️ extremely rare |
| In-place update | ✅ re-triggers banner | ✅ silent replacement | ✅ replaces_id |
| Programmatic dismiss | ✅ requires tag+group | ✅ delivered + pending | ✅ |
| Notification history | ✅ | ✅ | ❌ |
| Clear all delivered | ✅ | ✅ | ✅ per-id loop |
| Raw XML payload | ✅ full schema | ❌ | ❌ |
| Interruption levels | ✅ scenario ≈ equiv | ✅ 4 levels | ❌ |
| Media attachments | ✅ XML heroImage | ✅ | ✅ image-path hint |
| App badge | ❌ | ✅ | ❌ |
| Thread / group stacking | ✅ group | ✅ thread_identifier | ❌ |
| Progress bars | ✅ XML | ❌ | ❌ |
| Capability detection | synthesised | synthesised | ✅ GetCapabilities |
| Permission flow | ❌ not required | ✅ async dialog | ❌ not required |

---

## License

MIT

---

## Credits

Created by [@phteocos](https://x.com/phteocos). Built for [**THYPRESS**](https://thypress.org) — zero-config static site generator.

Sister library: [tray-hook](https://github.com/phtdacosta/tray-hook) — native system tray with the same architecture.
