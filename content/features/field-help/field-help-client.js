/**
 * field-help-client.js
 * NetSuite TactaSuite — Field Help (Page World Script)
 *
 * @author Blane Maher
 *
 * MV3-compliant rewrite — NO eval(), NO new Function().
 * Uses a MutationObserver to detect when NetSuite's field help popup
 * iframe (#fieldhelp_frame) appears in the DOM. When it does, waits
 * for the iframe's body_div to load, then appends enhanced field data.
 *
 * Runs in the page world — NO IIFE, NO strict mode — so it can access
 * NetSuite globals (nlapiGetFieldValue, jQuery, getDropdown, etc.).
 *
 * @fileoverview Page-world inject script for the Field Help feature.
 */

if (!window.__tactaFieldHelpClientLoaded) {
window.__tactaFieldHelpClientLoaded = true;

// ── Public API object ────────────────────────────────────────────
var NSExtension = {
    /**
     * Main entry: extract field ID from iframe src and build enhancements.
     * @param {HTMLIFrameElement} iframe - The #fieldhelp_frame element
     */
    enhanceFromIframe: function(iframe) {
        try {
            var fieldId = _tactaGetFieldIdFromIframe(iframe);
            if (!fieldId) return;
            var iframeDoc = iframe.contentWindow.document;
            _tactaBuildEnhancement(fieldId, iframeDoc);
        } catch (err) {
            console.log('[Tacta FieldHelp] Error enhancing iframe: ' + err);
        }
    },

    /**
     * Legacy entry: accept a URL string, resolve the iframe, build enhancements.
     * Kept for backward compatibility with any callers passing a URL.
     * @param {string} urlStr - URL containing f= or fld= parameter
     */
    getFieldHelpData: function(urlStr) {
        try {
            var d = 2, e = urlStr.indexOf('f=');
            if (-1 === e) { e = urlStr.indexOf('fld='); d = 4; }
            var f = urlStr.indexOf('&', e + 1);
            if (-1 === f) f = urlStr.length;
            if (e && f) {
                var fieldId = urlStr.substring(e + d, f);
                var iframe = document.getElementById('fieldhelp_frame');
                if (iframe) {
                    var iframeDoc = iframe.contentWindow.document;
                    _tactaBuildEnhancement(fieldId, iframeDoc);
                }
            }
        } catch (err) {
            console.log('[Tacta FieldHelp] Error getting data. Err: ' + err);
        }
    },

    /**
     * Set a field's mandatory flag and close the popup.
     */
    setFieldRequired: function(fieldId, val) {
        nlapiSetFieldMandatory(fieldId, val);
        _tactaClosePopup();
    },

    /**
     * Set a field's disabled flag and close the popup.
     */
    setFieldDisabled: function(fieldId, val) {
        nlapiSetFieldDisabled(fieldId, val);
        _tactaClosePopup();
    },

    /**
     * Copy a field ID to the clipboard.
     */
    copyFieldId: function(fieldId) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(fieldId).catch(function() {
                _tactaCopyFallback(fieldId);
            });
        } else {
            _tactaCopyFallback(fieldId);
        }
    },

    /**
     * Set a field's value and close the popup.
     */
    setNewValue: function(fieldId, val) {
        nlapiSetFieldValue(fieldId, val);
        _tactaClosePopup();
    },

    /**
     * Lazy-load the system-note history for a body field into the popup.
     * Triggered by the "Load" link rendered in divTactaHistory.
     */
    loadFieldHistory: function(fieldId) {
        try { _tactaLoadFieldHistory(fieldId); } catch (err) {
            console.log('[Tacta FieldHelp] Error loading field history: ' + err);
        }
    },

    /**
     * Expand the compact history list to every cached row.
     */
    showAllFieldHistory: function(fieldId) {
        try {
            var rows = _tactaHistoryCache[fieldId];
            if (rows) _tactaRenderFieldHistory(fieldId, rows, true);
        } catch (err) {
            console.log('[Tacta FieldHelp] Error expanding field history: ' + err);
        }
    }
};

