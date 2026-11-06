/**
 * instant-ui.js
 * NetSuite TactaSuite - Instant UI (Content Script, Auto-Trigger)
 *
 * @author Blane Maher
 *
 * Marks the document with the "tacta-instant-ui" class so instant-ui.css can
 * collapse NetSuite's CSS transitions to 1ms and force instant scrolling.
 * Keyframe animations (loading wheels, progress bars) are left untouched so
 * they keep spinning at their normal speed. The toolkit's own UI (shadow host
 * and any element with a tacta- class) is excluded by the stylesheet so panels
 * keep their motion.
 *
 * @fileoverview Instant UI content script for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // Guard against double-init
    if (window.__tactaInstantUiLoaded) return;
    window.__tactaInstantUiLoaded = true;

    /** @type {string} Class applied to <html> */
    var ROOT_CLASS = 'tacta-instant-ui';

    function apply() {
        var root = document.documentElement;
        if (root && !root.classList.contains(ROOT_CLASS)) {
            root.classList.add(ROOT_CLASS);
        }
    }

    apply();

    // NetSuite occasionally rewrites the <html> class attribute; keep ours on.
    try {
        var observer = new MutationObserver(function () {
            if (!document.documentElement.classList.contains(ROOT_CLASS)) apply();
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    } catch (_) { /* ignore */ }
})();
