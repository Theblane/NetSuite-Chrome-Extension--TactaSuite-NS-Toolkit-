/**
 * Field Explorer page-world functions, exercised against a fake NetSuite form.
 *
 * The functions under test live in background/service-worker.js and are
 * serialised into the NetSuite page with chrome.scripting.executeScript. This
 * test extracts their source text, loads a fixture that mimics NetSuite's form
 * markup (.uir-field-wrapper[data-field-type], <id>_fs_lbl labels, machine
 * tables) plus fake SS2 (require/N/currentRecord) and SS1 (nlapi*) globals,
 * and checks the field metadata that comes back.
 *
 * Runs headless and does not need the extension loaded.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const swSource = fs.readFileSync(path.resolve(__dirname, '../background/service-worker.js'), 'utf8');

function extractFn(name: string, nextName: string): string {
    const start = swSource.indexOf(`function ${name}(`);
    const end = swSource.indexOf(`\nfunction ${nextName}(`, start);
    if (start < 0 || end < 0) throw new Error(`Could not extract ${name} from service-worker.js`);
    return swSource.slice(start, end);
}

const FE_GET_FIELDS = extractFn('feGetRecordFieldsFn', 'feGetSelectOptionsFn');
const FE_GET_OPTIONS = extractFn('feGetSelectOptionsFn', 'feSetFieldValueFn');
const FE_SET_VALUE = extractFn('feSetFieldValueFn', 'feSetFieldAttributeFn');

// Guard: the page-world functions must be self-contained. Any helper defined
// elsewhere in the service worker would be undefined once injected.
test('page-world functions do not reference other service-worker helpers', () => {
    const topLevelNames = Array.from(swSource.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)).map((m) => m[1]);
    for (const src of [FE_GET_FIELDS, FE_GET_OPTIONS, FE_SET_VALUE]) {
        const own = src.match(/^function\s+(\w+)/)![1];
        for (const name of topLevelNames) {
            if (name === own) continue;
            expect(new RegExp(`\\b${name}\\s*\\(`).test(src), `${own} must not call ${name}`).toBe(false);
        }
    }
});

const FIXTURE_HTML = `<!doctype html><html><body>
<form id="main_form" name="main_form">
  <input type="hidden" name="whence" id="whence" value="">
  <input type="hidden" name="nlloc" id="nlloc" value="">
  <input type="hidden" name="entryformquerystring" id="entryformquerystring" value="x=1">
  <input type="hidden" name="nlapiPI" id="nlapiPI" value="">
  <input type="hidden" name="type" id="type" value="salesord">
  <table>
    <tr>
      <td>
        <div class="uir-field-wrapper" data-field-type="select" data-nsps-type="field_input" data-nsps-label="Customer">
          <div class="uir-label"><a id="entity_fs_lbl_uir_label"><span id="entity_fs_lbl" class="smalltextnolink">Customer <span class="uir-required-icon">*</span></span></a></div>
          <span class="uir-field">
            <input type="text" id="inpt_entity" name="inpt_entity" readonly value="ABC Corp">
            <input type="hidden" name="entity" id="hddn_entity" value="123">
          </span>
        </div>
      </td>
      <td>
        <div class="uir-field-wrapper" data-field-type="checkbox">
          <span class="uir-field"><input type="checkbox" id="custbody_flag" name="custbody_flag" checked></span>
          <div class="uir-label"><a><span id="custbody_flag_fs_lbl" class="smalltextnolink">Rush Order</span></a></div>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <div class="uir-field-wrapper" data-field-type="date">
          <div class="uir-label"><a><span id="trandate_fs_lbl">Date</span></a></div>
          <span class="uir-field"><input type="text" id="trandate" name="trandate" value="10/20/2026"></span>
        </div>
      </td>
      <td>
        <div class="uir-field-wrapper" data-field-type="currency">
          <div class="uir-label"><a><span id="total_fs_lbl">Total</span></a></div>
          <span class="uir-field"><span id="total_fs">1,234.50</span></span>
        </div>
      </td>
    </tr>
    <tr style="display:none">
      <td>
        <div class="uir-field-wrapper" data-field-type="text">
          <div class="uir-label"><a><span id="custbody_collapsed_fs_lbl">Collapsed</span></a></div>
          <span class="uir-field"><input type="text" id="custbody_collapsed" name="custbody_collapsed" value="c"></span>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <div class="uir-field-wrapper" data-field-type="textarea">
          <div class="uir-label"><a><span id="custbody_dom_only_fs_lbl">DOM Only</span></a></div>
          <span class="uir-field"><textarea id="custbody_dom_only" name="custbody_dom_only">hello</textarea></span>
        </div>
      </td>
      <td>
        <!-- Visible on screen, but SS2 reports isDisplay:false. The page wins. -->
        <div class="uir-field-wrapper" data-field-type="text">
          <div class="uir-label"><a><span id="custbody_quirk_fs_lbl">Quirk</span></a></div>
          <span class="uir-field"><input type="text" id="custbody_quirk" name="custbody_quirk" value="q"></span>
        </div>
      </td>
    </tr>
    <tr>
      <td>
        <!-- No wrapper, bare id is a hidden companion input, label uses the _lbl form.
             Old code matched the hidden input first and called the field hidden. -->
        <span id="custbody_bare_lbl" class="smalltextnolink">Bare</span>
        <span id="custbody_bare_fs">shown</span>
        <input type="hidden" name="custbody_bare" id="custbody_bare" value="b">
      </td>
      <td>
        <!-- Only a hidden input and nothing visible: genuinely hidden -->
        <input type="hidden" name="custbody_onlyhidden" id="custbody_onlyhidden" value="oh">
      </td>
    </tr>
  </table>
  <input type="hidden" name="custbody_hidden_input" id="custbody_hidden_input" value="hv">
  <!-- View-mode list/record field: no input at all, NetSuite renders the display
       text as a link to the source record and stamps data-field-name on the wrapper. -->
  <div class="uir-field-wrapper" data-field-type="select" data-field-name="custbody_viewsel" data-mode="view" data-nsps-label="Vendor">
    <span id="custbody_viewsel_fs_lbl_uir_label" class="uir-label"><span id="custbody_viewsel_fs_lbl" class="uir-label-span smallgraytextnolink">Vendor</span></span>
    <span class="uir-field inputreadonly" data-field-type="select">
      <span class="inputreadonly uir-field-input" data-fieldtype="select" data-mode="view"><a id="qsTarget_1" class="dottedlink" href="/app/common/entity/vendor.nl?id=77">Widget Corp<span style="padding-left:5px"></span></a></span>
    </span>
  </div>
  <!-- Form header: the quick-find box is not a field. -->
  <div class="uir-form-header"><div id="uir-quickfind-box" class="uir-quickfind"><div><input type="text" id="quickfind-field" name="quickfind-field"></div></div></div>
  <!-- Inline-HTML field (NetSuite Sticky Notes) whose widget markup carries its own
       form controls. The field is real; the controls inside it are not fields. -->
  <div class="uir-field-wrapper" data-field-type="inlinehtml">
    <div class="uir-label"><a><span id="custpage_stick_fs_lbl" class="smalltextnolink">Sticky Notes</span></a></div>
    <span id="custpage_stick_fs" class="text"><span id="custpage_stick_val">
      <div id="stickEntry"><textarea id="stickNote" name="stickNote"></textarea><select id="stickEmployeeSelect" name="stickEmployeeSelect"><option value="1">A</option></select></div>
      <table id="stickNoteUserPreference"><tr><td><input type="checkbox" id="stickHideNote" name="stickHideNote"><label for="stickHideNote">HIDE NOTES</label></td></tr></table>
      <table id="tbl_stickbtnNext" class="uir-button"><tr><td><input type="button" id="stickbtnNext" value="Next"></td></tr></table>
    </span></span>
  </div>
  <div class="ns-dropdown" data-name="entity" data-options='[{"value":"","text":""},{"value":"123","text":"ABC Corp"},{"value":"456","text":"XYZ Inc"}]'></div>
  <div id="item_layer">
    <div class="uir-machine-table-container" id="item_splits">
      <table id="item_splits_table">
        <tr class="uir-machine-headerrow">
          <td data-nsps-id="columnsheader_item_item" data-nsps-label="Item"><div>Item</div></td>
          <td data-nsps-id="columnsheader_item_quantity" data-nsps-label="Quantity"><div>Quantity</div></td>
          <td data-nsps-id="columnsheader_item_custcol_note" data-nsps-label="Note"><div>Note</div></td>
        </tr>
        <tr class="uir-machine-row-odd"><td>Widget</td><td>2</td><td>n</td></tr>
      </table>
    </div>
  </div>
</form>
</body></html>`;

/** Installs fake SS2 (async require) and SS1 globals on the page. */
const WIDGET_IDS = ['quickfind-field', 'stickNote', 'stickEmployeeSelect', 'stickHideNote', 'stickbtnNext'];