// Expose globally for onclick handlers inside the iframe
window.NSExtension = NSExtension;


// ── HTML escape helper ───────────────────────────────────────────

function _tactaEsc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// ── URL scheme validator ─────────────────────────────────────────
// Only allows http:, https:, and relative (/) URLs. Blocks javascript:, data:, etc.

function _tactaIsSafeUrl(url) {
    if (!url) return false;
    var trimmed = url.trim();
    if (trimmed.charAt(0) === '/') return true;
    if (/^https?:/i.test(trimmed)) return true;
    return false;
}


// ── Field ID validator ───────────────────────────────────────────
// NetSuite field IDs are alphanumeric with underscores. Reject anything else
// to prevent injection when embedding in onclick attribute strings.

function _tactaIsValidFieldId(fieldId) {
    if (!fieldId) return false;
    return /^[a-zA-Z0-9_]+$/.test(fieldId);
}


// ── Extract field ID from iframe src ─────────────────────────────

function _tactaGetFieldIdFromIframe(iframe) {
    var src = iframe.src || iframe.getAttribute('src') || '';
    var match = src.match(/[?&]f=([^&]+)/) || src.match(/[?&]fld=([^&]+)/);
    return match ? match[1] : null;
}


// ── Close popup helpers ──────────────────────────────────────────

function _tactaClosePopup() {
    try {
        if (typeof jQuery !== 'undefined' && jQuery('.x-tool-close').length > 0) {
            jQuery('.x-tool-close').click();
        }
    } catch (_) {}
    try {
        var closeBtn = document.querySelector("[aria-label='Close']");
        if (closeBtn) closeBtn.click();
    } catch (_) {}
}


// ── Clipboard fallback ───────────────────────────────────────────

function _tactaCopyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
}


// ── XHR helper ───────────────────────────────────────────────────

function _tactaXhr(url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.onload = xhr.onerror = function() { callback(xhr.responseText); };
    xhr.open('GET', url);
    xhr.send();
}


// ── Get source record link via Sync function ─────────────────────
// NetSuite generates a global function named Sync<fieldId> for
// select fields that links to the source record. We read it
// via window['Sync' + fieldId] and extract the URL from its
// toString() representation — NO eval needed.

function _tactaGetSourceLink(fieldId) {
    try {
        var syncFn = window['Sync' + fieldId];
        if (typeof syncFn !== 'function') return '';
        var fnStr = syncFn.toString();
        var openIdx = fnStr.indexOf('nlOpenWindow(');
        if (openIdx < 1) return '';
        var quoteIdx = fnStr.indexOf("'", openIdx + 15);
        var url = fnStr.substring(openIdx + 14, quoteIdx);
        url = url.replace('target', 'target_');
        return url;
    } catch (_) {
        return '';
    }
}


// ── Field history (systemnote via SuiteQL) ───────────────────────
// The page world cannot call chrome.runtime, so the query is relayed to
// the field-help.js content script over window.postMessage; it forwards
// to the background executeSuiteQL handler and posts the result back.
// If the relay does not answer (content script missing) and NetSuite's
// require() is available, N/query is used directly as a fallback.

/** @type {string} postMessage namespace shared with field-help.js */
var _TACTA_FH_NAMESPACE = 'TACTA_FIELD_HELP';

/** @type {number} Compact rows shown before the "more" link */
var _TACTA_FH_HISTORY_PREVIEW = 5;

/** @type {number} ms to wait for the content-script relay before falling back */
var _TACTA_FH_RELAY_TIMEOUT = 10000;

/** @type {Object<string, Array<Object>>} Rows already fetched, by field id */
var _tactaHistoryCache = {};

/** @type {Object<string, {resolve: Function, reject: Function, timer: number}>} */
var _tactaFhPending = {};

var _tactaFhReqCounter = 0;

window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.namespace !== _TACTA_FH_NAMESPACE || msg.direction !== 'response') return;
    var pending = _tactaFhPending[msg.requestId];
    if (!pending) return;
    clearTimeout(pending.timer);
    delete _tactaFhPending[msg.requestId];
    if (msg.error) {
        pending.reject(new Error(msg.error));
    } else {
        pending.resolve(msg.result || { rows: [] });
    }
});

