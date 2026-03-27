/**
 * demo.js — A little show for your notification center.
 *
 * Run:  bun demo.js
 */

import { spawn }           from 'child_process';
import { createInterface } from 'readline';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY    = join(__dirname, 'target/debug/notifier-hook-daemon.exe');

// ─── Minimal daemon client ─────────────────────────────────────────────────────

const proc = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'] });
proc.on('error', (e) => { console.error('spawn error:', e.message); process.exit(1); });

const pending = {};
const rl = createInterface({ input: proc.stdout });

rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.event === 'shown'   && pending[msg.id]) pending[msg.id].resolve(msg.id);
    if (msg.event === 'failed'  && pending[msg.id]) pending[msg.id].reject(new Error(msg.error));
    if (msg.event === 'action')   console.log(`  <  action   id=${msg.id}  button="${msg.action_id}"`);
    if (msg.event === 'reply')    console.log(`  <  reply    id=${msg.id}  text="${msg.text}"`);
    if (msg.event === 'dismissed')console.log(`  <  dismissed id=${msg.id}  reason=${msg.reason}`);
});

function send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n'); }

let _n = 0;
function show(opts) {
    const id = `demo-${++_n}`;
    return new Promise((resolve, reject) => {
        pending[id] = { resolve, reject };
        send({ action: 'show', id, ...opts });
    });
}

function update(opts) {
    const id = opts.id;
    return new Promise((resolve, reject) => {
        pending[id] = { resolve, reject };
        send({ action: 'update', id, ...opts });
    });
}

function dismiss(id) { send({ action: 'dismiss', id }); }
function quit()      { return new Promise(r => { proc.on('exit', r); send({ action: 'quit' }); }); }
const delay = (ms)  => new Promise(r => setTimeout(r, ms));

// Boot
send({ action: 'init', app_name: 'notifier-hook', windows_app_id: 'com.example.notifier-hook' });
await new Promise(r => rl.on('line', function h(line) {
    try { if (JSON.parse(line).event === 'ready') { rl.off('line', h); r(); } } catch {}
}));

console.log('Daemon ready. Starting demo…\n');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Simple hello
// ═══════════════════════════════════════════════════════════════════════════════

console.log('1. Hello world');
await show({
    title: 'Hey 👋',
    body:  'notifier-hook is alive and talking to you from a Rust daemon over a JSON pipe.',
    sound: true,
});
await delay(2500);

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Countdown — same notification updates in place
// ═══════════════════════════════════════════════════════════════════════════════

console.log('2. Countdown (in-place update)');

const COUNT_TAG   = 'countdown';
const COUNT_GROUP = 'demo';

const countXml = (n) => {
    const filled = 10 - n;
    const bar    = '█'.repeat(filled) + '░'.repeat(n);
    return `<toast><visual><binding template="ToastGeneric">
  <text>${n > 0 ? `T-${n}  Launching…` : '🚀  Liftoff!'}</text>
  <text>${n > 0 ? `${bar}  ${filled * 10}%` : 'We have liftoff. notifier-hook is go for launch.'}</text>
</binding></visual></toast>`;
};

const cid = 'demo-count';
await update({ id: cid, title: '', windows: { xml: countXml(10), tag: COUNT_TAG, group: COUNT_GROUP } })
    .catch(() => {}); // first call may land as show or update — fire show explicitly
pending[cid] = { resolve: () => {}, reject: () => {} };
send({ action: 'show', id: cid, title: '', windows: { xml: countXml(10), tag: COUNT_TAG, group: COUNT_GROUP } });
await delay(1200); // give it a moment to appear

for (let i = 9; i >= 0; i--) {
    await delay(1200);
    await update({ id: cid, title: '', windows: { xml: countXml(i), tag: COUNT_TAG, group: COUNT_GROUP } });
    process.stdout.write(`\r  T-${i}… `);
}
console.log('\n  Liftoff!');
await delay(3500);

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Progress bar — file upload sim
// ═══════════════════════════════════════════════════════════════════════════════

console.log('3. Progress bar upload');

const files    = ['vacation-2024.zip', 'project-final-v3.psd', 'backup.tar.gz'];
const PROG_TAG = 'upload', PROG_GRP = 'demo';

const progXml = (file, pct) => `<toast><visual><binding template="ToastGeneric">
  <text>☁  Uploading to cloud…</text>
  <text>${file}</text>
  <progress
    title="${file}"
    value="${(pct / 100).toFixed(2)}"
    valueStringOverride="${pct}%"
    status="${pct < 100 ? 'Uploading…' : 'Done ✓'}"/>
</binding></visual></toast>`;

