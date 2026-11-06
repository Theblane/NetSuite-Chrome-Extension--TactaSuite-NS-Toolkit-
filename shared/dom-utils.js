/**
 * dom-utils.js
 * NetSuite TactaSuite - DOM Manipulation Helpers
 *
 * @author Blane Maher
 *
 * Provides factory functions for creating themed UI components
 * (panels, modals, toasts, sidebars, tables) and general DOM utilities.
 * All created elements are scoped under the .tacta-toolkit class.
 *
 * Exposes: window.TactaDOM
 *
 * @fileoverview DOM builder utilities for the NetSuite TactaSuite.
 */
(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    // Internal helpers
    // ────────────────────────────────────────────────────────────────

    /** Counter for generating unique element IDs */
    var _idCounter = 0;

    /**
     * Generates a unique ID string for toolkit elements.
     * @param {string} [prefix='tacta']
     * @returns {string}
     */
    function _uid(prefix) {
        return (prefix || 'tacta') + '-' + (++_idCounter) + '-' + Date.now().toString(36);
    }

    /**
     * Internal state for Shadow DOM isolation.
     * @type {ShadowRoot|null}
     */
    var _shadowRoot = null;

    /**
     * Internal state for the UI wrapper within the Shadow DOM.
     * @type {HTMLElement|null}
     */
    var _shadowWrapper = null;

    /**
     * Returns or creates the singleton toast container element.
     * @returns {HTMLElement}
     */
    function _getToastContainer() {
        var root = _ensureRoot();
        var existing = root.querySelector('.tacta-toast-container');
        if (existing) return existing;

        var container = document.createElement('div');
        container.className = 'tacta-toast-container';
        root.appendChild(container);
        return container;
    }

    /**
     * Ensures a Shadow DOM host exists, attaches a Shadow Root if needed,
     * and returns the internal .tacta-toolkit wrapper.
     * @returns {HTMLElement}
     */
    function _ensureRoot() {
        if (_shadowWrapper) return _shadowWrapper;

        var host = document.querySelector('#tacta-toolkit-host');
        if (!host) {
            host = document.createElement('div');
            host.id = 'tacta-toolkit-host';
            document.body.appendChild(host);
        }

        if (!host.shadowRoot) {
            _shadowRoot = host.attachShadow({ mode: 'open' });

            // Inject primary styles into shadow root
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
                var styles = ['shared/theme-vars.css', 'shared/tactasuite-ui.css'];
                for (var i = 0; i < styles.length; i++) {
                    var link = document.createElement('link');
                    link.rel = 'stylesheet';
                    link.href = chrome.runtime.getURL(styles[i]);
                    _shadowRoot.appendChild(link);
                }
            }

            _shadowWrapper = document.createElement('div');
            _shadowWrapper.className = 'tacta-toolkit';
            _shadowRoot.appendChild(_shadowWrapper);
        } else {
            _shadowRoot = host.shadowRoot;
            _shadowWrapper = _shadowRoot.querySelector('.tacta-toolkit');
            if (!_shadowWrapper) {
                _shadowWrapper = document.createElement('div');
                _shadowWrapper.className = 'tacta-toolkit';
                _shadowRoot.appendChild(_shadowWrapper);
            }
        }

        return _shadowWrapper;
    }

    /**
     * SVG icon strings for toast types.
     * @type {Object<string, string>}
     */
    var TOAST_ICONS = {
        success: '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#76c043" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M5.5 9.5l2 2 5-5"/></svg>',
        error:   '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#e74c3c" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M6 6l6 6M12 6l-6 6"/></svg>',
        warning: '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#f39c12" stroke-width="2"><path d="M9 2l8 14H1z"/><path d="M9 7v4M9 13v1"/></svg>',
        info:    '<svg class="tacta-toast-icon" viewBox="0 0 18 18" fill="none" stroke="#3498db" stroke-width="2"><circle cx="9" cy="9" r="8"/><path d="M9 8v5M9 5v1"/></svg>'
    };

    // ────────────────────────────────────────────────────────────────
    // createElement
    // ────────────────────────────────────────────────────────────────

    /**
     * Shorthand DOM element builder.
     *
     * @param {string} tag - HTML tag name.
     * @param {Object} [attrs] - Attributes/properties to set. Special keys:
     *   - `className` sets the class attribute
     *   - `style` (object) merges into element.style
     *   - `dataset` (object) merges into element.dataset
     *   - `events` (object) calls addEventListener for each key
     *   - `innerHTML` sets raw HTML
     *   - `textContent` sets text content
     *   - All other string keys are set as attributes.
     * @param {Array<HTMLElement|string>} [children] - Child elements or text strings.
     * @returns {HTMLElement}
     */
    function createElement(tag, attrs, children) {
        var el = document.createElement(tag);

        if (attrs) {
            var keys = Object.keys(attrs);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                var val = attrs[key];

                if (key === 'className') {
                    el.className = val;
                } else if (key === 'style' && typeof val === 'object') {
                    var styleKeys = Object.keys(val);
                    for (var s = 0; s < styleKeys.length; s++) {
                        el.style[styleKeys[s]] = val[styleKeys[s]];
                    }
                } else if (key === 'dataset' && typeof val === 'object') {
                    var dataKeys = Object.keys(val);
                    for (var d = 0; d < dataKeys.length; d++) {
                        el.dataset[dataKeys[d]] = val[dataKeys[d]];
                    }
                } else if (key === 'events' && typeof val === 'object') {
                    var eventKeys = Object.keys(val);
                    for (var e = 0; e < eventKeys.length; e++) {
                        el.addEventListener(eventKeys[e], val[eventKeys[e]]);
                    }
                } else if (key === 'innerHTML') {
                    el.innerHTML = val;
                } else if (key === 'textContent') {
                    el.textContent = val;
                } else {
                    el.setAttribute(key, val);
                }
            }
        }

        if (children) {
            for (var c = 0; c < children.length; c++) {
                var child = children[c];
                if (typeof child === 'string') {
                    el.appendChild(document.createTextNode(child));
                } else if (child instanceof HTMLElement) {
                    el.appendChild(child);
                }
            }
        }

        return el;
    }

    // ────────────────────────────────────────────────────────────────
    // Dragging helper
    // ────────────────────────────────────────────────────────────────

    /**
     * Makes an element draggable by a handle element.
     * @param {HTMLElement} element - The element to move.
     * @param {HTMLElement} handle - The drag handle.
     */
    /**
     * Checks the 'tacta_close_on_click_outside' setting from chrome.storage.
     * @param {Function} callback - called with boolean
     */
    function _checkClickOutsideSetting(callback) {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get('tacta_close_on_click_outside', function (data) {
                    callback(data.tacta_close_on_click_outside === true);
                });
            } else {
                callback(false);
            }
        } catch (_) {
            callback(false);
        }
    }

    function _makeDraggable(element, handle) {
        var offsetX = 0;
        var offsetY = 0;
        var isDragging = false;

        function onMouseDown(e) {
            if (e.target.closest('.tacta-panel-close') || e.target.closest('.tacta-btn')) return;
            isDragging = true;
            offsetX = e.clientX - element.getBoundingClientRect().left;
            offsetY = e.clientY - element.getBoundingClientRect().top;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            e.preventDefault();
        }

        function onMouseMove(e) {
            if (!isDragging) return;
            var x = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - element.offsetWidth));
            var y = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - element.offsetHeight));
            element.style.left = x + 'px';
            element.style.top = y + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        }

        function onMouseUp() {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        handle.addEventListener('mousedown', onMouseDown);
    }

    /**
     * Makes a panel resizable from the bottom-left corner.
     * Dragging the handle adjusts width (shrinks right), height (grows down),
     * and left position simultaneously.
     *
     * @param {HTMLElement} panel - The panel element.
     * @param {HTMLElement} handle - The resize handle element.
     */
    function _makeResizableBottomLeft(panel, handle) {
        var isResizing = false;
        var startX, startY, startW, startH, startLeft;

        handle.addEventListener('mousedown', function (e) {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            var rect = panel.getBoundingClientRect();
            startW = rect.width;
            startH = rect.height;
            startLeft = rect.left;
            document.body.style.cursor = 'sw-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });

        function onMove(e) {
            if (!isResizing) return;
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;

            // Bottom-left: width shrinks as mouse goes left, height grows as mouse goes down
            var newW = Math.max(280, startW - dx);
            var newH = Math.max(200, startH + dy);
            var newLeft = Math.max(0, startLeft + dx);

            // Don't let panel shrink past its right edge
            if (newLeft + newW > startLeft + startW) {
                newLeft = startLeft + startW - newW;
            }

            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
            panel.style.left = newLeft + 'px';
            panel.style.right = 'auto';
        }

        function onUp() {
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
    }

    // ────────────────────────────────────────────────────────────────
    // createPanel
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates a floating panel with a header bar, body area, and close button.
     *
     * @param {Object} options
     * @param {string} [options.title='Panel'] - Panel title text.
     * @param {string|number} [options.width='360px'] - CSS width.
     * @param {string|number} [options.height='auto'] - CSS height.
     * @param {Object} [options.position] - Position overrides.
     * @param {string} [options.position.top]
     * @param {string} [options.position.right='16px']
     * @param {string} [options.position.bottom]
     * @param {string} [options.position.left]
     * @param {boolean} [options.resizable=true] - Allow manual resize.
     * @param {boolean} [options.draggable=true] - Allow dragging by header.
     * @param {Function} [options.onClose] - Callback when close button is clicked.
     * @returns {{ panel: HTMLElement, header: HTMLElement, body: HTMLElement, close: Function }}
     */
    function createPanel(options) {
        var opts = options || {};
        var id = _uid('panel');

        var width = opts.width || '360px';
        if (typeof width === 'number') width = width + 'px';
        var height = opts.height || 'auto';
        if (typeof height === 'number') height = height + 'px';

        var pos = opts.position || {};
        var resizable = opts.resizable !== false;
        var draggable = opts.draggable !== false;

        // Panel container
        var panel = createElement('div', {
            id: id,
            className: 'tacta-panel' + (resizable ? ' tacta-panel--resizable' : ''),
            style: {
                width: width,
                height: height,
                top: pos.top || '60px',
                right: pos.right || (pos.left ? 'auto' : '16px'),
                bottom: pos.bottom || 'auto',
                left: pos.left || 'auto'
            }
        });

        // Header
        var titleEl = createElement('div', { className: 'tacta-panel-title' }, [
            createElement('span', { className: 'tacta-accent-dot' }),
            createElement('span', { textContent: opts.title || 'Panel' })
        ]);

        var closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        var header = createElement('div', { className: 'tacta-panel-header' }, [
            titleEl,
            createElement('div', { className: 'tacta-panel-actions' }, [closeBtn])
        ]);

        // Body
        var body = createElement('div', { className: 'tacta-panel-body' });

        panel.appendChild(header);
        panel.appendChild(body);

        // Bottom-left resize handle
        if (resizable) {
            var resizeHandle = createElement('div', { className: 'tacta-panel-resize-handle' });
            panel.appendChild(resizeHandle);
            _makeResizableBottomLeft(panel, resizeHandle);
        }

        // Close behavior
        function close() {
            if (panel.parentNode) {
                panel.parentNode.removeChild(panel);
            }
            if (typeof opts.onClose === 'function') {
                opts.onClose();
            }
        }

        closeBtn.addEventListener('click', close);

        // Click-outside-to-close: check global setting
        if (opts.closeOnClickOutside !== false) {
            _checkClickOutsideSetting(function (enabled) {
                if (enabled) {
                    setTimeout(function () {
                        function onClickOutside(e) {
                            if (!panel.parentNode) {
                                document.removeEventListener('mousedown', onClickOutside, true);
                                return;
                            }
                            // Handle retargeting: use composedPath() to check if the click was inside the panel
                            var path = e.composedPath();
                            if (path.indexOf(panel) === -1) {
                                document.removeEventListener('mousedown', onClickOutside, true);
                                close();
                            }
                        }
                        document.addEventListener('mousedown', onClickOutside, true);
                    }, 200);
                }
            });
        }

        // Dragging
        if (draggable) {
            _makeDraggable(panel, header);
        }

        // Mount
        _ensureRoot().appendChild(panel);

        return {
            panel: panel,
            header: header,
            body: body,
            close: close
        };
    }

    // ────────────────────────────────────────────────────────────────
    // createModal
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates a centered modal dialog with an overlay backdrop.
     *
     * @param {Object} options
     * @param {string} [options.title=''] - Modal title.
     * @param {string|HTMLElement} [options.content=''] - Body content (HTML string or element).
     * @param {Array<{label: string, className?: string, onClick?: Function}>} [options.buttons] -
     *   Footer buttons. Each button can have a label, optional CSS class, and onClick handler.
     * @param {Function} [options.onClose] - Called when the modal is dismissed.
     * @param {boolean} [options.closeOnOverlay=true] - Close when clicking the overlay.
     * @returns {{ overlay: HTMLElement, modal: HTMLElement, body: HTMLElement, close: Function }}
     */
    function createModal(options) {
        var opts = options || {};

        // Overlay
        var overlay = createElement('div', { className: 'tacta-modal-overlay' });

        // Modal container
        var modal = createElement('div', { className: 'tacta-modal' });

        // Header
        var closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        var modalHeader = createElement('div', { className: 'tacta-modal-header' }, [
            createElement('div', { className: 'tacta-modal-title', textContent: opts.title || '' }),
            closeBtn
        ]);

        // Body
        var modalBody = createElement('div', { className: 'tacta-modal-body' });
        if (typeof opts.content === 'string') {
            modalBody.innerHTML = opts.content;
        } else if (opts.content instanceof HTMLElement) {
            modalBody.appendChild(opts.content);
        }

        modal.appendChild(modalHeader);
        modal.appendChild(modalBody);

        // Footer buttons
        if (opts.buttons && opts.buttons.length) {
            var footer = createElement('div', { className: 'tacta-modal-footer' });
            for (var i = 0; i < opts.buttons.length; i++) {
                var btnCfg = opts.buttons[i];
                var btn = createElement('button', {
                    className: 'tacta-btn ' + (btnCfg.className || ''),
                    textContent: btnCfg.label || 'Button'
                });
                if (typeof btnCfg.onClick === 'function') {
                    btn.addEventListener('click', btnCfg.onClick);
                }
                footer.appendChild(btn);
            }
            modal.appendChild(footer);
        }

        overlay.appendChild(modal);

        // Close behavior
        function close() {
            overlay.classList.remove('tacta-visible');
            setTimeout(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 300);
            if (typeof opts.onClose === 'function') {
                opts.onClose();
            }
        }

        closeBtn.addEventListener('click', close);

        if (opts.closeOnOverlay !== false) {
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) close();
            });
        }

        // Escape key
        function onKeyDown(e) {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKeyDown);
            }
        }
        document.addEventListener('keydown', onKeyDown);

        // Mount & animate in
        _ensureRoot().appendChild(overlay);
        // Force reflow before adding visible class for transition
        void overlay.offsetHeight;
        overlay.classList.add('tacta-visible');

        return {
            overlay: overlay,
            modal: modal,
            body: modalBody,
            close: close
        };
    }

    // ────────────────────────────────────────────────────────────────
    // showToast
    // ────────────────────────────────────────────────────────────────

    /**
     * Shows a toast notification that slides in from the top-right.
     *
     * @param {string} message - Toast message text.
     * @param {string} [type='info'] - Toast type: 'success', 'error', 'warning', 'info'.
     * @param {number} [duration=4000] - Auto-dismiss duration in ms. Set to 0 to persist.
     * @returns {{ element: HTMLElement, dismiss: Function }}
     */
    function showToast(message, type, duration) {
        type = type || 'info';
        duration = duration !== undefined ? duration : 4000;

        var container = _getToastContainer();

        var icon = TOAST_ICONS[type] || TOAST_ICONS.info;

        var closeBtn = createElement('button', {
            className: 'tacta-toast-close',
            innerHTML: '&#10005;',
            title: 'Dismiss'
        });

        var toast = createElement('div', {
            className: 'tacta-toast tacta-toast--' + type
        }, [
            createElement('span', { innerHTML: icon }),
            createElement('span', { className: 'tacta-toast-message', textContent: message }),
            closeBtn
        ]);

        container.appendChild(toast);

        // Trigger slide-in after mount
        var autoTimer = null;
        requestAnimationFrame(function () {
            toast.classList.add('tacta-visible');
        });

        function dismiss() {
            if (autoTimer) clearTimeout(autoTimer);
            toast.classList.remove('tacta-visible');
            toast.classList.add('tacta-toast-exit');
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 350);
        }

        closeBtn.addEventListener('click', dismiss);

        if (duration > 0) {
            autoTimer = setTimeout(dismiss, duration);
        }

        return {
            element: toast,
            dismiss: dismiss
        };
    }

    // ────────────────────────────────────────────────────────────────
    // createSidebar
    // ────────────────────────────────────────────────────────────────

    /**
     * Creates a sidebar that slides in from the right edge.
     *
     * @param {Object} options
     * @param {string} [options.title=''] - Sidebar header title.
     * @param {string|HTMLElement} [options.content=''] - Body content.
     * @param {string|number} [options.width='380px'] - CSS width.
     * @param {boolean} [options.overlay=true] - Show a backdrop overlay.
     * @param {Function} [options.onClose] - Called when sidebar is closed.
     * @returns {{ sidebar: HTMLElement, body: HTMLElement, close: Function }}
     */
    function createSidebar(options) {
        var opts = options || {};
        var width = opts.width || '380px';
        if (typeof width === 'number') width = width + 'px';

        var root = _ensureRoot();

        // Optional overlay
        var overlayEl = null;
        if (opts.overlay !== false) {
            overlayEl = createElement('div', { className: 'tacta-sidebar-overlay' });
            root.appendChild(overlayEl);
        }

        // Sidebar
        var closeBtn = createElement('button', {
            className: 'tacta-panel-close',
            title: 'Close',
            innerHTML: '&#10005;'
        });

        var sidebarHeader = createElement('div', { className: 'tacta-sidebar-header' }, [
            createElement('div', { className: 'tacta-sidebar-title', textContent: opts.title || '' }),
            closeBtn
        ]);

        var sidebarBody = createElement('div', { className: 'tacta-sidebar-body' });
        if (typeof opts.content === 'string') {
            sidebarBody.innerHTML = opts.content;
        } else if (opts.content instanceof HTMLElement) {
            sidebarBody.appendChild(opts.content);
        }

        var sidebarStyle = {
            width: width,
            top: opts.top || '0',
            bottom: '0'
        };
        var sidebar = createElement('div', {
            className: 'tacta-sidebar',
            style: sidebarStyle
        }, [sidebarHeader, sidebarBody]);

        root.appendChild(sidebar);

        // Close behavior
        function close() {
            sidebar.classList.remove('tacta-visible');
            if (overlayEl) overlayEl.classList.remove('tacta-visible');
            setTimeout(function () {
                if (sidebar.parentNode) sidebar.parentNode.removeChild(sidebar);
                if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
            }, 350);
            if (typeof opts.onClose === 'function') {
                opts.onClose();
            }
        }

        closeBtn.addEventListener('click', close);

        if (overlayEl) {
            overlayEl.addEventListener('click', close);
        }

        // Escape key
        function onKeyDown(e) {
            if (e.key === 'Escape') {
                close();
                document.removeEventListener('keydown', onKeyDown);
            }
        }
        document.addEventListener('keydown', onKeyDown);

        // Animate in
        requestAnimationFrame(function () {
            sidebar.classList.add('tacta-visible');
            if (overlayEl) overlayEl.classList.add('tacta-visible');
        });

        return {
            sidebar: sidebar,
            body: sidebarBody,
            close: close
        };
    }

    // ────────────────────────────────────────────────────────────────
    // createTable
    // ────────────────────────────────────────────────────────────────

    /**
     * Builds a styled data table from headers and row data.
     *
     * @param {string[]} headers - Column header labels.
     * @param {Array<Array<string|number>>} rows - Row data (2D array).
     * @param {Object} [options]
     * @param {boolean} [options.sortable=false] - Enable click-to-sort on headers.
     * @param {boolean} [options.searchable=false] - Add a search/filter input above the table.
     * @param {boolean} [options.exportable=false] - Add a "Copy CSV" button.
     * @returns {{ wrapper: HTMLElement, table: HTMLElement, refresh: Function }}
     */
    function createTable(headers, rows, options) {
        var opts = options || {};
        var sortCol = -1;
        var sortAsc = true;
        var currentRows = rows.slice();

        // Wrapper
        var wrapper = createElement('div', { style: { width: '100%' } });

        // Toolbar (search + export)
        var toolbar = null;
        var searchInput = null;

        if (opts.searchable || opts.exportable) {
            toolbar = createElement('div', {
                style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px'
                }
            });

            if (opts.searchable) {
                searchInput = createElement('input', {
                    className: 'tacta-input',
                    placeholder: 'Filter rows...',
                    style: { flex: '1' }
                });
                searchInput.addEventListener('input', function () {
                    renderBody();
                });
                toolbar.appendChild(searchInput);
            }

            if (opts.exportable) {
                var exportBtn = createElement('button', {
                    className: 'tacta-btn tacta-btn-sm',
                    textContent: 'Copy CSV'
                });
                exportBtn.addEventListener('click', function () {
                    var csv = headers.join(',') + '\n';
                    for (var r = 0; r < currentRows.length; r++) {
                        csv += currentRows[r].map(function (cell) {
                            var str = String(cell);
                            if (str.indexOf(',') >= 0 || str.indexOf('"') >= 0) {
                                return '"' + str.replace(/"/g, '""') + '"';
                            }
                            return str;
                        }).join(',') + '\n';
                    }
                    copyToClipboard(csv).then(function (ok) {
                        if (ok) showToast('CSV copied to clipboard', 'success', 2000);
                    });
                });
                toolbar.appendChild(exportBtn);
            }

            wrapper.appendChild(toolbar);
        }

        // Table wrapper (scrollable)
        var tableWrapper = createElement('div', { className: 'tacta-table-wrapper' });

        // Table
        var table = createElement('table', { className: 'tacta-table' });

        // Thead
        var thead = createElement('thead');
        var headRow = createElement('tr');
        for (var h = 0; h < headers.length; h++) {
            var th = createElement('th', {
                textContent: headers[h],
                className: opts.sortable ? 'tacta-sortable' : '',
                dataset: { col: String(h) }
            });
            if (opts.sortable) {
                th.addEventListener('click', (function (colIndex) {
                    return function () {
                        if (sortCol === colIndex) {
                            sortAsc = !sortAsc;
                        } else {
                            sortCol = colIndex;
                            sortAsc = true;
                        }
                        renderBody();
                        updateSortIndicators();
                    };
                })(h));
            }
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        // Tbody
        var tbody = createElement('tbody');
        table.appendChild(tbody);

        tableWrapper.appendChild(table);
        wrapper.appendChild(tableWrapper);

        function updateSortIndicators() {
            var ths = headRow.querySelectorAll('th');
            for (var i = 0; i < ths.length; i++) {
                ths[i].classList.remove('tacta-sort-asc', 'tacta-sort-desc');
                if (parseInt(ths[i].dataset.col, 10) === sortCol) {
                    ths[i].classList.add(sortAsc ? 'tacta-sort-asc' : 'tacta-sort-desc');
                }
            }
        }

        function renderBody() {
            // Filter
            var filtered = currentRows;
            if (searchInput && searchInput.value.trim()) {
                var term = searchInput.value.trim().toLowerCase();
                filtered = currentRows.filter(function (row) {
                    for (var c = 0; c < row.length; c++) {
                        if (String(row[c]).toLowerCase().indexOf(term) >= 0) return true;
                    }
                    return false;
                });
            }

            // Sort
            if (sortCol >= 0) {
                filtered = filtered.slice().sort(function (a, b) {
                    var va = a[sortCol];
                    var vb = b[sortCol];
                    if (typeof va === 'number' && typeof vb === 'number') {
                        return sortAsc ? va - vb : vb - va;
                    }
                    va = String(va).toLowerCase();
                    vb = String(vb).toLowerCase();
                    if (va < vb) return sortAsc ? -1 : 1;
                    if (va > vb) return sortAsc ? 1 : -1;
                    return 0;
                });
            }

            // Render
            tbody.innerHTML = '';
            for (var r = 0; r < filtered.length; r++) {
                var tr = createElement('tr');
                for (var c = 0; c < headers.length; c++) {
                    var cellVal = filtered[r][c] !== undefined ? filtered[r][c] : '';
                    tr.appendChild(createElement('td', { textContent: String(cellVal) }));
                }
                tbody.appendChild(tr);
            }
        }

        /**
         * Replaces the table data and re-renders.
         * @param {Array<Array<string|number>>} newRows
         */
        function refresh(newRows) {
            currentRows = newRows.slice();
            sortCol = -1;
            sortAsc = true;
            updateSortIndicators();
            renderBody();
        }

        // Initial render
        renderBody();

        return {
            wrapper: wrapper,
            table: table,
            refresh: refresh
        };
    }

    // ────────────────────────────────────────────────────────────────
    // copyToClipboard
    // ────────────────────────────────────────────────────────────────

    /**
     * Copies text to the system clipboard.
     * Uses the Clipboard API with a textarea fallback.
     *
     * @param {string} text - Text to copy.
     * @returns {Promise<boolean>} Resolves true if successful, false otherwise.
     */
    function copyToClipboard(text) {
        // Prefer modern Clipboard API
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).then(function () {
                return true;
            }).catch(function () {
                return _fallbackCopy(text);
            });
        }
        return Promise.resolve(_fallbackCopy(text));
    }

    /**
     * Fallback clipboard copy using a hidden textarea and execCommand.
     * @param {string} text
     * @returns {boolean}
     */
    function _fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '-9999px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (_) {
            ok = false;
        }
        document.body.removeChild(ta);
        return ok;
    }

    // ────────────────────────────────────────────────────────────────
    // injectStylesheet
    // ────────────────────────────────────────────────────────────────

    /**
     * Loads a CSS file into the current page. Avoids duplicate injection.
     *
     * @param {string} url - URL of the stylesheet (can be a chrome-extension:// URL).
     * @returns {Promise<void>} Resolves when the stylesheet has loaded.
     */
    function injectStylesheet(url) {
        return new Promise(function (resolve, reject) {
            var wrapper = _ensureRoot();
            var shadow = wrapper.parentNode; // The ShadowRoot

            // Check for duplicate in shadow root
            if (shadow.querySelector('link[href="' + url + '"]')) {
                resolve();
                return;
            }

            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = url;
            link.addEventListener('load', function () { resolve(); });
            link.addEventListener('error', function () {
                reject(new Error('TactaDOM: Failed to load stylesheet: ' + url));
            });

            // Insert before the wrapper to ensure styles are available for elements inside
            shadow.insertBefore(link, wrapper);
        });
    }

    // ────────────────────────────────────────────────────────────────
    // Expose
    // ────────────────────────────────────────────────────────────────

    /** @namespace TactaDOM */
    var TactaDOM = {
        getToolkitRoot: _ensureRoot,
        createPanel: createPanel,
        createModal: createModal,
        showToast: showToast,
        createSidebar: createSidebar,
        createTable: createTable,
        copyToClipboard: copyToClipboard,
        injectStylesheet: injectStylesheet,
        createElement: createElement
    };

    if (typeof window !== 'undefined') {
        window.TactaDOM = TactaDOM;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = TactaDOM;
    }
})();