function _tactaRunSuiteQL(query) {
    return new Promise(function(resolve, reject) {
        var requestId = _TACTA_FH_NAMESPACE + '_' + (++_tactaFhReqCounter) + '_' + Date.now().toString(36);
        var timer = setTimeout(function() {
            delete _tactaFhPending[requestId];
            _tactaRunSuiteQLDirect(query).then(resolve, reject);
        }, _TACTA_FH_RELAY_TIMEOUT);
        _tactaFhPending[requestId] = { resolve: resolve, reject: reject, timer: timer };
        window.postMessage({
            namespace: _TACTA_FH_NAMESPACE,
            direction: 'request',
            requestId: requestId,
            action: 'executeSuiteQL',
            query: query
        }, '*');
    });
}

function _tactaRunSuiteQLDirect(query) {
    return new Promise(function(resolve, reject) {
        if (typeof require !== 'function') {
            reject(new Error('SuiteQL relay timed out and N/query is not available on this page.'));
            return;
        }
        try {
            require(['N/query'], function(queryModule) {
                try {
                    var rs = queryModule.runSuiteQL({ query: query });
                    resolve({ rows: rs.asMappedResults() });
                } catch (e) {
                    reject(e);
                }
            }, function(err) {
                reject(err || new Error('Failed to load N/query'));
            });
        } catch (e) {
            reject(e);
        }
    });
}

function _tactaSqlQuote(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function _tactaGetRecordId() {
    try {
        if (typeof nlapiGetRecordId === 'function') {
            var rid = nlapiGetRecordId();
            if (rid && /^\d+$/.test(String(rid))) return String(rid);
        }
    } catch (_) {}
    var m = window.location.href.match(/[?&]id=(\d+)/);
    return m ? m[1] : null;
}

// Body field = reachable through nlapiGetField, or rendered outside a
// sublist machine table. Sublist columns are not addressable in systemnote.
function _tactaIsBodyField(fieldId) {
    try {
        if (typeof nlapiGetField === 'function' && nlapiGetField(fieldId)) return true;
    } catch (_) {}
    var ids = [fieldId + '_fs_lbl', fieldId + '_fs', fieldId, 'inpt_' + fieldId, 'hddn_' + fieldId];
    for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (!el) continue;
        if (el.closest && el.closest('.uir-machine-table-container, table.uir-machine-table, .uir-machine-row, .uir-machine-headerrow')) {
            return false;
        }
        return true;
    }
    return false;
}

function _tactaGetHelpDoc() {
    var frame = document.getElementById('fieldhelp_frame');
    if (!frame) return null;
    try { return frame.contentWindow.document; } catch (_) { return null; }
}

/**
 * Tries the uppercased id (CUSTBODY_X / ENTITY), then the raw id, then a
 * suffix match for the RECTYPE.KFIELD form some standard fields use.
 */
function _tactaFetchFieldHistory(recordId, fieldId) {
    var upper = String(fieldId).toUpperCase();
    var candidates = [
        'sn.field = ' + _tactaSqlQuote(upper),
        'sn.field = ' + _tactaSqlQuote(fieldId),
        'UPPER(sn.field) LIKE ' + _tactaSqlQuote('%.K' + upper)
    ];

    function attempt(i) {
        if (i >= candidates.length) return Promise.resolve([]);
        var sql = 'SELECT sn.date, sn.name, BUILTIN.DF(sn.name) AS username, sn.oldvalue, sn.newvalue ' +
            'FROM systemnote sn ' +
            'WHERE sn.record = ' + recordId + ' AND ' + candidates[i] + ' ' +
            'ORDER BY sn.date DESC';
        return _tactaRunSuiteQL(sql).then(function(result) {
            var rows = (result && result.rows) ? result.rows : [];
            if (rows.length > 0) return rows;
            return attempt(i + 1);
        });
    }

    return attempt(0);
}

