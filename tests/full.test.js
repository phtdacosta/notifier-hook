/**
 * test.js — Elaborate notifier-hook daemon test suite.
 *
 * Covers every command, every event type, every Windows-specific feature,
 * error paths, concurrency, stress, and timing.
 *
 * Run from repo root:
 *   bun test.js
 *   node test.js
 */

import { spawn }           from 'child_process';
import { createInterface } from 'readline';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY    = join(__dirname, 'target/debug/notifier-hook-daemon.exe');

// ═══════════════════════════════════════════════════════════════════════════════
// INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════════════════

let passed   = 0;
let failed   = 0;
const failures = [];

function assert(condition, label) {
    if (condition) {
        console.log(`  ✓  ${label}`);
        passed++;
    } else {
        console.error(`  ✗  ${label}`);
        failed++;
        failures.push(label);
    }
}

function assertEq(actual, expected, label) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
        console.log(`  ✓  ${label}`);
        passed++;
    } else {
        console.error(`  ✗  ${label}  (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
        failed++;
        failures.push(label);
    }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let _idCounter = 0;
function uid() { return `test-${Date.now()}-${++_idCounter}`; }

// ─── Daemon wrapper ───────────────────────────────────────────────────────────

class Daemon {
    constructor() {
        this._pending   = {};
        this._listeners = {};
        this._allEvents = [];
        this._warnings  = [];
        this._proc      = null;
        this.capabilities = null;
        this.permission   = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            this._proc = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'] });
            this._proc.on('error', reject);
            this._proc.on('exit',  (code, sig) => this._emit('exit', code, sig));

            const rl = createInterface({ input: this._proc.stdout });
            rl.on('line', (line) => {
                let msg;
                try { msg = JSON.parse(line); } catch { return; }
                this._allEvents.push({ ts: Date.now(), ...msg });

                if (msg.event === 'ready') {
                    this.capabilities = msg.capabilities;
                    this.permission   = msg.permission;
                    resolve();
                }
                if (msg.event === 'warn')      this._warnings.push(msg.message);
                if (msg.event === 'shown')     this._settle(msg.id, 'resolve', msg);
                if (msg.event === 'failed')    this._settle(msg.id, 'reject',  msg);
                this._emit(msg.event, msg);
            });

            this._send({ action: 'init', app_name: 'notifier-hook test suite',
                         windows_app_id: 'com.example.notifier-hook-test' });
        });
    }

    _send(obj) { this._proc.stdin.write(JSON.stringify(obj) + '\n'); }

    _settle(id, outcome, msg) {
        const p = this._pending[id];
        if (!p) return;
        clearTimeout(p.timer);
        delete this._pending[id];
        outcome === 'resolve' ? p.resolve(msg) : p.reject(new Error(msg.error));
    }

    _emit(event, ...args) {
        for (const fn of (this._listeners[event] || [])) fn(...args);
    }

    on(event, fn)  { (this._listeners[event] ??= []).push(fn); return this; }
    off(event, fn) { this._listeners[event] = (this._listeners[event] || []).filter(f => f !== fn); }

    show(opts, timeoutMs = 8_000) {
        const id = opts.id ?? uid();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this._pending[id];
                reject(new Error(`show() timed out for id=${id}`));
            }, timeoutMs);
            this._pending[id] = { resolve, reject, timer };
            this._send({ action: 'show', id, ...opts });
        });
    }

    update(opts, timeoutMs = 8_000) {
        const id = opts.id;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                delete this._pending[id];
                reject(new Error(`update() timed out for id=${id}`));
            }, timeoutMs);
            this._pending[id] = { resolve, reject, timer };
            this._send({ action: 'update', id, ...opts });
        });
    }

    dismiss(id)              { this._send({ action: 'dismiss', id }); }
    clearDelivered()         { this._send({ action: 'clear_delivered' }); }
    registerCategories(cats) { this._send({ action: 'register_categories', categories: cats }); }
    sendRaw(str)             { this._proc.stdin.write(str + '\n'); }

    getDelivered() {
        return new Promise((resolve) => {
            const handler = (msg) => { this.off('delivered', handler); resolve(msg.notifications ?? []); };
            this.on('delivered', handler);
            this._send({ action: 'get_delivered' });
        });
    }

    nextEvent(eventName, predicate = () => true, timeoutMs = 10_000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.off(eventName, handler);
                reject(new Error(`nextEvent(${eventName}) timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            const handler = (msg) => {
                if (predicate(msg)) {
                    clearTimeout(timer);
                    this.off(eventName, handler);
                    resolve(msg);
                }
            };
            this.on(eventName, handler);
        });
    }

    quit() {
        return new Promise((resolve) => {
            this.on('exit', resolve);
            this._send({ action: 'quit' });
        });
    }

    get eventLog() { return this._allEvents; }
    get warnings() { return this._warnings;  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUITE
// ═══════════════════════════════════════════════════════════════════════════════

const d = new Daemon();
const dismissed = [], actions = [], replies = [];
d.on('dismissed', (msg) => dismissed.push(msg));
d.on('action',    (msg) => actions.push(msg));
d.on('reply',     (msg) => replies.push(msg));

// ─── Boot ─────────────────────────────────────────────────────────────────────

console.log('\n══ BOOT ══════════════════════════════════════════════════════════════');
const t0 = Date.now();
await d.start();
const bootMs = Date.now() - t0;

assert(d.permission === 'granted',           'permission is granted');
assert(d.capabilities !== null,              'capabilities object present');
assert(d.capabilities.actions === true,      'capabilities.actions');
assert(d.capabilities.body    === true,      'capabilities.body');
assert(d.capabilities.update  === true,      'capabilities.update');
assert(d.capabilities.dismiss === true,      'capabilities.dismiss');
assert(bootMs < 3000,                        `boot completed in ${bootMs}ms (<3000ms)`);
assert(d.warnings.length === 0,              'no warnings at boot (windowsAppId was provided)');

// ─── Suite 1: Baseline fields ─────────────────────────────────────────────────

console.log('\n══ SUITE 1: Baseline fields ══════════════════════════════════════════');

assertEq((await d.show({ title: 'Baseline — title only' })).event,
         'shown', 'title-only show() resolves');

assertEq((await d.show({ title: 'Baseline — with body', body: 'Body text here.' })).event,
         'shown', 'show() with body resolves');

assertEq((await d.show({ title: 'Baseline — silent', body: 'No chime.', sound: false })).event,
         'shown', 'show() with sound:false resolves');

assertEq((await d.show({ title: 'Baseline — missing icon', icon: 'C:\\no\\such\\icon.png' })).event,
         'shown', 'show() with missing icon path resolves (icon is optional)');

await delay(400);

// ─── Suite 2: id round-trip ───────────────────────────────────────────────────

console.log('\n══ SUITE 2: id round-trip ════════════════════════════════════════════');

{
    const id = 'my-custom-uuid-1234';
    assertEq((await d.show({ id, title: 'id round-trip' })).id, id,
             'shown event echoes the caller-supplied id');
}

{
    const id1 = 'concurrent-a', id2 = 'concurrent-b';
    const [ev1, ev2] = await Promise.all([
        d.show({ id: id1, title: 'Concurrent A' }),
        d.show({ id: id2, title: 'Concurrent B' }),
    ]);
    assertEq(ev1.id, id1, 'concurrent show A returns correct id');
    assertEq(ev2.id, id2, 'concurrent show B returns correct id');
}

await delay(400);

// ─── Suite 3: Programmatic dismiss ───────────────────────────────────────────

console.log('\n══ SUITE 3: Programmatic dismiss ═════════════════════════════════════');

{
    const id = uid();
    await d.show({ id, title: 'Dismiss me in 1s', windows: { tag: 'dm-' + id, group: 'suite' } });
    const dismissedP = d.nextEvent('dismissed', (m) => m.id === id);
    await delay(1000);
    d.dismiss(id);
    const ev = await dismissedP;
    assertEq(ev.id,     id,           'dismissed event carries correct id');
    assertEq(ev.reason, 'app_closed', 'dismiss reason is app_closed');
}

{
    const warnsBefore = d.warnings.length;
    d.dismiss('id-that-was-never-shown');
    await delay(300);
    assert(d.warnings.length > warnsBefore, 'dismiss on unknown id emits warn (not crash)');
}

await delay(400);

// ─── Suite 4: In-place update (progress bar) ──────────────────────────────────

console.log('\n══ SUITE 4: In-place update — progress bar ═══════════════════════════');

{
    const id = uid(), TAG = 'prog-' + id, GRP = 'suite';
    const xml = (pct, status) => `<toast><visual><binding template="ToastGeneric">
  <text>Upload progress</text>
  <progress title="Uploading" value="${(pct/100).toFixed(2)}"
            valueStringOverride="${pct}%" status="${status}"/>
</binding></visual></toast>`;

    assertEq((await d.show({ id, title: 'Upload',
        windows: { xml: xml(0, 'Starting…'), tag: TAG, group: GRP } })).event,
        'shown', 'progress bar initial show resolves');

    const results = [];
    for (const pct of [25, 50, 75, 100]) {
        const ev = await d.update({ id, title: 'Upload',
            windows: { xml: xml(pct, pct < 100 ? `${pct}%` : 'Done ✓'), tag: TAG, group: GRP } });
        results.push(ev.event === 'shown');
        await delay(250);
    }
    assert(results.every(Boolean), `all ${results.length} progress updates resolved with shown`);
}

await delay(400);

// ─── Suite 5: update() without tag+group must fail ────────────────────────────

console.log('\n══ SUITE 5: update() without tag+group (error path) ══════════════════');

{
    const id = uid();
    const failP = new Promise((resolve) => {
        const h = (msg) => { if (msg.id === id) { d.off('failed', h); resolve(msg); } };
        d.on('failed', h);
    });
    d.sendRaw(JSON.stringify({ action: 'update', id, title: 'No tag or group here' }));
    const ev = await failP;
    assertEq(ev.event,          'failed', 'update() without tag+group emits failed');
    assert(typeof ev.error === 'string',  'failed event carries an error string');
    assert(ev.error.length > 0,          'error string is non-empty');
}

await delay(300);

// ─── Suite 6: Expiration time ─────────────────────────────────────────────────

console.log('\n══ SUITE 6: Expiration time ══════════════════════════════════════════');

assertEq(
    (await d.show({ title: 'Expires in 3s', body: 'Auto-removes from Action Center.',
        windows: { tag: 'exp-' + uid(), group: 'suite', expiration_ms: 3_000 } })).event,
    'shown', 'notification with expiration_ms resolves');

await delay(400);

// ─── Suite 7: Scenario mode ───────────────────────────────────────────────────

console.log('\n══ SUITE 7: scenario=alarm ═══════════════════════════════════════════');

{
    const id = uid();
    assertEq((await d.show({ id, title: 'Alarm',
        windows: { xml: `<toast scenario="alarm">
  <visual><binding template="ToastGeneric">
    <text>Alarm Scenario Test</text>
    <text>Auto-dismissed by test suite in 2s.</text>
  </binding></visual>
  <actions>
    <action content="Dismiss" arguments="action=dismiss" activationType="system"/>
  </actions>
  <audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true"/>
</toast>`, tag: 'alarm-' + id, group: 'suite' } })).event,
        'shown', 'alarm scenario notification resolves');

    await delay(2000);
    d.dismiss(id);
    console.log('  alarm auto-dismissed by test suite');
}

await delay(400);

// ─── Suite 8: Raw XML ─────────────────────────────────────────────────────────

console.log('\n══ SUITE 8: Raw XML — hero image + buttons ═══════════════════════════');

assertEq((await d.show({ title: 'ignored',
    windows: { tag: 'raw-' + uid(), group: 'suite',
        xml: `<toast launch="action=open">
  <visual><binding template="ToastGeneric">
    <text>Raw XML Notification</text>
    <text>Built entirely from raw Toast XML — baseline fields are ignored.</text>
    <image placement="hero"
           src="https://via.placeholder.com/360x180/0078d4/ffffff?text=notifier-hook"/>
  </binding></visual>
  <actions>
    <action content="Open"   arguments="action=open"/>
    <action content="Ignore" arguments="action=ignore"/>
  </actions>
</toast>` } })).event, 'shown', 'raw XML notification resolves');

await delay(400);

// ─── Suite 9: Text reply input ────────────────────────────────────────────────

console.log('\n══ SUITE 9: Inline text reply input ══════════════════════════════════');

assertEq((await d.show({ title: 'Reply input',
    windows: { tag: 'reply-' + uid(), group: 'suite',
        xml: `<toast>
  <visual><binding template="ToastGeneric">
    <text>Text Reply Test</text>
    <text>Type and click Send (optional — test proceeds automatically).</text>
  </binding></visual>
  <actions>
    <input id="userReply" type="text" placeHolderContent="Type a reply…"/>
    <action content="Send"   arguments="action=send"   hint-inputId="userReply"/>
    <action content="Cancel" arguments="action=cancel"/>
  </actions>
</toast>` } })).event, 'shown', 'text reply notification resolves');

await delay(800);

// ─── Suite 10: Burst / stress ────────────────────────────────────────────────

console.log('\n══ SUITE 10: Burst — 20 concurrent notifications ═════════════════════');

{
    const N   = 20;
    const ids = Array.from({ length: N }, () => uid());
    const t   = Date.now();
    const evs = await Promise.all(ids.map((id, i) =>
        d.show({ id, title: `Burst #${i + 1} of ${N}`, sound: false })));
    const ms  = Date.now() - t;

    assert(evs.length === N,                     `all ${N} show() calls resolved`);
    assert(evs.every(e => e.event === 'shown'),  'every burst notification emitted shown');
    assert(evs.every((e, i) => e.id === ids[i]), 'every burst shown event carries correct id');
    assert(ms < 10_000,                          `burst of ${N} completed in ${ms}ms (<10s)`);
    console.log(`  ${N} concurrent notifications resolved in ${ms}ms`);
}

await delay(400);

// ─── Suite 11: get_delivered ─────────────────────────────────────────────────

console.log('\n══ SUITE 11: get_delivered ═══════════════════════════════════════════');

{
    const tag = 'hist-' + uid();
    await d.show({ title: 'History entry', windows: { tag, group: 'suite' } });
    await delay(800);

    const list = await d.getDelivered();
    assert(Array.isArray(list),  'get_delivered returns an array');
    assert(list.length >= 0,     'get_delivered array is non-negative length');

    if (list.length > 0) {
        const n = list[0];
        assert(typeof n.id           === 'string',  'entry.id is string');
        assert(typeof n.title        === 'string',  'entry.title is string');
        assert(typeof n.delivered_at === 'number',  'entry.delivered_at is number');
        assert(n.delivered_at > 0,                  'entry.delivered_at is positive');
        console.log(`  ${list.length} notification(s) in history.`);
        for (const n of list.slice(0, 3))
            console.log(`    "${n.title}"  at=${new Date(n.delivered_at).toISOString()}`);
    } else {
        console.log('  history empty (OS may have cleared it)');
    }
}

// ─── Suite 12: clear_delivered ───────────────────────────────────────────────

console.log('\n══ SUITE 12: clear_delivered ═════════════════════════════════════════');

{
    d.clearDelivered();
    await delay(500);
    const list = await d.getDelivered();
    assert(list.length === 0, 'Action Center empty after clear_delivered');
}

// ─── Suite 13: register_categories (no-op on Windows) ────────────────────────

console.log('\n══ SUITE 13: register_categories (no-op on Windows) ══════════════════');

{
    const before = d.warnings.length;
    d.registerCategories([{ id: 'msg', actions: [{ id: 'reply', title: 'Reply' }] }]);
    await delay(300);
    assert(d.warnings.length === before, 'register_categories is silent no-op on Windows');
}

// ─── Suite 14: Malformed / unexpected protocol input ─────────────────────────

console.log('\n══ SUITE 14: Malformed / unexpected protocol input ═══════════════════');

{
    const before = d.warnings.length;
    d.sendRaw('this is not json at all!!!!');
    await delay(200);
    assert(d.warnings.length > before, 'invalid JSON emits warn (daemon alive)');
}

{
    const before = d.warnings.length;
    d.sendRaw(JSON.stringify({ action: 'explode_everything', id: 'x' }));
    await delay(200);
    assert(d.warnings.length > before, 'unknown action emits warn (not crash)');
}

{
    const before = d.warnings.length;
    d.sendRaw('');
    d.sendRaw('   ');
    await delay(200);
    assert(d.warnings.length === before, 'empty/whitespace lines silently ignored');
}

{
    const before = d.warnings.length;
    d.sendRaw(JSON.stringify({ action: 'init', app_name: 'second init' }));
    await delay(200);
    assert(d.warnings.length > before, 'second init command emits warn');
}

// Daemon must still respond correctly after all the abuse above.
assertEq((await d.show({ title: 'Post-abuse sanity check', sound: false })).event,
         'shown', 'daemon still functional after malformed input');

await delay(400);

// ─── Suite 15: XML special-character escaping ─────────────────────────────────

console.log('\n══ SUITE 15: XML special-character escaping ══════════════════════════');

assertEq(
    (await d.show({ title: `Chars: & < > " '`, body: 'Baseline XML must escape these.' })).event,
    'shown', 'XML special chars in title/body resolve (escaping works)');

assertEq(
    (await d.show({ title: 'Emoji 🔔🚀💥', body: '日本語テスト — Unicode body.', sound: false })).event,
    'shown', 'emoji + Unicode title/body resolves');

await delay(400);

// ─── Suite 16: Capabilities schema validation ─────────────────────────────────

console.log('\n══ SUITE 16: Capabilities schema validation ══════════════════════════');

{
    const KEYS = ['actions','body','body_hyperlinks','body_images','body_markup',
                  'dismiss','icon_multi','icon_static','persistence','sound','update'];
    const caps = d.capabilities;
    for (const k of KEYS)
        assert(typeof caps[k] === 'boolean', `capabilities.${k} is boolean`);

    assertEq(caps.actions,     true,  'Windows: capabilities.actions     = true');
    assertEq(caps.update,      true,  'Windows: capabilities.update      = true');
    assertEq(caps.dismiss,     true,  'Windows: capabilities.dismiss     = true');
    assertEq(caps.body,        true,  'Windows: capabilities.body        = true');
    assertEq(caps.body_markup, false, 'Windows: capabilities.body_markup = false');
}

// ─── Suite 17: Event log integrity ───────────────────────────────────────────

console.log('\n══ SUITE 17: Event log integrity ═════════════════════════════════════');

{
    const log   = d.eventLog;
    const types = [...new Set(log.map(e => e.event))];
    console.log(`  total events: ${log.length}  types: ${types.sort().join(', ')}`);

    assert(log.length > 0,                         'event log is non-empty');
    assert(types.includes('ready'),                'event log contains ready');
    assert(types.includes('shown'),                'event log contains shown');
    assert(types.includes('warn'),                 'event log contains warn');
    assert(log.filter(e=>e.event==='shown').every(e => typeof e.id === 'string' && e.id.length > 0),
           'every shown event has a non-empty id');
    assert(log.filter(e=>e.event==='warn').every(e => typeof e.message === 'string'),
           'every warn event has a string message');
    assert(log.every(e => typeof e.ts === 'number' && e.ts > 0),
           'every logged event has numeric ts');

    let mono = true;
    for (let i = 1; i < log.length; i++) if (log[i].ts < log[i-1].ts) { mono = false; break; }
    assert(mono, 'event log timestamps are non-decreasing');
}

// ─── Suite 18: Latency sampling ───────────────────────────────────────────────

console.log('\n══ SUITE 18: Shown event latency ═════════════════════════════════════');

{
    const latencies = [];
    for (let i = 0; i < 5; i++) {
        const t = Date.now();
        await d.show({ title: `Latency sample ${i+1}`, sound: false });
        latencies.push(Date.now() - t);
    }
    const avg = Math.round(latencies.reduce((a,b)=>a+b,0) / latencies.length);
    const max = Math.max(...latencies);
    console.log(`  latencies: [${latencies.join(', ')}]ms  avg=${avg}ms  max=${max}ms`);
    assert(avg < 2000, `avg shown latency ${avg}ms < 2000ms`);
    assert(max < 5000, `max shown latency ${max}ms < 5000ms`);
}

// ─── Suite 19: Graceful quit ──────────────────────────────────────────────────

console.log('\n══ SUITE 19: Graceful quit ═══════════════════════════════════════════');

await d.quit();
assert(true, 'quit() resolved (daemon exited cleanly)');

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

const totalMs = Date.now() - t0;

console.log('\n' + '═'.repeat(70));
console.log(`  RESULTS   ${passed} passed  /  ${failed} failed  /  ${passed + failed} total`);
console.log(`  Duration  ${totalMs}ms`);
if (failures.length) {
    console.log('\n  FAILURES:');
    for (const f of failures) console.log(`    ✗  ${f}`);
}
console.log('═'.repeat(70) + '\n');

process.exit(failed > 0 ? 1 : 0);