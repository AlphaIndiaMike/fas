/**
 * dialogs.js
 * Functional Analysis Studio [FAS] — Modal dialog controller.
 *
 * All structural editing (event / gate / group / scenario) happens
 * through dialogs. Modules above (catalog, controls, canvas) only
 * route to dialogs; dialogs talk to the model through the api object
 * injected at init() so we can refresh + persist consistently.
 *
 * Public:
 *   dialogs.init(api)
 *   dialogs.openEventEdit(eventIdOrNull, createKind)
 *   dialogs.openGateEdit(gateIdOrNull, createType)
 *   dialogs.openGroupEdit(groupIdOrNull)
 *   dialogs.openScenarioEdit(scenarioIdOrNull)
 *   dialogs.openNewProject(onSubmit)
 *   dialogs.openExport(project, analysis)
 *   dialogs.confirm(title, message, onOk)
 *
 * Depends on: modal.js, fmt.js, config.js, fas.js (Project type)
 */

const dialogs = (() => {

    let api = null;

    function init(a) {
        api = a;
        modal.init();
    }

    /* ── Form helpers ─────────────────────────────────────────────── */

    function _field(label, inner, hint) {
        return `
            <label class="dlg-field">
                <span class="dlg-label">${label}</span>
                ${inner}
                ${hint ? `<span class="dlg-hint">${hint}</span>` : ''}
            </label>`;
    }

    function _errBox() { return `<div class="dlg-err" id="dlgErr" style="display:none"></div>`; }
    function _err(msg) {
        const box = document.getElementById('dlgErr');
        if (box) { box.textContent = msg || ''; box.style.display = msg ? 'block' : 'none'; }
    }

    /* ── Help system ─────────────────────────────────────────────────
       Every dialog renders inline (?) buttons via `_help(topic)`. A
       click opens a popover anchored to the button (NOT a modal — using
       a modal would overwrite the current edit dialog and lose user
       input). The popover is dismissed on outside-click or Escape. */

    let _popoverEl = null;

    function _help(topic) {
        return `<button type="button" class="dlg-help"
                        data-help="${topic}" title="What is this?">?</button>`;
    }

    function openHelp(topic, anchorEl) {
        const h = (CONFIG.helpTopics || {})[topic];
        if (!h) return;
        _closeHelp();

        const pop = document.createElement('div');
        pop.className = 'help-popover';
        pop.innerHTML = `
            <div class="help-popover-hd">
                <span>${fmt.escHtml(h.title)}</span>
                <button type="button" class="help-popover-x" title="Close">✕</button>
            </div>
            <div class="help-popover-body">${h.body}</div>`;
        document.body.appendChild(pop);
        _popoverEl = pop;

        _positionPopover(pop, anchorEl);

        pop.querySelector('.help-popover-x').addEventListener('click', _closeHelp);
        setTimeout(() => {
            document.addEventListener('mousedown', _outsideClose, true);
            document.addEventListener('keydown',  _escClose);
        }, 0);
    }

    function _closeHelp() {
        if (_popoverEl) { _popoverEl.remove(); _popoverEl = null; }
        document.removeEventListener('mousedown', _outsideClose, true);
        document.removeEventListener('keydown',  _escClose);
    }

    function _outsideClose(e) {
        if (!_popoverEl) return;
        if (_popoverEl.contains(e.target)) return;
        if (e.target.classList && e.target.classList.contains('dlg-help')) return;
        _closeHelp();
    }
    function _escClose(e) { if (e.key === 'Escape') _closeHelp(); }

    /* Place the popover next to the anchor with viewport clamping.
       Preference: right of anchor; falls back to left if right would
       clip; falls back to centred at viewport mid if no anchor. */
    function _positionPopover(pop, anchor) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w  = Math.min(360, vw - 32);
        pop.style.maxWidth = w + 'px';
        pop.style.visibility = 'hidden';
        pop.style.left = '0px'; pop.style.top = '0px';

        // Force layout to get actual height.
        const ph = pop.offsetHeight;

        if (!anchor || !anchor.getBoundingClientRect) {
            pop.style.left = Math.max(16, (vw - w) / 2) + 'px';
            pop.style.top  = Math.max(16, (vh - ph) / 2) + 'px';
            pop.style.visibility = 'visible';
            return;
        }
        const r = anchor.getBoundingClientRect();
        let left = r.right + 10;
        if (left + w > vw - 12) left = Math.max(12, r.left - w - 10);
        let top  = r.top - 4;
        if (top + ph > vh - 12) top = Math.max(12, vh - ph - 12);
        pop.style.left = left + 'px';
        pop.style.top  = top  + 'px';
        pop.style.visibility = 'visible';
    }

    /* Delegate help-button clicks anywhere in the document. */
    document.addEventListener('click', e => {
        const btn = e.target.closest('.dlg-help');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        openHelp(btn.getAttribute('data-help'), btn);
    });

    function _eventOptions(project, selectedId, excludeIds, basicOnly) {
        const ex = new Set(excludeIds || []);
        return project.events
            .filter(e => !ex.has(e.id))
            .filter(e => !basicOnly || e.kind === 'basic' || e.kind === 'intermediate')
            .map(e => `<option value="${e.id}"${e.id === selectedId ? ' selected' : ''}>` +
                       `${fmt.escHtml(e.name)} (${e.kind})</option>`)
            .join('') || '<option value="">— no events available —</option>';
    }

    function _groupOptions(project, selectedId) {
        const none = `<option value=""${!selectedId ? ' selected' : ''}>— ungrouped —</option>`;
        const opts = project.groups.map(g =>
            `<option value="${g.id}"${g.id === selectedId ? ' selected' : ''}>` +
            `${fmt.escHtml(g.name)}</option>`).join('');
        return none + opts;
    }

    /* ════════════════════════════════════════════════════════════════
       EVENT — create or edit
       ════════════════════════════════════════════════════════════════ */

    function openEventEdit(eventId, createKind) {
        const p = api.getProject();
        if (!p) return;
        const existing = eventId ? p.eventById(eventId) : null;
        const e = existing || _eventDraft(p, createKind);

        const hasTop  = !!p.topEvent();
        const kindOpts = ['basic', 'intermediate', 'top'].map(k =>
            `<option value="${k}"${k === e.kind ? ' selected' : ''}` +
            (k === 'top' && hasTop && e.kind !== 'top' ? ' disabled' : '') +
            `>${k}${k === 'top' && hasTop && e.kind !== 'top' ? ' (one already exists)' : ''}</option>`
        ).join('');

        modal.open((existing ? 'Edit ' : 'New ') + 'event', `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="60" value="${fmt.escHtml(e.name)}">`)}
            ${_field('Kind',
                `<select class="dlg-inp" id="fKind">${kindOpts}</select>`,
                'Basic = leaf (ellipse). Intermediate = derived (round box). Top = system outcome (dark square; one per project).')}
            ${_field('Group',
                `<select class="dlg-inp" id="fGroup">${_groupOptions(p, e.groupId)}</select>`,
                'Groups mark independence boundaries. Two basic events sharing a group flag FFI on AND/Voting gates that combine them. ' + _help('ffi'))}
            ${_field('Description',
                `<textarea class="dlg-inp" id="fDesc" rows="2" maxlength="500">${fmt.escHtml(e.description || '')}</textarea>`)}

            <div id="probSection">
                ${_probSectionHtml(p, e)}
            </div>

            <div id="targetSection">
                ${_targetSectionHtml(e)}
            </div>
        `, _eventFooter(existing, e));

        _wireProbSection(p, e);
        _wireTargetSection();
    }

    function _eventDraft(project, createKind) {
        const d = CONFIG.eventDefaults;
        let kind = 'basic';
        if (createKind === 'event-intermediate') kind = 'intermediate';
        if (createKind === 'event-top')          kind = project.topEvent() ? 'intermediate' : 'top';
        return {
            id:           null,
            name:         '',
            kind,
            description:  '',
            groupId:      null,
            x: 200, y: 200,
            probMode:            d.probMode,
            directUnit:          d.directUnit,
            probability:         d.probability,
            failureRate:         d.failureRate,
            missionTimeOverride: null,
            failureRateRaw:      d.failureRateRaw,
            diagnosticCoverage:  d.diagnosticCoverage,
            diagnosticEvidence:  '',
            target:              null
        };
    }

    function _probSectionHtml(project, e) {
        // The probability block only matters for basic events.
        if (e.kind !== 'basic') {
            return `
                <div class="dlg-note">
                    <strong>${e.kind === 'top' ? 'Top' : 'Intermediate'} event</strong> — value
                    is derived from whatever feeds it. Either add a gate whose
                    <em>output</em> is this event, or link a single child event
                    directly to it (a pass-through). ${_help('linking')}
                </div>`;
        }
        const m = e.probMode || 'direct';
        const modes = [
            { v: 'direct',   label: 'Probability of failure (% over mission profile)' },
            { v: 'rate',     label: 'Failure rate (FIT)' },
            { v: 'coverage', label: 'Rate + diagnostic coverage' }
        ].map(o =>
            `<label class="dlg-radio">
                <input type="radio" name="fMode" value="${o.v}" ${o.v === m ? 'checked' : ''}>
                <span>${o.label}</span>
            </label>`).join('');

        return `
            <div class="dlg-label" style="margin-top:0.4rem">
                Input mode ${_help('probMode')}
            </div>
            <div class="dlg-radios">${modes}</div>

            <div id="fModeBody">
                ${_modeBodyHtml(e)}
            </div>
        `;
    }

    function _modeBodyHtml(e) {
        if (e.probMode === 'rate') {
            return `
                <div class="dlg-row">
                    ${_field('λ (FIT)',
                        `<input class="dlg-inp" id="fRate" type="number" min="0" step="any" value="${e.failureRate}">`,
                        '1 FIT = 1 failure per 10⁹ hours. ' + _help('units'))}
                    ${_field('Mission time override (h)',
                        `<input class="dlg-inp" id="fMtO" type="number" min="0" step="any" value="${e.missionTimeOverride != null ? e.missionTimeOverride : ''}">`,
                        'Blank = use project mission time.')}
                </div>
                <div class="dlg-note" id="fLive"></div>`;
        }
        if (e.probMode === 'coverage') {
            return `
                <div class="dlg-row">
                    ${_field('λ dangerous, λ_D (FIT)',
                        `<input class="dlg-inp" id="fRateRaw" type="number" min="0" step="any" value="${e.failureRateRaw}">`,
                        'Dangerous failure rate, before diagnostic credit. ' +
                        'DC applies to dangerous failures only (IEC 61508-4 §3.8.7) — ' +
                        'do not enter the total failure rate.')}
                    ${_field('Diagnostic coverage',
                        `<input class="dlg-inp" id="fDC" type="number" min="0" max="1" step="0.001" value="${e.diagnosticCoverage}">`,
                        'Fraction detected by diagnostics (0–1). ' + _help('coverage'))}
                    ${_field('Mission time override (h)',
                        `<input class="dlg-inp" id="fMtO" type="number" min="0" step="any" value="${e.missionTimeOverride != null ? e.missionTimeOverride : ''}">`,
                        'Blank = use project mission time.')}
                </div>
                ${_field('Evidence / source',
                    `<textarea class="dlg-inp" id="fEvidence" rows="2" maxlength="800" placeholder="e.g. ISO 26262-5:2018 Annex D, Table D.13 — E2E Profile 5">${fmt.escHtml(e.diagnosticEvidence || '')}</textarea>`,
                    'Where does this coverage value come from? ' + _help('coverageEvidence'))}
                <div class="dlg-note" id="fLive"></div>`;
        }
        // direct
        const u = e.directUnit || 'PFD';
        const unitOpts = ['PFD', 'PFH', 'FIT'].map(o =>
            `<label class="dlg-chip ${o === u ? 'dlg-chip-on' : ''}">
                <input type="radio" name="fUnit" value="${o}" ${o === u ? 'checked' : ''}>
                <span>${o}</span>
            </label>`).join('');
        return `
            ${_field('Direct value',
                `<input class="dlg-inp" id="fProb" type="number" min="0" step="any" value="${e.probability}">`,
                'Interpret per the unit selected below.')}
            <div class="dlg-label">Unit ${_help('units')}</div>
            <div class="dlg-chips">${unitOpts}</div>
            <div class="dlg-note" id="fLive"></div>`;
    }

    /* Safety target — only meaningful on the top event. One dropdown
       with all SIL and ASIL options labelled with their standard, so
       the user picks one target deliberately and the analyzer compares
       against a single, unambiguous PFH bound. */
    function _targetSectionHtml(e) {
        if (e.kind !== 'top') return '';
        const current = e.target || '';
        const noneOpt = `<option value=""${current ? '' : ' selected'}>— None —</option>`;
        const opts = (CONFIG.targetCombined || []).map(o =>
            `<option value="${o.value}"${o.value === current ? ' selected' : ''}>` +
            `${fmt.escHtml(o.label)}</option>`).join('');
        return `
            <div class="dlg-label" style="margin-top:0.6rem">
                Safety target ${_help('target')}
            </div>
            <div class="dlg-note" style="margin-top:0;">
                Pick the SIL or ASIL the top event must achieve. On Recalculate
                the tool compares the computed PFH against this target's bound
                and shows met / missed.
            </div>
            <select class="dlg-inp" id="fTarget">
                ${noneOpt}${opts}
            </select>
        `;
    }

    function _wireTargetSection() {
        // Dropdown is self-contained; no extra wiring needed for
        // visual state. The chip-style wiring from the old dual picker
        // is intentionally gone.
    }

    function _wireProbSection(project, eOriginal) {
        const probSec = document.getElementById('probSection');
        if (!probSec) return;

        // Re-render the probability + target blocks when kind changes
        // (basic vs intermediate/top changes content; top adds target).
        const kindSel = document.getElementById('fKind');
        if (kindSel) kindSel.addEventListener('change', () => {
            const draft = _readDraft(eOriginal);
            draft.kind = kindSel.value;
            probSec.innerHTML = _probSectionHtml(project, draft);
            const targetSec = document.getElementById('targetSection');
            if (targetSec) targetSec.innerHTML = _targetSectionHtml(draft);
            _wireProbSection(project, draft);
            _wireTargetSection();
        });

        // Probability mode radios
        probSec.querySelectorAll('input[name="fMode"]').forEach(r => {
            r.addEventListener('change', () => {
                const draft = _readDraft(eOriginal);
                draft.probMode = r.value;
                document.getElementById('fModeBody').innerHTML = _modeBodyHtml(draft);
                _wireModeBody(project, draft);
            });
        });
        _wireModeBody(project, eOriginal);
    }

    function _wireModeBody(project, e) {
        const body = document.getElementById('fModeBody');
        if (!body) return;

        // Direct-mode unit chips
        body.querySelectorAll('input[name="fUnit"]').forEach(r => {
            r.addEventListener('change', () => {
                body.querySelectorAll('.dlg-chip').forEach(c =>
                    c.classList.toggle('dlg-chip-on',
                        c.querySelector('input').checked));
                _liveUpdate(project, e);
            });
        });
        // Number inputs → live readout
        body.querySelectorAll('input[type="number"]').forEach(i => {
            i.addEventListener('input', () => _liveUpdate(project, e));
        });
        _liveUpdate(project, e);
    }

    function _liveUpdate(project, eOrig) {
        const live = document.getElementById('fLive');
        if (!live) return;
        const e = _readDraft(eOrig);
        if (e.kind !== 'basic') { live.textContent = ''; return; }
        // Build a one-off basic event and run the analyzer's per-event
        // helper logic via a small clone to compute PFD/PFH.
        const t = e.missionTimeOverride || project.missionTime;
        let pfd = 0, pfh = 0;
        try {
            if (e.probMode === 'direct') {
                const v = +e.probability || 0;
                if (e.directUnit === 'PFD') {
                    pfd = Math.max(0, Math.min(1, v));
                    pfh = (pfd < 1 && t > 0) ? -Math.log(1 - pfd) / t : 0;
                } else if (e.directUnit === 'PFH') {
                    pfh = Math.max(0, v);
                    pfd = 1 - Math.exp(-pfh * t);
                } else {
                    pfh = Math.max(0, v) * 1e-9;
                    pfd = 1 - Math.exp(-pfh * t);
                }
            } else if (e.probMode === 'rate') {
                pfh = Math.max(0, +e.failureRate || 0) * 1e-9;
                pfd = 1 - Math.exp(-pfh * t);
            } else if (e.probMode === 'coverage') {
                const raw = Math.max(0, +e.failureRateRaw || 0) * 1e-9;
                const dc  = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
                pfh = raw * (1 - dc);
                pfd = 1 - Math.exp(-pfh * t);
            }
        } catch (_) { /* swallow */ }
        live.innerHTML =
            '<strong>PFD</strong> = ' + fmt.probStr(pfd) +
            ' · <strong>PFH</strong> = ' + fmt.perHourStr(pfh) +
            ' · t = ' + t + ' h';
    }

    function _readDraft(eOrig) {
        const draft = { ...eOrig };
        draft.name        = (document.getElementById('fName') || {}).value || draft.name;
        draft.kind        = (document.getElementById('fKind') || {}).value || draft.kind;
        draft.groupId     = (document.getElementById('fGroup') || {}).value || null;
        draft.description = (document.getElementById('fDesc') || {}).value || draft.description;
        if (draft.groupId === '') draft.groupId = null;

        const modeR = document.querySelector('input[name="fMode"]:checked');
        if (modeR) draft.probMode = modeR.value;
        const unitR = document.querySelector('input[name="fUnit"]:checked');
        if (unitR) draft.directUnit = unitR.value;

        const prob    = document.getElementById('fProb');
        const rate    = document.getElementById('fRate');
        const rateRaw = document.getElementById('fRateRaw');
        const dc      = document.getElementById('fDC');
        const mtO     = document.getElementById('fMtO');
        const evid    = document.getElementById('fEvidence');
        if (prob)    draft.probability        = +prob.value;
        if (rate)    draft.failureRate        = +rate.value;
        if (rateRaw) draft.failureRateRaw     = +rateRaw.value;
        if (dc)      draft.diagnosticCoverage = +dc.value;
        if (mtO)     draft.missionTimeOverride = mtO.value === '' ? null : +mtO.value;
        if (evid)    draft.diagnosticEvidence = evid.value;

        const tSel = document.getElementById('fTarget');
        if (tSel) draft.target = tSel.value || null;

        return draft;
    }

    function _eventFooter(existing, eDraft) {
        const buttons = [];
        if (existing) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete event?',
                'Remove "' + existing.name + '". Any gate referencing it will lose this input or be removed if its output is this event.',
                () => { api.applyEventDelete(existing.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec',     onClick: modal.close });
        buttons.push({
            label: existing ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveEvent(existing, eDraft)
        });
        return buttons;
    }

    function _saveEvent(existing, originalDraft) {
        const draft = _readDraft(originalDraft);
        if (!draft.name || !draft.name.trim()) { _err('Name is required.'); return; }
        if (draft.kind === 'basic') {
            if (draft.probMode === 'direct') {
                if (draft.directUnit === 'PFD' &&
                    (draft.probability < 0 || draft.probability > 1)) {
                    _err('PFD must be between 0 and 1.'); return;
                }
                if (draft.probability < 0) { _err('Value must be ≥ 0.'); return; }
            } else if (draft.probMode === 'rate') {
                if (draft.failureRate < 0) { _err('λ must be ≥ 0.'); return; }
            } else if (draft.probMode === 'coverage') {
                if (draft.failureRateRaw < 0) { _err('λ dangerous must be ≥ 0.'); return; }
                if (draft.diagnosticCoverage < 0 || draft.diagnosticCoverage > 1) {
                    _err('Diagnostic coverage must be between 0 and 1.'); return;
                }
            }
        }
        const patch = {
            name:                draft.name.trim(),
            kind:                draft.kind,
            description:         draft.description,
            groupId:             draft.groupId,
            probMode:            draft.probMode,
            directUnit:          draft.directUnit,
            probability:         draft.probability,
            failureRate:         draft.failureRate,
            missionTimeOverride: draft.missionTimeOverride,
            failureRateRaw:      draft.failureRateRaw,
            diagnosticCoverage:  draft.diagnosticCoverage,
            diagnosticEvidence:  draft.diagnosticEvidence || '',
            // Target only meaningful on top — clear on others so
            // demoting a top doesn't leave stale data.
            target:              draft.kind === 'top' ? (draft.target || null) : null
        };
        if (existing) api.applyEventUpdate(existing.id, patch);
        else          api.applyEventCreate(patch);
        modal.close();
    }

    /* ════════════════════════════════════════════════════════════════
       GATE — create or edit
       ════════════════════════════════════════════════════════════════ */

    function openGateEdit(gateId, createType) {
        const p = api.getProject();
        if (!p) return;
        const existing = gateId ? p.gateById(gateId) : null;
        if (!existing && p.events.length < 2) {
            _alert('Not enough events',
                'A gate needs at least two events to combine (and one output event). Add more events first.');
            return;
        }
        const g = existing || {
            id: null,
            type: createType || 'AND',
            inputs: [],
            output: null,
            k:           CONFIG.gateDefaults.k,
            inhibitProb: CONFIG.gateDefaults.inhibitProb
        };

        modal.open((existing ? 'Edit ' : 'New ') + g.type + ' gate', `
            ${_errBox()}
            ${existing ? '' : `${_field('Gate type',
                `<select class="dlg-inp" id="fType">
                    <option value="AND"    ${g.type==='AND'    ? 'selected':''}>AND</option>
                    <option value="OR"     ${g.type==='OR'     ? 'selected':''}>OR</option>
                    <option value="VOTING" ${g.type==='VOTING' ? 'selected':''}>VOTING (k-of-n)</option>
                    <option value="INHIBIT" ${g.type==='INHIBIT'? 'selected':''}>INHIBIT</option>
                </select>`)}`}
            <div class="dlg-note" id="gNote"></div>
            <div class="dlg-label" style="margin-top:0.4rem">
                Inputs (events feeding this gate)
            </div>
            ${_pickerSearchBar('gInputsSearch', 'Search events…')}
            <div id="gInputs" class="picker"></div>
            ${_field('Output event',
                `<select class="dlg-inp" id="fOut">${_eventOptions(p, g.output, [])}</select>`,
                'The event this gate computes. Must be intermediate or top.')}
            <div id="gExtra"></div>
        `, _gateFooter(existing, g));

        // Selected inputs as a mutable list, kept in sync via picker.
        const selected = (g.inputs || []).slice();
        const typeSel  = document.getElementById('fType');
        const search   = document.getElementById('gInputsSearch');
        const renderAll = () => {
            const t = typeSel ? typeSel.value : g.type;
            const out = document.getElementById('fOut').value || null;
            const filter = search ? search.value : '';
            _renderEventPickerV2(p, selected, 'gInputs', {
                exclude:    out ? [out] : [],
                filter,
                groupByKind: true
            });
            _renderGateExtras(t, g);
            _renderGateNote(t);
        };
        renderAll();
        if (typeSel) typeSel.addEventListener('change', renderAll);
        if (search)  search.addEventListener('input',  renderAll);
        const outSel = document.getElementById('fOut');
        if (outSel) outSel.addEventListener('change', renderAll);
    }

    function _renderGateNote(type) {
        const el = document.getElementById('gNote');
        if (!el) return;
        const text = {
            AND:    'Output fails when <em>every</em> input fails. P = ∏ Pᵢ. Assumes independent inputs.',
            OR:     'Output fails when <em>any</em> input fails. P = 1 − ∏(1 − Pᵢ).',
            VOTING: 'Output fails when at least <em>k</em> of the n inputs fail.',
            INHIBIT:'Output fails when the single input fails <em>and</em> a conditioning event holds. P = P_in × P_cond.'
        }[type] || '';
        el.innerHTML = `<strong>${type}</strong> — ${text}`;
    }

    function _renderGateExtras(type, gOrig) {
        const el = document.getElementById('gExtra');
        if (!el) return;
        if (type === 'VOTING') {
            el.innerHTML = _field('k (minimum failed inputs)',
                `<input class="dlg-inp" id="fK" type="number" min="1" step="1" value="${gOrig.k || 2}">`,
                'k must be ≥ 1 and ≤ number of inputs.');
        } else if (type === 'INHIBIT') {
            el.innerHTML = _field('Conditioning probability (P_cond)',
                `<input class="dlg-inp" id="fCond" type="number" min="0" max="1" step="0.001" value="${gOrig.inhibitProb != null ? gOrig.inhibitProb : 0.1}">`,
                'INHIBIT takes one functional input and multiplies it by this probability.');
        } else {
            el.innerHTML = '';
        }
    }

    function _gateFooter(existing, g) {
        const buttons = [];
        if (existing) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete gate?',
                'Remove this ' + existing.type + ' gate and its connecting arrows.',
                () => { api.applyGateDelete(existing.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        buttons.push({
            label: existing ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveGate(existing, g)
        });
        return buttons;
    }

    function _saveGate(existing, originalG) {
        const typeSel = document.getElementById('fType');
        const type    = typeSel ? typeSel.value : originalG.type;
        const out     = document.getElementById('fOut').value || null;
        const inputs  = JSON.parse(document.getElementById('gInputs').dataset.selected || '[]');
        const kEl     = document.getElementById('fK');
        const cEl     = document.getElementById('fCond');

        if (!out) { _err('Pick an output event.'); return; }
        if (inputs.indexOf(out) !== -1) { _err('Output cannot also be an input.'); return; }
        if (type === 'INHIBIT' && inputs.length !== 1) {
            _err('INHIBIT takes exactly one input.'); return;
        }
        if (type !== 'INHIBIT' && inputs.length < 2) {
            _err('Pick at least two inputs.'); return;
        }
        const k = kEl ? parseInt(kEl.value, 10) : null;
        if (type === 'VOTING' && (!k || k < 1 || k > inputs.length)) {
            _err('k must be between 1 and ' + inputs.length + '.'); return;
        }
        const cond = cEl ? parseFloat(cEl.value) : null;
        if (type === 'INHIBIT' && (cond == null || isNaN(cond) || cond < 0 || cond > 1)) {
            _err('Conditioning probability must be between 0 and 1.'); return;
        }

        // Enforce single gate per output event.
        const p = api.getProject();
        const conflict = p.gates.find(gg => gg.output === out &&
                                            (!existing || gg.id !== existing.id));
        if (conflict) {
            _err('Another gate already outputs into "' +
                 p.eventById(out).name + '". An event can be fed by only one gate.');
            return;
        }
        // Enforce single feeder: also reject if a direct link already
        // feeds this event (one feeder per event — gate OR link).
        if (p.linkFeeding(out)) {
            _err('Event "' + p.eventById(out).name + '" is already fed by a ' +
                 'direct link. Remove that link first, or pick another output.');
            return;
        }
        // Enforce: output is intermediate or top.
        const outEv = p.eventById(out);
        if (!outEv || outEv.kind === 'basic') {
            _err('Output event must be intermediate or top. Change its kind first.');
            return;
        }

        const data = {
            type, inputs, output: out,
            k:           type === 'VOTING'  ? k    : null,
            inhibitProb: type === 'INHIBIT' ? cond : null
        };
        if (existing) api.applyGateUpdate(existing.id, data);
        else          api.applyGateCreate(data);
        modal.close();
    }

    /* ── Link (direct event→event signal) ─────────────────────────────
       A single-child pass-through. The dialog mirrors the gate editor
       but with just two pickers — child (from) and parent (to) — and the
       same one-feeder validation the model enforces in Project.linkError. */

    function openLinkEdit(linkId) {
        const p = api.getProject();
        if (!p) return;
        const existing = linkId ? p.linkById(linkId) : null;

        // Need at least one possible child and one possible parent.
        const possibleChildren = p.events.filter(e => e.kind !== 'top');
        const possibleParents  = p.events.filter(e => e.kind !== 'basic');
        if (!existing && (possibleChildren.length === 0 || possibleParents.length === 0)) {
            _alert('Not enough events',
                'A link needs a child event (basic or intermediate) and a ' +
                'parent event (intermediate or top). Add those events first.');
            return;
        }

        const l = existing || { id: null, from: null, to: null };

        const childOpts = (sel) => possibleChildren
            .map(e => `<option value="${e.id}"${e.id === sel ? ' selected' : ''}>` +
                       `${fmt.escHtml(e.name)} (${e.kind})</option>`)
            .join('') || '<option value="">— none —</option>';
        const parentOpts = (sel) => possibleParents
            .map(e => `<option value="${e.id}"${e.id === sel ? ' selected' : ''}>` +
                       `${fmt.escHtml(e.name)} (${e.kind})</option>`)
            .join('') || '<option value="">— none —</option>';

        modal.open((existing ? 'Edit link' : 'New link') + ' (signal)', `
            ${_errBox()}
            <div class="dlg-note">
                A <strong>link</strong> feeds one child event straight into a
                parent — the parent inherits the child's probability
                (pass-through). For two or more inputs, use a gate instead.
                ${_help('linking')}
            </div>
            ${_field('Child event (from)',
                `<select class="dlg-inp" id="fFrom">${childOpts(l.from)}</select>`,
                'The event whose probability flows up. Basic or intermediate.')}
            ${_field('Parent event (to)',
                `<select class="dlg-inp" id="fTo">${parentOpts(l.to)}</select>`,
                'The event that inherits it. Intermediate or top, and not ' +
                'already fed by a gate or another link.')}
        `, _linkFooter(existing));
    }

    function _linkFooter(existing) {
        const buttons = [];
        if (existing) buttons.push({
            label: 'Delete', cls: 'btn-danger',
            onClick: () => confirm('Delete link?',
                'Remove this direct link. The parent event will have no ' +
                'feeder until you add a gate or a new link.',
                () => { api.applyLinkDelete(existing.id); modal.close(); })
        });
        buttons.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        buttons.push({
            label: existing ? 'Save' : 'Create',
            cls:   'btn-primary',
            onClick: () => _saveLink(existing)
        });
        return buttons;
    }

    function _saveLink(existing) {
        const p    = api.getProject();
        const from = document.getElementById('fFrom').value || null;
        const to   = document.getElementById('fTo').value   || null;
        if (!from || !to) { _err('Pick both a child and a parent event.'); return; }

        // Single source of truth: ask the model whether this is valid.
        const err = p.linkError(from, to, existing ? existing.id : null);
        if (err) { _err(err); return; }

        if (existing) api.applyLinkUpdate(existing.id, { from, to });
        else          api.applyLinkCreate({ from, to });
        modal.close();
    }

    /* ── Search bar for pickers ──────────────────────────────────── */

    function _pickerSearchBar(inputId, placeholder) {
        return `<div class="picker-search">
            <span class="picker-search-ic">⌕</span>
            <input class="dlg-inp" id="${inputId}" type="text"
                   placeholder="${placeholder || 'Search…'}">
        </div>`;
    }

    /* ── Event picker V2: search + group-by-kind ─────────────────────
       Options: { exclude:[ids], filter:string, groupByKind:bool }.
       Sections render as collapsible headers "BASIC (n)" / "INTERMEDIATE (n)"
       skipping any empty section. Top events are never selectable as gate
       inputs (a top can't feed a gate). */

    function _renderEventPickerV2(project, selected, containerId, opts) {
        const el = document.getElementById(containerId);
        if (!el) return;
        const ex     = new Set((opts && opts.exclude) || []);
        const filter = ((opts && opts.filter) || '').toLowerCase().trim();
        const groupByKind = !!(opts && opts.groupByKind);

        // Preserve collapsed state across re-renders so a filter keystroke
        // doesn't expand sections the user just collapsed. State lives
        // on the container's dataset.
        const collapsedRaw = el.dataset.collapsed || '';
        const collapsed = new Set(collapsedRaw ? collapsedRaw.split(',') : []);

        const kindOrder = ['basic', 'intermediate', 'top'];
        const buckets = { basic: [], intermediate: [], top: [] };
        project.events.forEach(e => {
            if (ex.has(e.id)) return;
            if (filter && !e.name.toLowerCase().includes(filter)) return;
            buckets[e.kind].push(e);
        });

        let html = '';
        if (groupByKind) {
            kindOrder.forEach(k => {
                const list = buckets[k];
                if (list.length === 0) return;
                if (k === 'top') return;   // tops aren't selectable as inputs
                const isCollapsed = collapsed.has(k);
                html += `<div class="picker-section ${isCollapsed ? 'collapsed' : ''}" data-kind="${k}">
                    <button type="button" class="picker-section-hd" data-toggle="${k}">
                        <span class="picker-chev">▾</span>
                        <span>${k}</span>
                        <span class="picker-section-n">${list.length}</span>
                    </button>
                    <div class="picker-section-body">`;
                list.forEach(e => { html += _eventRowHTML(e, selected); });
                html += `</div></div>`;
            });
        } else {
            project.events.forEach(e => {
                if (ex.has(e.id)) return;
                if (filter && !e.name.toLowerCase().includes(filter)) return;
                html += _eventRowHTML(e, selected);
            });
        }
        if (!html.trim()) {
            html = `<div class="ctrl-empty" style="padding:0.6rem">${filter ? 'No matches.' : 'No selectable events.'}</div>`;
        }
        el.innerHTML = html;
        el.dataset.selected = JSON.stringify(selected);

        el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-id');
                if (cb.checked) { if (selected.indexOf(id) === -1) selected.push(id); }
                else            { const i = selected.indexOf(id); if (i !== -1) selected.splice(i, 1); }
                _renderEventPickerV2(project, selected, containerId, opts);
            });
        });
        // Collapse/expand on header click.
        el.querySelectorAll('[data-toggle]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.preventDefault();
                const k = btn.getAttribute('data-toggle');
                const next = new Set(collapsed);
                if (next.has(k)) next.delete(k); else next.add(k);
                el.dataset.collapsed = Array.from(next).join(',');
                _renderEventPickerV2(project, selected, containerId, opts);
            });
        });
    }

    function _eventRowHTML(e, selected) {
        const idx     = selected.indexOf(e.id);
        const checked = idx !== -1 ? 'checked' : '';
        const pos     = idx !== -1 ? (idx + 1) : '';
        return `
            <div class="gi-row ${idx !== -1 ? 'gi-on' : ''}" data-id="${e.id}">
                <label class="gi-check">
                    <input type="checkbox" data-id="${e.id}" ${checked}>
                    <span>${fmt.escHtml(e.name)} <em class="gi-kind">${e.kind}</em></span>
                </label>
                <span class="gi-pos">${pos}</span>
            </div>`;
    }

    /* ════════════════════════════════════════════════════════════════
       GROUP
       ════════════════════════════════════════════════════════════════ */

    function openGroupEdit(groupId) {
        const p = api.getProject();
        if (!p) return;
        const existing = groupId ? p.groupById(groupId) : null;
        const g = existing || {
            id: null,
            name: '',
            color: CONFIG.groupColors[p.groups.length % CONFIG.groupColors.length],
            description: ''
        };

        // Initial member set = events currently pointing to this group.
        const initialMembers = existing
            ? p.events.filter(e => e.groupId === existing.id).map(e => e.id)
            : [];
        const members = initialMembers.slice();

        // Build a swatch picker.
        const swatches = CONFIG.groupColors.map(c =>
            `<label class="dlg-swatch" style="background:${c}">
                <input type="radio" name="fColor" value="${c}" ${c === g.color ? 'checked' : ''}>
            </label>`).join('');

        modal.open((existing ? 'Edit ' : 'New ') + 'group', `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="40" value="${fmt.escHtml(g.name)}">`,
                'Visible label on the canvas container.')}

            <div class="dlg-label">Color</div>
            <div class="dlg-swatches">${swatches}</div>

            ${_field('Description / FFI argument',
                `<textarea class="dlg-inp" id="fDesc" rows="3" maxlength="800">${fmt.escHtml(g.description || '')}</textarea>`,
                'Free-text. Use to document a Freedom From Interference argument when accepting a flagged warning. ' + _help('ffi'))}

            <div class="dlg-label" style="margin-top:0.4rem">Members</div>
            <div class="dlg-hint" style="margin-bottom:0.4rem">
                Pick events that share this independence boundary. ${_help('ffi')}
            </div>
            ${_pickerSearchBar('gMemSearch', 'Search events…')}
            <div id="gMembers" class="picker"></div>
        `, [
            ...(existing ? [{
                label: 'Delete', cls: 'btn-danger',
                onClick: () => confirm('Delete group?',
                    'Remove "' + existing.name + '". Events in this group fall back to ungrouped.',
                    () => { api.applyGroupDelete(existing.id); modal.close(); })
            }] : []),
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            {
                label: existing ? 'Save' : 'Create',
                cls:   'btn-primary',
                onClick: () => _saveGroup(existing, members)
            }
        ]);

        // Wire swatches
        document.querySelectorAll('.dlg-swatch input').forEach(r => {
            r.addEventListener('change', () => {
                document.querySelectorAll('.dlg-swatch').forEach(s =>
                    s.classList.toggle('dlg-swatch-on', s.querySelector('input').checked));
            });
        });
        document.querySelectorAll('.dlg-swatch').forEach(s =>
            s.classList.toggle('dlg-swatch-on', s.querySelector('input').checked));

        // Member picker — searchable, grouped by kind. We exclude top
        // events since "group" is about independence between leaves /
        // intermediates that share a resource.
        const search = document.getElementById('gMemSearch');
        const renderMembers = () => {
            _renderEventPickerV2(p, members, 'gMembers', {
                filter:      search ? search.value : '',
                groupByKind: true
            });
        };
        renderMembers();
        if (search) search.addEventListener('input', renderMembers);
    }

    function _saveGroup(existing, members) {
        const name = document.getElementById('fName').value.trim();
        const desc = document.getElementById('fDesc').value;
        const col  = (document.querySelector('input[name="fColor"]:checked') || {}).value;
        if (!name) { _err('Name is required.'); return; }
        const patch = { name, color: col, description: desc };

        if (existing) {
            api.applyGroupUpdate(existing.id, patch, members);
        } else {
            api.applyGroupCreate(patch, members);
        }
        modal.close();
    }

    /* ════════════════════════════════════════════════════════════════
       SCENARIO
       ════════════════════════════════════════════════════════════════ */

    function openScenarioEdit(scenarioId) {
        const p = api.getProject();
        if (!p) return;
        const existing = scenarioId ? p.scenarioById(scenarioId) : null;
        const s = existing || { id: null, name: '', overrides: [] };

        // Map of eventId → forcedProbability (live edit buffer).
        const overrideMap = new Map();
        s.overrides.forEach(o => overrideMap.set(o.eventId, +o.forcedProbability));

        modal.open((existing ? 'Edit ' : 'New ') + 'scenario', `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="60" value="${fmt.escHtml(s.name)}">`,
                'Shown in the scenarios picker on the right panel.')}
            <div class="dlg-note">
                Pick events to <strong>force</strong> to a fixed probability (0–1).
                Forced values replace the event's computed value during analysis.
                Use 1 for "always fails", 0 for "perfectly reliable".
            </div>
            <div class="dlg-label">Overrides</div>
            ${_pickerSearchBar('scnSearch', 'Search events…')}
            <div id="scnRows" class="picker"></div>
        `, [
            ...(existing ? [{
                label: 'Delete', cls: 'btn-danger',
                onClick: () => confirm('Delete scenario?',
                    'Remove "' + existing.name + '".',
                    () => { api.applyScenarioDelete(existing.id); modal.close(); })
            }] : []),
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            {
                label: existing ? 'Save' : 'Create',
                cls:   'btn-primary',
                onClick: () => {
                    const name = document.getElementById('fName').value.trim();
                    if (!name) { _err('Name is required.'); return; }
                    const cleaned = [];
                    overrideMap.forEach((v, k) => {
                        if (v < 0 || v > 1 || isNaN(v)) return;
                        cleaned.push({ eventId: k, forcedProbability: v });
                    });
                    const patch = { name, overrides: cleaned };
                    if (existing) api.applyScenarioUpdate(existing.id, patch);
                    else          api.applyScenarioCreate(patch);
                    modal.close();
                }
            }
        ]);

        const search = document.getElementById('scnSearch');
        const render = () => _renderScenarioPicker(p, overrideMap, search ? search.value : '');
        render();
        if (search) search.addEventListener('input', render);
    }

    function _renderScenarioPicker(project, overrideMap, filterStr) {
        const el = document.getElementById('scnRows');
        if (!el) return;
        const filter = (filterStr || '').toLowerCase().trim();

        const collapsedRaw = el.dataset.collapsed || '';
        const collapsed = new Set(collapsedRaw ? collapsedRaw.split(',') : []);

        const buckets = { basic: [], intermediate: [], top: [] };
        project.events.forEach(e => {
            if (filter && !e.name.toLowerCase().includes(filter)) return;
            buckets[e.kind].push(e);
        });
        let html = '';
        ['basic', 'intermediate', 'top'].forEach(k => {
            const list = buckets[k];
            if (list.length === 0) return;
            const isCollapsed = collapsed.has(k);
            html += `<div class="picker-section ${isCollapsed ? 'collapsed' : ''}" data-kind="${k}">
                <button type="button" class="picker-section-hd" data-toggle="${k}">
                    <span class="picker-chev">▾</span>
                    <span>${k}</span>
                    <span class="picker-section-n">${list.length}</span>
                </button>
                <div class="picker-section-body">`;
            list.forEach(e => {
                const has = overrideMap.has(e.id);
                const val = has ? overrideMap.get(e.id) : 0;
                html += `
                    <div class="scn-row ${has ? 'gi-on' : ''}" data-id="${e.id}">
                        <label class="scn-pick">
                            <input type="checkbox" data-id="${e.id}" ${has ? 'checked' : ''}>
                            <span>${fmt.escHtml(e.name)} <em class="gi-kind">${e.kind}</em></span>
                        </label>
                        <input class="dlg-inp scn-val" type="number" min="0" max="1" step="any"
                               data-id="${e.id}" value="${val}" ${has ? '' : 'disabled'}>
                    </div>`;
            });
            html += `</div></div>`;
        });
        if (!html.trim()) html = `<div class="ctrl-empty" style="padding:0.6rem">${filter ? 'No matches.' : 'No events yet.'}</div>`;
        el.innerHTML = html;

        el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.getAttribute('data-id');
                const numEl = el.querySelector('.scn-val[data-id="' + id + '"]');
                if (cb.checked) {
                    overrideMap.set(id, +numEl.value || 0);
                    if (numEl) numEl.disabled = false;
                } else {
                    overrideMap.delete(id);
                    if (numEl) numEl.disabled = true;
                }
                const row = cb.closest('.scn-row');
                if (row) row.classList.toggle('gi-on', cb.checked);
            });
        });
        el.querySelectorAll('.scn-val').forEach(inp => {
            inp.addEventListener('input', () => {
                const id = inp.getAttribute('data-id');
                if (overrideMap.has(id)) overrideMap.set(id, +inp.value || 0);
            });
        });
        el.querySelectorAll('[data-toggle]').forEach(btn => {
            btn.addEventListener('click', e => {
                e.preventDefault();
                const k = btn.getAttribute('data-toggle');
                const next = new Set(collapsed);
                if (next.has(k)) next.delete(k); else next.add(k);
                el.dataset.collapsed = Array.from(next).join(',');
                _renderScenarioPicker(project, overrideMap, filterStr);
            });
        });
    }

    /* ════════════════════════════════════════════════════════════════
       NEW PROJECT
       ════════════════════════════════════════════════════════════════ */

    function openNewProject(onSubmit) {
        const presetOpts = CONFIG.missionTimePresets.map(p =>
            `<option value="${p.hours}">${fmt.escHtml(p.label)}</option>`).join('');
        modal.open('New project', `
            ${_errBox()}
            ${_field('Project name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="60" placeholder="e.g. Brake-by-wire FTA">`)}
            ${_field('Mission time preset',
                `<select class="dlg-inp" id="fMTPreset">
                    <option value="">— custom —</option>
                    ${presetOpts}
                </select>`,
                'Pick a typical value or leave on "custom" and fill the field below. ' + _help('missionTime'))}
            ${_field('Mission time (h)',
                `<input class="dlg-inp" id="fMT" type="number" min="1" step="1" value="${CONFIG.defaultMissionTime}">`,
                'Operating duration over which the failure probability accumulates.')}
        `, [
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            {
                label: 'Create', cls: 'btn-primary',
                onClick: () => {
                    const name = document.getElementById('fName').value.trim() || 'Untitled project';
                    const mt   = parseFloat(document.getElementById('fMT').value);
                    if (isNaN(mt) || mt <= 0) { _err('Mission time must be a positive number.'); return; }
                    onSubmit({ name, missionTime: mt });
                    modal.close();
                }
            }
        ]);

        // Wire preset → field.
        const sel = document.getElementById('fMTPreset');
        const inp = document.getElementById('fMT');
        if (sel) sel.addEventListener('change', () => {
            if (sel.value) inp.value = sel.value;
        });
        // Pre-select preset if current value matches one.
        if (sel && inp) {
            const match = CONFIG.missionTimePresets.find(p => +p.hours === +inp.value);
            if (match) sel.value = String(match.hours);
        }
    }

    /* ════════════════════════════════════════════════════════════════
       EXPORT — small report dialog
       ════════════════════════════════════════════════════════════════ */

    /* Markdown lines for an ETA analysis: one block per final event, with
       the same PFD/PFH/SIL figures and the plain-language "1 in N hours"
       gloss the on-screen cards use, plus the shared event breakdown. */
    function _etaReportLines(lines, a) {
        lines.push('Mode: ETA (multiple final events) · Mission time: ' + a.missionTime + ' h');
        lines.push('');
        if (a.warnings && a.warnings.length) {
            lines.push('## Warnings');
            a.warnings.forEach(w => lines.push('- [' + w.kind + '] ' + w.msg));
            lines.push('');
        }
        lines.push('## Final events (' + a.finals.length + ')');
        if (a.finals.length === 0) {
            lines.push('- None. Mark one or more events as "final" (top).');
        }
        a.finals.forEach((f, i) => {
            lines.push((i + 1) + '. ' + f.name);
            lines.push('   - PFD : ' + fmt.probStr(f.pfd) +
                       (f.pfd != null ? '  (' + fmt.inHoursStr(f.pfd, a.missionTime) + ')' : ''));
            lines.push('   - PFH : ' + fmt.perHourStr(f.pfh) +
                       '   SIL ' + f.sil + ' · ASIL ' + f.asil);
            if (f.target) {
                lines.push('   - Target: ' + f.target + ' → ' +
                           (f.targetMet ? 'MET ✓' : 'MISSED ✗'));
            }
        });
        lines.push('');
        lines.push('## Events');
        a.events.forEach(ev => {
            lines.push('- (' + ev.kind + ') ' + ev.name + ' — P=' + fmt.probStr(ev.pfd));
        });
    }

    function openExport(project, analysis) {
        const lines = [];
        lines.push('# ' + (project.name || 'Untitled project'));
        lines.push('Generated by Functional Analysis Studio (FAS) v' +
                   (CONFIG.appVersion || '?'));

        const isEta = analysis && analysis.mode === 'ETA';
        if (isEta) {
            _etaReportLines(lines, analysis);
        } else {
            lines.push('Mode: FTA · Mission time: ' + project.missionTime + ' h');
            lines.push('');
            if (analysis && analysis.top) {
                lines.push('## Top event');
                lines.push('- Name: ' + analysis.top.name);
                lines.push('- PFD : ' + fmt.probStr(analysis.top.pfd));
                lines.push('- PFH : ' + fmt.perHourStr(analysis.top.pfh));
                lines.push('- SIL : ' + analysis.top.sil + '  (IEC 61508 high-demand)');
                lines.push('- ASIL: ' + analysis.top.asil + '  (ISO 26262 PMHF, informative)');
                if (analysis.top.target) {
                    lines.push('- Target: ' + analysis.top.target +
                        '  →  ' + (analysis.top.targetMet ? 'MET ✓' : 'MISSED ✗'));
                }
                lines.push('');
            }
            if (analysis && analysis.warnings.length) {
                lines.push('## Warnings');
                analysis.warnings.forEach(w => lines.push('- [' + w.kind + '] ' + w.msg));
                lines.push('');
            }
            if (analysis) {
                lines.push('## Events');
                analysis.events.forEach(ev => {
                    lines.push('- (' + ev.kind + ') ' + ev.name +
                               ' — P=' + fmt.probStr(ev.pfd) +
                               (ev.kind === 'top' ? '' : ', contribution ' +
                                    (ev.contribution > 0 ? (ev.contribution*100).toFixed(2) + '%' : '—')));
                });
            }
        }
        const text = lines.join('\n');
        const baseName = (project.name || 'fas-report').replace(/\s+/g, '_');

        modal.open('Export report', `
            <div class="dlg-msg">
                Save the diagram as PNG, or copy / download the Markdown summary.
            </div>
            <div class="dlg-label">Diagram (PNG)</div>
            <div class="export-row">
                <button class="btn btn-sec export-btn" id="btnPngTech"
                        title="Diagram with technical labels (PFD scientific notation, SIL codes)">
                    <span class="export-ic">▦</span> Save Diagram — Complete
                </button>
                <button class="btn btn-sec export-btn" id="btnPngSimple"
                        title="Diagram with simplified labels (percentages, plain-language integrity)">
                    <span class="export-ic">◌</span> Save Diagram — Simple
                </button>
            </div>
            <div class="dlg-label" style="margin-top:0.6rem">Report (Markdown)</div>
            <textarea class="dlg-inp" id="fExport" rows="10" readonly>${fmt.escHtml(text)}</textarea>
        `, [
            { label: 'Close', cls: 'btn-sec', onClick: modal.close },
            { label: 'Download .md', cls: 'btn-primary', onClick: () => {
                const blob = new Blob([text], { type: 'text/markdown' });
                _downloadBlob(blob, baseName + '.md');
            }}
        ]);

        document.getElementById('btnPngTech').addEventListener('click', () => {
            const blob = canvas.exportPNG('technical');
            if (blob) _downloadBlob(blob, baseName + '_complete.png');
        });
        document.getElementById('btnPngSimple').addEventListener('click', () => {
            const blob = canvas.exportPNG('simplified');
            if (blob) _downloadBlob(blob, baseName + '_simple.png');
        });
    }

    function _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    /* ════════════════════════════════════════════════════════════════
       CONFIRM / ALERT
       ════════════════════════════════════════════════════════════════ */

    function confirm(title, message, onOk) {
        modal.open(title, `<div class="dlg-msg">${fmt.escHtml(message)}</div>`, [
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            // Close BEFORE running onOk so that an onOk which itself opens
            // a new modal (e.g. New Project after Discard) isn't torn
            // down one frame later. Same fix as the MS baseline.
            { label: 'OK',     cls: 'btn-primary',
              onClick: () => { modal.close(); onOk && onOk(); } }
        ]);
    }

    function _alert(title, message) {
        modal.open(title, `<div class="dlg-msg">${fmt.escHtml(message)}</div>`, [
            { label: 'OK', cls: 'btn-primary', onClick: modal.close }
        ]);
    }

    return {
        init,
        openEventEdit, openGateEdit, openLinkEdit, openGroupEdit, openScenarioEdit,
        openNewProject, openExport, openHelp,
        confirm
    };
})();
