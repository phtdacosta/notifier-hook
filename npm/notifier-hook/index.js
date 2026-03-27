'use strict';

// ─── Dependencies ──────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');
const { spawn }        = require('child_process');
const { randomUUID }   = require('crypto');
const path             = require('path');

// ─── Binary resolution ────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the pre-compiled Rust daemon binary for the
 * current platform + architecture combination.
 *
 * Strategy:
 *   1. Derive the scoped platform package name from process.platform + arch.
 *   2. Resolve the package directory via require.resolve('pkg/package.json').
 *      This works in every module system that honours node_modules resolution
 *      (CommonJS, bundlers, Bun) without any binary-path shim file needed in
 *      each platform package.
 *   3. Append the known binary filename (platform-conditional).
 *
 * optionalDependencies in package.json ensures only the matching platform
 * package is installed under normal circumstances. The --ignore-platform flag
 * allows CI / cross-compile scenarios to install a specific package manually.
 *
 * @returns {string} Absolute path to the daemon binary.
 * @throws  {Error}  Clear, actionable message if the platform package is absent.
 */
function getBinaryPath() {
    const platform   = process.platform; // 'win32' | 'darwin' | 'linux'
    const arch       = process.arch;     // 'x64'   | 'arm64'
    const pkg        = `@phtdacosta/notifier-hook-${platform}-${arch}`;
    const binaryName = platform === 'win32'
        ? 'notifier-hook-daemon.exe'
        : 'notifier-hook-daemon';

    let pkgDir;
    try {
        // require.resolve('pkg/package.json') → absolute path to package.json.
        // path.dirname() gives us the package root directory.
        pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
    } catch {
        throw new Error(
            `notifier-hook: native binary not found.\n` +
            `Expected platform package '${pkg}' to be installed.\n` +
            `\n` +
            `If you are on a supported platform, reinstall:\n` +
            `  npm install\n` +
            `\n` +
            `To force-install a specific platform binary (e.g. in CI):\n` +
            `  npm install ${pkg} --ignore-platform\n` +
            `\n` +
            `Supported platforms: win32-x64, win32-arm64, ` +
            `darwin-x64, darwin-arm64, linux-x64, linux-arm64`
        );
    }

    return path.join(pkgDir, binaryName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Milliseconds to wait for a getDelivered() response before rejecting. */
const GET_DELIVERED_TIMEOUT_MS = 10_000;

// ═══════════════════════════════════════════════════════════════════════════════
// Notifier
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Native system notification client.
 *
 * Spawns a pre-compiled Rust daemon as a child process and communicates with
 * it via newline-delimited JSON over stdin / stdout. The daemon owns all
 * platform-specific OS integration; this class is a thin EventEmitter wrapper
 * that exposes a clean Promise-based API.
 *
 * ## Lifecycle
 *
 *   1. Construct:  `const n = createNotifier({ appName: 'My App' })`
 *   2. Listen:     `n.on('action', handler)` — attach before start()
 *   3. Start:      `await n.start()` — spawns daemon, waits for ready
 *   4. Use:        `await n.show({ title: 'Hello' })`
 *   5. Shutdown:   `await n.quit()` — graceful, or `n.destroy()` — immediate
 *
 * ## Events
 *
 *   'ready'     — daemon up, OS permission resolved
 *   'action'    — user clicked a notification action button
 *   'reply'     — user submitted an inline text-input reply
 *   'dismissed' — notification dismissed for any reason
 *   'failed'    — OS rejected a show / update command
 *   'delivered' — response payload from getDelivered()
 *   'warn'      — non-fatal daemon warning (never rejects a Promise)
 *   'exit'      — daemon process exited
 *   'error'     — protocol-level error (malformed JSON from daemon)
 *
 * ⚠️  Per Node.js convention, an unhandled 'error' event crashes the process.
 *     Always attach: `notifier.on('error', handler)`
 *
 * @extends EventEmitter
 */
class Notifier extends EventEmitter {

    /**
     * @param {object} [options={}]
     * @param {string} [options.appName]
     *   Human-readable application name.
     *   Windows: Action Center attribution text (fallback, when windowsAppId absent).
     *   Linux:   passed as app_name to every org.freedesktop.Notifications Notify call.
     *   macOS:   informational only (OS uses bundle name).
     *   Default: 'notifier-hook'
     *
     * @param {string} [options.windowsAppId]
     *   Windows App User Model ID (AUMID). When provided, the daemon registers
     *   it in HKCU\Software\Classes\AppUserModelId\{id} on first run, granting
     *   proper attribution (app name) in Action Center.
     *   When omitted, notifications work but are attributed to "Windows PowerShell".
     *   Example: "com.yourcompany.yourapp"
     *   macOS + Linux: ignored entirely.
     */
    constructor(options = {}) {
        super();

        /** @private @type {{ appName?: string, windowsAppId?: string }} */
        this._options = options;

        /** @private @type {import('child_process').ChildProcess | null} */
        this._daemon = null;

        /**
         * Pending show() / update() Promises keyed by notification UUID.
         * Resolved by 'shown' event; rejected by 'failed' event or daemon exit.
         * @private @type {Map<string, { resolve: Function, reject: Function }>}
         */
        this._pending = new Map();

        /**
         * FIFO queue of pending getDelivered() resolvers.
         *
         * A queue is used instead of `once('delivered')` to handle concurrent
         * getDelivered() calls correctly. Each incoming 'delivered' event pops
         * exactly one resolver — FIFO ordering matches request ordering.
         * A naive once() approach would cause the first 'delivered' response
         * to resolve ALL concurrent callers with the same payload.
         *
         * @private
         * @type {Array<{ resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>}
         */
        this._deliveredQueue = [];

        /**
         * Idempotency guard for start(). Concurrent calls all receive this
         * same Promise instance so only one daemon is ever spawned.
         * Reset to null on daemon exit so start() can be called again.
         * @private @type {Promise<void> | null}
         */
        this._starting = null;

        /**
         * stdout line-buffering accumulator.
         *
         * A single 'data' event from the daemon may contain:
         *   • a partial line                  → buffer and wait for more
         *   • exactly one complete line       → parse immediately
         *   • multiple complete lines         → split and parse each
         *   • complete line(s) + partial tail → parse complete, buffer tail
         *
         * Splitting naively on the raw chunk boundary produces intermittent
         * JSON parse failures under load. Always accumulate here.
         *
         * @private @type {string}
         */
        this._buffer = '';

        /**
         * Platform capability flags. Populated from the 'ready' event after
         * start() resolves. Gate advanced features on these values.
         * null before start() resolves.
         * @type {object | null}
         */
        this.capabilities = null;

        /**
         * System notification permission state.
         * 'granted' | 'denied' | 'not_determined'
         * Windows + Linux: always 'granted'.
         * macOS: actual system authorisation result — start() waits for it.
         * null before start() resolves.
         * @type {string | null}
         */
        this.permission = null;
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Spawn the Rust daemon and wait for it to signal readiness.
     *
     * Idempotent — safe to call multiple times or concurrently. All callers
     * receive the same Promise and the single daemon process.
     *
     * macOS: resolves only after the system notification permission dialog is
     * answered. On first run this may take 30+ seconds.
     *
     * After start() resolves, `this.capabilities` and `this.permission` are set.
     *
     * @returns {Promise<void>}
     * @throws  {Error} Binary not found, spawn failure, or daemon exited before ready.
     */
    start() {
        if (this._starting) return this._starting;

        this._starting = new Promise((resolve, reject) => {

            // ── Resolve binary path ───────────────────────────────────────────
            let binaryPath;
            try {
                binaryPath = getBinaryPath();
            } catch (err) {
                this._starting = null;
                return reject(err);
            }

            // ── Spawn daemon ──────────────────────────────────────────────────
            // stdin : pipe    — we write newline-delimited JSON commands
            // stdout: pipe    — we read newline-delimited JSON events
            // stderr: inherit — daemon errors / Rust panics pass through
            //                   to the parent process stderr unchanged,
            //                   keeping the JSON stream on stdout clean.
            this._daemon = spawn(binaryPath, [], {
                stdio: ['pipe', 'pipe', 'inherit'],
            });

            // ── Spawn error ───────────────────────────────────────────────────
            this._daemon.on('error', (err) => {
                this._starting = null;
                const wrapped = new Error(
                    `notifier-hook: daemon spawn failed: ${err.message}`
                );
                this._rejectAllPending(wrapped);
                reject(wrapped);
            });

            // ── Daemon exit ───────────────────────────────────────────────────
            // Reset _starting so start() can be called again after an exit.
            this._daemon.on('exit', (code, signal) => {
                this._daemon   = null;
                this._starting = null;
                this.emit('exit', code, signal);

                // If exit arrives before 'ready', reject the start() Promise.
                // If exit arrives after 'ready', this reject() is a no-op
                // because Promise settlement is idempotent.
                reject(new Error(
                    `notifier-hook: daemon exited before ready ` +
                    `(code=${code}, signal=${signal})`
                ));

                this._rejectAllPending(
                    new Error('notifier-hook: daemon exited unexpectedly')
                );
            });

            // ── stdout line buffering ─────────────────────────────────────────
            // Accumulate chunks and split on '\n'. Never split on the raw
            // chunk boundary — a chunk may contain a partial line.
            this._daemon.stdout.on('data', (chunk) => {
                this._buffer += chunk.toString();

                const lines = this._buffer.split('\n');

                // The last element is the incomplete tail (or '' if the chunk
                // ended with '\n'). Retain it for the next chunk.
                this._buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    let msg;
                    try {
                        msg = JSON.parse(trimmed);
                    } catch {
                        this.emit(
                            'error',
                            new Error(
                                `notifier-hook: malformed JSON from daemon: ${trimmed}`
                            )
                        );
                        continue;
                    }

                    this._handleMessage(msg);
                }
            });

            // ── Wait for ready ────────────────────────────────────────────────
            this.once('ready', () => resolve());

            // ── Send init — MUST be the first command ─────────────────────────
            // The daemon blocks on stdin waiting for this before any OS work.
            // Sending anything else first is a protocol violation.
            this._write({
                action:         'init',
                app_name:       this._options.appName      ?? 'notifier-hook',
                windows_app_id: this._options.windowsAppId ?? null,
            });
        });

        return this._starting;
    }

    /**
     * Immediately kill the daemon process (SIGKILL) and reject all in-flight
     * Promises. Synchronous — does not wait for the OS to confirm exit.
     *
     * The 'exit' event fires when the OS confirms the process is gone.
     * After destroy() you may call start() again to restart the daemon.
     *
     * For a graceful shutdown that allows the daemon to clean up prefer quit().
     */
    destroy() {
        if (this._daemon) {
            this._daemon.kill('SIGKILL');
            this._daemon   = null;
            this._starting = null;
        }
        this._buffer = '';
        this._rejectAllPending(
            new Error('notifier-hook: destroy() called — daemon killed')
        );
    }

    // ─── Message handler ───────────────────────────────────────────────────────

    /**
     * Route a parsed daemon event object to the appropriate Promise resolver
     * or EventEmitter emission.
     *
     * Called once per complete JSON line received from daemon stdout.
     *
     * @private
     * @param {object} msg Parsed JSON event object.
     */
    _handleMessage(msg) {
        switch (msg.event) {

            // ── ready ─────────────────────────────────────────────────────────
            case 'ready':
                this.capabilities = msg.capabilities ?? null;
                this.permission   = msg.permission   ?? 'granted';
                this.emit('ready', {
                    capabilities: this.capabilities,
                    permission:   this.permission,
                });
                break;

            // ── shown ─────────────────────────────────────────────────────────
            // "OS accepted the command" ≠ "user saw the notification".
            // The notification may still be queued, rate-limited, or suppressed
            // by Focus / Do Not Disturb / notification server policy.
            case 'shown':
                if (this._pending.has(msg.id)) {
                    this._pending.get(msg.id).resolve(msg.id);
                    this._pending.delete(msg.id);
                }
                break;

            // ── failed ────────────────────────────────────────────────────────
            case 'failed': {
                const err = new Error(msg.error ?? 'unknown error from daemon');
                if (this._pending.has(msg.id)) {
                    this._pending.get(msg.id).reject(err);
                    this._pending.delete(msg.id);
                }
                // Emit 'failed' for passive listeners regardless of whether
                // the caller awaited the show() Promise.
                this.emit('failed', msg.id, msg.error ?? 'unknown error');
                break;
            }

            // ── action ────────────────────────────────────────────────────────
            case 'action':
                this.emit('action', msg.id, msg.action_id);
                break;

            // ── reply ─────────────────────────────────────────────────────────
            case 'reply':
                this.emit('reply', msg.id, msg.action_id, msg.text);
                break;

            // ── dismissed ─────────────────────────────────────────────────────
            case 'dismissed':
                this.emit('dismissed', msg.id, msg.reason);
                break;

            // ── delivered ─────────────────────────────────────────────────────
            // Pop exactly one queued resolver (FIFO). Also emit the event so
            // passive listeners receive it regardless of queue state.
            case 'delivered': {
                const notifications = msg.notifications ?? [];
                if (this._deliveredQueue.length > 0) {
                    const entry = this._deliveredQueue.shift();
                    clearTimeout(entry.timer);
                    entry.resolve(notifications);
                }
                this.emit('delivered', notifications);
                break;
            }

            // ── warn ──────────────────────────────────────────────────────────
            // Never rejects a Promise. Attach a 'warn' listener in development
            // for visibility into daemon decisions and configuration issues.
            case 'warn':
                this.emit('warn', msg.message);
                break;

            // ── forward-compatible: unknown event types ────────────────────────
            // Future daemon versions may emit new event types. Pass them through
            // so callers can handle them without a library update.
            default:
                this.emit(msg.event, msg);
                break;
        }
    }

    // ─── Internal helpers ──────────────────────────────────────────────────────

    /**
     * Serialise `obj` to JSON and write it to daemon stdin followed by '\n'.
     *
     * @private
     * @param  {object} obj Command object. Must be JSON-serialisable.
     * @throws {Error}  If the daemon is not running.
     */
    _write(obj) {
        if (!this._daemon?.stdin?.writable) {
            throw new Error(
                'notifier-hook: daemon is not running. Call start() first.'
            );
        }
        this._daemon.stdin.write(JSON.stringify(obj) + '\n');
    }

    /**
     * Reject all pending show() / update() Promises and all queued
     * getDelivered() Promises with the given error.
     *
     * Called on daemon exit, spawn failure, and destroy().
     *
     * @private
     * @param {Error} err
     */
    _rejectAllPending(err) {
        for (const [, pending] of this._pending) {
            pending.reject(err);
        }
        this._pending.clear();

        for (const entry of this._deliveredQueue) {
            clearTimeout(entry.timer);
            entry.reject(err);
        }
        this._deliveredQueue = [];
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    /**
     * Display a notification.
     *
     * Resolves with the notification id string once the OS has accepted the
     * command. "OS accepted" ≠ "user saw it" — the notification may still be
     * queued, rate-limited, or suppressed by Focus / Do Not Disturb.
     *
     * Rejects with the raw OS error string if the OS returns an error.
     *
     * @param  {object}  options
     * @param  {string}  [options.id]      UUID v4. Auto-generated if omitted.
     *                                     Pass explicitly to correlate events.
     * @param  {string}  options.title     Notification title. Required.
     * @param  {string}  [options.body]    Body text.
     * @param  {string}  [options.icon]    Absolute path to icon image.
     * @param  {boolean} [options.sound]   Play default sound. Default: true.
     * @param  {object}  [options.windows] Windows escape hatch options.
     * @param  {object}  [options.macos]   macOS escape hatch options.
     * @param  {object}  [options.linux]   Linux escape hatch options.
     * @returns {Promise<string>} Resolves with notification id.
     */
    show(options) {
        const id = options.id ?? randomUUID();
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                this._write({ action: 'show', id, ...options });
            } catch (err) {
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    /**
     * Replace an existing notification in-place.
     *
     * `options.id` is required and must match a previously shown notification.
     *
     * Windows: requires original show() to have included `windows.tag` and
     *          `windows.group`. Emits 'failed' if they were absent.
     * macOS:   re-sends addNotificationRequest with the same identifier.
     *          The OS replaces the existing notification automatically.
     * Linux:   passes the stored D-Bus uint32 as replaces_id. Falls back to
     *          a new notification if the id is not in the id_map.
     *
     * @param  {object} options Same shape as show(). `id` is required.
     * @returns {Promise<string>}
     */
    update(options) {
        if (!options.id) {
            return Promise.reject(
                new Error('notifier-hook: update() requires options.id')
            );
        }
        const id = options.id;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                this._write({ action: 'update', ...options });
            } catch (err) {
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    /**
     * Programmatically remove a displayed notification.
     *
     * Fire-and-forget — resolves immediately without waiting for a daemon ack.
     * A 'dismissed' event with reason 'app_closed' may follow asynchronously
     * on platforms that emit it.
     *
     * Windows: requires original show() to have included windows.tag + group.
     *
     * @param  {string} id Notification id returned by show() / update().
     * @returns {Promise<void>}
     */
    dismiss(id) {
        try {
            this._write({ action: 'dismiss', id });
        } catch (err) {
            return Promise.reject(err);
        }
        return Promise.resolve();
    }

    /**
     * Register macOS UNNotificationCategory objects.
     *
     * MUST be called before any show() that uses `macos.category_identifier`.
     * If a category is used before registration, the notification shows without
     * action buttons and a 'warn' event fires. The show() itself never fails.
     *
     * Safe no-op on Windows and Linux — silently accepted, no OS calls made.
     *
     * @param  {Array<object>} categories Array of CategoryDefinition objects.
     * @returns {Promise<void>}
     */
    registerCategories(categories) {
        try {
            this._write({ action: 'register_categories', categories });
        } catch (err) {
            return Promise.reject(err);
        }
        return Promise.resolve();
    }

    /**
     * Request the list of currently delivered (visible) notifications.
     *
     * Windows + macOS: resolves with an array of DeliveredNotification objects.
     * Linux: always resolves with [] and emits a 'warn' event.
     *
     * Concurrent calls are safe — responses are matched FIFO to callers.
     * Rejects if the daemon does not respond within GET_DELIVERED_TIMEOUT_MS.
     *
     * ⚠️  Windows: `delivered_at` is the time getDelivered() was called, not
     *     the actual delivery time. WinRT does not expose delivery timestamps
     *     for historical notifications. Record timestamps on the JS side at
     *     show() time if precision is required.
     *
     * @returns {Promise<Array<{ id: string, title: string, body?: string, delivered_at: number }>>}
     */
    getDelivered() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // Remove this entry from the queue on timeout so it doesn't
                // consume a future 'delivered' response for a different caller.
                const idx = this._deliveredQueue.findIndex(e => e.timer === timer);
                if (idx !== -1) this._deliveredQueue.splice(idx, 1);
                reject(new Error(
                    `notifier-hook: getDelivered() timed out after ` +
                    `${GET_DELIVERED_TIMEOUT_MS}ms — daemon did not respond`
                ));
            }, GET_DELIVERED_TIMEOUT_MS);

            this._deliveredQueue.push({ resolve, reject, timer });

            try {
                this._write({ action: 'get_delivered' });
            } catch (err) {
                clearTimeout(timer);
                this._deliveredQueue.pop();
                reject(err);
            }
        });
    }

    /**
     * Remove all delivered notifications.
     *
     * Windows + macOS: clears Action Center / Notification Center.
     * Linux: calls CloseNotification for each tracked notification.
     *
     * Fire-and-forget. Returns void, not a Promise.
     */
    clearDelivered() {
        try {
            this._write({ action: 'clear_delivered' });
        } catch {
            // daemon not running — no-op
        }
    }

    /**
     * Gracefully shut down the daemon.
     *
     * Sends the `quit` command and waits for the 'exit' event. The daemon
     * performs OS cleanup then exits with code 0.
     *
     * After quit() resolves do not call any further methods. To restart,
     * call start() again — _starting is reset on exit.
     *
     * @returns {Promise<void>}
     */
    quit() {
        return new Promise((resolve) => {
            // Guard: if the daemon is already gone, resolve immediately.
            if (!this._daemon) {
                return resolve();
            }
            this.once('exit', () => resolve());
            try {
                this._write({ action: 'quit' });
            } catch {
                // Daemon already gone — resolve immediately.
                resolve();
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory + exports
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new Notifier instance. Equivalent to `new Notifier(options)`.
 *
 * @param   {object} [options] See Notifier constructor.
 * @returns {Notifier}
 *
 * @example
 * const { createNotifier } = require('notifier-hook');
 * const notifier = createNotifier({ appName: 'My App' });
 * notifier.on('error', console.error);
 * await notifier.start();
 * await notifier.show({ title: 'Hello', body: 'World' });
 */
function createNotifier(options) {
    return new Notifier(options);
}

module.exports = { Notifier, createNotifier };
