// javascript
/* jshint esversion: 8 */
/* global ResizeObserver */

(function () {
    'use strict';

    // Do not run when loaded in a top-level context
    if (window === window.parent) { return; }

    // Parent Origin
    const DEFAULT_ORIGIN = "https://usethatapp.onrender.com";  // TODO: change to usethatapp.com for production
    const scriptEl = document.currentScript;
    const rawParentOrigin = (scriptEl && scriptEl.getAttribute('data-parent-origin')) || DEFAULT_ORIGIN;

    // Normalize the configured parent origin so a stray trailing slash (a
    // common integration mistake) doesn't silently break every postMessage.
    // MessageEvent.origin is always the bare scheme://host[:port] with no
    // path, so we strip exactly one trailing slash if present.  Everything
    // else (scheme, host, port, casing) is still required to match exactly.
    const parentOrigin = rawParentOrigin.replace(/\/$/, '');
    if (parentOrigin !== rawParentOrigin) {
        try {
            console.warn('[UTA child] data-parent-origin had a trailing slash; ' +
                'using', parentOrigin, 'instead of', rawParentOrigin);
        } catch (_) {}
    }

    // Diagnostic: announce expected parent origin once at load.  This is the
    // single most useful piece of information when debugging a handshake
    // timeout — if it doesn't match the origin app.html is actually served
    // from, every message will be silently dropped by the origin check below.
    try { console.debug('[UTA child] loaded; expecting parent origin =', parentOrigin); } catch (_) {}

    // Constants
    const HANDSHAKE_TIMEOUT_MS = 10000; // Must stay in sync with parent app.html timeout
    const RESIZE_DEBOUNCE_MS = 100;
    const MAX_CONTENT_HEIGHT = 10000; // Safety cap — mirrors parent MAX_RESET_HEIGHT_PX

    // Handshake state — per page load only.
    // We intentionally do NOT persist this across iframe navigations: the parent
    // re-runs the nonce handshake on every load, and persisting the flag created
    // a race where the child would post `reset-height` before the new handshake
    // completed (using stale state from the previous load).
    let handshakeComplete = false;

    // Handshake promise — resolved when the nonce exchange completes on this page load.
    // requestAccessLevel awaits this so it never fires before the parent is ready.
    let _handshakeResolve;
    let _handshakePromise = new Promise(function (resolve) { _handshakeResolve = resolve; });

    function setHandshakeComplete() {
        if (handshakeComplete) { return; }
        handshakeComplete = true;
        if (_handshakeResolve) { _handshakeResolve(); }
        // Static apps may never mutate the DOM after this point; force one
        // resize report now so the parent gets the real content height.
        notifyResize(true);
    }

    function clearHandshake() {
        handshakeComplete = false;
        // Reset promise so the next handshake cycle can be awaited
        _handshakePromise = new Promise(function (resolve) { _handshakeResolve = resolve; });
        // Reset dedupe so the next handshake cycle re-reports the size
        lastSentHeight = -1;
    }

    /**
     * Top-level function to request access level from the parent.
     * Exposed as `window.requestAccessLevel` for non-Dash consumers and also kept
     * available under `window.dash_clientside.clientside.requestAccessLevel`.
     */
    async function requestAccessLevel(...args) {
        // Dash expects window.dash_clientside.no_update for no change.
        var NO_UPDATE = (window.dash_clientside && window.dash_clientside.no_update) ? window.dash_clientside.no_update : undefined;

        // Wait for the handshake to complete on this page load instead of
        // returning NO_UPDATE immediately.  A timeout prevents hanging forever
        // if the parent never initiates the nonce exchange.
        try {
            await Promise.race([
                _handshakePromise,
                new Promise(function (_, reject) {
                    setTimeout(function () { reject(new Error('Handshake wait timed out')); }, HANDSHAKE_TIMEOUT_MS);
                })
            ]);
        } catch (_e) {
            return NO_UPDATE;
        }

        const requestId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

        return new Promise((resolve, reject) => {
            let timeoutId = null;

            function cleanup() {
                window.removeEventListener('message', onMessage, false);
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            }

            function onMessage(event) {
                if (event.origin !== parentOrigin) {
                    return; // ignore other origins
                }

                const msg = event.data || {};

                // Only act on responses that explicitly reference our request id.
                // Ignore unrelated messages instead of rejecting.
                if (msg.responseTo === requestId) {
                    cleanup();
                    resolve(msg);
                }
            }

            // Listen for the parent's response
            window.addEventListener('message', onMessage, false);

            // Send request with correlation id
            try {
                window.parent.postMessage({
                    type: 'request-level',
                    requestId: requestId
                }, parentOrigin);
            } catch (err) {
                cleanup();
                return reject(err);
            }

            // Timeout handling
            timeoutId = setTimeout(() => {
                cleanup();
                reject(new Error('requestAccessLevel timed out'));
            }, HANDSHAKE_TIMEOUT_MS);
        });
    }

    // Make the function available globally
    window.requestAccessLevel = requestAccessLevel;

    // Also keep it accessible for Dash clients
    window.dash_clientside = Object.assign({}, window.dash_clientside, {
        clientside: Object.assign({}, (window.dash_clientside && window.dash_clientside.clientside) || {}, {
            requestAccessLevel: requestAccessLevel
        })
    });

    /**
     * Responds to messages from the parent window.
     */
    function handleHandshakeMessage(event) {
        if (event.origin !== parentOrigin) {
            // Diagnostic only — log once per unexpected origin so we don't spam.
            if (!handleHandshakeMessage._warned) { handleHandshakeMessage._warned = {}; }
            if (!handleHandshakeMessage._warned[event.origin]) {
                handleHandshakeMessage._warned[event.origin] = true;
                try {
                    console.warn('[UTA child] ignoring postMessage from unexpected origin',
                        event.origin, '(expected', parentOrigin + ')');
                } catch (_) {}
            }
            return;
        }

        const msg = event.data || {};

        switch (msg.type) {
            case 'nonce':
                // Validate nonce is a non-empty string before echoing
                if (!msg.nonce || typeof msg.nonce !== 'string') { return; }
                try { console.debug('[UTA child] nonce received, sending nonce-ack'); } catch (_) {}
                // Acknowledge nonce to complete handshake
                window.parent.postMessage({
                    type: 'nonce-ack',
                    nonce: msg.nonce
                }, parentOrigin);
                setHandshakeComplete();
                break;
            case 'clear-handshake':
                // parent requested we drop the handshake flag (logout / revoke)
                try { console.debug('[UTA child] clear-handshake received'); } catch (_) {}
                clearHandshake();
                break;
            default:
                // Handle other post-handshake messages if needed
                break;
        }
    }

    // Listen for messages from parent (handshake + cleared explicitly by parent)
    // Add once at module init so we don't create duplicates on repeated calls
    window.addEventListener('message', handleHandshakeMessage, false);

    // Resize notification
    let resizeTimeout = null;
    let lastSentHeight = -1;

    // Sentinel element used to measure true content height without being
    // contaminated by the iframe's own height.  scrollHeight on <html>/<body>
    // is inflated by any descendant whose size resolves against the viewport
    // (100vh, 100dvh, % of a vh-sized ancestor, flex/grid stretch inside
    // such a container, etc.).  Because the parent sets the iframe's height
    // from our reported value, those viewport units feed back into the next
    // measurement and produce a runaway "escalator" loop until the parent's
    // safety clamp is hit.
    //
    // The sentinel is a zero-size, visibility:hidden element appended as the
    // last child of <body>.  Its bottom edge tracks where real content ends,
    // independent of any viewport-based sizing on ancestors, so it gives a
    // stable measurement that breaks the loop on the first cycle.
    const SENTINEL_ID = '__uta_height_sentinel__';
    let sentinel = null;

    function ensureSentinel() {
        if (sentinel && sentinel.isConnected) { return sentinel; }
        if (!document.body) { return null; }
        sentinel = document.getElementById(SENTINEL_ID);
        if (!sentinel) {
            sentinel = document.createElement('div');
            sentinel.id = SENTINEL_ID;
            sentinel.setAttribute('aria-hidden', 'true');
            // `all: unset` neutralises any global selectors the host page
            // might apply (e.g. `div { margin: ... }`).  The explicit rules
            // after it lock the box to zero size and remove it from the
            // accessibility / interaction layers.
            sentinel.style.cssText =
                'all: unset !important;' +
                'display: block !important;' +
                'height: 0 !important;' +
                'width: 0 !important;' +
                'margin: 0 !important;' +
                'padding: 0 !important;' +
                'border: 0 !important;' +
                'visibility: hidden !important;' +
                'pointer-events: none !important;';
        }
        // Always (re-)append to make sure it's the LAST child of body.  If
        // the app re-renders and wipes body children, the MutationObserver
        // will fire and we'll re-attach on the next notifyResize call.
        if (sentinel.parentNode !== document.body ||
            document.body.lastChild !== sentinel) {
            document.body.appendChild(sentinel);
        }
        return sentinel;
    }

    function measureContentHeight() {
        const s = ensureSentinel();
        // Sentinel-based measurement: bottom of the sentinel relative to the
        // top of the document is the true end-of-content offset.
        let sentinelBottom = 0;
        if (s) {
            const rect = s.getBoundingClientRect();
            // Add window.scrollY in case the iframe document is itself
            // scrolled (rare, but cheap to be correct).
            sentinelBottom = rect.bottom + (window.scrollY || 0);
        }
        // Fallback: classic scrollHeight.  Used when the sentinel can't be
        // attached yet (no body) and as a floor in case the sentinel ends
        // up inside a positioned/transformed ancestor that throws off its
        // getBoundingClientRect (defence in depth — should not normally
        // happen because we append directly to <body>).
        const scroll = Math.max(
            document.documentElement ? document.documentElement.scrollHeight : 0,
            document.body ? document.body.scrollHeight : 0
        );
        // Use the SMALLER of the two non-zero values when the sentinel is
        // available: scrollHeight may be inflated by viewport-feedback, but
        // the sentinel can never be inflated by it.  Falling back to scroll
        // only when the sentinel is unavailable preserves prior behaviour.
        const raw = (s && sentinelBottom > 0)
            ? Math.min(sentinelBottom, scroll)
            : scroll;
        return Math.min(Math.ceil(raw), MAX_CONTENT_HEIGHT);
    }

    function notifyResize(force) {
        if (!handshakeComplete) {
            return;
        }
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            const contentHeight = measureContentHeight();
            // Skip no-op messages.  This is the definitive break for any residual
            // viewport-feedback loop (e.g. child uses 100vh): once layout settles
            // the next measurement equals lastSentHeight and the chain terminates.
            if (!force && contentHeight === lastSentHeight) {
                return;
            }
            lastSentHeight = contentHeight;
            try {
                window.parent.postMessage({
                    type: 'reset-height',
                    height: contentHeight
                }, parentOrigin);
                // Visible-by-default diagnostic so integrators can confirm
                // which build is live and watch the height stream in real
                // time.  Logs only the (numeric) height — no user data.
                try {
                    console.info('[UTA child] reset-height sent:', contentHeight, 'px');
                } catch (_) {}
            } catch (_) { /* parent may have navigated away */ }
        }, RESIZE_DEBOUNCE_MS);
    }

    // Fire immediately if DOM is already ready; otherwise wait for the event
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', notifyResize, false);
    } else {
        notifyResize();
    }

    // Guard both observers against a missing document.body (e.g. script injected from <head>)
    if (document.body) {
        // Watch for any DOM change that could affect content height:
        //   childList     — nodes added/removed
        //   subtree       — anywhere under <body>, not just direct children
        //   attributes    — class/style/aria changes (collapses, accordions,
        //                   tabs, conditional CSS) often change height without
        //                   touching the node tree
        //   characterData — text content changes (counters, status text, etc.)
        const mutationObserver = new MutationObserver(function () { notifyResize(); });
        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true
        });

        // Watch for size changes on both <body> and <html>.  Observing only
        // <body> misses cases where the body has a fixed/min-viewport height
        // (common in Dash / Bootstrap defaults) while inner content — and
        // therefore documentElement.scrollHeight — grows.
        if (typeof ResizeObserver !== 'undefined') {
            const resizeObserver = new ResizeObserver(function () { notifyResize(); });
            resizeObserver.observe(document.body);
            if (document.documentElement) {
                resizeObserver.observe(document.documentElement);
            }
        }
    }

    // Late-arriving resources (images, web fonts, async chunks) don't generate
    // mutation events but do change scrollHeight when they finish loading.
    // Force a fresh report on window 'load' to catch them.
    window.addEventListener('load', function () { notifyResize(true); }, false);

    // Viewport changes can affect responsive layouts inside the iframe.
    window.addEventListener('resize', function () { notifyResize(); }, false);

    // NOTE: do not clear the handshake on unload/pagehide here.
    // The parent can explicitly send `clear-handshake` when it wants the child to drop the flag.
})();
