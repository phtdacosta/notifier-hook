/**
 * examples/macos-advanced.js
 *
 * Demonstrates every macOS-specific feature exposed by notifier-hook:
 *   • Permission flow (granted / denied handling)
 *   • registerCategories() with text_input, destructive, auth_required actions
 *   • category_identifier in show()
 *   • Interruption levels (passive, active, timeSensitive, critical)
 *   • Thread identifier (notification stacking)
 *   • Relevance score
 *   • Attachments (image preview in notification)
 *   • Badge count
 *   • subtitle
 *   • sound_name
 *   • get_delivered / clear_delivered
 *
 * Run on macOS:
 *   node examples/macos-advanced.js
 *   bun examples/macos-advanced.js
 */

import { createNotifier } from 'notifier-hook';
import { fileURLToPath }  from 'url';
import { dirname, join }  from 'path';

if (process.platform !== 'darwin') {
    console.error('This example is macOS-only. See windows-advanced.js or linux-advanced.js.');
    process.exit(0);
}

const __dirname  = dirname(fileURLToPath(import.meta.url));
const assetsDir  = join(__dirname, 'assets');

const notifier = createNotifier({ appName: 'notifier-hook macOS Demo' });

notifier.on('error',     (err)            => console.error('[error]', err.message));
notifier.on('warn',      (msg)            => console.warn('[warn]', msg));
notifier.on('action',    (id, actionId)   => console.log(`[action]    id=${id}  action=${actionId}`));
notifier.on('reply',     (id, _, text)    => console.log(`[reply]     id=${id}  text="${text}"`));
notifier.on('dismissed', (id, reason)     => console.log(`[dismissed] id=${id}  reason=${reason}`));

// ─── Start + permission check ──────────────────────────────────────────────────

console.log('Starting daemon (may show system permission dialog on first run)…');
await notifier.start();

console.log(`Permission:   ${notifier.permission}`);
console.log('Capabilities:', JSON.stringify(notifier.capabilities, null, 2));

if (notifier.permission === 'denied') {
    console.error(
        '\n✗ Notification permission denied.\n' +
        '  Go to: System Settings → Notifications → notifier-hook macOS Demo\n' +
        '  and enable "Allow Notifications".\n'
    );
    await notifier.quit();
    process.exit(1);
}

// ─── Register categories BEFORE any show() that uses category_identifier ──────
//
// Categories define the action buttons that appear on a notification.
// Must be registered before show() — if a category_identifier is used
// before registration, the notification shows without buttons + warn fires.

console.log('\n→ Registering notification categories…');

await notifier.registerCategories([
    {
        id: 'build_complete',
        actions: [
            {
                id:    'open_site',
                title: 'Open Site',
            },
            {
                id:    'deploy',
                title: 'Deploy Now',
            },
            {
                id:          'add_note',
                title:       'Add Note',
                type:        'text_input',
                placeholder: 'Write a note about this build…',
                button_title: 'Save',
            },
        ],
        options: ['custom_dismiss_action'],
    },

    {
        id: 'message_received',
        actions: [
            {
                id:          'reply',
                title:       'Reply',
                type:        'text_input',
                placeholder: 'Write a reply…',
                button_title: 'Send',
            },
            {
                id:    'mark_read',
                title: 'Mark as Read',
            },
            {
                id:          'delete',
                title:       'Delete',
                destructive: true,
            },
        ],
        options: ['custom_dismiss_action'],
    },

    {
        id: 'auth_required',
        actions: [
            {
                id:                      'approve',
                title:                   'Approve',
                authentication_required: true,
            },
            {
                id:          'deny',
                title:       'Deny',
                destructive: true,
            },
        ],
    },
]);

console.log('  Categories registered.');

// ─── Demo 1: Basic notification with subtitle + category ──────────────────────

console.log('\n─── Demo 1: Build complete with actions ───');

const buildId = await notifier.show({
    title: 'Build Complete',
    body:  'Your site was generated in 420ms.',
    macos: {
        subtitle:            'notifier-hook-demo.thypress.org',
        thread_identifier:   'builds',
        interruption_level:  'timeSensitive',
        category_identifier: 'build_complete',
        relevance_score:     0.9,
        badge:               1,
        sound_name:          'default',
    },
});

console.log(`  shown — id: ${buildId}`);
console.log('  (click "Open Site", "Deploy Now", or "Add Note" in the notification)');

// ─── Demo 2: Notification with image attachment ───────────────────────────────

console.log('\n─── Demo 2: Notification with image attachment ───');

// Using a publicly available test image. In a real app this would be an
// absolute path to an image file on the user's machine.
const attachmentPath = join(assetsDir, 'preview.png');

const attachId = await notifier.show({
    title: 'Screenshot Captured',
    body:  'Your screenshot has been saved.',
    macos: {
        subtitle:    'Press & Hold to preview',
        attachments: [attachmentPath],
        sound_name:  'default',
    },
});

console.log(`  shown — id: ${attachId}`);

// ─── Demo 3: Interruption levels ──────────────────────────────────────────────

console.log('\n─── Demo 3: Interruption levels ───');

// passive — completely silent, no banner, delivered to Notification Center
const passiveId = await notifier.show({
    title: 'Passive notification',
    body:  'This arrived silently in Notification Center.',
    macos: {
        interruption_level: 'passive',
        thread_identifier:  'interruption-demo',
        relevance_score:    0.1,
    },
});
console.log(`  passive — id: ${passiveId}`);

// timeSensitive — breaks through most Focus modes
const urgentId = await notifier.show({
    title: 'Time-sensitive notification',
    body:  'This breaks through most Focus modes.',
    macos: {
        interruption_level: 'timeSensitive',
        thread_identifier:  'interruption-demo',
        relevance_score:    0.95,
    },
});
console.log(`  timeSensitive — id: ${urgentId}`);

// ─── Demo 4: Thread stacking ──────────────────────────────────────────────────

console.log('\n─── Demo 4: Thread stacking (same thread_identifier → grouped) ───');

for (let i = 1; i <= 3; i++) {
    const msgId = await notifier.show({
        title: `Message ${i} of 3`,
        body:  `This is message number ${i}. All three stack under the same thread.`,
        macos: {
            subtitle:            'notifier-hook-demo',
            thread_identifier:   'stacked-messages',
            category_identifier: 'message_received',
            relevance_score:     i / 3,
            badge:               i,
        },
    });
    console.log(`  message ${i} — id: ${msgId}`);
}

// ─── Demo 5: get_delivered ────────────────────────────────────────────────────

console.log('\n─── Demo 5: get_delivered ───');

await new Promise(r => setTimeout(r, 1500)); // give OS a moment to register

const delivered = await notifier.getDelivered();
console.log(`  ${delivered.length} notification(s) currently delivered:`);
for (const n of delivered) {
    const ts = new Date(n.delivered_at).toLocaleTimeString();
    console.log(`    [${ts}] "${n.title}" — id: ${n.id}`);
}

// ─── Demo 6: clear_delivered ──────────────────────────────────────────────────

console.log('\n─── Demo 6: clear_delivered ───');
notifier.clearDelivered();
console.log('  All delivered notifications cleared from Notification Center.');

// ─── Finish ───────────────────────────────────────────────────────────────────

setTimeout(async () => {
    console.log('\nAll macOS demos complete. Quitting…');
    await notifier.quit();
    process.exit(0);
}, 10000);
