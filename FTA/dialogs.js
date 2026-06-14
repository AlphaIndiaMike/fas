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

    function openEventEdit(eventId, createKind, draft) {
        const p = api.getProject();
        if (!p) return;
        const existing = eventId ? p.eventById(eventId) : null;
        const e = existing || Object.assign(_eventDraft(p, createKind), draft || {});

        const isFmeda = p.mode === 'FMEDA';

        const hasTop  = !!p.topEvent();
        const kindOpts = ['basic', 'intermediate', 'top'].map(k =>
            `<option value="${k}"${k === e.kind ? ' selected' : ''}` +
            (k === 'top' && hasTop && e.kind !== 'top' ? ' disabled' : '') +
            `>${k}${k === 'top' && hasTop && e.kind !== 'top' ? ' (one already exists)' : ''}</option>`
        ).join('');

        // In FMEDA a failure mode is ALWAYS a basic event living inside a
        // FUNCTION (never an architecture element, never intermediate/top).
        // So we drop the Kind selector and turn "Group" into a Function
        // picker restricted to function-groups. A hidden fKind keeps the
        // rest of the save path unchanged.
        const kindField = isFmeda
            ? `<input type="hidden" id="fKind" value="basic">`
            : _field('Kind',
                `<select class="dlg-inp" id="fKind">${kindOpts}</select>`,
                'Basic = leaf (ellipse). Intermediate = derived (round box). Top = system outcome (dark square; one per project).');

        // FTA/ETA still pick a grouping box. FMEDA picks the owning FUNCTION:
        // the picker was removed in 1.8.3, which broke the add-flow (you could
        // not steer a new failure mode onto a low-level function, so it landed
        // on whatever opened it — often a mid-level element, where the editor
        // is read-only). The pickList writes its value into a hidden input
        // with id "fGroup", so the save path (which reads #fGroup) is
        // unchanged; selecting a different function re-renders the editable /
        // derived body below.
        const ownerField = isFmeda
            ? _field('Function',
                _pickList({ id: 'fGroup', items: _functionPickItems(p),
                            selected: e.groupId, multi: false,
                            placeholder: 'Search functions…' }),
                'The function this failure mode belongs to. A low-level element holds editable leaf failure modes; a top/mid element holds derived effects computed from their causes. Re-pick to move the failure mode.')
            : _field('Group',
                `<select class="dlg-inp" id="fGroup">${_groupOptions(p, e.groupId)}</select>`,
                'Groups mark independence boundaries. Two basic events sharing a group flag FFI on AND/Voting gates that combine them. ' + _help('ffi'));

        // The FMEDA error-specification + mitigation block depends on the
        // owning function's element LEVEL (leaf → editable; top/mid → derived
        // read-only). It is rebuilt whenever the function picker changes, so
        // it lives in its own container. (FTA/ETA keep their fixed layout.)
        const nameField = _field('Name',
            `<input class="dlg-inp" id="fName" type="text" maxlength="60" value="${fmt.escHtml(e.name)}">`,
            isFmeda ? 'The failure mode — the way this function fails.' : '');

        let body;
        if (isFmeda) {
            body = `
                ${_errBox()}
                ${nameField}
                ${kindField}
                ${ownerField}
                <div id="fmedaFlex">${_fmedaFlexHtml(p, e, existing)}</div>
                <div id="targetSection"></div>`;
        } else {
            // FTA/ETA: description, then the probability chooser, then target.
            const detailField = _field('Description',
                `<textarea class="dlg-inp" id="fDesc" rows="2" maxlength="500">${fmt.escHtml(e.description || '')}</textarea>`);
            body = `
                ${_errBox()}
                ${nameField}
                ${kindField}
                ${ownerField}
                ${detailField}
                <div id="probSection">${_probSectionHtml(p, e)}</div>
                <div id="targetSection">${_targetSectionHtml(e)}</div>`;
        }

        modal.open((existing ? 'Edit ' : 'New ') +
            (isFmeda ? 'failure mode' : 'event'), body, _eventFooter(existing, e));

        if (isFmeda) {
            // Re-pick the function → move the failure mode and rebuild the
            // editable/derived body for the newly chosen function's level.
            _wirePickList('fGroup', (val) => {
                e.groupId = val || null;
                const flex = document.getElementById('fmedaFlex');
                if (flex) flex.innerHTML = _fmedaFlexHtml(p, e, existing);
                if (!_fmedaDerivedLevel(p, e.groupId)) _wireProbSection(p, e);
            });
            if (!_fmedaDerivedLevel(p, e.groupId)) _wireProbSection(p, e);
        } else {
            _wireProbSection(p, e);
            _wireTargetSection();
        }
    }

    /* The level-dependent FMEDA body: error-specification (probability chooser
       or the read-only derived summary) plus the mitigation field (or, for a
       derived effect, an explanatory note and a hidden mitigation carrier).
       Rebuilt whenever the owning function — and therefore the level — changes. */
    function _fmedaFlexHtml(p, e, existing) {
        const isDerived = _fmedaDerivedLevel(p, e.groupId);
        let detailField;
        if (isDerived) {
            detailField = `
                <div class="dlg-note">
                    <strong>Derived effect — ${fmt.escHtml(isDerived)}-level architecture element.</strong>
                    Its failure rate and diagnostic coverage are determined by
                    the contributing lower-level failure modes and their
                    mitigations, combined through the failure network.
                    Mitigations are specified on those lower-level failure
                    modes.
                </div>
                <input type="hidden" id="fMitigation" value="${fmt.escHtml(e.mitigation || '')}">`;
        } else {
            detailField = _field('Mitigation — diagnostic + reaction requirement',
                `<textarea class="dlg-inp" id="fMitigation" rows="3" maxlength="800" placeholder="e.g. Register readback: compare against commanded value every cycle; on mismatch, force power stage off within 10 ms.">${fmt.escHtml(e.mitigation || '')}</textarea>`,
                'The diagnostic and the reaction it triggers. The residual rate always reflects the diagnostic coverage entered below; the mitigation text records the requirement to trace and is flagged if missing.');
        }
        const probInner = isDerived
            ? _derivedProbHtml(p, existing)
            : _probSectionHtml(p, e);
        return `
            <div class="dlg-label">Error specification</div>
            <div id="probSection">${probInner}</div>
            ${detailField}`;
    }

    /* Return the element LEVEL ('top'|'mid') if a failure mode in this
       function-group is DERIVED, else ''. A failure mode is derived when its
       owning architecture element sits at the top or mid level. */
    function _fmedaDerivedLevel(p, groupId) {
        if (!groupId) return '';
        const el = p.elementOf(groupId);
        const lvl = el ? (el.level || '') : '';
        return (lvl === 'top' || lvl === 'mid') ? lvl : '';
    }

    /* Read-only computed summary for a derived failure mode. */
    function _derivedProbHtml(p, existing) {
        if (!existing) {
            return `<div class="dlg-note">The failure rate and diagnostic
                coverage are determined from the contributing lower-level
                failure modes once they are linked.</div>`;
        }
        const raw = p.fmedaPropagatedRaw(existing.id);
        const res = p.fmedaPropagatedResidual(existing.id);
        const dc  = p.fmedaComputedDC(existing.id);
        const pfh = res * 1e-9;
        const sil = fmt.silForPfh(pfh), asil = fmt.asilForPfh(pfh);
        if (!(raw > 0)) {
            return `<div class="dlg-note">No contributing failure modes are
                linked to this effect yet. Link the lower-level failure modes
                that lead to it on the failure network; its failure rate and
                diagnostic coverage follow from them.</div>`;
        }
        return `
            <div class="dlg-readonly">
                <div class="dlg-ro-row"><span>Incoming rate (before mitigation)</span><strong>${fmt.fitStr(raw)}</strong></div>
                <div class="dlg-ro-row"><span>Residual rate</span><strong>${fmt.fitStr(res)}</strong></div>
                <div class="dlg-ro-row"><span>Diagnostic coverage</span><strong>${Math.round(dc * 100)}%</strong></div>
                <div class="dlg-ro-row"><span>Achieved integrity</span><strong>${fmt.pfhDualStr(pfh)} · ${sil} / ${asil}</strong></div>
                <div class="dlg-note" style="margin-top:.5rem">Determined by the
                    contributing lower-level failure modes and their mitigations.
                    Strengthen the diagnostics on those failure modes to improve
                    these figures.</div>
            </div>`;
    }

    /* pickList items for the FMEDA failure-mode Function picker: every
       function as "FN_n — name · element (level)" so the user can see which
       functions are leaf (low) and which are derived (top/mid). */
    function _functionPickItems(project) {
        return project.functionGroups().map(fn => {
            const el = project.elementOf(fn.id);
            const elName = el ? el.name : '—';
            const lvl = el && el.level ? el.level : '';
            return {
                value:  fn.id,
                idText: fn.id,
                name:   fn.name + ' · ' + elName + (lvl ? ' (' + lvl + ')' : '')
            };
        });
    }

    /* Function-only option list for the FMEDA failure-mode editor. Shows
       the parent element in parentheses so duplicate function names across
       elements stay distinguishable. */
    function _functionOptions(project, selectedId) {
        const fns = project.functionGroups();
        if (!fns.length) {
            return `<option value="">— no functions yet —</option>`;
        }
        return fns.map(fn => {
            const el = project.elementOf(fn.id);
            const tag = el && el.kind === 'element' ? ' (' + el.name + ')' : '';
            return `<option value="${fn.id}"${fn.id === selectedId ? ' selected' : ''}>` +
                   `${fmt.escHtml(fn.name + tag)}</option>`;
        }).join('');
    }

    /* pickList items: architecture elements as "XXX_n — name". */
    function _elementPickItems(project) {
        return project.elementGroups().map(el =>
            ({ value: el.id, idText: el.id, name: el.name }));
    }

    /* pickList items: every failure mode as "FM_n — name (function · element)".
       Used by the "copy failure modes" control in the function editor. */
    function _failureModePickItems(project) {
        const items = [];
        project.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const fn = project.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const el = project.elementOf(fn.id);
            const loc = fn.name + (el ? ' · ' + el.name : '');
            items.push({ value: e.id, idText: e.id, name: e.name + '  (' + loc + ')' });
        });
        return items;
    }

    function _eventDraft(project, createKind) {
        const d = CONFIG.eventDefaults;
        let kind = 'basic';
        if (createKind === 'event-intermediate') kind = 'intermediate';
        if (createKind === 'event-top')          kind = project.topEvent() ? 'intermediate' : 'top';
        // In FMEDA a failure mode is most naturally entered as a dangerous
        // failure rate plus its diagnostic coverage, so open in coverage mode.
        const probMode = (project.mode === 'FMEDA' && CONFIG.fmedaEventDefaults)
            ? CONFIG.fmedaEventDefaults.probMode : d.probMode;
        return {
            id:           null,
            name:         '',
            kind,
            description:  '',
            groupId:      null,
            x: 200, y: 200,
            probMode:            probMode,
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
        // A single dropdown chooses HOW the failure is specified. This
        // replaces the old "input mode" radios + a separate UNIT chip group,
        // which overlapped (e.g. direct+FIT vs rate) and caused confusion.
        // Each choice maps cleanly to the stored (probMode, directUnit):
        //   pfd      -> direct / PFD   (percentage field)
        //   pfh      -> direct / PFH   (per-hour rate)
        //   fit      -> rate           (FIT)
        //   coverage -> coverage       (FIT dangerous + diagnostic coverage)
        const sel = _inputChoiceOf(e);
        const choices = [
            { v: 'pfd',      label: 'Probability of failure (%)' },
            { v: 'pfh',      label: 'Probability per hour (PFH)' },
            { v: 'fit',      label: 'Failure rate (FIT)' },
            { v: 'coverage', label: 'Failure rate (FIT) + diagnostic coverage' }
        ].map(o => `<option value="${o.v}" ${o.v === sel ? 'selected' : ''}>${o.label}</option>`).join('');

        return `
            ${_field('How is this failure specified? ' + _help('probMode'),
                `<select class="dlg-inp" id="fInputChoice">${choices}</select>`,
                'Pick the kind of value you have. The field below adapts to your choice.')}

            <div id="fModeBody">
                ${_modeBodyHtml(e)}
            </div>
        `;
    }

    /* Map a stored event to the single dropdown choice. */
    function _inputChoiceOf(e) {
        if (e.probMode === 'rate')     return 'fit';
        if (e.probMode === 'coverage') return 'coverage';
        // direct: distinguish by unit (PFD => percent, PFH => per-hour).
        return (e.directUnit === 'PFH') ? 'pfh' : 'pfd';
    }

    /* Apply a dropdown choice back onto a draft's (probMode, directUnit). */
    function _applyInputChoice(draft, choice) {
        switch (choice) {
            case 'pfh':      draft.probMode = 'direct';   draft.directUnit = 'PFH'; break;
            case 'fit':      draft.probMode = 'rate';     draft.directUnit = 'FIT'; break;
            case 'coverage': draft.probMode = 'coverage'; break;
            case 'pfd':
            default:         draft.probMode = 'direct';   draft.directUnit = 'PFD'; break;
        }
        return draft;
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
                    ${_field('Diagnostic coverage, DC₁',
                        `<input class="dlg-inp" id="fDC" type="number" min="0" max="1" step="0.001" value="${e.diagnosticCoverage}">`,
                        'Primary diagnostic coverage — fraction of the dangerous rate detected by the safety mechanism (0–1). Drives the residual and SFF. ' + _help('coverage'))}
                    ${_field('Latent-fault coverage, DC₂',
                        `<input class="dlg-inp" id="fDCL" type="number" min="0" max="1" step="0.001" value="${e.diagnosticCoverageLatent != null ? e.diagnosticCoverageLatent : 0}">`,
                        'ISO 26262 latent-fault coverage — fraction of the detected (multiple-point) faults whose latency is itself revealed (0–1). Drives λ_MPF,latent and the LFM. Leave 0 if there is no latent-fault check.')}
                    ${_field('Mission time override (h)',
                        `<input class="dlg-inp" id="fMtO" type="number" min="0" step="any" value="${e.missionTimeOverride != null ? e.missionTimeOverride : ''}">`,
                        'Blank = use project mission time.')}
                </div>
                ${_field('Evidence / source',
                    `<textarea class="dlg-inp" id="fEvidence" rows="2" maxlength="800" placeholder="e.g. ISO 26262-5:2018 Annex D, Table D.13 — E2E Profile 5">${fmt.escHtml(e.diagnosticEvidence || '')}</textarea>`,
                    'Where does this coverage value come from? ' + _help('coverageEvidence'))}
                <div class="dlg-note" id="fLive"></div>`;
        }
        // direct — the dropdown already decided PFD (percent) vs PFH
        // (per-hour). No more UNIT chips here.
        const u = e.directUnit || 'PFD';
        const isPct = (u !== 'PFH');   // PFD shown as a percentage
        const shownVal = isPct ? fmt.pctInputVal(e.probability) : e.probability;
        const affix = isPct ? '<span class="dlg-affix">%</span>'
                            : '<span class="dlg-affix">/h</span>';
        const stepAttr = isPct ? '0.001' : 'any';
        const maxAttr  = isPct ? ' max="100"' : '';
        const fieldLabel = isPct ? 'Probability of failure (%)'
                                 : 'Probability per hour (PFH)';
        const fieldHelp  = isPct
            ? 'Percent chance the event has occurred by the end of the mission. ' +
              'Type 10 for 10 %, 0.1 for 0.1 %, 100 for certain failure.'
            : 'Dangerous failures per hour (h⁻¹). ' + _help('units');
        return `
            ${_field(fieldLabel,
                `<div class="dlg-affix-wrap">` +
                `<input class="dlg-inp" id="fProb" type="number" min="0"${maxAttr} step="${stepAttr}" ` +
                `data-pct="${isPct ? '1' : '0'}" value="${shownVal}">${affix}</div>`,
                fieldHelp)}
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

        // Single input-choice dropdown: maps to (probMode, directUnit) and
        // re-renders the value field. Replaces the old radios + unit chips.
        const choiceSel = document.getElementById('fInputChoice');
        if (choiceSel) choiceSel.addEventListener('change', () => {
            const draft = _readDraft(eOriginal);
            _applyInputChoice(draft, choiceSel.value);
            document.getElementById('fModeBody').innerHTML = _modeBodyHtml(draft);
            _wireModeBody(project, draft);
        });
        _wireModeBody(project, eOriginal);
    }

    function _wireModeBody(project, e) {
        const body = document.getElementById('fModeBody');
        if (!body) return;
        // Number inputs → live readout. (No more unit chips — the dropdown
        // above owns the PFD/PFH/FIT/coverage choice.)
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

        // The single input-choice dropdown drives (probMode, directUnit).
        const choiceSel = document.getElementById('fInputChoice');
        if (choiceSel) _applyInputChoice(draft, choiceSel.value);

        const prob    = document.getElementById('fProb');
        const rate    = document.getElementById('fRate');
        const rateRaw = document.getElementById('fRateRaw');
        const dc      = document.getElementById('fDC');
        const dcl     = document.getElementById('fDCL');
        const mtO     = document.getElementById('fMtO');
        const evid    = document.getElementById('fEvidence');
        if (prob) {
            // When the field is a percentage (PFD unit), convert back to a
            // [0,1] fraction so the engine and storage are unchanged: the
            // user's "10" becomes 0.10. data-pct is set by _modeBodyHtml.
            const raw = +prob.value;
            draft.probability = (prob.dataset.pct === '1') ? raw / 100 : raw;
        }
        if (rate)    draft.failureRate        = +rate.value;
        if (rateRaw) draft.failureRateRaw     = +rateRaw.value;
        if (dc)      draft.diagnosticCoverage = +dc.value;
        if (dcl)     draft.diagnosticCoverageLatent = +dcl.value;
        if (mtO)     draft.missionTimeOverride = mtO.value === '' ? null : +mtO.value;
        if (evid)    draft.diagnosticEvidence = evid.value;
        const mit = document.getElementById('fMitigation');
        if (mit) draft.mitigation = mit.value;

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
                    // draft.probability is the [0,1] fraction; the user sees
                    // and types percent, so phrase the bound in percent.
                    _err('Probability of failure must be between 0 % and 100 %.'); return;
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
            diagnosticCoverageLatent: draft.diagnosticCoverageLatent != null ? draft.diagnosticCoverageLatent : 0,
            diagnosticEvidence:  draft.diagnosticEvidence || '',
            mitigation:          draft.mitigation || '',
            x:                   draft.x, y: draft.y,
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

    /* ── pickList: searchable single/multi select ────────────────────
       A self-contained labelled list control: an optional summary line, a
       search box, and a scrollable list of "ID — Name" rows with a radio
       (single) or checkbox (multi) each. Replaces the old search-above-a-
       native-select pattern everywhere.

       Contract:
         _pickList({ id, items, selected, multi, placeholder, noneLabel })
           id        — base id; a hidden <input id="{id}"> holds the value(s),
                       comma-separated for multi, so existing read paths keep
                       working via document.getElementById(id).value.
           items     — [{ value, idText, name }]
           selected  — string | string[]  (current selection)
           multi     — boolean (checkboxes vs radios)
           placeholder, noneLabel — optional copy.
         Wire with _wirePickList(id, onChange?) after the modal opens.
         Read with _pickListValue(id) (single) / _pickListValues(id) (multi). */
    function _pickList({ id, items, selected, multi = false,
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
        const summary = _pickListSummary(items, sel, multi, noneLabel);
        return `
            <div class="picklist" data-multi="${multi ? 1 : 0}" data-pl="${id}">
                <input type="hidden" id="${id}" value="${fmt.escHtml(csv)}">
                <div class="picklist-summary" id="${id}__sum">${summary}</div>
                <input class="picklist-search" id="${id}__q" type="text"
                       placeholder="${fmt.escHtml(placeholder || ('Search ' + n + ' items…'))}">
                <div class="picklist-list" id="${id}__list">
                    ${rows || '<div class="picklist-empty">No items.</div>'}
                </div>
            </div>`;
    }

    function _pickListSummary(items, selSet, multi, noneLabel) {
        const n = items.length;
        if (selSet.size === 0) return `${noneLabel} of ${n}`;
        if (multi) return `${selSet.size} selected of ${n}`;
        const v = Array.from(selSet)[0];
        const it = items.find(i => i.value === v);
        return it ? `${fmt.escHtml(it.idText)} — ${fmt.escHtml(it.name)}` : `${noneLabel} of ${n}`;
    }

    function _wirePickList(id, onChange) {
        const root = document.querySelector('.picklist[data-pl="' + id + '"]');
        if (!root) return;
        const multi  = root.getAttribute('data-multi') === '1';
        const hidden = document.getElementById(id);
        const sumEl  = document.getElementById(id + '__sum');
        const q      = document.getElementById(id + '__q');
        const list   = document.getElementById(id + '__list');
        const opts   = Array.from(list.querySelectorAll('.picklist-opt'));
        const items  = opts.map(o => ({
            value:  o.querySelector('input').value,
            idText: (o.querySelector('.picklist-id') || {}).textContent || '',
            name:   (o.querySelector('.picklist-nm') || {}).textContent || ''
        }));
        function refresh() {
            const checked = opts
                .filter(o => o.querySelector('input').checked)
                .map(o => o.querySelector('input').value);
            hidden.value = checked.join(',');
            sumEl.innerHTML = _pickListSummary(items, new Set(checked), multi, 'none');
            if (onChange) onChange(hidden.value);
        }
        list.addEventListener('change', refresh);
        if (q) q.addEventListener('input', () => {
            const needle = q.value.toLowerCase().trim();
            opts.forEach(o => {
                const hit = !needle || (o.getAttribute('data-hay') || '').indexOf(needle) !== -1;
                o.style.display = hit ? '' : 'none';
            });
        });
    }

    function _pickListValue(id) {
        const h = document.getElementById(id);
        return h && h.value ? h.value.split(',')[0] : '';
    }
    function _pickListValues(id) {
        const h = document.getElementById(id);
        return h && h.value ? h.value.split(',').filter(Boolean) : [];
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

    function openGroupEdit(groupId, draft) {
        const p = api.getProject();
        if (!p) return;
        const existing = groupId ? p.groupById(groupId) : null;
        // For a brand-new FMEDA element/function, `draft` carries the intended
        // kind / level / parentId so we can show the right fields and create
        // the group ONLY on Save (Cancel leaves nothing behind).
        const g = existing || {
            id: null,
            name: (draft && draft.name) || '',
            color: CONFIG.groupColors[p.groups.length % CONFIG.groupColors.length],
            description: '',
            kind:     draft && draft.kind     ? draft.kind     : 'group',
            level:    draft && draft.level    ? draft.level    : null,
            parentId: draft && draft.parentId ? draft.parentId : null
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

        // FMEDA-specific fields. For an element: which swimlane level.
        // For a function: which parent element it lives in. Hidden for
        // plain FTA/ETA groups (kind 'group').
        const isFmeda = p.mode === 'FMEDA' &&
                        (g.kind === 'element' || g.kind === 'function');
        let fmedaFields = '';
        if (isFmeda) fmedaFields += `<input type="hidden" id="fGroupKind" value="${g.kind}">`;
        if (isFmeda && g.kind === 'element') {
            const levels = [['top','Top level'],['mid','Mid level'],['low','Low level']];
            const opts = levels.map(([v,l]) =>
                `<label class="dlg-chip ${g.level === v ? 'dlg-chip-on' : ''}">
                    <input type="radio" name="fLevel" value="${v}" ${g.level === v ? 'checked' : ''}>
                    <span>${l}</span></label>`).join('');
            fmedaFields += `<div class="dlg-label">Swimlane level</div>
                <div class="dlg-chips" id="fLevelChips">${opts}</div>`;
        } else if (isFmeda && g.kind === 'function') {
            fmedaFields += _field('Parent element',
                _pickList({ id: 'fParent', items: _elementPickItems(p),
                            selected: g.parentId, multi: false,
                            placeholder: 'Search elements…' }),
                'The architecture element this function belongs to.');
            // Copy existing failure modes into this function (item 4): reuse
            // the text and properties of failure modes defined elsewhere.
            const fmItems = _failureModePickItems(p);
            if (fmItems.length) {
                fmedaFields += _field('Copy failure modes (optional)',
                    _pickList({ id: 'fCopyFms', items: fmItems, selected: [],
                                multi: true,
                                placeholder: 'Search failure modes to copy…' }),
                    'Duplicate the selected failure modes into this function, reusing their description and properties. Each copy is independent of the original.');
            }
        }

        modal.open((existing ? 'Edit ' : 'New ') +
            (isFmeda ? (g.kind === 'element' ? 'element' : 'function') : 'group'), `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="fName" type="text" maxlength="40" value="${fmt.escHtml(g.name)}">`,
                'Visible label on the canvas container.')}

            ${fmedaFields}

            ${isFmeda ? '' : `<div class="dlg-label">Color</div>
            <div class="dlg-swatches">${swatches}</div>`}

            ${_field(isFmeda ? 'Description' : 'Description / FFI argument',
                `<textarea class="dlg-inp" id="fDesc" rows="3" maxlength="800">${fmt.escHtml(g.description || '')}</textarea>`,
                isFmeda ? 'Free-text notes for this ' + (g.kind === 'element' ? 'element.' : 'function.')
                        : 'Free-text. Use to document a Freedom From Interference argument when accepting a flagged warning. ' + _help('ffi'))}

            ${isFmeda ? '' : `
            <div class="dlg-label" style="margin-top:0.4rem">Members</div>
            <div class="dlg-hint" style="margin-bottom:0.4rem">
                Pick events that share this independence boundary. ${_help('ffi')}
            </div>
            ${_pickerSearchBar('gMemSearch', 'Search events…')}
            <div id="gMembers" class="picker"></div>`}
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

        // FMEDA level chips (elements only): toggle the on-state visual.
        document.querySelectorAll('#fLevelChips input[name="fLevel"]').forEach(r => {
            r.addEventListener('change', () => {
                document.querySelectorAll('#fLevelChips .dlg-chip').forEach(c =>
                    c.classList.toggle('dlg-chip-on', c.querySelector('input').checked));
            });
        });
        _wirePickList('fParent');
        _wirePickList('fCopyFms');

        // Member picker — searchable, grouped by kind. Absent in FMEDA
        // (functions don't use the FFI member boundary), so guard for it.
        const membersBox = document.getElementById('gMembers');
        const search = document.getElementById('gMemSearch');
        if (membersBox) {
            const renderMembers = () => {
                _renderEventPickerV2(p, members, 'gMembers', {
                    filter:      search ? search.value : '',
                    groupByKind: true
                });
            };
            renderMembers();
            if (search) search.addEventListener('input', renderMembers);
        }
    }

    function _saveGroup(existing, members) {
        const name = document.getElementById('fName').value.trim();
        const desc = document.getElementById('fDesc').value;
        const col  = (document.querySelector('input[name="fColor"]:checked') || {}).value;
        if (!name) { _err('Name is required.'); return; }
        const patch = { name, description: desc };
        // Color is only set when the swatch picker is present (FTA/ETA).
        // FMEDA uses semantic colors, so leave the stored color untouched.
        if (col) patch.color = col;

        // FMEDA fields, if present in the dialog.
        const kindH = document.getElementById('fGroupKind');
        if (kindH && kindH.value) patch.kind = kindH.value;
        const levelR = document.querySelector('input[name="fLevel"]:checked');
        if (levelR) patch.level = levelR.value;
        const parentSel = document.getElementById('fParent');
        if (parentSel && parentSel.value) patch.parentId = parentSel.value;

        // Failure modes selected to copy into this function (item 4).
        const copyIds = _pickListValues('fCopyFms');

        let targetId;
        if (existing) {
            api.applyGroupUpdate(existing.id, patch, members);
            targetId = existing.id;
        } else {
            targetId = api.applyGroupCreate(patch, members);
        }
        if (copyIds.length && targetId && api.applyCopyFailureModes) {
            api.applyCopyFailureModes(targetId, copyIds);
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

    function openNewProject(onSubmit, onDemo) {
        const presetOpts = CONFIG.missionTimePresets.map(p =>
            `<option value="${p.hours}">${fmt.escHtml(p.label)}</option>`).join('');
        const footer = [];
        if (typeof onDemo === 'function') {
            footer.push({
                label: 'Load demo', cls: 'btn-sec btn-left',
                onClick: () => { modal.close(); onDemo(); }
            });
        }
        footer.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        footer.push({
            label: 'Create', cls: 'btn-primary',
            onClick: () => {
                const name = document.getElementById('fName').value.trim() || 'Untitled project';
                const mt   = parseFloat(document.getElementById('fMT').value);
                if (isNaN(mt) || mt <= 0) { _err('Mission time must be a positive number.'); return; }
                onSubmit({ name, missionTime: mt });
                modal.close();
            }
        });
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
            ${typeof onDemo === 'function'
                ? '<div class="dlg-note">New here? <strong>Load demo</strong> opens a worked brake-by-wire FMEDA that shows every feature.</div>'
                : ''}
        `, footer);

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

    /* Markdown for an FMEDA model (item A). Built fresh from the project so
       the report always matches the current model. Includes element/function
       integrity, the per-failure-mode breakdown with ids, the numbered
       safety-requirement list (SRn) for tracing mitigation outside the tool,
       and common-cause findings. */
    function _fmedaReportLines(lines, p) {
        const ru = p.fmedaRollup();
        const pfhStr = fit => fmt.pfhDualStr(fit * 1e-9);
        lines.push('Mode: FMEDA · Mission time: ' + p.missionTime + ' h');
        lines.push('');

        // Hardware metrics — IEC 61508 SFF and ISO 26262 SPF/RF/MPF.
        const m = p.fmedaMetrics();
        const t = m.total;
        const pct = v => (v == null) ? '—' : (Math.round(v * 1000) / 10) + '%';
        const fitU = v => fmt.fitStr(v);
        lines.push('## FMEDA metrics');
        if (!(t.lambdaTotal > 0)) {
            lines.push('- No quantified leaf failure modes yet.');
        } else {
            lines.push('- λ_Total,Safety: ' + fitU(t.lambdaTotal));
            lines.push('- λ_SD: ' + fitU(t.lambdaSD) + ' · λ_SU: ' + fitU(t.lambdaSU));
            lines.push('- λ_DD (detected dangerous): ' + fitU(t.lambdaDD));
            lines.push('- λ_DU (undetected dangerous): ' + fitU(t.lambdaDU));
            lines.push('- Safe Failure Fraction (SFF): ' + pct(t.sff));
            lines.push('');
            lines.push('   ISO 26262 terminology mapping:');
            lines.push('   - λ_SPF (single-point fault, no DC₁): ' + fitU(t.lambdaSPF));
            lines.push('   - λ_RF (residual fault, missed by DC₁): ' + fitU(t.lambdaRF));
            lines.push('   - λ_MPF,dp (multiple-point, detected by DC₁): ' + fitU(t.lambdaMPFdp));
            lines.push('   - λ_MPF,latent (not caught by DC₂): ' + fitU(t.lambdaMPFlatent));
            lines.push('   - Single-Point Fault Metric (SPFM): ' + pct(t.spfm));
            lines.push('   - Latent-Fault Metric (LFM): ' + pct(t.lfm));
            lines.push('   - Basis: leaf failure modes; λ_S = 0 (no safe-failure portion modelled), so λ_SD = λ_SU = 0, λ_Total sums dangerous rates only, and SFF is a conservative floor.');
            if (m.elements.length > 1) {
                lines.push('');
                lines.push('   Per element:');
                m.elements.slice().sort((a, b) => (b.lambdaTotal || 0) - (a.lambdaTotal || 0)).forEach(e =>
                    lines.push('   - [' + (e.id || '—') + '] ' + e.name +
                        ': λ ' + fitU(e.lambdaTotal) + ' · SFF ' + pct(e.sff) +
                        ' · SPFM ' + pct(e.spfm) + ' · LFM ' + pct(e.lfm)));
            }
        }
        lines.push('');

        // Elements — achieved integrity.
        lines.push('## Architecture elements (' + ru.elements.length + ')');
        if (!ru.elements.length) lines.push('- None yet.');
        ru.elements.slice().sort((a, b) => a.integrityFit - b.integrityFit).forEach(e => {
            const pfh = e.integrityFit * 1e-9;
            lines.push('- [' + e.id + '] ' + e.name +
                (e.level ? ' (' + e.level + ')' : '') +
                ' — integrity ' + fmt.silForPfh(pfh) + ' / ' + fmt.asilForPfh(pfh) +
                ' at ' + pfhStr(e.integrityFit) +
                '; total residual ' + fmt.fitStr(e.residualFit));
        });
        lines.push('');

        // Functions — residual & integrity.
        lines.push('## Functions (' + ru.functions.length + ')');
        ru.functions.forEach(f => {
            const pfh = f.residualFit * 1e-9;
            lines.push('- [' + f.id + '] ' + f.name + '  (' + f.elementName + ')');
            lines.push('   - Residual: ' + fmt.fitStr(f.residualFit) + ' = ' + pfhStr(f.residualFit) +
                '  →  ' + fmt.silForPfh(pfh) + ' / ' + fmt.asilForPfh(pfh));
            lines.push('   - Raw: ' + fmt.fitStr(f.rawFit) +
                ' · handled ' + f.handledCount + '/' + f.total +
                (f.derivedCount ? ' · derived ' + f.derivedCount : ''));
        });
        lines.push('');

        // Per failure-mode breakdown with ids and leaf/derived state.
        lines.push('## Failure modes');
        p.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const fn = p.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const derived = p.fmedaIsDerived(e.id);
            const raw = derived ? p.fmedaPropagatedRaw(e.id) : p.fmedaRawFit(e);
            const res = p.fmedaPropagatedResidual(e.id);
            const dc  = derived ? p.fmedaComputedDC(e.id) : (+e.diagnosticCoverage || 0);
            const sr  = p.fmedaSrIdOf(e.id);
            lines.push('- [' + e.id + '] ' + e.name + '  (' + fn.name + ')' +
                (derived ? ' — DERIVED' : '') + (sr ? ' — ' + sr : ''));
            lines.push('   - raw ' + fmt.fitStr(raw) + ' · residual ' + fmt.fitStr(res) +
                ' · DC ' + Math.round(dc * 100) + '%');
        });
        lines.push('');

        // Safety requirements — the traceable SRn list.
        const srs = p.safetyRequirements();
        lines.push('## Safety requirements (' + srs.length + ')');
        if (!srs.length) lines.push('- None. A requirement is created for each handled (mitigated) low-level failure mode.');
        srs.forEach(sr => {
            lines.push('- ' + sr.srId + ' [' + sr.eventId + '] — ' + sr.elementName +
                ' · ' + sr.functionName + ' · ' + sr.name);
            lines.push('   - DC ' + Math.round(sr.dc * 100) + '% — ' + sr.mitigation);
        });
        lines.push('');

        // Common-cause findings.
        const cc = p.commonCauseFindings();
        if (cc.length) {
            lines.push('## Common-cause findings (' + cc.length + ')');
            cc.forEach(f => {
                lines.push('- ' + f.sourceName + ' [' + f.sourceId + '] defeats ' +
                    f.functionCount + ' functions:');
                f.targets.forEach(t =>
                    lines.push('   - ' + t.elementName + ' · ' + t.functionName + ' · ' + t.name));
            });
            lines.push('');
        }
    }

    function openExport(project, analysis) {
        const lines = [];
        lines.push('# ' + (project.name || 'Untitled project'));
        lines.push('Generated by Functional Analysis Studio (FAS) v' +
                   (CONFIG.appVersion || '?'));

        const isEta   = analysis && analysis.mode === 'ETA';
        const isFmeda = project.mode === 'FMEDA';
        if (isFmeda) {
            _fmedaReportLines(lines, project);
        } else if (isEta) {
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
