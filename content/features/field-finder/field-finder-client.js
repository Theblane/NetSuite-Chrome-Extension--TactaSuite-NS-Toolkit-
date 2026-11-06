/**
 * field-finder-client.js
 * NetSuite TactaSuite - Field Finder (PAGE WORLD script)
 */
(function () {
    'use strict';

    if (window.__tactaFieldFinderLoaded) return;
    window.__tactaFieldFinderLoaded = true;

    var FIELD_DROPDOWN_NAMES = [
        'rffield', 'filterfilter', 'sort1', 'sort2', 'sort3',
        'field', 'dffield', 'fffilter',
        'fieldid', 'fieldname', 'fieldselect', 'workflowfield', 'wfconditionfield',
        'conditionfield', 'actionfield', 'triggerfield', 'recordfield'
    ];

    var FIELD_TYPE = {
        STANDARD: 'Standard',
        RELATED: 'Related Fields',
        CUSTOM: 'Custom Field',
        CUSTOM_BODY: 'Custom Body',
        CUSTOM_COLUMN: 'Custom Column',
        FORMULA: 'Formula Field'
    };

    function getSearchType() {
        var stEl = document.getElementById('searchtype');
        if (stEl && stEl.value) return stEl.value;
        try {
            return typeof NS !== 'undefined' && NS.Core ? (NS.Core.getURLParameter('searchtype') || '') : '';
        } catch (_) {
            return '';
        }
    }

    function stripCustomLabel(text) {
        return String(text || '').replace(/\((Custom Body|Custom Column|Custom)\)/i, '').trim();
    }

    function isRelatedFieldLabel(text) {
        return /\bfields\.\.\.\s*$/i.test(String(text || '').trim());
    }

    function classifyField(fieldId, fieldName) {
        var id = String(fieldId || '').toLowerCase();
        var name = String(fieldName || '').toLowerCase();
        if (isRelatedFieldLabel(fieldName)) return FIELD_TYPE.RELATED;
        if (id.match(/formula/) || name.match(/^formula\b|\(formula\)|formula \(/)) return FIELD_TYPE.FORMULA;
        if (id.match(/^custbody/)) return FIELD_TYPE.CUSTOM_BODY;
        if (id.match(/^custcol/)) return FIELD_TYPE.CUSTOM_COLUMN;
        if (id.match(/^(custrecord|custentity|custitem)/)) return FIELD_TYPE.CUSTOM;
        return FIELD_TYPE.STANDARD;
    }

    function prettyFieldId(fieldId, searchType) {
        var strip = ['stdentity', 'stdbody', 'custom_', 'transaction_'];
        if (searchType) strip.push(String(searchType).toLowerCase() + '_');
        return String(fieldId || '').toLowerCase().replace(new RegExp('(' + strip.join('|') + ')', 'g'), '');
    }

    function escapeRegExp(value) {
        return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function copyText(value) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(value);
                return;
            }
        } catch (_) {}
        var ta = document.createElement('textarea');
        ta.value = value;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        document.body.removeChild(ta);
    }

    function isolateFinderEvent(e, preventDefault) {
        if (preventDefault) e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    }

    function FieldFinderDropdown(nsDropdown, searchType) {
        this.nsDropdown = nsDropdown;
        this.searchType = searchType || '';
        this.options = [];
        this.buttons = {};
        this.active = {
            standard: false,
            custom: false,
            related: false,
            formula: false
        };
        this.searchInput = document.createElement('input');
        this.header = document.createElement('div');
        this.status = document.createElement('div');
        this.firstVisibleIndex = -1;
        this.init();
    }

    FieldFinderDropdown.prototype.init = function () {
        if (!this.nsDropdown.div) this.nsDropdown.buildDiv();
        if (!this.nsDropdown.div || this.nsDropdown.div._tactaFieldFinderLoaded) return;

        this.nsDropdown.div._tactaFieldFinderLoaded = true;
        this.nsDropdown.div.style.setProperty('width', '800px');
        this.nsDropdown.div.style.setProperty('margin-top', '32px');
        this.nsDropdown.div.style.setProperty('margin-bottom', '25px');

        this.prepareOptions();
        this.addHeader();
        this.addFooter();
        this.bindOpenHandlers();
        this.filterDropdown();
    };

    FieldFinderDropdown.prototype.prepareOptions = function () {
        this.options = [];
        for (var i = 0; i < this.nsDropdown.valueArray.length; i++) {
            this.options.push(new FieldFinderOption(this, i));
        }
    };

    /**
     * NetSuite rebuilds a field dropdown's option list in place when its
     * contents change (for example after choosing a "... Fields..." entry that
     * repopulates the list). Our option objects then point at detached cells
     * and stale indexes, and selecting one would call setAndClose() with the
     * wrong index, which NetSuite reports as "Field not found". Rebuild when
     * the live arrays no longer match what we indexed.
     */
    FieldFinderDropdown.prototype.refreshOptionsIfStale = function () {
        var ns = this.nsDropdown;
        var values = ns.valueArray || [];
        var cells = ns.divArray || [];
        if (!cells.length && typeof ns.buildDiv === 'function') {
            try { ns.buildDiv(); cells = ns.divArray || []; } catch (_) { return; }
        }
        var stale = this.options.length !== values.length ||
            (this.options.length > 0 && cells.length > 0 && this.options[0].element !== cells[0]) ||
            (this.options.length > 0 && !document.contains(this.options[0].element));
        if (!stale) return;
        this.prepareOptions();
        this.filterDropdown();
    };

    FieldFinderDropdown.prototype.addHeader = function () {
        this.header.className = 'tacta-ff-container';
        this.header.setAttribute('onclick', 'event.preventDefault();');
        this.header.setAttribute('onpointerdown', 'event.preventDefault();');

        this.searchInput.type = 'text';
        this.searchInput.className = 'tacta-ff-input';
        this.searchInput.placeholder = 'Filter by Name or ID...';
        this.searchInput.autocomplete = 'off';
        this.searchInput.setAttribute('onmouseup', 'event.preventDefault();event.stopPropagation();this.focus();');
        this.searchInput.setAttribute('ondblclick', 'event.preventDefault();this.select();');
        this.searchInput.setAttribute('onclick', 'event.preventDefault();event.stopPropagation();this.focus();');

        var self = this;
        this.searchInput.addEventListener('mousedown', function (e) {
            isolateFinderEvent(e, true);
            self.searchInput.focus();
        }, true);
        this.searchInput.addEventListener('mouseup', function (e) {
            isolateFinderEvent(e, true);
            self.searchInput.focus();
        }, true);
        this.searchInput.addEventListener('click', function (e) {
            isolateFinderEvent(e, true);
            self.searchInput.focus();
        }, true);
        this.searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                isolateFinderEvent(e, true);
                self.handleArrowKey(e.key);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                isolateFinderEvent(e, true);
                self.handleEnterOrTabKey();
                return;
            }
            if (e.key === 'Escape') {
                isolateFinderEvent(e, true);
                self.searchInput.value = '';
                self.handleTextInput();
                return;
            }
            isolateFinderEvent(e, false);
        }, true);
        this.searchInput.addEventListener('keypress', function (e) {
            isolateFinderEvent(e, false);
        }, true);
        this.searchInput.addEventListener('keyup', function (e) {
            isolateFinderEvent(e, false);
            self.handleTextInput();
        }, true);
        this.searchInput.addEventListener('input', function (e) {
            isolateFinderEvent(e, false);
            self.handleTextInput();
        }, true);

        var btnGroup = document.createElement('div');
        btnGroup.className = 'tacta-ff-btn-group';
        this.addButton(btnGroup, 'standard', 'Standard');
        this.addButton(btnGroup, 'custom', 'Custom');
        this.addButton(btnGroup, 'related', 'Related Fields');
        this.addButton(btnGroup, 'formula', 'Formula');

        this.header.appendChild(this.searchInput);
        this.header.appendChild(btnGroup);
        this.nsDropdown.div.insertBefore(this.header, this.nsDropdown.div.childNodes[0]);
    };

    FieldFinderDropdown.prototype.addButton = function (container, key, label) {
        var self = this;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tacta-ff-btn';
        btn.textContent = label;
        btn.setAttribute('onpointerdown', 'event.preventDefault();');
        btn.addEventListener('mousedown', function (e) {
            isolateFinderEvent(e, true);
        }, true);
        btn.addEventListener('click', function (e) {
            isolateFinderEvent(e, true);
            self.active[key] = !self.active[key];
            btn.classList.toggle('tacta-ff-btn-active', self.active[key]);
            self.resetNetSuiteIndex();
            self.filterDropdown();
            self.searchInput.focus();
        }, true);
        this.buttons[key] = btn;
        container.appendChild(btn);
    };

    FieldFinderDropdown.prototype.addFooter = function () {
        this.status.className = 'tacta-ff-status';
        this.nsDropdown.div.appendChild(this.status);
    };

    FieldFinderDropdown.prototype.bindOpenHandlers = function () {
        var self = this;
        function focusFinder() {
            if (!self.nsDropdown.div && typeof self.nsDropdown.buildDiv === 'function') {
                try { self.nsDropdown.buildDiv(); } catch (_) {}
            }
            if (!self.nsDropdown.div) return;

            if (!self.nsDropdown.div._tactaFieldFinderLoaded) {
                self.nsDropdown.div._tactaFieldFinderLoaded = true;
            }
            if (!self.header.parentNode) {
                self.nsDropdown.div.insertBefore(self.header, self.nsDropdown.div.childNodes[0]);
            }
            if (!self.status.parentNode) {
                self.nsDropdown.div.appendChild(self.status);
            }
            self.searchInput.focus();
        }

        if (this.nsDropdown.inpt) {
            this.nsDropdown.inpt.addEventListener('click', function () {
                setTimeout(focusFinder, 10);
            });
            this.nsDropdown.inpt.addEventListener('focus', function () {
                setTimeout(focusFinder, 10);
            });
            var arrow = document.getElementById(this.nsDropdown.inpt.id + '_arrow');
            if (arrow) {
                arrow.addEventListener('click', function () {
                    setTimeout(focusFinder, 10);
                });
            }
        }

        if (this.nsDropdown.open) {
            var originalOpen = this.nsDropdown.open.bind(this.nsDropdown);
            this.nsDropdown.open = function () {
                originalOpen();
                self.refreshOptionsIfStale();
                self.searchInput.value = '';
                self.filterDropdown();
                focusFinder();
                setTimeout(focusFinder, 10);
            };
        }
    };

    FieldFinderDropdown.prototype.anyTypeFilterActive = function () {
        return this.active.standard || this.active.custom || this.active.related || this.active.formula;
    };

    FieldFinderDropdown.prototype.matchesActiveType = function (option) {
        if (!this.anyTypeFilterActive()) return true;
        if (this.active.standard && option.fieldType === FIELD_TYPE.STANDARD) return true;
        if (this.active.related && option.isRelatedField) return true;
        if (this.active.formula && option.fieldType === FIELD_TYPE.FORMULA) return true;
        if (this.active.custom && (
            option.fieldType === FIELD_TYPE.CUSTOM ||
            option.fieldType === FIELD_TYPE.CUSTOM_BODY ||
            option.fieldType === FIELD_TYPE.CUSTOM_COLUMN
        )) return true;
        return false;
    };

    FieldFinderDropdown.prototype.filterDropdown = function () {
        var shown = 0;
        var term = this.searchInput.value || '';
        this.firstVisibleIndex = -1;
        for (var i = 0; i < this.options.length; i++) {
            if (this.options[i].filter(term)) {
                if (this.firstVisibleIndex < 0) this.firstVisibleIndex = i;
                shown++;
            }
        }
        this.status.textContent = 'Showing ' + shown + ' of ' + this.options.length + ' fields';
    };

    FieldFinderDropdown.prototype.resetNetSuiteIndex = function () {
        try {
            this.nsDropdown.respondToArrow(0 - (this.nsDropdown.indexOnDeck || 0));
        } catch (_) {}
    };

    FieldFinderDropdown.prototype.handleTextInput = function () {
        this.filterDropdown();
    };

    FieldFinderDropdown.prototype.handleEnterOrTabKey = function () {
        var idx = this.nsDropdown.indexOnDeck || 0;
        if (this.searchInput.value) idx = this.firstVisibleIndex;
        if (!this.options[idx] || this.options[idx].hidden) idx = this.firstVisibleIndex;
        if (this.options[idx]) this.selectOption(this.options[idx]);
        else {
            try { this.nsDropdown.setAndClose(idx); } catch (_) {}
        }
    };

    FieldFinderDropdown.prototype.selectOption = function (option) {
        if (!option || option.hidden) return;
        // Never hand NetSuite an index from a list it has since rebuilt:
        // re-index, then select the same field id in the fresh list.
        if (this.nsDropdown.valueArray && this.nsDropdown.valueArray[option.index] !== option.fieldId) {
            this.refreshOptionsIfStale();
            var fresh = null;
            for (var k = 0; k < this.options.length; k++) {
                if (this.options[k].fieldId === option.fieldId) { fresh = this.options[k]; break; }
            }
            if (!fresh || fresh === option || fresh.hidden) return;
            option = fresh;
        }

        try {
            this.nsDropdown.indexOnDeck = option.index;
            if (this.nsDropdown.setCurrentCellInMenu && this.nsDropdown.divArray[option.index]) {
                this.nsDropdown.setCurrentCellInMenu(this.nsDropdown.divArray[option.index]);
            }
            this.nsDropdown.setAndClose(option.index);
        } catch (err) {
            console.warn('[Tacta FieldFinder] Failed to select field option:', err);
        }
    };

    FieldFinderDropdown.prototype.handleArrowKey = function (key) {
        var current = this.nsDropdown.indexOnDeck || 0;
        if (current === 0 && key === 'ArrowUp') return;
        var dir = key === 'ArrowDown' ? 1 : -1;
        var next = current + dir;
        while (this.options[next]) {
            if (!this.options[next].hidden) {
                try { this.nsDropdown.respondToArrow(next - current); } catch (_) {}
                break;
            }
            next += dir;
        }
    };

    function FieldFinderOption(dropdown, index) {
        this.dropdown = dropdown;
        this.index = index;
        this.element = dropdown.nsDropdown.divArray[index];
        this.fieldId = dropdown.nsDropdown.valueArray[index] || '';
        this.originalName = dropdown.nsDropdown.textArray[index] || '';
        this.fieldName = stripCustomLabel(this.originalName);
        this.fieldType = classifyField(this.fieldId, this.originalName);
        this.isRelatedField = isRelatedFieldLabel(this.originalName);
        this.prettyId = prettyFieldId(this.fieldId, dropdown.searchType);
        this.hidden = false;
        this.nameEl = document.createElement('span');
        this.idEl = document.createElement('span');
        this.typeEl = document.createElement('span');
        this.build();
    }

    FieldFinderOption.prototype.build = function () {
        while (this.element.firstChild) this.element.removeChild(this.element.firstChild);
        this.element.classList.add('tacta-ff-option-row');

        this.nameEl.className = 'tacta-ff-col tacta-ff-col-name';
        this.idEl.className = 'tacta-ff-col tacta-ff-col-id';
        this.typeEl.className = 'tacta-ff-col tacta-ff-col-type';

        this.nameEl.textContent = this.fieldName;
        this.idEl.textContent = this.fieldType === FIELD_TYPE.RELATED ? '' : this.prettyId;
        this.typeEl.textContent = this.fieldType;

        var self = this;
        this.idEl.setAttribute('onmouseup', 'event.preventDefault();event.stopImmediatePropagation();');
        this.idEl.addEventListener('mousedown', function (e) {
            isolateFinderEvent(e, true);
        }, true);
        this.idEl.addEventListener('mouseup', function (e) {
            isolateFinderEvent(e, true);
        }, true);
        this.idEl.addEventListener('click', function (e) {
            isolateFinderEvent(e, true);
            copyText(self.fieldId);
            self.idEl.classList.add('tacta-ff-copied');
            setTimeout(function () {
                self.idEl.classList.remove('tacta-ff-copied');
            }, 1200);
        }, true);

        this.element.addEventListener('mousedown', function (e) {
            if (e.target === self.idEl || self.idEl.contains(e.target)) return;
            isolateFinderEvent(e, true);
        }, true);
        this.element.addEventListener('mouseup', function (e) {
            if (e.target === self.idEl || self.idEl.contains(e.target)) return;
            isolateFinderEvent(e, true);
            self.dropdown.selectOption(self);
        }, true);
        this.element.addEventListener('click', function (e) {
            if (e.target === self.idEl || self.idEl.contains(e.target)) return;
            isolateFinderEvent(e, true);
        }, true);

        this.element.appendChild(this.nameEl);
        this.element.appendChild(this.idEl);
        this.element.appendChild(this.typeEl);
    };

    FieldFinderOption.prototype.filter = function (term) {
        var visible = this.dropdown.matchesActiveType(this);
        if (visible && term) {
            var regex = new RegExp(escapeRegExp(term), 'i');
            visible = regex.test(this.fieldName) || regex.test(this.prettyId);
        }
        if (visible) this.show();
        else this.hide();

        if (visible && term) this.highlight(term);
        else this.resetText();

        return visible;
    };

    FieldFinderOption.prototype.highlight = function (term) {
        var regex = new RegExp('(' + escapeRegExp(term) + ')', 'gi');
        this.nameEl.innerHTML = this.fieldName.replace(regex, '<mark class="tacta-ff-highlight">$1</mark>');
        if (this.fieldType !== FIELD_TYPE.RELATED) {
            this.idEl.innerHTML = this.prettyId.replace(regex, '<mark class="tacta-ff-highlight">$1</mark>');
        }
    };

    FieldFinderOption.prototype.resetText = function () {
        this.nameEl.textContent = this.fieldName;
        this.idEl.textContent = this.fieldType === FIELD_TYPE.RELATED ? '' : this.prettyId;
    };

    FieldFinderOption.prototype.hide = function () {
        this.element.style.setProperty('display', 'none');
        this.hidden = true;
    };

    FieldFinderOption.prototype.show = function () {
        this.element.style.removeProperty('display');
        this.hidden = false;
    };

    function looksLikeFieldDropdown(dd) {
        if (!dd || !dd.valueArray || !dd.textArray || dd.valueArray.length < 8) return false;
        var sampleSize = Math.min(dd.valueArray.length, 40);
        var matches = 0;
        for (var i = 0; i < sampleSize; i++) {
            var value = String(dd.valueArray[i] || '').toLowerCase();
            var text = String(dd.textArray[i] || '').toLowerCase();
            if (/^(cust(body|col|entity|item|record)|tran|entity|item|memo|amount|date|status|externalid|internalid)/.test(value) ||
                /(field|amount|date|status|memo|customer|vendor|item|transaction)/.test(text)) {
                matches++;
            }
        }
        return matches >= Math.max(4, Math.floor(sampleSize * 0.2));
    }

    function init() {
        if (typeof dropdowns === 'undefined') return;
        var searchType = getSearchType();
        var isWorkflow = /\/app\/common\/workflow\/setup\//i.test(window.location.href);
        for (var name in dropdowns) {
            if (!Object.prototype.hasOwnProperty.call(dropdowns, name)) continue;
            var dd = dropdowns[name];
            if (dd && (FIELD_DROPDOWN_NAMES.indexOf(dd.name) >= 0 || (isWorkflow && looksLikeFieldDropdown(dd)))) {
                try {
                    dd.fieldFinder = new FieldFinderDropdown(dd, searchType);
                } catch (e) {
                    console.warn('[Tacta FieldFinder] Failed to enhance dropdown "' + name + '":', e);
                }
            }
        }
    }

    if (typeof NS !== 'undefined' && NS.form && NS.form.isInited && NS.event) {
        if (NS.form.isInited()) init();
        else NS.event.once(NS.event.type.FORM_INITED, init);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 500); });
    } else {
        setTimeout(init, 500);
    }
})();