async function installFakeNetSuite(page: Page, opts: { ss2: boolean; viewMode?: boolean }) {
    await page.evaluate(({ withSS2, viewMode }) => {
        const w = window as any;

        const bodyMeta: Record<string, any> = {
            entity: { type: 'select', label: 'Customer', isMandatory: true, isDisabled: false, isDisplay: true, isVisible: true },
            custbody_flag: { type: 'checkbox', label: 'Rush Order', isMandatory: false, isDisabled: false, isDisplay: true, isVisible: true },
            trandate: { type: 'date', label: 'Date', isMandatory: true, isDisabled: false, isDisplay: true, isVisible: true },
            total: { type: 'currency', label: 'Total', isMandatory: false, isDisabled: true, isDisplay: true, isVisible: true },
            custbody_collapsed: { type: 'text', label: 'Collapsed', isMandatory: false, isDisabled: false, isDisplay: true, isVisible: true },
            custbody_hidden_input: { type: 'text', label: 'Hidden Input', isMandatory: false, isDisabled: false, isDisplay: false, isVisible: false },
            custbody_dom_only: { type: 'textarea', label: 'DOM Only', isMandatory: false, isDisabled: false, isDisplay: true, isVisible: true },
            custbody_quirk: { type: 'text', label: 'Quirk', isMandatory: false, isDisabled: false, isDisplay: false, isVisible: false },
            custbody_bare: { type: 'text', label: 'Bare', isMandatory: false, isDisabled: false, isDisplay: true, isVisible: true },
            custbody_onlyhidden: { type: 'text', label: 'Only Hidden', isMandatory: false, isDisabled: false, isDisplay: true, isVisible: true },
            custbody_ss2hidden: { type: 'text', label: 'SS2 Hidden', isMandatory: false, isDisabled: false, isDisplay: false, isVisible: false }
            // custbody_offform: in getFields() but getField() returns null (not on the form)
        };
        const values: Record<string, any> = {
            entity: '123', custbody_flag: true, trandate: new Date('2026-10-20T00:00:00Z'), total: 1234.5,
            custbody_collapsed: 'c', custbody_hidden_input: 'hv', custbody_dom_only: 'hello', custbody_offform: 'off',
            custbody_multi: ['1', '2'], custbody_quirk: 'q', custbody_bare: 'b', custbody_onlyhidden: 'oh', custbody_ss2hidden: 's'
        };
        const texts: Record<string, any> = { entity: 'ABC Corp', custbody_multi: ['One', 'Two'] };

        const lineMeta: Record<string, any> = {
            item: { type: 'select', label: 'Item', isDisplay: true },
            // Header cell is rendered, so SS2's isDisplay:false must not win.
            quantity: { type: 'float', label: 'Quantity', isDisplay: false, isVisible: false },
            custcol_note: { type: 'text', label: 'Note', isDisplay: true },
            custcol_hiddencol: { type: 'text', label: 'Hidden Col', isDisplay: false }
        };
        const lineValues: Record<string, any> = { item: '55', quantity: 2, custcol_note: 'n', custcol_hiddencol: 'h' };
        const lineTexts: Record<string, any> = { item: 'Widget' };

        w.__setValueCalls = [];

        const rec = {
            type: 'salesorder',
            id: 42,
            getFields: () => ['entity', 'custbody_flag', 'trandate', 'total', 'custbody_collapsed', 'custbody_hidden_input', 'custbody_offform', 'custbody_multi',
                'custbody_quirk', 'custbody_bare', 'custbody_onlyhidden', 'custbody_ss2hidden'],
            getField: ({ fieldId }: any) => {
                if (fieldId === 'custbody_multi') {
                    return { type: 'multiselect', label: 'Multi', isDisplay: true, isVisible: true, getSelectOptions: () => [{ value: '1', text: 'One' }, { value: '2', text: 'Two' }] };
                }
                return bodyMeta[fieldId] ? { ...bodyMeta[fieldId], getSelectOptions: () => [{ value: '9', text: 'Nine' }] } : null;
            },
            getValue: ({ fieldId }: any) => (fieldId in values ? values[fieldId] : null),
            getText: ({ fieldId }: any) => {
                if (fieldId === 'custbody_flag') throw new Error('getText not supported for checkbox');
                return fieldId in texts ? texts[fieldId] : (fieldId in values ? String(values[fieldId]) : null);
            },
            setValue: ({ fieldId, value }: any) => { w.__setValueCalls.push({ fieldId, value }); values[fieldId] = value; },
            getSublists: () => ['item'],
            getLineCount: ({ sublistId }: any) => { if (sublistId !== 'item') throw new Error('bad sublist'); return 1; },
            getSublistFields: ({ sublistId }: any) => (sublistId === 'item' ? ['item', 'quantity', 'custcol_note', 'custcol_hiddencol'] : []),
            getSublistField: ({ fieldId }: any) => lineMeta[fieldId] || null,
            getCurrentSublistField: ({ fieldId }: any) => lineMeta[fieldId] || null,
            getSublistValue: ({ fieldId }: any) => (fieldId in lineValues ? lineValues[fieldId] : null),
            getSublistText: ({ fieldId }: any) => (fieldId in lineTexts ? lineTexts[fieldId] : null)
        };

        // View mode: N/currentRecord.get() returns a record whose getFields is
        // undefined, and whose getField() returns the SAME stub for any id,
        // real or not (observed live on a custom record, 2026-10-21).
        const viewRec = {
            type: 'salesorder', id: 42, isDynamic: false, getFields: undefined, getSublists: undefined,
            getField: (_: any) => ({ type: 'text', label: '', isDisplay: false, isVisible: false, isMandatory: false, isDisabled: false }),
            getValue: ({ fieldId }: any) => (fieldId in values ? values[fieldId] : null),
            getText: ({ fieldId }: any) => (fieldId in texts ? texts[fieldId] : null),
            getLineCount: (_: any) => -1
        };
        if (withSS2) {
            // NetSuite's AMD loader invokes the callback asynchronously.
            const r = viewMode ? viewRec : rec;
            w.require = (deps: string[], cb: Function) => { setTimeout(() => cb({ get: () => r }), 15); };
        } else {
            delete w.require;
        }

        // SS1 globals. nlapiGetField reports 'text' with no label for anything it
        // does not really know about, which is the behaviour that produced the
        // spurious "Free-Form Text" rows.
        const ss1Known: Record<string, any> = {
            entity: { type: 'select', label: 'Customer' },
            custbody_flag: { type: 'checkbox', label: 'Rush Order' },
            trandate: { type: 'date', label: 'Date' },
            total: { type: 'currency', label: 'Total' }
        };
        w.nlapiGetField = (id: string) => {
            const k = ss1Known[id] || { type: 'text', label: '' };
            return { type: k.type, getType: () => k.type, getLabel: () => k.label, isMandatory: () => id === 'entity', isDisabled: () => id === 'total' };
        };
        const ss1Values: Record<string, any> = { entity: '123', custbody_flag: 'T', trandate: '10/20/2026', total: '1234.50', custbody_collapsed: 'c', custbody_dom_only: 'hello', custbody_hidden_input: 'hv', custbody_quirk: 'q', custbody_bare: 'b', whence: '', nlloc: '' };
        w.nlapiGetFieldValue = (id: string) => (id in ss1Values ? ss1Values[id] : null);
        w.nlapiGetFieldText = (id: string) => (id === 'entity' ? 'ABC Corp' : null);
        w.nlapiGetFieldValues = (id: string) => (id in ss1Values ? [ss1Values[id]] : []);
        w.nlapiGetFieldTexts = (id: string) => (id === 'entity' ? ['ABC Corp'] : []);
        w.nlapiSetFieldValue = (id: string, v: any) => { ss1Values[id] = v; };
        w.nlapiGetRecordType = () => 'salesorder';
        w.nlapiGetRecordId = () => 42;
        w.nlapiGetLineItemCount = (name: string) => (name === 'item' ? 1 : -1);
        w.nlapiGetLineItemValue = (sl: string, f: string) => (sl === 'item' && f in lineValues ? String(lineValues[f]) : null);
        w.nlapiGetLineItemText = (sl: string, f: string) => (sl === 'item' && f in lineTexts ? lineTexts[f] : null);
        w.nlapiGetLineItemField = (sl: string, f: string) => {
            const k = lineMeta[f];
            return k ? { type: k.type, getType: () => k.type, getLabel: () => k.label } : { type: 'text', getType: () => 'text', getLabel: () => '' };
        };
    }, { withSS2: opts.ss2, viewMode: !!opts.viewMode });
}