function _tactaLoadFieldHistory(fieldId) {
    if (!_tactaIsValidFieldId(fieldId)) return;
    var doc = _tactaGetHelpDoc();
    if (!doc) return;
    var div = doc.getElementById('divTactaHistory');
    if (!div) return;

    if (_tactaHistoryCache[fieldId]) {
        _tactaRenderFieldHistory(fieldId, _tactaHistoryCache[fieldId], false);
        return;
    }

    var recordId = _tactaGetRecordId();
    if (!recordId) {
        div.innerHTML = '<span style="color:#666666">History: <i>record not saved yet</i></span>';
        return;
    }

    div.innerHTML = '<span style="color:#666666">History: <i>Loading...</i></span>';

    _tactaFetchFieldHistory(recordId, fieldId).then(function(rows) {
        _tactaHistoryCache[fieldId] = rows;
        _tactaRenderFieldHistory(fieldId, rows, false);
    }).catch(function(err) {
        var d = _tactaGetHelpDoc();
        var target = d ? d.getElementById('divTactaHistory') : null;
        if (target) {
            target.innerHTML = '<span style="color:#666666">History: </span>' +
                '<span style="color:#c0392b">' + _tactaEsc(err && err.message ? err.message : String(err)) + '</span> ' +
                '(<a href="javascript:void(0)" onclick="window.parent.NSExtension.loadFieldHistory(\'' + _tactaEsc(fieldId) + '\');return false;">retry</a>)';
        }
    });
}

/**
 * Compact table: date | user | old -> new. First 5 rows unless showAll.
 */
function _tactaRenderFieldHistory(fieldId, rows, showAll) {
    var doc = _tactaGetHelpDoc();
    if (!doc) return;
    var div = doc.getElementById('divTactaHistory');
    if (!div) return;

    if (!rows || rows.length === 0) {
        div.innerHTML = '<span style="color:#666666">History: <i>no system notes for this field</i></span>';
        return;
    }

    var limit = showAll ? rows.length : Math.min(rows.length, _TACTA_FH_HISTORY_PREVIEW);
    var html = '<div style="color:#666666;margin-bottom:2px">History: <b>' + rows.length + '</b> change' + (rows.length !== 1 ? 's' : '') + '</div>' +
        '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation" style="font-size:11px"><tbody>';

    for (var i = 0; i < limit; i++) {
        var r = rows[i];
        var who = r.username || r.name || '';
        var oldVal = (r.oldvalue === null || r.oldvalue === undefined) ? '' : String(r.oldvalue);
        var newVal = (r.newvalue === null || r.newvalue === undefined) ? '' : String(r.newvalue);
        var bg = (i % 2 === 0) ? '#f1f1f1' : '#fafafa';
        html += '<tr style="background-color:' + bg + '">' +
            '<td style="white-space:nowrap;color:#666666">' + _tactaEsc(r.date || '') + '</td>' +
            '<td style="color:#666666">' + _tactaEsc(who) + '</td>' +
            '<td><span style="color:#999999;text-decoration:line-through">' + _tactaEsc(oldVal || '(empty)') + '</span>' +
            ' -&gt; <b>' + _tactaEsc(newVal || '(empty)') + '</b></td></tr>';
    }

    html += '</tbody></table>';

    if (!showAll && rows.length > limit) {
        html += '<div style="color:#666666;margin-top:2px"><a href="javascript:void(0)" onclick="window.parent.NSExtension.showAllFieldHistory(\'' + _tactaEsc(fieldId) + '\');return false;">' +
            'Show ' + (rows.length - limit) + ' more</a></div>';
    }

    div.innerHTML = html;
}


// ── Build mandatory/disabled toggle HTML ─────────────────────────

