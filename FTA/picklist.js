/**
 * picklist.js
 * Functional Analysis Studio [FAS] — Shared searchable single/multi select.
 *
 * A self-contained labelled control, reused by every dialog that needs to
 * choose one or many "ID — Name" rows (the FMEDA function picker, the
 * parent-element picker, the copy-failure-modes picker). Extracted out of
 * dialogs.js — which had grown past 2,000 lines — to keep that file from
 * carrying a general-purpose widget, exactly as modal.js was carved out for
 * the overlay. Tiny, dependency-light (only fmt.escHtml), and stateful only
 * for the one popover that is open at a time.
 *
 * v2.6.1 — the control is now a CLOSED-BY-DEFAULT dropdown: at rest it shows
 * only a compact trigger ("FN_1 — …" for single, "n selected of m" for
 * multi), so a dialog with several pickers no longer stacks several tall
 * always-open lists. Clicking the trigger floats a popover (search + list)
 * over the dialog rather than growing it. BOTH selection modes are kept:
 *   • single (radios) — picking one commits and dismisses, like a native select;
 *   • multi  (checkboxes) — the popover stays open so several can be ticked.
 * The data contract is unchanged, so every call site and save path is too.
 *
 * Contract:
 *   picklist.create({ id, items, selected, multi, placeholder, noneLabel })
 *       -> HTML string. Render it, then call picklist.wire(id).
 *     id        — base id; a hidden <input id="{id}"> holds the value(s),
 *                 comma-separated for multi, so existing read paths keep
 *                 working via document.getElementById(id).value.
 *     items     — [{ value, idText, name }]
 *     selected  — string | string[]   (current selection)
 *     multi     — boolean (checkboxes vs radios)
 *     placeholder, noneLabel — optional copy.
 *   picklist.wire(id, onChange?)   — wire after the modal opens.
 *   picklist.value(id)             — single selection (first value, or '').
 *   picklist.values(id)            — array of selected values.
 *
 * Closing the popover (trigger, outside-click, Escape) records nothing;
 * selection lives entirely in the hidden input, so a dismissal is always a
 * safe no-op that leaves the value untouched.
 */

