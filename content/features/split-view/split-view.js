/**
 * split-view.js
 * NetSuite TactaSuite - Split View (Content Script, Context Menu Trigger)
 *
 * @author Blane Maher
 *
 * Opens the current NetSuite page (or a right-clicked link) in a side-by-side
 * split layout. Uses window.open() to create a popup window sized to the right
 * half of the screen and shows a floating "Exit Split" button on the originating
 * page.
 *
 * Because NetSuite pages set X-Frame-Options headers that block iframes, this
 * feature uses real browser windows instead. The user can also tile windows
 * manually with Win+Left / Win+Right after the popup opens.
 *
 * Activated by the `tacta:featureActivated` custom event with featureId
 * 'split-view', dispatched by the router after a context-menu click.
 *
 * @fileoverview Split View content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaSplitViewLoaded) return;
    window.__tactaSplitViewLoaded = true;

    // ────────────────────────────────────────────────────────────────
    // Constants
    // ────────────────────────────────────────────────────────────────

    /** @type {string} CSS class for the floating exit button */
    var EXIT_BTN_CLASS = 'tacta-split-exit-btn';

    /** @type {string} CSS class for the toast notification */
    var TOAST_CLASS = 'tacta-split-toast';

    /** @type {string} Key used to mark that split view is active */
    var STORAGE_KEY = 'tacta-split-view-active';

    /** @type {number} How long the toast stays visible (ms) */
    var TOAST_DURATION = 5000;

    /** @type {Window|null} Reference to the opened popup window */
    var _popupRef = null;

    // ────────────────────────────────────────────────────────────────
    // Toast notification
    // ────────────────────────────────────────────────────────────────

    /**
     * Shows a brief toast notification with a tip about window tiling.
     *
     * @param {string} message - The message text to display.
     */
    function _showToast(message) {
        // Remove any existing toast
        var existing = document.querySelector('.' + TOAST_CLASS);
        if (existing) existing.remove();

        var toast = document.createElement('div');
        toast.className = TOAST_CLASS;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger entrance animation on next frame
        requestAnimationFrame(function () {
            toast.classList.add('tacta-split-toast--visible');
        });

        // Auto-dismiss
        setTimeout(function () {
            toast.classList.remove('tacta-split-toast--visible');
            toast.addEventListener('transitionend', function () {
                if (toast.parentNode) toast.remove();
            });
            // Fallback removal if transitionend doesn't fire
            setTimeout(function () {
                if (toast.parentNode) toast.remove();
            }, 400);
        }, TOAST_DURATION);
    }

    // ────────────────────────────────────────────────────────────────
    // Exit button
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates and inserts the floating "Exit Split" button into the DOM.
     * Clicking it closes the popup window and removes the button.
     */
    function _showExitButton() {
        // Don't add a second button
        if (document.querySelector('.' + EXIT_BTN_CLASS)) return;

        var btn = document.createElement('button');
        btn.className = EXIT_BTN_CLASS;
        btn.setAttribute('title', 'Close the split-view popup window');

        // Icon (two rectangles) + label
        btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">' +
            '<rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>' +
            '<rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5"/>' +
            '</svg>' +
            '<span>Exit Split</span>';

        btn.addEventListener('click', function () {
            _exitSplitView();
        });

        document.body.appendChild(btn);
    }

    /**
     * Removes the exit button from the DOM.
     */
    function _removeExitButton() {
        var btn = document.querySelector('.' + EXIT_BTN_CLASS);
        if (btn) btn.remove();
    }

    // ────────────────────────────────────────────────────────────────
    // Core split logic
    // ────────────────────────────────────────────────────────────────

    /**
     * Opens a new popup window positioned on the right half of the screen
     * with the target URL. Shows the exit button and a helper toast.
     *
     * @param {string} url - The URL to open in the right-side window.
     */
    function _enterSplitView(url) {
        var targetUrl = url || window.location.href;
        var screenW = screen.availWidth;
        var screenH = screen.availHeight;
        var screenLeft = screen.availLeft || 0;
        var screenTop = screen.availTop || 0;

        // Calculate right-half dimensions
        var popupWidth = Math.floor(screenW / 2);
        var popupHeight = screenH;
        var popupLeft = screenLeft + Math.floor(screenW / 2);
        var popupTop = screenTop;

        // Build the window.open features string
        var features = [
            'width=' + popupWidth,
            'height=' + popupHeight,
            'left=' + popupLeft,
            'top=' + popupTop,
            'menubar=no',
            'toolbar=yes',
            'location=yes',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');

        // Open the popup
        _popupRef = window.open(targetUrl, '_blank', features);

        if (!_popupRef || _popupRef.closed) {
            // Popup was blocked
            _showToast('Popup blocked! Please allow popups for netsuite.com, then try again.');
            return;
        }

        // Mark split view as active
        sessionStorage.setItem(STORAGE_KEY, 'true');

        // Show exit button and helpful toast
        _showExitButton();
        _showToast('Split View opened. Use Win+\u2190 on this window to snap left, or drag to arrange.');

        // Listen for the popup closing so we can clean up
        var pollInterval = setInterval(function () {
            if (_popupRef && _popupRef.closed) {
                clearInterval(pollInterval);
                _cleanup();
            }
        }, 1000);
    }

    /**
     * Closes the split-view popup and cleans up the UI.
     */
    function _exitSplitView() {
        if (_popupRef && !_popupRef.closed) {
            try {
                _popupRef.close();
            } catch (e) {
                // Cross-origin: can't close, just clean up our side
            }
        }
        _cleanup();
    }

    /**
     * Removes the exit button and clears the active flag.
     */
    function _cleanup() {
        _popupRef = null;
        _removeExitButton();
        sessionStorage.removeItem(STORAGE_KEY);
    }

    // ────────────────────────────────────────────────────────────────
    // Activation
    // ────────────────────────────────────────────────────────────────

    /**
     * Handles the split-view activation. If already in split view, exits it;
     * otherwise enters split view.
     *
     * @param {Object} [data] - Optional data from the context menu handler.
     * @param {string} [data.url] - URL to open (defaults to current page URL).
     */
    function _activate(data) {
        // Toggle: if exit button is showing, we're in split view — exit
        if (document.querySelector('.' + EXIT_BTN_CLASS)) {
            _exitSplitView();
            return;
        }

        var url = (data && data.url) ? data.url : window.location.href;
        _enterSplitView(url);
    }

    // ────────────────────────────────────────────────────────────────
    // Event listener
    // ────────────────────────────────────────────────────────────────

    /**
     * Listen for the activation event dispatched by the router after the
     * context menu manager sends the 'activateFeature' message.
     */
    window.addEventListener('tacta:featureActivated', function (e) {
        if (e.detail && e.detail.featureId === 'split-view') {
            _activate(e.detail.data || null);
        }
    });

    // If the page was loaded while split view was previously active (e.g.,
    // after a navigation in the main window), restore the exit button.
    if (sessionStorage.getItem(STORAGE_KEY) === 'true') {
        // We lost the popup reference on navigation, so just show a toast
        // letting the user know they can close the other window manually.
        sessionStorage.removeItem(STORAGE_KEY);
    }

})();