function _tactaBuildFieldAttrs(fieldId) {
    var html = '';
    try {
        var field = nlapiGetField(fieldId);
        if (field && null == nlapiGetFieldValue('edit')) {
            html += '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
                '<tr><td align="right" style="color:#666666">Mandatory: ' +
                (field.required ? '<b>Yes</b>' : 'No') +
                ' (<a href="javascript:void(0)" onclick="window.parent.NSExtension.setFieldRequired(\'' + _tactaEsc(fieldId) + '\', ' + !field.required + ');return false;">Set' +
                (field.required ? ' Non' : '') + ' mandatory</a>)</td></tr>' +
                '<tr><td align="right" style="color:#666666">Disabled: ' +
                (field.disabled ? '<b>Yes</b>' : 'No') +
                ' (<a href="javascript:void(0)" onclick="window.parent.NSExtension.setFieldDisabled(\'' + _tactaEsc(fieldId) + '\', ' + !field.disabled + ');return false;">Set' +
                (field.disabled ? ' Non' : '') + ' disabled</a>)</td></tr></tbody></table>';
        }
    } catch (err) {
        console.log('[Tacta FieldHelp] Error getting field attributes.');
    }
    return html;
}


// ── Fetch custom field definition ────────────────────────────────

function _tactaDetectCustomFieldType(fieldId, iframeDoc) {
    if (fieldId.substring(0, 8) === 'custbody') {
        _tactaFetchCustomFieldDef(fieldId, 'bodycustfields', iframeDoc);
    } else if (fieldId.substring(0, 10) === 'custentity') {
        _tactaFetchCustomFieldDef(fieldId, 'entitycustfields', iframeDoc);
    } else if (fieldId.substring(0, 8) === 'custitem') {
        _tactaFetchCustomFieldDef(fieldId, 'itemcustfields', iframeDoc);
    }
}

function _tactaFetchCustomFieldDef(fieldId, fieldCategory, iframeDoc) {
    _tactaXhr('/app/common/custom/' + fieldCategory + '.nl?frame=B&segment=1%01000%01%021000', function(response) {
        if (!response) return;
        var idx = response.indexOf('>' + fieldId + '<');
        if (idx < 1) return;

        // Parse the custom field name (link) from the HTML table
        var tdEnd = response.lastIndexOf('<td', idx);
        var tdPrev = response.lastIndexOf('<td', tdEnd - 1);
        var tdStart = response.lastIndexOf('<td', tdPrev - 1);
        var tagStart = response.indexOf('<', tdStart + 1);
        var tagEnd = response.indexOf('</td>', tagStart);
        var fieldLink = response.substring(tagStart, tagEnd);
        fieldLink = fieldLink.replace('"_self"', '"_blank"');

        // Parse the field type
        var typeStart = response.indexOf('>' + fieldId + '<');
        typeStart = response.indexOf('<td', typeStart + 1);
        typeStart = response.indexOf('<td', typeStart + 1);
        typeStart = response.indexOf('>', typeStart + 1);
        var typeEnd = response.indexOf('</td>', typeStart);
        var fieldType = response.substring(typeStart + 1, typeEnd);

        var html = '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
            '<tr><td align="right" style="color:#666666">Custom Field: ' + fieldLink + '</td></tr>' +
            '<tr><td align="right" style="color:#666666">Field Type: <i>' + fieldType + '</i></td></tr></tbody></table>';

        // Fetch XML definition for formula/source list
        _tactaFetchFieldXml(fieldLink, iframeDoc);

        var divCustom = iframeDoc.getElementById('divCustomFields');
        if (divCustom && typeof jQuery !== 'undefined') {
            jQuery(divCustom).html(html);
        }
    });
}


// ── Fetch XML field definition (formula, source list) ────────────