const doneXml = () => `<toast><visual><binding template="ToastGeneric">
  <text>✅  Upload complete</text>
  <text>All ${files.length} files uploaded successfully.</text>
</binding></visual></toast>`;

const upid = 'demo-upload';

// Show with the first file at 0% — properly awaited
pending[upid] = { resolve: () => {}, reject: () => {} };
send({ action: 'show', id: upid, title: '', windows: { xml: progXml(files[0], 0), tag: PROG_TAG, group: PROG_GRP } });
await delay(1200); // let it appear before we start updating

for (const file of files) {
    for (let pct = 0; pct <= 100; pct += 20) {
        await update({ id: upid, title: '', windows: { xml: progXml(file, pct), tag: PROG_TAG, group: PROG_GRP } });
        process.stdout.write(`\r  ${file}  ${pct}%   `);
        await delay(1200); // slow enough to actually see each step
    }
    console.log();
}

// Final done state
await update({ id: upid, title: '', windows: { xml: doneXml(), tag: PROG_TAG, group: PROG_GRP } });
console.log('  Upload complete.');
await delay(3000);

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Action buttons — coffee order
// ═══════════════════════════════════════════════════════════════════════════════

console.log('4. Action buttons — pick your coffee');

await show({
    title: '☕  Coffee order ready',
    windows: {
        xml: `<toast launch="action=open">
  <visual><binding template="ToastGeneric">
    <text>☕  Your order is ready</text>
    <text>The barista at counter 3 is waiting. What size?</text>
  </binding></visual>
  <actions>
    <action content="Small"  arguments="size=small"/>
    <action content="Medium" arguments="size=medium"/>
    <action content="Large"  arguments="size=large"/>
  </actions>
</toast>`,
        tag: 'coffee', group: 'demo',
    },
});
await delay(8000);

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Inline text reply
// ═══════════════════════════════════════════════════════════════════════════════

console.log('5. Inline reply — message from a friend');

await show({
    title: '💬  Message from Alex',
    windows: {
        xml: `<toast>
  <visual><binding template="ToastGeneric">
    <text>💬  Alex</text>
    <text>hey are you coming tonight or what</text>
  </binding></visual>
  <actions>
    <input id="r" type="text" placeHolderContent="Reply to Alex…"/>
    <action content="Send" arguments="action=send" hint-inputId="r"/>
    <action content="👍"   arguments="action=thumbsup"/>
    <action content="😂"   arguments="action=lol"/>
  </actions>
</toast>`,
        tag: 'msg-alex', group: 'demo',
    },
});
await delay(10000);

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Stacked burst — 5 "emails" arriving at once
// ═══════════════════════════════════════════════════════════════════════════════

console.log('6. Email burst — 5 in rapid succession');

const emails = [
    { from: 'GitHub',    subj: 'Your PR was merged 🎉',              body: 'feat: add linux support — merged into main' },
    { from: 'THYPRESS',  subj: 'Deployment succeeded ✅',            body: 'notifier-hook-demo.thypress.org is live' },
    { from: 'npm',       subj: 'Package published 📦',               body: 'notifier-hook@1.0.0 is now on the registry' },
    { from: 'Boss',      subj: 'Nice work on the daemon',            body: 'That Rust IPC stuff is actually pretty clever' },
    { from: 'You',       subj: 'Reminder: touch grass today',        body: 'You have been at this for 6 hours. Go outside.' },
];

for (const [i, e] of emails.entries()) {
    await show({ title: `${e.from}: ${e.subj}`, body: e.body, sound: i === 0 });
    await delay(1200);
}
await delay(4000);

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Alarm — the dramatic finale
// ═══════════════════════════════════════════════════════════════════════════════

console.log('7. Alarm scenario — the finale');

const alarmId = 'demo-alarm';
pending[alarmId] = { resolve: ()=>{}, reject: console.error };
send({ action: 'show', id: alarmId, title: '', windows: {
    xml: `<toast scenario="alarm">
  <visual><binding template="ToastGeneric">
    <text>⏰  That's a wrap</text>
    <text>notifier-hook demo complete. Every feature shown. Zero native compilation.</text>
  </binding></visual>
  <actions>
    <action content="Nice 👌" arguments="action=nice"   activationType="foreground"/>
    <action content="Dismiss"  arguments="action=dismiss" activationType="system"/>
  </actions>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm2" loop="false"/>
</toast>`,
    tag: 'finale', group: 'demo',
}});

await delay(6000);
dismiss(alarmId);

// ─── Done ──────────────────────────────────────────────────────────────────────

await delay(1200);
console.log('\nAll done. Bye!!!');
await quit();
process.exit(0);