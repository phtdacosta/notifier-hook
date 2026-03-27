/**
 * examples/basic.js
 *
 * The universal quickstart. This file runs identically on Windows, macOS,
 * and Linux — no platform checks, no conditional logic. The daemon handles
 * everything underneath.
 *
 * Run:
 *   node examples/basic.js
 *   bun examples/basic.js
 */

import { createNotifier } from 'notifier-hook';

// ─── Create ────────────────────────────────────────────────────────────────────

const notifier = createNotifier({
    appName: 'notifier-hook example',

    // Windows: provide your own AUMID for proper Action Center attribution.
    // Without this, notifications work but appear as "Windows PowerShell".
    // macOS + Linux: this field is silently ignored.
    windowsAppId: 'com.example.notifier-hook',
});

// ─── Attach event listeners BEFORE start() ────────────────────────────────────

// ⚠️  Always attach an 'error' listener. Per Node.js convention, an unhandled
//     'error' event crashes the process.
notifier.on('error', (err) => {
    console.error('[notifier-hook] protocol error:', err.message);
});

// Non-fatal daemon warnings — helpful in development.
notifier.on('warn', (msg) => {
    console.warn('[notifier-hook] warn:', msg);
});

// User clicked a notification action button.
notifier.on('action', (id, actionId) => {
    console.log(`[action]    notification=${id}  action=${actionId}`);
});

// User submitted an inline text reply (macOS text_input / Windows XML input).
notifier.on('reply', (id, actionId, text) => {
    console.log(`[reply]     notification=${id}  action=${actionId}  text="${text}"`);
});

// Notification was dismissed for any reason.
notifier.on('dismissed', (id, reason) => {
    console.log(`[dismissed] notification=${id}  reason=${reason}`);
});

// Daemon exited.
notifier.on('exit', (code, signal) => {
    console.log(`[exit] code=${code} signal=${signal}`);
});

// ─── Start ─────────────────────────────────────────────────────────────────────

console.log('Starting daemon…');
await notifier.start();

console.log('Daemon ready.');
console.log('Permission :', notifier.permission);
console.log('Capabilities:', JSON.stringify(notifier.capabilities, null, 2));

// ─── Show a basic notification ─────────────────────────────────────────────────

console.log('\n→ Showing basic notification…');

const id = await notifier.show({
    title: 'Hello from notifier-hook',
    body:  'This notification was sent from Node.js / Bun with zero native compilation.',
    icon:  new URL('./assets/icon.png', import.meta.url).pathname,
});

console.log(`  shown — id: ${id}`);

// ─── Show a second notification, then dismiss it programmatically ──────────────

console.log('\n→ Showing a notification that will be dismissed in 2 seconds…');

const id2 = await notifier.show({
    title: 'Auto-dismiss demo',
    body:  'This notification will be removed programmatically in 2 seconds.',
    sound: false, // silent
});

console.log(`  shown — id: ${id2}`);

setTimeout(async () => {
    console.log(`\n→ Dismissing ${id2}…`);
    await notifier.dismiss(id2);
    console.log('  dismissed.');
}, 2000);

// ─── Wait a moment then quit ───────────────────────────────────────────────────

setTimeout(async () => {
    console.log('\n→ Quitting daemon…');
    await notifier.quit();
    console.log('Done.');
    process.exit(0);
}, 5000);
