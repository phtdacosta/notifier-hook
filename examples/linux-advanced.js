/**
 * examples/linux-advanced.js
 *
 * Demonstrates every Linux-specific feature exposed by notifier-hook:
 *   • Capability-gated feature usage (always check before using)
 *   • Urgency levels (low / normal / critical)
 *   • Raw D-Bus hints dict (category, desktop-entry, image-path, transient,
 *     resident, sound-file, suppress-sound, x/y positioning)
 *   • Action buttons (gated on capabilities.actions)
 *   • Custom timeout values
 *   • In-place update via replaces_id (D-Bus)
 *   • clear_delivered (iterates tracked ids via CloseNotification)
 *   • Body markup (gated on capabilities.body_markup)
 *
 * Run on Linux:
 *   node examples/linux-advanced.js
 *   bun examples/linux-advanced.js
 *
 * Tested notification servers:
 *   dunst         — full action + signal support
 *   KDE Plasma    — full support
 *   XFCE          — full support
 *   GNOME Shell   — actions may be unreliable (see README limitations)
 */

import { createNotifier } from 'notifier-hook';

if (process.platform !== 'linux') {
    console.error('This example is Linux-only. See windows-advanced.js or macos-advanced.js.');
    process.exit(0);
}

const notifier = createNotifier({ appName: 'notifier-hook Linux Demo' });

notifier.on('error',     (err)            => console.error('[error]', err.message));
notifier.on('warn',      (msg)            => console.warn('[warn]', msg));
notifier.on('action',    (id, actionId)   => console.log(`[action]    id=${id}  action=${actionId}`));
notifier.on('dismissed', (id, reason)     => console.log(`[dismissed] id=${id}  reason=${reason}`));

await notifier.start();

console.log('Permission:   ', notifier.permission);
console.log('Capabilities:', JSON.stringify(notifier.capabilities, null, 2));

const caps = notifier.capabilities;

// ─── Demo 1: Urgency levels ────────────────────────────────────────────────────
//
// urgency 0 = Low     — often displayed smaller / without sound
// urgency 1 = Normal  — default
// urgency 2 = Critical — ignores timeout on most servers, requires explicit dismiss

console.log('\n─── Demo 1: Urgency levels ───');

const lowId = await notifier.show({
    title: 'Low urgency',
    body:  'This is a low-priority notification.',
    linux: {
        urgency: 0,
        timeout: 4000,
        hints: {
            category:        'im.received',
            'desktop-entry': 'notifier-hook-demo',
            transient:       true,  // don't persist in notification area
        },
    },
});
console.log(`  low urgency — id: ${lowId}`);

await delay(500);

const normalId = await notifier.show({
    title: 'Normal urgency',
    body:  'Standard notification. Server decides the timeout.',
    linux: {
        urgency: 1,
        timeout: -1,  // server decides
        hints: {
            category:        'transfer.complete',
            'desktop-entry': 'notifier-hook-demo',
        },
    },
});
console.log(`  normal urgency — id: ${normalId}`);

await delay(500);

const criticalId = await notifier.show({
    title: 'Critical urgency',
    body:  'This notification will not auto-dismiss on most servers.',
    linux: {
        urgency: 2,
        timeout: 0,   // never auto-dismiss
        hints: {
            category:        'device.error',
            'desktop-entry': 'notifier-hook-demo',
            resident:        true,  // stay in notification area after activation
        },
    },
});
console.log(`  critical urgency — id: ${criticalId}  (will be dismissed programmatically in 4s)`);

setTimeout(async () => {
    await notifier.dismiss(criticalId);
    console.log('  critical notification dismissed');
}, 4000);

// ─── Demo 2: Body markup (if supported) ───────────────────────────────────────

console.log('\n─── Demo 2: Body markup ───');

const bodyText = caps.body_markup
    ? '<b>Bold</b> and <i>italic</i> and <u>underline</u> supported by your server.'
    : 'Your notification server does not support body markup.';

await notifier.show({
    title: 'Body markup demo',
    body:  bodyText,
    linux: {
        urgency: 1,
        timeout: 5000,
        hints: { 'desktop-entry': 'notifier-hook-demo' },
    },
});

