/**
 * examples/windows-advanced.js
 *
 * Demonstrates every Windows-specific feature exposed by notifier-hook:
 *
 *   • AUMID registration for proper Action Center attribution
 *   • Raw XML injection (overrides all baseline fields when present)
 *   • Progress bar notification with in-place update via tag + group
 *   • Inline text reply input via Toast XML <input type="text">
 *   • Scenario modes: alarm, reminder, incomingCall
 *   • Expiration time (auto-removal from Action Center)
 *   • Programmatic dismiss
 *   • get_delivered / clear_delivered
 *
 * Run on Windows:
 *   node examples/windows-advanced.js
 *   bun   examples/windows-advanced.js
 *
 * Notes:
 *   • All event listeners are attached BEFORE start() so no event fired
 *     between show() and listener registration can be silently lost.
 *   • Demo flow is linear and sequential — each demo awaits the previous
 *     one before starting so output is readable and deterministic.
 */

import { createNotifier } from 'notifier-hook';

if (process.platform !== 'win32') {
    console.error(
        'This example is Windows-only.\n' +
        'See examples/macos-advanced.js or examples/linux-advanced.js.'
    );
    process.exit(0);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

/** Promisified setTimeout. */
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Return a Promise that resolves the next time the notifier emits one of the
 * named events, whichever comes first. Resolves with { event, args }.
 * Rejects after `timeoutMs` if neither event fires.
 */
function nextEvent(notifier, events, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const handlers = {};
        let timer;

        const cleanup = () => {
            clearTimeout(timer);
            for (const [ev, fn] of Object.entries(handlers)) {
                notifier.off(ev, fn);
            }
        };

        timer = setTimeout(() => {
            cleanup();
            reject(new Error(
                `nextEvent: timed out after ${timeoutMs}ms waiting for [${events.join(', ')}]`
            ));
        }, timeoutMs);

        for (const ev of events) {
            handlers[ev] = (...args) => {
                cleanup();
                resolve({ event: ev, args });
            };
            notifier.on(ev, handlers[ev]);
        }
    });
}

// ─── Create notifier ──────────────────────────────────────────────────────────

const notifier = createNotifier({
    appName:      'notifier-hook Windows Demo',
    // windowsAppId grants correct Action Center attribution text.
    // Without it, notifications work but appear as "Windows PowerShell".
    windowsAppId: 'com.example.notifier-hook',
});

// ─── Attach ALL event listeners before start() ───────────────────────────────
//
// This is the correct pattern. If listeners are attached inside callbacks
// or after async gaps, events fired in that window are silently lost.
//
// The notifier is an EventEmitter — every event it can ever emit is wired
// up here once, before any async work begins.

// ⚠️  Always attach 'error'. Per Node.js convention an unhandled 'error' event
//     crashes the process.
notifier.on('error', (err) => {
    console.error('[error]', err.message);
});

notifier.on('warn', (msg) => {
    console.warn('[warn]', msg);
});

notifier.on('action', (id, actionId) => {
    console.log(`[action]    id=${id}  actionId="${actionId}"`);
});

notifier.on('reply', (id, actionId, text) => {
    console.log(`[reply]     id=${id}  actionId="${actionId}"  text="${text}"`);
});

notifier.on('dismissed', (id, reason) => {
    console.log(`[dismissed] id=${id}  reason=${reason}`);
});

notifier.on('failed', (id, error) => {
    console.error(`[failed]    id=${id}  error=${error}`);
});