async function runGetFields(page: Page): Promise<any> {
    return page.evaluate(`(${FE_GET_FIELDS})()`);
}

function byId(list: any[], id: string) {
    return list.find((f) => f.id === id);
}

test.describe('feGetRecordFieldsFn', () => {
    test('SS2 path: types come from N/currentRecord, plumbing inputs are excluded', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: true });
        const result = await runGetFields(page);

        expect(result.error).toBeUndefined();
        expect(result.meta.ss2).toBe(true);
        expect(result.meta.recordType).toBe('salesorder');

        const ids = result.bodyFields.map((f: any) => f.id);
        for (const junk of ['whence', 'nlloc', 'entryformquerystring', 'nlapiPI', 'type', 'inpt_entity', 'hddn_entity', ...WIDGET_IDS]) {
            expect(ids, `${junk} must not be listed as a field`).not.toContain(junk);
        }
        expect(byId(result.bodyFields, 'custpage_stick')).toMatchObject({ type: 'Inline HTML', label: 'Sticky Notes', isHidden: false });

        const entity = byId(result.bodyFields, 'entity');
        expect(entity).toMatchObject({ type: 'List/Record', label: 'Customer', value: '123', text: 'ABC Corp', isMandatory: true, isHidden: false });
        // A readonly dropdown display input is NOT a disabled field.
        expect(entity.isDisabled).toBe(false);

        expect(byId(result.bodyFields, 'custbody_flag')).toMatchObject({ type: 'Check Box', label: 'Rush Order', value: true, text: null });
        expect(byId(result.bodyFields, 'trandate')).toMatchObject({ type: 'Date', label: 'Date', value: '2026-10-20T00:00:00.000Z' });
        expect(byId(result.bodyFields, 'total')).toMatchObject({ type: 'Currency', label: 'Total', value: 1234.5, isDisabled: true });
        expect(byId(result.bodyFields, 'custbody_multi')).toMatchObject({ type: 'Multi-Select', value: '1, 2', text: 'One, Two' });

        // Collapsed row => hidden. Only a hidden input in the DOM => hidden.
        expect(byId(result.bodyFields, 'custbody_collapsed')).toMatchObject({ type: 'Free-Form Text', isHidden: true, hiddenBy: 'dom' });
        expect(byId(result.bodyFields, 'custbody_hidden_input')).toMatchObject({ type: 'Free-Form Text', label: 'Hidden Input', isHidden: true, hiddenBy: 'dom', value: 'hv' });
        expect(byId(result.bodyFields, 'custbody_onlyhidden')).toMatchObject({ isHidden: true, hiddenBy: 'dom' });

        // The page is the deciding vote: visibly rendered fields are never hidden,
        // even when N/currentRecord reports isDisplay:false.
        expect(byId(result.bodyFields, 'custbody_quirk')).toMatchObject({ type: 'Free-Form Text', label: 'Quirk', isHidden: false, hiddenBy: null, value: 'q' });
        // A hidden companion input beside a visible label/value is not a hidden field.
        expect(byId(result.bodyFields, 'custbody_bare')).toMatchObject({ label: 'Bare', isHidden: false, value: 'b' });
        // Nothing in the DOM, SS2 has a field object and says hidden => trust SS2.
        expect(byId(result.bodyFields, 'custbody_ss2hidden')).toMatchObject({ isHidden: true, hiddenBy: 'ss2' });

        // On the record but not on the form: listed, hidden, and NOT mislabelled
        // as Free-Form Text just because SS1 defaulted to 'text'.
        expect(byId(result.bodyFields, 'custbody_offform')).toMatchObject({ type: 'Unknown', isHidden: true, hiddenBy: 'not-on-form', value: 'off' });

        // Visible fields never carry a hidden badge.
        for (const id of ['entity', 'custbody_flag', 'trandate', 'total', 'custbody_dom_only', 'custbody_quirk', 'custbody_bare']) {
            expect(byId(result.bodyFields, id).isHidden, `${id} must not be hidden`).toBe(false);
        }

        // Rendered by NetSuite but missing from getFields(): still picked up via the wrapper.
        expect(byId(result.bodyFields, 'custbody_dom_only')).toMatchObject({ type: 'Text Area', label: 'DOM Only', value: 'hello', isHidden: false });

        // Sublists
        expect(Object.keys(result.sublists)).toEqual(['item']);
        const item = result.sublists.item;
        expect(item.lineCount).toBe(1);
        expect(byId(item.fields, 'item')).toMatchObject({ type: 'List/Record', label: 'Item', value: '55', text: 'Widget' });
        // Header cell rendered => visible, regardless of SS2 isDisplay:false
        expect(byId(item.fields, 'quantity')).toMatchObject({ type: 'Decimal', label: 'Quantity', value: 2, isHidden: false });
        expect(byId(item.fields, 'custcol_note')).toMatchObject({ type: 'Free-Form Text', label: 'Note', value: 'n', isHidden: false });
        // No header cell for this column => hidden
        expect(byId(item.fields, 'custcol_hiddencol')).toMatchObject({ isHidden: true, hiddenBy: 'dom' });
    });

    test('SS1-only path: types come from NetSuite markup, not the SS1 text default', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: false });
        const result = await runGetFields(page);

        expect(result.error).toBeUndefined();
        expect(result.meta.ss2).toBe(false);
        expect(result.meta.recordType).toBe('salesorder');

        const ids = result.bodyFields.map((f: any) => f.id);
        for (const junk of ['whence', 'nlloc', 'entryformquerystring', 'nlapiPI', 'type', ...WIDGET_IDS]) {
            expect(ids, `${junk} must not be listed as a field`).not.toContain(junk);
        }
        expect(byId(result.bodyFields, 'custpage_stick')).toMatchObject({ type: 'Inline HTML', label: 'Sticky Notes', isHidden: false });

        expect(byId(result.bodyFields, 'entity')).toMatchObject({ type: 'List/Record', label: 'Customer', value: '123', text: 'ABC Corp', isMandatory: true, isDisabled: false });
        expect(byId(result.bodyFields, 'custbody_flag')).toMatchObject({ type: 'Check Box', label: 'Rush Order', value: 'T' });
        expect(byId(result.bodyFields, 'trandate')).toMatchObject({ type: 'Date', value: '10/20/2026' });
        expect(byId(result.bodyFields, 'total')).toMatchObject({ type: 'Currency', isDisabled: true });
        expect(byId(result.bodyFields, 'custbody_collapsed')).toMatchObject({ type: 'Free-Form Text', isHidden: true, hiddenBy: 'dom' });
        expect(byId(result.bodyFields, 'custbody_dom_only')).toMatchObject({ type: 'Text Area', label: 'DOM Only', value: 'hello', isHidden: false });
        expect(byId(result.bodyFields, 'custbody_quirk')).toMatchObject({ type: 'Free-Form Text', label: 'Quirk', isHidden: false });

        // No "Free-Form Text" badge may appear on a field whose label is unknown.
        for (const f of result.bodyFields) {
            if (f.type === 'Free-Form Text') expect(f.label, `${f.id} is Free-Form Text without a label`).not.toBe('');
        }

        const item = result.sublists.item;
        expect(item.lineCount).toBe(1);
        expect(byId(item.fields, 'item')).toMatchObject({ type: 'List/Record', label: 'Item', value: '55', text: 'Widget' });
        expect(byId(item.fields, 'quantity')).toMatchObject({ type: 'Decimal', label: 'Quantity' });
    });

    test('view mode: stub field objects admit nothing and never set hidden badges', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: true, viewMode: true });
        const result = await runGetFields(page);

        expect(result.error).toBeUndefined();
        expect(result.meta.ss2).toBe(true);

        const ids = result.bodyFields.map((f: any) => f.id);
        for (const junk of ['whence', 'nlloc', 'entryformquerystring', 'nlapiPI', 'type', ...WIDGET_IDS]) {
            expect(ids, `${junk} must not be listed as a field`).not.toContain(junk);
        }

        // Fields NetSuite rendered are still found through their wrappers.
        expect(byId(result.bodyFields, 'entity')).toMatchObject({ type: 'List/Record', label: 'Customer', isHidden: false });
        // View-mode list/record: the API knows nothing, so text comes from the
        // rendered link, the value from its id= and the link itself is kept.
        expect(byId(result.bodyFields, 'custbody_viewsel')).toMatchObject({
            type: 'List/Record', label: 'Vendor', value: '77', text: 'Widget Corp',
            sourceUrl: '/app/common/entity/vendor.nl?id=77', isHidden: false
        });
        expect(byId(result.bodyFields, 'custpage_stick')).toMatchObject({ type: 'Inline HTML', label: 'Sticky Notes', isHidden: false });
        expect(byId(result.bodyFields, 'custbody_quirk')).toMatchObject({ isHidden: false });

        // The stub says isDisplay:false for everything; that must never become a badge.
        for (const f of result.bodyFields) {
            expect(f.hiddenBy, `${f.id} hidden by ss2 stub`).not.toBe('ss2');
        }
        // Only the collapsed row is hidden.
        expect(result.bodyFields.filter((f: any) => f.isHidden).map((f: any) => f.id)).toEqual(['custbody_collapsed']);
    });
});

