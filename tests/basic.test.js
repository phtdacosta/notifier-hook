/**
 * test.js — run from repo root with: bun test.js  OR  node test.js
 * Bypasses all package resolution — spawns the daemon binary directly.
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BINARY = join(__dirname, 'target/debug/notifier-hook-daemon.exe');

// ── Spawn ──────────────────────────────────────────────────────────────────────
const daemon = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'inherit'] });

daemon.on('error', (e) => { console.error('[spawn error]', e.message); process.exit(1); });
daemon.on('exit',  (code, sig) => console.log(`[exit] code=${code} signal=${sig}`));

// ── Read newline-delimited JSON from stdout ────────────────────────────────────
const rl = createInterface({ input: daemon.stdout });
const pending = {};

rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('[raw]', line); return; }
    console.log('[event]', JSON.stringify(msg));

    if (msg.event === 'ready') onReady();
    if (msg.event === 'shown' && pending[msg.id]) {
        pending[msg.id](msg.id);
        delete pending[msg.id];
    }
});

// ── Send a command ─────────────────────────────────────────────────────────────
function send(obj) {
    daemon.stdin.write(JSON.stringify(obj) + '\n');
}

function show(opts) {
    return new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        pending[id] = resolve;
        send({ action: 'show', id, ...opts });
    });
}

function quit() {
    return new Promise((resolve) => {
        daemon.on('exit', resolve);
        send({ action: 'quit' });
    });
}

// ── Test sequence ──────────────────────────────────────────────────────────────
async function onReady() {
    console.log('\n→ showing notification…');
    const id = await show({
        title: 'notifier-hook works',
        body:  'Daemon is alive and talking JSON.',
    });
    console.log('  shown, id:', id);

    setTimeout(async () => {
        console.log('\n→ quitting…');
        await quit();
        process.exit(0);
    }, 4000);
}

// ── Init ───────────────────────────────────────────────────────────────────────
send({ action: 'init', app_name: 'notifier-hook test' });