function _tactaFetchFieldXml(fieldLinkHtml, iframeDoc) {
    var hrefMatch = fieldLinkHtml.match(/href="([^"]*)/);
    if (!hrefMatch) return;
    var url = hrefMatch[1];

    _tactaXhr(url + '&xml=T', function(response) {
        if (!response) return;
        try {
            var parser = new DOMParser();
            var xmlDoc = parser.parseFromString(response, 'text/xml');
            if (!xmlDoc) return;

            var isFormula = false;
            var staticListId = null;
            var selectRecordId = null;

            try { isFormula = 'T' === xmlDoc.getElementsByTagName('isformula')[0].childNodes[0].nodeValue; } catch (_) { isFormula = false; }
            try { staticListId = xmlDoc.getElementsByTagName('staticlistrecordtype')[0].childNodes[0].nodeValue; } catch (_) { staticListId = null; }
            try { selectRecordId = xmlDoc.getElementsByTagName('selectrecordtype')[0].childNodes[0].nodeValue; } catch (_) { selectRecordId = null; }

            var html = '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>';
            var hasContent = false;

            if (selectRecordId && parseInt(selectRecordId) > 0) {
                html += '<tr><td align="right" style="color:#666666">List: <a href="/app/common/custom/custrecordentrylist.nl?rectype=' + selectRecordId + '" target="_blank">Go to Source List</a></td></tr>';
                hasContent = true;
            } else if (staticListId && parseInt(staticListId) > 0) {
                html += '<tr><td align="right" style="color:#666666">List: <a href="/app/common/custom/custlist.nl?id=' + staticListId + '&e=T&ord=T" target="_blank">Go to Source List</a></td></tr>';
                hasContent = true;
            }

            if (isFormula) {
                var formula = '';
                try { formula = xmlDoc.getElementsByTagName('defaultvalue')[0].childNodes[0].nodeValue; } catch (_) { formula = ''; }
                if (formula) {
                    html += '<tr><td align="right" style="color:#666666">Formula: <i>' + formula + '</i></td></tr>';
                    hasContent = true;
                }
            }

            html += '</tbody></table>';

            if (hasContent) {
                var divCustom = iframeDoc.getElementById('divCustomFields');
                if (divCustom && typeof jQuery !== 'undefined') {
                    jQuery(divCustom).html(jQuery(divCustom).html() + html);
                }
            }
        } catch (err) {
            console.log('[Tacta FieldHelp] Error parsing XML field definition: ' + err);
        }
    });
}


// ── Main enhancement builder ─────────────────────────────────────