// ─── Demo 3: Image via image-path hint ────────────────────────────────────────

console.log('\n─── Demo 3: Image via image-path hint ───');

await notifier.show({
    title: 'Image notification',
    body:  'An image attached via image-path hint.',
    linux: {
        urgency: 1,
        timeout: 5000,
        hints: {
            'image-path':    '/usr/share/pixmaps/gnome-logo-icon.png',
            'desktop-entry': 'notifier-hook-demo',
            category:        'transfer.complete',
        },
    },
});

// Alternatively, use the baseline icon field — the daemon inserts it as
// image-path automatically if not already in the hints dict:
await notifier.show({
    title: 'Icon via baseline field',
    body:  'Using the top-level icon field — daemon converts to image-path hint.',
    icon:  '/usr/share/pixmaps/gnome-logo-icon.png',
    linux: {
        urgency: 1,
        timeout: 5000,
    },
});

// ─── Demo 4: Action buttons (capability-gated) ────────────────────────────────

console.log('\n─── Demo 4: Action buttons ───');

if (!caps.actions) {
    console.log('  ⚠ Your notification server does not support actions. Skipping.');
} else {
    const actionId = await notifier.show({
        title: 'Action buttons demo',
        body:  'Click one of the action buttons below.',
        linux: {
            urgency: 1,
            timeout: 10000,
            hints: {
                category:        'im.received',
                'desktop-entry': 'notifier-hook-demo',
            },
            // Always gate actions on caps.actions — never hardcode
            actions: [
                { id: 'view',    label: 'View'    },
                { id: 'archive', label: 'Archive' },
                { id: 'delete',  label: 'Delete'  },
            ],
        },
    });
    console.log(`  shown — id: ${actionId}  (click a button in the notification)`);
}

// ─── Demo 5: In-place update via replaces_id ──────────────────────────────────
//
// On Linux, update() passes the stored D-Bus uint32 as replaces_id.
// The notification server replaces the existing notification in-place.

console.log('\n─── Demo 5: In-place update (replaces_id) ───');

const updateId = await notifier.show({
    title: 'Sync in progress…',
    body:  '0 of 5 files synced.',
    linux: {
        urgency: 1,
        timeout: -1,
        hints: { 'desktop-entry': 'notifier-hook-demo', transient: false },
    },
});

console.log(`  initial — id: ${updateId}`);

for (let i = 1; i <= 5; i++) {
    await delay(800);
    await notifier.update({
        id:    updateId,
        title: i < 5 ? 'Syncing…' : 'Sync Complete ✓',
        body:  `${i} of 5 files synced.`,
        linux: {
            urgency: i < 5 ? 1 : 1,
            timeout: i < 5 ? -1 : 5000,
            hints: {
                'desktop-entry': 'notifier-hook-demo',
                transient:       i === 5,  // remove from area when done
            },
        },
    });
    console.log(`  updated → ${i}/5`);
}

// ─── Demo 6: Sound control ────────────────────────────────────────────────────

console.log('\n─── Demo 6: Sound control ───');

// Suppress sound via hint
await notifier.show({
    title: 'Silent notification',
    body:  'suppress-sound: true — no sound will play.',
    linux: {
        urgency: 1,
        timeout: 4000,
        hints: {
            'suppress-sound': true,
            'desktop-entry':  'notifier-hook-demo',
        },
    },
});

// Custom sound file
await notifier.show({
    title: 'Custom sound notification',
    body:  'Playing a custom .oga sound file.',
    linux: {
        urgency: 1,
        timeout: 4000,
        hints: {
            'sound-file':    '/usr/share/sounds/freedesktop/stereo/message.oga',
            'desktop-entry': 'notifier-hook-demo',
        },
    },
});

// ─── Demo 7: clear_delivered ──────────────────────────────────────────────────

console.log('\n─── Demo 7: clear_delivered ───');
console.log('  (calls CloseNotification for each tracked notification id)');
notifier.clearDelivered();
console.log('  Done.');

// ─── Finish ───────────────────────────────────────────────────────────────────

setTimeout(async () => {
    console.log('\nAll Linux demos complete. Quitting…');
    await notifier.quit();
    process.exit(0);
}, 12000);

// ─── Utility ──────────────────────────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