test.describe('feGetSelectOptionsFn', () => {
    test('reads DOM data-options first, then falls back to SS2 getSelectOptions', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: true });

        const fromDom = await page.evaluate(`(${FE_GET_OPTIONS})('entity', null, null)`);
        expect(fromDom.options).toEqual([{ value: '123', text: 'ABC Corp' }, { value: '456', text: 'XYZ Inc' }]);

        const fromSS2 = await page.evaluate(`(${FE_GET_OPTIONS})('custbody_multi', null, null)`);
        expect(fromSS2.options).toEqual([{ value: '1', text: 'One' }, { value: '2', text: 'Two' }]);
    });
});

test.describe('feSetFieldValueFn', () => {
    test('coerces UI strings to the SS2 field type before setValue', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: true });

        const res = await page.evaluate(`(${FE_SET_VALUE})('custbody_flag', 'false', null, null)`);
        expect(res).toMatchObject({ success: true, newValue: false });
        const calls = await page.evaluate(() => (window as any).__setValueCalls);
        expect(calls).toEqual([{ fieldId: 'custbody_flag', value: false }]);

        const num = await page.evaluate(`(${FE_SET_VALUE})('total', '2,500.75', null, null)`);
        expect(num).toMatchObject({ success: true, newValue: 2500.75 });
    });

    test('falls back to SS1 when require is unavailable', async ({ page }) => {
        await page.setContent(FIXTURE_HTML);
        await installFakeNetSuite(page, { ss2: false });
        const res = await page.evaluate(`(${FE_SET_VALUE})('custbody_flag', 'false', null, null)`);
        expect(res).toMatchObject({ success: true, newValue: 'F' });
    });
});