function _tactaBuildEnhancement(fieldId, iframeDoc) {
    // Validate field ID before embedding in HTML/onclick attributes
    if (!_tactaIsValidFieldId(fieldId)) {
        console.log('[Tacta FieldHelp] Invalid field ID rejected: ' + fieldId);
        return;
    }

    var html = '';
    var dataOptions = null;
    var fieldValue = null;
    var sourceLink = '';

    // Fetch custom field info (async — will inject itself)
    try { _tactaDetectCustomFieldType(fieldId, iframeDoc); } catch (err) {
        console.log('[Tacta FieldHelp] Error getting custom field data: ' + err);
    }

    // Get data-options from the NS dropdown element
    try {
        if (typeof jQuery !== 'undefined') {
            dataOptions = jQuery('.ns-dropdown[data-name="' + fieldId + '"]').attr('data-options');
        }
    } catch (_) {}

    // Get field value/text
    try { fieldValue = nlapiGetFieldValue(fieldId); } catch (_) {}

    var fieldText = '';

    if (fieldValue) {
        // Multi-select aware: try getFieldValues/Texts first
        try {
            var multiVals = nlapiGetFieldValues(fieldId);
            if (multiVals) fieldValue = multiVals.join();
        } catch (_) {}
        try {
            var multiTexts = nlapiGetFieldTexts(fieldId);
            if (multiTexts) fieldText = multiTexts.join();
        } catch (_) {}
        try {
            if (!fieldText) {
                var singleText = nlapiGetFieldText(fieldId);
                if (singleText) fieldText = singleText;
            }
        } catch (_) {}

        // Get source record link (validate URL scheme to prevent XSS)
        if (dataOptions) {
            var rawLink = _tactaGetSourceLink(fieldId);
            if (_tactaIsSafeUrl(rawLink)) sourceLink = rawLink;
        }

        html = '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
            '<tr><td align="right" style="color:#666666">Field Value: <b>' +
            (sourceLink ? '<a href="' + _tactaEsc(sourceLink) + '&id=' + _tactaEsc(fieldValue) + '" target="_blank">' + _tactaEsc(fieldValue) + '</a>' : _tactaEsc(fieldValue)) +
            '</b></td></tr>';
        if (fieldText) {
            html += '<tr><td align="right" style="color:#666666">Field Text: ' + _tactaEsc(fieldText) + '</td></tr>';
        }
        html += '</tbody></table>';
    }

    // Set new value (edit mode only — edit mode: nlapiGetFieldValue("edit") == null)
    var isEditMode = false;
    try { isEditMode = (null == nlapiGetFieldValue('edit')); } catch (_) {}

    if (isEditMode) {
        html += '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
            '<tr><td align="right" style="color:#666666">' +
            '<table style="border: 1px solid #666666;border-radius: 13px; border-spacing: 0;padding: 5px;">' +
            '<tr><td style="color:#666666">Enter new value:&nbsp;&nbsp;' +
            '<input type="text" id="txtNewValue" style="width:100px">&nbsp;&nbsp;' +
            '<button id="btnSetId" onclick="window.parent.NSExtension.setNewValue(\'' + _tactaEsc(fieldId) + '\', window.document.getElementById(\'txtNewValue\').value);return false;">Set</button>' +
            '</td></tr></table></td></tr></tbody></table>';
    }

    // Mandatory / Disabled toggles
    html += _tactaBuildFieldAttrs(fieldId);

    // Custom field info placeholder (populated async by _tactaDetectCustomFieldType)
    html += '<div id="divCustomFields"></div>';

    // Field history (body fields on a saved record only; loaded on demand)
    var showHistory = false;
    try { showHistory = !!_tactaGetRecordId() && _tactaIsBodyField(fieldId); } catch (_) {}
    if (showHistory) {
        html += '<div id="divTactaHistory" style="text-align:right;padding:2px"><span style="color:#666666">History: ' +
            '<a href="javascript:void(0)" onclick="window.parent.NSExtension.loadFieldHistory(\'' + _tactaEsc(fieldId) + '\');return false;">Load</a></span></div>';
    }

    // Select options table
    if (dataOptions) {
        var options = [];
        try { options = JSON.parse(dataOptions); } catch (_) {}

        html += '<hr><table id="dataOptionsTable" border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
            '<tr><td class="fgroup_title" align="center">Internal Id</td><td class="fgroup_title">Text</td><td class="fgroup_title"></td></tr>';

        // If data-options is empty, try getDropdown fallback
        if (options.length === 0) {
            try {
                var dropdownEl = window.document.getElementsByName('inpt_' + fieldId)[0];
                if (dropdownEl) {
                    var dropdown = getDropdown(dropdownEl);
                    if (dropdown) {
                        for (var di = 0; di < dropdown.valueArray.length; di++) {
                            if (dropdown.valueArray[di]) {
                                options.push({ value: dropdown.valueArray[di], text: dropdown.textArray[di] });
                            }
                        }
                    }
                }
            } catch (_) {}
        }

        for (var oi = 0; oi < options.length; oi++) {
            var bgColor = (options[oi].value == fieldValue) ? '#FFFF99' : (oi % 2 === 0 ? '#f1f1f1' : '#fafafa');
            if (options[oi].value) {
                html += '<tr style="background-color:' + bgColor + '"><td align="center">' + _tactaEsc(options[oi].value) + '</td><td>' + _tactaEsc(options[oi].text) + '</td>' +
                    '<td><a href="javascript:void(0)" onclick="window.parent.NSExtension.setNewValue(\'' + _tactaEsc(fieldId) + '\', \'' + _tactaEsc(options[oi].value) + '\');return false;">Set</a></td></tr>';
            }
        }
        html += '</tbody></table>';
    }

    // Wrap with Copy Field ID button at the top
    if (html) {
        html = '<table border="0" cellspacing="0" cellpadding="2" width="100%" role="presentation"><tbody>' +
            '<tr><td align="right" style="color:#666666">' +
            '<div id="divCopy"></div>' +
            '<button id="btnCopyId" onclick="window.parent.NSExtension.copyFieldId(\'' + _tactaEsc(fieldId) + '\');window.document.getElementById(\'btnCopyId\').style.display=\'none\';window.document.getElementById(\'divCopy\').innerHTML=\'<i>Copied!</i>\';return false;">Copy Field Id</button>' +
            '<br/></td></tr></tbody></table>' + html;
    }

    // Inject into iframe body_div
    _tactaInjectIntoIframe(html, iframeDoc);
}