const picklist = (() => {

    // Only one popover is open at a time across the whole app.
    let _openRoot = null;
    let _globalsInstalled = false;

    function _summary(items, selSet, multi, noneLabel) {
        const n = items.length;
        if (selSet.size === 0) return `${noneLabel} of ${n}`;
        if (multi) return `${selSet.size} selected of ${n}`;
        const v = Array.from(selSet)[0];
        const it = items.find(i => i.value === v);
        return it ? `${fmt.escHtml(it.idText)} — ${fmt.escHtml(it.name)}` : `${noneLabel} of ${n}`;
    }

    function create({ id, items, selected, multi = false,
                      placeholder, noneLabel = 'none' }) {
        const sel = new Set(
            Array.isArray(selected) ? selected : (selected ? [selected] : []));
        const n = items.length;
        const rows = items.map(it => {
            const checked = sel.has(it.value) ? ' checked' : '';
            const hay = (it.idText + ' ' + it.name).toLowerCase();
            return `<label class="picklist-opt" data-hay="${fmt.escHtml(hay)}">
                <input type="${multi ? 'checkbox' : 'radio'}"
                       name="${id}__r" value="${fmt.escHtml(it.value)}"${checked}>
                <span class="picklist-id">${fmt.escHtml(it.idText)}</span>
                <span class="picklist-dash">—</span>
                <span class="picklist-nm">${fmt.escHtml(it.name)}</span>
            </label>`;
        }).join('');
        const csv = Array.from(sel).join(',');
        const summary = _summary(items, sel, multi, noneLabel);
        return `
            <div class="picklist" data-multi="${multi ? 1 : 0}" data-pl="${id}">
                <input type="hidden" id="${id}" value="${fmt.escHtml(csv)}">
                <button type="button" class="picklist-trigger" id="${id}__trigger"
                        aria-haspopup="listbox" aria-expanded="false">
                    <span class="picklist-summary" id="${id}__sum">${summary}</span>
                    <span class="picklist-caret" aria-hidden="true">▾</span>
                </button>
                <div class="picklist-panel" id="${id}__panel">
                    <input class="picklist-search" id="${id}__q" type="text"
                           placeholder="${fmt.escHtml(placeholder || ('Search ' + n + ' items…'))}">
                    <div class="picklist-list" id="${id}__list">
                        ${rows || '<div class="picklist-empty">No items.</div>'}
                    </div>
                </div>
            </div>`;
    }

    function wire(id, onChange) {
        const root = document.querySelector('.picklist[data-pl="' + id + '"]');
        if (!root) return;
        _installGlobals();
        const multi   = root.getAttribute('data-multi') === '1';
        const hidden  = document.getElementById(id);
        const sumEl   = document.getElementById(id + '__sum');
        const trigger = document.getElementById(id + '__trigger');
        const q       = document.getElementById(id + '__q');
        const list    = document.getElementById(id + '__list');
        const opts    = Array.from(list.querySelectorAll('.picklist-opt'));
        const items   = opts.map(o => ({
            value:  o.querySelector('input').value,
            idText: (o.querySelector('.picklist-id') || {}).textContent || '',
            name:   (o.querySelector('.picklist-nm') || {}).textContent || ''
        }));

        function refresh() {
            const checked = opts
                .filter(o => o.querySelector('input').checked)
                .map(o => o.querySelector('input').value);
            hidden.value = checked.join(',');
            sumEl.innerHTML = _summary(items, new Set(checked), multi, 'none');
            if (onChange) onChange(hidden.value);
            // Single-select behaves like a native <select>: one pick commits the
            // choice and dismisses the popover. Multi stays open for more ticks.
            if (!multi) { _close(); if (trigger) trigger.focus(); }
        }
        list.addEventListener('change', refresh);

        if (trigger) trigger.addEventListener('click', () => {
            if (root.classList.contains('open')) _close();
            else _open(root, trigger, q);
        });

        if (q) q.addEventListener('input', () => {
            const needle = q.value.toLowerCase().trim();
            opts.forEach(o => {
                const hit = !needle || (o.getAttribute('data-hay') || '').indexOf(needle) !== -1;
                o.style.display = hit ? '' : 'none';
            });
        });
    }

    function _open(root, trigger, q) {
        if (_openRoot && _openRoot !== root) _close();
        root.classList.add('open');
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
        _placePanel(root, trigger);
        _openRoot = root;
        // Focus the search so the user can type straight away.
        if (q) setTimeout(() => q.focus(), 0);
    }

    function _close() {
        if (!_openRoot) return;
        const t = _openRoot.querySelector('.picklist-trigger');
        _openRoot.classList.remove('open', 'picklist-up');
        if (t) t.setAttribute('aria-expanded', 'false');
        _openRoot = null;
    }

    /* Open downward by default; flip above the trigger when the dialog has
       run out of room below it, so the list never opens off the bottom of a
       scrollable modal. (jsdom returns zero-rects → always downward.) */
    function _placePanel(root, trigger) {
        root.classList.remove('picklist-up');
        if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;
        const panel  = root.querySelector('.picklist-panel');
        const rect   = trigger.getBoundingClientRect();
        const panelH = (panel && panel.offsetHeight) || 240;
        const below  = window.innerHeight - rect.bottom;
        const above  = rect.top;
        if (below < Math.min(panelH + 8, 248) && above > below) {
            root.classList.add('picklist-up');
        }
    }

    function _installGlobals() {
        if (_globalsInstalled) return;
        _globalsInstalled = true;
        // Escape closes the popover BEFORE the modal's own Escape handler runs.
        // Capture phase + stopPropagation keeps the surrounding modal open.
        document.addEventListener('keydown', e => {
            if (_openRoot && e.key === 'Escape') {
                const t = _openRoot.querySelector('.picklist-trigger');
                _close();
                if (t) t.focus();
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);
        // A pointer-down anywhere outside the open popover dismisses it.
        document.addEventListener('mousedown', e => {
            if (_openRoot && !_openRoot.contains(e.target)) _close();
        });
    }

    function value(id) {
        const h = document.getElementById(id);
        return h && h.value ? h.value.split(',')[0] : '';
    }
    function values(id) {
        const h = document.getElementById(id);
        return h && h.value ? h.value.split(',').filter(Boolean) : [];
    }

    return { create, wire, value, values };
})();
