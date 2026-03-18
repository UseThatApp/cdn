// javascript
/* jshint esversion: 8 */
/* global ResizeObserver */

(function () {
    'use strict';

    const parentOrigin = "https://usethatapp.onrender.com"; // TODO: Update to www.usethatapp.com in production

    // Restore handshake flag from sessionStorage (persists across same-origin iframe navigations)
    let handshakeComplete = sessionStorage.getItem('handshakeComplete') === '1';

    function setHandshakeComplete(value) {
        handshakeComplete = !!value;
        sessionStorage.setItem('handshakeComplete', handshakeComplete ? '1' : '0');
    }

    function clearHandshake() {
        handshakeComplete = false;
        sessionStorage.removeItem('handshakeComplete');
    }

    /**
     * Top-level function to request access level from the parent.
     * Exposed as `window.requestAccessLevel` for non-Dash consumers and also kept
     * available under `window.dash_clientside.clientside.requestAccessLevel`.
     */
    async function requestAccessLevel(...args) {
        // If the handshake hasn't completed yet, do not attempt the request.
        // Dash expects window.dash_clientside.no_update for no change.
        var NO_UPDATE = (window.dash_clientside && window.dash_clientside.no_update) ? window.dash_clientside.no_update : undefined;
        if (!handshakeComplete) {
            return NO_UPDATE;
        }

        const timeout = 10000; // milliseconds
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
            }, timeout);
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
            return;
        }

        const msg = event.data || {};

        switch (msg.type) {
            case 'nonce':
                // Acknowledge nonce to complete handshake
                window.parent.postMessage({
                    type: 'nonce-ack',
                    nonce: msg.nonce
                }, parentOrigin);
                setHandshakeComplete(true);
                break;
            case 'clear-handshake':
                // parent requested we drop the handshake flag (logout / revoke)
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

    // Throttle resize notifications to avoid rapid firing
    let resizeTimeout;

    function notifyResize() {
        if (!handshakeComplete) {
            return;
        }
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            let contentHeight = document.body.scrollHeight;
            window.parent.postMessage({
                type: 'reset-height',
                height: contentHeight
            }, parentOrigin);
        }, 100); // Debounce time in ms
    }

    // Call notifyResize whenever the content changes size
    window.addEventListener('DOMContentLoaded', notifyResize, false);

    // Watch for DOM mutations and signal resize
    let observer = new MutationObserver(notifyResize);
    observer.observe(document.body, {childList: true, subtree: true});

    // Watch for changes to children's size and signal resize (guard ResizeObserver)
    if (typeof ResizeObserver !== 'undefined') {
        let resizeObserver = new ResizeObserver(notifyResize);
        for (const child of document.children) {
            resizeObserver.observe(child);
        }
    }

    // NOTE: do not clear the handshake on unload/pagehide here.
    // The parent can explicitly send `clear-handshake` when it wants the child to drop the flag.
})();