// ── Inject HTML into iframe body_div ─────────────────────────────

function _tactaInjectIntoIframe(html, iframeDoc) {
    if (!html) return;

    var bodyDiv = iframeDoc.getElementById('body_div');
    if (bodyDiv) {
        if (typeof jQuery !== 'undefined') {
            jQuery(bodyDiv).append(html);
        } else {
            bodyDiv.insertAdjacentHTML('beforeend', html);
        }
    } else {
        // body_div not yet loaded — poll for it
        var attempts = 0;
        var poller = setInterval(function() {
            var frame = document.getElementById('fieldhelp_frame');
            if (frame) {
                try {
                    var doc = frame.contentWindow.document;
                    var div = doc.getElementById('body_div');
                    if (div) {
                        if (typeof jQuery !== 'undefined') {
                            jQuery(div).append(html);
                        } else {
                            div.insertAdjacentHTML('beforeend', html);
                        }
                        clearInterval(poller);
                        return;
                    }
                } catch (_) {}
            }
            attempts++;
            if (attempts > 10) clearInterval(poller);
        }, 300);
    }
}


// ── Wait for iframe body_div, then enhance ───────────────────────

function _tactaWaitForBodyDiv(iframe) {
    var attempts = 0;
    var poller = setInterval(function() {
        try {
            var doc = iframe.contentWindow.document;
            if (doc && doc.getElementById('body_div')) {
                clearInterval(poller);
                NSExtension.enhanceFromIframe(iframe);
            }
        } catch (_) {
            // Cross-origin or not yet loaded — keep trying
        }
        attempts++;
        if (attempts > 20) clearInterval(poller);
    }, 150);
}


// ── MutationObserver: detect #fieldhelp_frame insertion ──────────
// Observes document.body with childList only (no subtree) since
// NetSuite's Ext.Window containers are appended directly to body.
// Falls back to subtree:true only for body children that are containers.

var _tactaHelpObserver = new MutationObserver(function(mutations) {
    for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType !== 1) continue;

            var iframe = null;

            // Check if this node IS the iframe
            if (node.id === 'fieldhelp_frame') {
                iframe = node;
            }

            // Check if this node CONTAINS the iframe (Ext.Window wraps it)
            if (!iframe && node.querySelector) {
                iframe = node.querySelector('#fieldhelp_frame');
            }

            if (iframe) {
                _tactaWaitForBodyDiv(iframe);
                // Disconnect the broad observer while help popup is open.
                // Reconnect when the iframe is removed from the DOM.
                _tactaHelpObserver.disconnect();
                _tactaWatchForClose(iframe);
                return;
            }
        }
    }
});

// Watch for the help iframe to be removed, then re-enable the main observer
function _tactaWatchForClose(iframe) {
    var closeObserver = new MutationObserver(function(mutations) {
        // Check if iframe has been removed from the document
        if (!document.contains(iframe)) {
            closeObserver.disconnect();
            _tactaStartObserving();
        }
    });
    // Only watch body's direct children for removal (Ext.Window removal)
    closeObserver.observe(document.body, { childList: true });
}

// Start observing once document.body is available
// Only watches body's direct childList — Ext.Window popups are appended here
function _tactaStartObserving() {
    if (document.body) {
        _tactaHelpObserver.observe(document.body, { childList: true, subtree: true });
    } else {
        // Body not yet available — wait for DOMContentLoaded
        document.addEventListener('DOMContentLoaded', function() {
            _tactaHelpObserver.observe(document.body, { childList: true, subtree: true });
        }, { once: true });
    }
}

_tactaStartObserving();

} // end guard: if (!window.__tactaFieldHelpClientLoaded)