notifier.on('exit', (code, signal) => {
    console.log(`[exit] code=${code} signal=${signal}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('Starting daemon…');
await notifier.start();

console.log('Daemon ready.');
console.log('Permission:   ', notifier.permission);
console.log('Capabilities:', JSON.stringify(notifier.capabilities, null, 2));
console.log();

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 1: Baseline notification (no XML)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Uses the cross-platform baseline fields: title, body, icon, sound.
// The daemon constructs a minimal ToastGeneric XML internally.

console.log('─── Demo 1: Baseline notification ───');

const baselineId = await notifier.show({
    title: 'notifier-hook — Baseline',
    body:  'This notification was built from title + body + icon fields. No raw XML.',
    sound: true,
});

console.log(`  shown — id: ${baselineId}`);
await delay(2000);

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 2: Progress bar with in-place update
// ═══════════════════════════════════════════════════════════════════════════════
//
// Windows Toast XML supports <progress> elements natively.
// We use raw XML (windows.xml) to show a progress bar, then call update()
// with a new value every 600ms. Because update() passes the same tag + group,
// the notification updates in-place — no flicker, no new notification entry.
//
// When windows.xml is present ALL baseline fields (title, body, icon, sound)
// are ENTIRELY IGNORED. The XML is loaded verbatim via XmlDocument::LoadXml().

console.log('─── Demo 2: Progress bar with in-place update ───');

const PROGRESS_TAG   = 'upload-progress';
const PROGRESS_GROUP = 'notifier-hook-demo';

/** Build a Toast XML string with a <progress> element at the given percent. */
function progressXml(percent, statusText) {
    const value = (percent / 100).toFixed(2);
    return `<toast launch="action=open" scenario="default">
  <visual>
    <binding template="ToastGeneric">
      <text>notifier-hook — Uploading</text>
      <text>Uploading your files to the cloud…</text>
      <progress
        title="Upload"
        value="${value}"
        valueStringOverride="${percent}%"
        status="${statusText}"
      />
    </binding>
  </visual>
</toast>`;
}

const progressId = await notifier.show({
    title:   'Uploading',   // ignored — windows.xml is present
    windows: {
        xml:   progressXml(0, 'Starting…'),
        tag:   PROGRESS_TAG,
        group: PROGRESS_GROUP,
    },
});

console.log(`  shown — id: ${progressId}`);

for (let pct = 10; pct <= 100; pct += 10) {
    await delay(600);
    const isDone   = pct >= 100;
    const status   = isDone ? 'Complete ✓' : `${pct}% complete`;
    const bodyXml  = isDone
        ? `<toast>
  <visual><binding template="ToastGeneric">
    <text>notifier-hook — Upload Complete</text>
    <text>All files uploaded successfully.</text>
  </binding></visual>
</toast>`
        : progressXml(pct, status);

    await notifier.update({
        id:      progressId,
        title:   'Uploading',
        windows: {
            xml:   bodyXml,
            tag:   PROGRESS_TAG,
            group: PROGRESS_GROUP,
        },
    });
    console.log(`  updated → ${pct}%`);
}

await delay(2000);

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 3: Inline text reply
// ═══════════════════════════════════════════════════════════════════════════════
//
// Toast XML supports <input type="text"> for inline replies. When the user
// types something and clicks the send button, the Activated callback fires
// with the text value in UserInput — the daemon emits a 'reply' event.
//
// The 'reply' and 'action' listeners are already attached above (before start).
// We use nextEvent() here only to gate the demo flow on user interaction
// so demos don't overlap.

console.log('─── Demo 3: Inline text reply ───');
console.log('  (type a reply in the notification, then click Send or Cancel)');

await notifier.show({
    title:   'Quick Reply Demo',
    windows: {
        xml: `<toast launch="action=open">
  <visual>
    <binding template="ToastGeneric">
      <text>notifier-hook — Quick Reply</text>
      <text>Type a message below and click Send.</text>
    </binding>
  </visual>
  <actions>
    <input
      id="userReply"
      type="text"
      placeHolderContent="Write something…"
    />
    <action
      content="Send"
      arguments="action=send"
      hint-inputId="userReply"
    />
    <action
      content="Cancel"
      arguments="action=cancel"
    />
  </actions>
</toast>`,
        tag:   'reply-demo',
        group: 'notifier-hook-demo',
    },
});

// Wait up to 20 seconds for the user to interact, then continue regardless.
try {
    const result = await nextEvent(notifier, ['reply', 'action'], 20_000);
    if (result.event === 'reply') {
        console.log(`  reply received: "${result.args[2]}"`);
    } else {
        console.log(`  action received: "${result.args[1]}"`);
    }
} catch {
    console.log('  (no interaction — continuing)');
}

await delay(500);

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 4: Scenario modes
// ═══════════════════════════════════════════════════════════════════════════════
//
// scenario="alarm"        → stays on screen until user acts
// scenario="reminder"     → stays on screen until user acts (softer than alarm)
// scenario="incomingCall" → full-screen incoming call UI (not shown here as
//                           it is extremely intrusive; see Toast schema docs)
//
// For alarm/reminder the <actions> element should provide snooze + dismiss
// buttons using activationType="system" as shown below.

console.log('─── Demo 4: Alarm scenario ───');
console.log('  (notification stays on screen — will be auto-dismissed in 8s)');

const alarmId = await notifier.show({
    title:   'Alarm Demo',
    windows: {
        xml: `<toast scenario="alarm">
  <visual>
    <binding template="ToastGeneric">
      <text>notifier-hook — Alarm</text>
      <text>This notification stays until you dismiss it.</text>
    </binding>
  </visual>
  <actions>
    <action
      content="Snooze"
      arguments="action=snooze"
      activationType="system"
    />
    <action
      content="Dismiss"
      arguments="action=dismiss"
      activationType="system"
    />
  </actions>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true"/>
</toast>`,
        tag:   'alarm-demo',
        group: 'notifier-hook-demo',
    },
});

console.log(`  shown — id: ${alarmId}`);

// Auto-dismiss after 8 seconds if the user hasn't interacted.
await delay(8000);
await notifier.dismiss(alarmId);
console.log('  auto-dismissed alarm after 8s');

await delay(500);

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 5: Expiration time
// ═══════════════════════════════════════════════════════════════════════════════
//
// expiration_ms sets an absolute ExpirationTime computed as now + delta.
// The notification is automatically removed from Action Center after this
// duration — it may briefly appear on screen then vanish from history.

console.log('─── Demo 5: Expiration time (auto-removed from Action Center in 5s) ───');

await notifier.show({
    title: 'Expires in 5 seconds',
    body:  'This notification disappears from Action Center automatically.',
    windows: {
        tag:           'expiry-demo',
        group:         'notifier-hook-demo',
        expiration_ms: 5_000,
    },
});

console.log('  shown — will be removed from Action Center in 5s');
await delay(6000);

// ═══════════════════════════════════════════════════════════════════════════════
// Demo 6: get_delivered + clear_delivered
// ═══════════════════════════════════════════════════════════════════════════════
//
// get_delivered queries ToastNotificationHistory for this AUMID.
// Notifications shown without windows.tag are skipped (cannot be identified).
// delivered_at is the time getDelivered() was called — WinRT does not expose
// original delivery timestamps for historical entries.

console.log('─── Demo 6: get_delivered ───');

// Show a tagged notification so it appears in history.
await notifier.show({
    title:   'History entry',
    body:    'This notification should appear in get_delivered results.',
    windows: { tag: 'history-demo', group: 'notifier-hook-demo' },
});

await delay(1000); // give the OS a moment to register it

const delivered = await notifier.getDelivered();
console.log(`  ${delivered.length} notification(s) in Action Center history:`);
for (const n of delivered) {
    const ts = new Date(n.delivered_at).toLocaleTimeString();
    console.log(`    [${ts}] "${n.title}" (id: ${n.id})`);
}

console.log('─── Demo 7: clear_delivered ───');
notifier.clearDelivered();
console.log('  All Action Center entries cleared.');

// ─── Shutdown ─────────────────────────────────────────────────────────────────

await delay(1000);
console.log('\nAll Windows demos complete. Shutting down…');
await notifier.quit();
console.log('Done.');
process.exit(0);