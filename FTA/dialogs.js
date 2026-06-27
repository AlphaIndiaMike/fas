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

    function _eventOptions(project, selectedId, excludeIds) {
        const ex = new Set(excludeIds || []);
        return project.events
            .filter(e => !ex.has(e.id))
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
        // Multi-function create: when ADDING a failure mode in FMEDA, let the
        // user pick several functions at once — one independent copy is made
        // in each. Editing stays single (a mode lives in one function).
        const multiCreate = isFmeda && !existing;

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

        // FTA/ETA still pick a grouping box. FMEDA picks the owning FUNCTION
        // so a new failure mode can be steered onto a specific low-level
        // function (rather than landing on whatever element opened the
        // editor — often a read-only mid-level one). The pickList writes its
        // value into a hidden input with id "fGroup", so the save path
        // (which reads #fGroup) is
        // unchanged; selecting a different function re-renders the editable /
        // derived body below.
        const ownerField = isFmeda
            ? _field(existing ? 'Function(s)' : 'Function',
                picklist.create({ id: 'fGroup', items: _functionPickItems(p),
                            selected: e.groupId ? [e.groupId] : [], multi: true,
                            placeholder: 'Search functions…' }),
                existing
                    ? 'The function this failure mode belongs to. It stays in the first function selected; selecting additional functions places an independent copy in each. A low-level function holds editable leaf modes; a top/mid function holds derived effects.'
                    : 'The function this failure mode belongs to. Selecting more than one places an independent copy in each. A low-level function holds editable leaf modes; a top/mid function holds derived effects.')
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
            // The body follows the chosen function's level: a neutral prompt
            // until one is picked, editable inputs for a LOW/MITIGATION function,
            // the derived note for a TOP/MID one. (A new mode opens with nothing
            // pre-selected — see the function picker — so it starts neutral.)
            const flexE = e;
            body = `
                ${_errBox()}
                ${nameField}
                ${kindField}
                ${ownerField}
                <div id="fmedaFlex">${_fmedaFlexHtml(p, flexE, existing)}</div>
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
            if (multiCreate) {
                // Multi-select. The editable FIT/DC/mitigation inputs appear ONLY
                // when at least one chosen function is a LEAF (low-level or
                // mitigation); when every chosen function is derived (top/mid) the
                // inputs are hidden (a derived effect takes its rate and DC from
                // the modes below); and with nothing chosen the body is a neutral
                // prompt. The body is rebuilt only when that STATE changes, so
                // values typed while a leaf stays selected are never discarded.
                // SAVE replicates the spec into every chosen function regardless
                // of which one the preview is anchored to, so re-anchoring the
                // preview here cannot affect the result.
                let _specState = _fmedaSpecState(p, e.groupId);
                picklist.wire('fGroup', () => {
                    const ids     = picklist.values('fGroup');
                    const leafIds = ids.filter(id => _fmedaSpecState(p, id) === 'leaf');
                    const st = !ids.length ? 'none' : (leafIds.length ? 'leaf' : 'derived');
                    if (st === _specState) return;     // no change → preserve typed values
                    _specState = st;
                    const flex = document.getElementById('fmedaFlex');
                    if (!flex) return;
                    e.groupId = st === 'leaf' ? leafIds[0]
                              : st === 'derived' ? ids[0]
                              : null;                  // anchor the preview to the choice
                    flex.innerHTML = _fmedaFlexHtml(p, e, existing);
                    if (st === 'leaf') _wireProbSection(p, e);
                });
                if (_specState === 'leaf') _wireProbSection(p, e);
            } else {
                // Edit: the picker is multi too. The failure mode stays in the
                // FIRST selected function (its home); any additional selections
                // spawn independent copies on save. Rebuild the editable/derived
                // body when the HOME function's level changes (a move).
                picklist.wire('fGroup', () => {
                    const home = picklist.values('fGroup')[0] || e.groupId;
                    if (home === e.groupId) return;
                    e.groupId = home;
                    const flex = document.getElementById('fmedaFlex');
                    if (flex) flex.innerHTML = _fmedaFlexHtml(p, e, existing);
                    if (_fmedaSpecState(p, e.groupId) === 'leaf') _wireProbSection(p, e);
                });
                if (_fmedaSpecState(p, e.groupId) === 'leaf') _wireProbSection(p, e);
            }
        } else {
            _wireProbSection(p, e);
        }
    }

    /* The level-dependent FMEDA body: error-specification (probability chooser
       or the read-only derived summary) plus the mitigation field (or, for a
       derived effect, an explanatory note and a hidden mitigation carrier).
       Rebuilt whenever the owning function — and therefore the level — changes. */
    function _fmedaFlexHtml(p, e, existing) {
        const state = _fmedaSpecState(p, e.groupId);
        // No function chosen yet → a neutral prompt with NO rate/coverage inputs.
        // The editor must not open pre-filled with detail fields (that belongs to
        // a LOW/MITIGATION function only), nor show an empty note box. The hidden
        // mitigation carrier keeps the save path stable.
        if (state === 'none') {
            return `
                <div class="dlg-note dlg-note--flush">Choose the function this
                    failure mode belongs to (above). A <strong>low-level</strong>
                    or <strong>mitigation</strong> function takes an editable
                    failure rate and diagnostic coverage; a
                    <strong>top/mid</strong> function shows a derived effect
                    computed from the lower-level modes.</div>
                <input type="hidden" id="fMitigation" value="${fmt.escHtml(e.mitigation || '')}">`;
        }
        const isDerived = (state === 'derived') ? _fmedaDerivedLevel(p, e.groupId) : '';
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
            : _probSectionHtml(p, e, 'fmedaInput');
        // λ_S is no longer entered as an absolute rate — it is DERIVED from the
        // dangerous fraction inside the input block (λ_S = λ_mode × (1 − d)) and
        // shown in the live readout. A datasheet that gives λ_S directly is
        // entered via base λ = λ_D + λ_S and dangerous = λ_D/(λ_D+λ_S) (see the
        // "from a datasheet" helper).
        const espHelp = isDerived ? '' : ' ' + _help('datasheet');
        // A LEAF (LL / M) that the failure net feeds gets a read-only
        // "incoming from below" panel. The entered rate adds ON TOP of it.
        const incoming = isDerived ? '' : _incomingHtml(p, existing);
        return `
            <div class="dlg-label">Error specification${espHelp}</div>
            <div id="probSection">${probInner}</div>
            ${incoming}
            ${detailField}`;
    }

    /* Read-only "Incoming from below" panel for a LEAF failure mode that the
       failure net feeds (an LL fed by another LL, or by a Mitigation M). The
       composition is ADDITIVE: total residual = the rate entered above PLUS
       this incoming. Hidden when nothing feeds the mode (the common case, so
       a plain leaf editor is unchanged). MAL/TAL use _derivedProbHtml instead
       — they have no own rate, so they show the pure composition there. */
    function _incomingHtml(p, existing) {
        if (!existing) return '';
        const incoming = p.failIncoming(existing.id);
        if (!incoming.length) return '';
        const own       = p.fmedaResidualFit(existing);
        const total     = p.fmedaPropagatedResidual(existing.id);
        const incomeFit = Math.max(0, total - own);
        const gate      = p.failGateOf(existing.id);
        const rows = incoming.map(ed => {
            const src  = p.eventById(ed.from);
            const isM  = p.isMitigationFailure(ed.from);
            const el   = src && src.groupId ? p.elementOf(src.groupId) : null;
            const where = el ? el.name : '';
            const fit  = p.fmedaPropagatedResidual(ed.from);
            return `<div class="dlg-ro-row"><span>${fmt.escHtml(src ? src.name : '?')}` +
                   `${isM ? ' <strong>· M</strong>' : ''}` +
                   `${where ? ' · ' + fmt.escHtml(where) : ''}</span>` +
                   `<strong>${fmt.fitStr(fit)}</strong></div>`;
        }).join('');
        const gateNote = incoming.length > 1
            ? ` Combined by the <strong>${gate}</strong> convergence gate.` : '';
        return `
            <div class="dlg-label dlg-label--gap">Incoming from below
                (${incoming.length})</div>
            <div class="dlg-readonly">
                ${rows}
                <div class="dlg-ro-row dlg-ro-row--divider">
                    <span>Incoming total λ<sub>DU</sub></span><strong>${fmt.fitStr(incomeFit)}</strong></div>
                <div class="dlg-note">Your entered rate is
                    <strong>added on top</strong> of this.${gateNote} Total residual
                    for this failure = your rate + incoming
                    = <strong>${fmt.fitStr(total)}</strong>.</div>
            </div>`;
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

    /* Which error-specification body to render for a failure mode whose owning
       function is `groupId`:
         'none'    — no function chosen yet (or it resolves to no element). The
                     editor shows a neutral prompt with NO rate/coverage inputs,
                     so it never opens pre-filled with detail fields the user did
                     not ask for, and never renders an empty note box.
         'derived' — owned by a TOP/MID (systematic) element: read-only, its rate
                     and coverage come from the modes below through the fail net.
         'leaf'    — owned by a LOW element or a MITIGATION: editable FMD / DC /
                     mitigation inputs.
       This is the single classifier the FM editor uses to decide between a blank
       prompt, the derived note, and the editable inputs. */
    function _fmedaSpecState(p, groupId) {
        if (!groupId) return 'none';
        const el = p.elementOf(groupId);
        if (!el || el.kind !== 'element') return 'none';
        const lvl = el.level || '';
        return (lvl === 'top' || lvl === 'mid') ? 'derived' : 'leaf';
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
        // Single active-lens band (no "SIL / ASIL" pair — that false
        // equivalence is avoided everywhere the tool reports integrity).
        // METRIC-GATED under ISO (from the leaves feeding this effect), so it
        // agrees with the function/system instead of a rate-only ASIL B.
        const band = p.fmedaModeBand(existing.id, p.standard !== 'IEC61508');
        if (!(raw > 0)) {
            return `<div class="dlg-note">No contributing failure modes are
                linked to this effect yet. Link the lower-level failure modes
                that lead to it on the failure network; its failure rate and
                diagnostic coverage follow from them.</div>`;
        }
        // Name the actual contributing causes so the user knows EXACTLY which
        // leaf to edit — the values here are inherited, never entered here.
        const causes = p.failIncoming(existing.id).map(ed => {
            const c = p.eventById(ed.from);
            const owner = c && c.groupId ? p.elementOf(c.groupId) : null;
            return c
                ? `<li>${fmt.escHtml(c.name)} <span class="dlg-cause-id">${fmt.escHtml(c.id)}</span>` +
                  (owner ? ` <span class="dlg-cause-el">in ${fmt.escHtml(owner.name)}</span>` : '') + `</li>`
                : `<li>${fmt.escHtml(ed.from)}</li>`;
        });
        const causeBlock = causes.length
            ? `<div class="dlg-label">Caused by — edit these to change the numbers</div>
               <ul class="dlg-cause-list">${causes.join('')}</ul>`
            : '';
        return `
            <div class="dlg-readonly">
                <div class="dlg-ro-row"><span>Incoming rate (before mitigation)</span><strong>${fmt.fitStr(raw)}</strong></div>
                <div class="dlg-ro-row"><span>Residual rate</span><strong>${fmt.fitStr(res)}</strong></div>
                <div class="dlg-ro-row"><span>Diagnostic coverage</span><strong>${Math.round(dc * 100)}%</strong></div>
                <div class="dlg-ro-row"><span>Achieved integrity</span><strong>${fmt.pfhDualStr(pfh)} · ${band}</strong></div>
                <div class="dlg-note">Derived effect — these figures are <em>inherited</em>
                    from the contributing lower-level (leaf) failure modes through
                    the failure net; they are <strong>not entered here</strong>. To change
                    them, edit the leaf failure mode(s) below and strengthen their
                    diagnostics.</div>
            </div>
            ${causeBlock}`;
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
            diagnosticCoverageLatent: d.diagnosticCoverageLatent || 0,
            failureRateSafe:     d.failureRateSafe || 0,
            diagnosticEvidence:  '',
            target:              null
        };
    }

    function _probSectionHtml(project, e, helpTopic) {
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
        // FMEDA: a failure mode is specified by its authoring PRIMITIVES —
        // base λ (FIT), failure-mode distribution (FMD %), dangerous fraction
        // (%), and the two diagnostic coverages (DC₁ %, DC₂ %). The engine
        // derives λ_D, λ_S, λ_DD and λ_DU from these, so there is one source of
        // truth and nothing to disagree. The FTA-style "probability of failure
        // (%)" / "per hour (PFH)" choices are NOT FMEDA inputs and are not
        // offered. The hidden fInputChoice keeps probMode = coverage on the
        // existing save path. A failure mode with no primitives yet (legacy
        // direct/rate or an absolute λ_D from ≤2.2.x) is shown pre-derived for
        // review; the live project is never mutated on open, only on Save.
        if (project.mode === 'FMEDA') {
            const eP       = _fmedaAsPrimitives(project, e);
            const note = `<div class="dlg-note">The failure rate is set on the
                <strong>element</strong> (its datasheet λ); this failure mode
                inherits it and takes its <strong>FMD</strong> share.</div>`;
            return `
                <input type="hidden" id="fInputChoice" value="coverage">
                <div class="dlg-label">Failure mode — share &amp; diagnostic ${_help('fmedaInput')}</div>
                ${note}
                <div id="fModeBody">${_fmedaInputBodyHtml(eP, project)}</div>`;
        }
        // A single dropdown chooses HOW the failure is specified. This
        // replaces the old "input mode" radios + a separate UNIT chip group,
        // which overlapped (e.g. direct+FIT vs rate) and caused confusion.
        // Each choice maps cleanly to the stored (probMode, directUnit):
        //   pfd      -> direct / PFD   (percentage field)
        //   pfh      -> direct / PFH   (per-hour rate)
        //   fit      -> rate           (FIT)
        //   coverage -> coverage       (FIT dangerous + diagnostic coverage)
        const topic = helpTopic || 'probMode';
        const sel = _inputChoiceOf(e);
        const choices = [
            { v: 'pfd',      label: 'Probability of failure (%)' },
            { v: 'pfh',      label: 'Probability per hour (PFH)' },
            { v: 'fit',      label: 'Failure rate (FIT)' },
            { v: 'coverage', label: 'Failure rate (FIT) + diagnostic coverage' }
        ].map(o => `<option value="${o.v}" ${o.v === sel ? 'selected' : ''}>${o.label}</option>`).join('');

        return `
            ${_field('How is this failure specified? ' + _help(topic),
                `<select class="dlg-inp" id="fInputChoice">${choices}</select>`,
                'Pick the kind of value you have; the fields below adapt. ' +
                'For FMEDA the natural choice is <em>Failure rate (FIT) + diagnostic ' +
                'coverage</em>: enter λ_D and DC, and the residual λ_DU follows.')}

            <div id="fModeBody">
                ${_modeBodyHtml(e)}
            </div>
        `;
    }

    /* Build a PRIMITIVE view of a failure mode for the FMEDA editor, WITHOUT
       mutating the original (which, when editing, IS the live project event).
       If the mode already carries primitives they pass through; otherwise the
       stored λ_D / λ_S (coverage) or the legacy direct/rate value is mapped to
       base λ = λ_D + λ_S, FMD = 100 %, dangerous = λ_D / (λ_D + λ_S). This
       preserves λ_D and λ_S exactly; the conversion is persisted only on Save. */
    function _fmedaAsPrimitives(project, e) {
        if (e.lambdaBase != null) return e;
        const v = Object.assign({}, e, { probMode: 'coverage' });
        let lamD = 0, lamS = 0;
        if (e.probMode === 'coverage') {
            lamD = Math.max(0, +e.failureRateRaw || 0);
            lamS = Math.max(0, +e.failureRateSafe || 0);
        } else if (e.probMode === 'rate') {
            lamD = Math.max(0, +e.failureRate || 0);
        } else if (e.probMode === 'direct') {
            const t = e.missionTimeOverride || project.missionTime || 1;
            if (e.directUnit === 'PFH')      lamD = Math.max(0, +e.probability || 0) * 1e9;
            else if (e.directUnit === 'FIT') lamD = Math.max(0, +e.probability || 0);
            else {   // PFD → equivalent constant rate over the mission, in FIT
                const pfd = Math.min(1, Math.max(0, +e.probability || 0));
                lamD = (pfd < 1 && t > 0) ? (-Math.log(1 - pfd) / t) * 1e9 : 0;
            }
        }
        const lamMode = lamD + lamS;
        v.lambdaBase        = lamMode;
        v.fmd               = 1;
        v.dangerousFraction = lamMode > 0 ? lamD / lamMode : 1;
        v.diagnosticCoverage = +e.diagnosticCoverage || 0;
        return v;
    }

    /* The FMEDA failure-mode input block. Only the two inputs that always
       matter — the base rate λ and the diagnostic coverage DC₁ — are shown up
       front; everything else (the dangerous split, mode share, latent coverage,
       mission time) is folded into an optional "refine the assumptions" drawer.
       A beginner can enter λ + DC₁ and get a usable, conservative model; an
       expert opens the drawer to refine. The rate can be entered in FIT or per
       hour (PFH) — handy for a subsystem quoted as a PFH. Each field's full
       explanation lives behind its (?) help. The live readout (#fLive) shows
       every derived quantity, and a one-line summary states the assumptions in
       force while the drawer is closed. */
    function _fmedaInputBodyHtml(e, project) {
        const pct = (id, frac) =>
            `<div class="dlg-affix-wrap">` +
            `<input class="dlg-inp" id="${id}" type="number" min="0" max="100" step="0.001" ` +
            `data-pct="1" value="${fmt.pctInputVal(frac)}"><span class="dlg-affix">%</span></div>`;
        const fmd  = e.fmd != null ? e.fmd : 1;
        const dang = e.dangerousFraction != null ? e.dangerousFraction : 1;
        const dc1  = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
        const dc2  = fmt.clamp(e.diagnosticCoverageLatent, 0, 1, 0);
        // The rate is INHERITED from the element (its datasheet λ); this mode
        // takes its FMD share. So the FM editor edits FMD + the dangerous split
        // + diagnostic coverage — never a per-mode rate.
        const el    = project ? project.elementOf(e.groupId) : null;
        const isMit = project && el ? project.isMitigationElement(el) : false;
        const elLam = project && el ? project.elementLambdaFit(el) : 0;
        const elName = el ? el.name : 'its element';
        const lamNote = !el
            ? 'Choose the function this failure mode belongs to (above); it inherits that element\u2019s λ and takes its FMD share.'
            : (elLam > 0
                ? `Inherits λ = <strong>${fmt.fitStr(elLam)}</strong> from <em>${fmt.escHtml(elName)}</em>; this mode takes its FMD share below.`
                : `<em>${fmt.escHtml(elName)}</em> has no base failure rate λ yet — set it on the element, or this mode computes 0 FIT.`);
        const dcLabel = isMit
            ? 'Coverage of incoming, DC ' + _help('mitigationLayer')
            : 'Diagnostic coverage, DC\u2081 ' + _help('coverage');
        const selfChk = isMit
            ? `<label class="dlg-check"><input type="checkbox" id="fCovSelf"${e.coverageIncludesSelf ? ' checked' : ''}> Coverage includes self-diagnostic ${_help('selfDiagnostic')}</label>`
            : '';
        return `
            <div class="dlg-note dlg-note--flush">${lamNote}</div>
            <div class="dlg-row">
                ${_field('Share of element\u2019s λ — FMD ' + _help('fmd'),
                    pct('fFmd', fmd))}
                ${_field(dcLabel, pct('fDC', dc1))}
            </div>
            ${selfChk}
            <details class="dlg-drawer" id="fAdvDrawer">
                <summary class="dlg-drawer-sum">Refine the assumptions</summary>
                <div class="dlg-drawer-body">
                    <div class="dlg-row">
                        ${_field('Dangerous fraction ' + _help('dangerousFraction'),
                            pct('fDangerous', dang))}
                        ${_field('Latent-fault coverage, DC₂ ' + _help('latentCoverage'),
                            pct('fDCL', dc2))}
                    </div>
                    <div class="dlg-row">
                        ${_field('Mission time override (h) ' + _help('missionTime'),
                            `<input class="dlg-inp" id="fMtO" type="number" min="0" step="any" value="${e.missionTimeOverride != null ? e.missionTimeOverride : ''}">`)}
                    </div>
                </div>
            </details>
            <div class="dlg-note dlg-note--flush" id="fAssume"></div>
            <div class="dlg-note" id="fLive"></div>`;
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
                        '1 FIT = 1 failure per 10⁹ hours. Example: 60 FIT. ' +
                        'No diagnostic credit is taken in this mode (treated as ' +
                        'fully undetected); use the coverage mode to credit a DC. ' + _help('units'))}
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
                        'do not enter the total failure rate. Example: a µC core ' +
                        'with λ_D ≈ 120 FIT.')}
                    ${_field('Diagnostic coverage, DC₁',
                        `<input class="dlg-inp" id="fDC" type="number" min="0" max="1" step="0.001" value="${e.diagnosticCoverage}">`,
                        'Primary diagnostic coverage — fraction of the dangerous rate detected by the safety mechanism (0–1). Drives the residual and SFF. Example: 0.9 = 90 % (single CRC / BIST); 0.99 = E2E. ' + _help('coverage'))}
                    ${_field('Latent-fault coverage, DC₂',
                        `<input class="dlg-inp" id="fDCL" type="number" min="0" max="1" step="0.001" value="${e.diagnosticCoverageLatent != null ? e.diagnosticCoverageLatent : 0}">`,
                        'ISO 26262 latent-fault coverage — fraction of the detected (multiple-point) faults whose latency is itself revealed (0–1). Drives λ_MPF,latent and the LFM. Example: 0.6 for a periodic test; leave 0 if there is no latent-fault check.')}
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
            <div class="dlg-label dlg-label--gap">
                Safety target ${_help('target')}
            </div>
            <div class="dlg-note dlg-note--flush">
                Pick the SIL or ASIL the top event must achieve. On Recalculate
                the tool compares the computed PFH against this target's bound
                and shows met / missed.
            </div>
            <select class="dlg-inp" id="fTarget">
                ${noneOpt}${opts}
            </select>
        `;
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
        // FMEDA base-rate unit toggle (FIT ⇄ /h): convert the shown value in
        // place so the stored FIT is unchanged, then refresh the readout.
        const unitSel = document.getElementById('fLambdaUnit');
        const lamB    = document.getElementById('fLambdaBase');
        if (unitSel && lamB) {
            unitSel.addEventListener('change', () => {
                const v = +lamB.value || 0;
                if (unitSel.value === 'ph' && unitSel.dataset.prev !== 'ph') {
                    lamB.value = v * 1e-9;            // FIT → /h
                } else if (unitSel.value === 'fit' && unitSel.dataset.prev === 'ph') {
                    lamB.value = v * 1e9;             // /h → FIT
                }
                unitSel.dataset.prev = unitSel.value;
                _liveUpdate(project, e);
            });
            unitSel.dataset.prev = unitSel.value;
        }
        _liveUpdate(project, e);
    }

    function _liveUpdate(project, eOrig) {
        const live = document.getElementById('fLive');
        if (!live) return;
        const e = _readDraft(eOrig);
        if (e.kind !== 'basic') { live.textContent = ''; return; }
        const t = e.missionTimeOverride || project.missionTime;
        // FMEDA: show the full derived chain from the primitives so the
        // computation is visible and traceable (qualification aid).
        if (project.mode === 'FMEDA' && e.probMode === 'coverage') {
            // The rate is inherited from the element (its datasheet λ); this
            // mode takes its FMD share.
            const el   = project.elementOf(e.groupId);
            const base = project.elementLambdaFit(el);
            const isMit = el ? project.isMitigationElement(el) : false;
            const fmd  = fmt.clamp(e.fmd, 0, 1, 1);
            const dang = fmt.clamp(e.dangerousFraction, 0, 1, 1);
            const dc1  = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
            const dc2  = fmt.clamp(e.diagnosticCoverageLatent, 0, 1, 0);
            const assume = document.getElementById('fAssume');
            if (assume) {
                const a = [];
                if (dang === 1)  a.push('all failures dangerous (100%)');
                if (!isMit && dc1 === 0) a.push('no diagnostic coverage');
                if (dc2  === 0)  a.push('no latent-fault check');
                if (fmd  === 1)  a.push('this mode is the element\u2019s whole λ (FMD 100%)');
                assume.innerHTML = a.length
                    ? 'Assuming: ' + a.join(', ') + '. Refine in the drawer.'
                    : '';
            }
            const lamMode = base * fmd;
            const lamD = lamMode * dang, lamS = lamMode * (1 - dang);
            // A MITIGATION mode: its coverage reduces the INCOMING rate (shown
            // per effect in the right pane), not its own — so the per-mode trace
            // shows its own contribution and how the coverage acts.
            if (isMit) {
                live.innerHTML =
                    'own λ<sub>D</sub> = <strong>' + fmt.fitStr(lamD) + '</strong>' +
                    (base > 0 ? '' : ' (set the element\u2019s λ)') +
                    '<br>this mitigation reduces the <em>incoming</em> rate by DC = <strong>' + Math.round(dc1 * 100) + '%</strong>' +
                    '<br>its own rate is added' + (e.coverageIncludesSelf ? ' and also reduced (self-diagnostic)' : ' in full (not self-diagnostic)') +
                    '. The residual is shown per effect in the results panel.';
                return;
            }
            const lamDD = lamD * dc1,   lamDU = lamD * (1 - dc1);
            const pfh = lamDU * 1e-9;
            const lamTot   = lamMode;                 // λD + λS for this mode
            const hasSM    = dc1 > 0;
            const lamSPF   = hasSM ? 0 : lamD;
            const lamRF    = hasSM ? lamD * (1 - dc1) : 0;
            const spfm     = lamTot > 0 ? 1 - (lamSPF + lamRF) / lamTot : null;
            const mpfBase  = lamTot - lamRF;
            const lamMPFl  = lamD * dc1 * (1 - dc2);
            const lfm      = mpfBase > 0 ? 1 - lamMPFl / mpfBase : null;
            const pc = x => (x == null ? '—' : Math.round(x * 100) + '%');
            const isoLens = (project.standard !== 'IEC61508');
            const rawBand = isoLens ? fmt.asilFromMetrics(pfh, spfm, lfm) : fmt.silForPfh(pfh);
            // A failure mode can never out-rank the element that realises its
            // function (ARCHITECTURE.md): cap the read-out to the element band —
            // the SAME ceiling the results panel and fmedaModeBand apply — so the
            // drawer can't show a SIL-4 mode sitting on a SIL-1 element.
            const elOfMode = project.elementOfMode(e.id);
            const band = elOfMode ? project.fmedaCapBandToElement(rawBand, elOfMode.id, isoLens) : rawBand;
            const capped = (band !== rawBand);
            const star = (band === 'ASIL A') ? '*' : '';
            live.innerHTML =
                'λ<sub>mode</sub> = ' + fmt.fitStr(lamMode) +
                ' · λ<sub>D</sub> = ' + fmt.fitStr(lamD) +
                ' · λ<sub>S</sub> = ' + fmt.fitStr(lamS) +
                '<br>λ<sub>DD</sub> = ' + fmt.fitStr(lamDD) +
                ' · residual λ<sub>DU</sub> = <strong>' + fmt.fitStr(lamDU) + '</strong>' +
                ' · PFH = ' + fmt.perHourStr(pfh) +
                '<br>DC₁ → SPFM = <strong>' + pc(spfm) + '</strong> · DC₂ → LFM = <strong>' + pc(lfm) + '</strong>' +
                '<br>residual reaches <strong>' + band + star + '</strong>' +
                (capped
                    ? ' — the rate alone would be ' + rawBand + ', capped to the element\u2019s band'
                    : ' (rolled up to its function / element)');
            return;
        }
        // FTA/ETA: PFD / PFH from the chosen mode.
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
        const safe    = document.getElementById('fSafe');
        // FMEDA authoring primitives (the % fields carry data-pct="1").
        const lamB    = document.getElementById('fLambdaBase');
        const fmdEl   = document.getElementById('fFmd');
        const dangEl  = document.getElementById('fDangerous');
        const asFrac  = el => (el.dataset.pct === '1') ? (+el.value / 100) : +el.value;
        if (prob) {
            // When the field is a percentage (PFD unit), convert back to a
            // [0,1] fraction so the engine and storage are unchanged: the
            // user's "10" becomes 0.10. data-pct is set by _modeBodyHtml.
            const raw = +prob.value;
            draft.probability = (prob.dataset.pct === '1') ? raw / 100 : raw;
        }
        if (rate)    draft.failureRate        = +rate.value;
        if (rateRaw) draft.failureRateRaw     = +rateRaw.value;
        if (lamB) {
            // λ is stored in FIT. If the user is entering it as a per-hour rate
            // (PFH), convert: 1 FIT = 1e-9 /h. The chosen unit is remembered so
            // the field reopens in the same unit.
            const unitSel = document.getElementById('fLambdaUnit');
            const unit = unitSel ? unitSel.value : 'fit';
            draft.lambdaUnit = (unit === 'ph') ? 'ph' : 'fit';
            draft.lambdaBase = (unit === 'ph') ? (+lamB.value || 0) * 1e9 : +lamB.value;
        }
        if (fmdEl)   draft.fmd                = asFrac(fmdEl);
        // A blank dangerous fraction is NOT read as 0 (that would mean "all safe"
        // — a flattering assumption). It defaults to 100 % (all dangerous, the
        // conservative worst case), which is also the value a new mode shows.
        if (dangEl)  draft.dangerousFraction  = (String(dangEl.value).trim() === '') ? 1 : asFrac(dangEl);
        // DC fields are percents in the FMEDA editor (data-pct), plain 0–1 in
        // the FTA/ETA coverage chooser. asFrac honours both.
        if (dc)      draft.diagnosticCoverage = asFrac(dc);
        if (dcl)     draft.diagnosticCoverageLatent = asFrac(dcl);
        if (safe)    draft.failureRateSafe = +safe.value;
        if (mtO)     draft.missionTimeOverride = mtO.value === '' ? null : +mtO.value;
        if (evid)    draft.diagnosticEvidence = evid.value;
        const mit = document.getElementById('fMitigation');
        if (mit) draft.mitigation = mit.value;
        const covSelf = document.getElementById('fCovSelf');
        if (covSelf) draft.coverageIncludesSelf = covSelf.checked;

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
        // ── No silent FLATTERING zero. A blank rate-bearing field whose absence
        // would UNDERSTATE the danger (a base rate, a dangerous λ_D, a probability,
        // or an FMD share) is rejected, never read as 0 — but 0 is a perfectly
        // valid value to TYPE (e.g. a failure mode that takes no share, or a
        // completely-safe mode), so only an empty field is flagged. Fields with a
        // safe conservative default are NOT here: a blank dangerous fraction
        // defaults to 100 % (all dangerous — the worst case, set in _readDraft),
        // and a blank diagnostic coverage means "no credit" (0). Only the fields
        // actually present in the current input mode are checked; one inside a
        // collapsed drawer is revealed so the user is not left hunting.
        {
            const _isBlank = id => { const el = document.getElementById(id); return !!el && String(el.value).trim() === ''; };
            const _reveal = id => {
                const el = document.getElementById(id);
                const dr = el && el.closest && el.closest('details.dlg-drawer');
                if (dr) dr.open = true;
            };
            const _required = [
                ['fProb',    'Enter a probability of failure — a blank field is not assumed to be zero.'],
                ['fRate',    'Enter a failure rate λ (FIT) — a blank field is not assumed to be zero.'],
                ['fRateRaw', 'Enter a dangerous failure rate λ_D (FIT) — a blank field is not assumed to be zero.'],
                ['fFmd',     'Enter the failure-mode distribution (FMD) — a blank field is not assumed to be zero. Type 0 if this mode takes no share of the element\u2019s λ.'],
            ];
            for (const [id, msg] of _required) {
                if (_isBlank(id)) { _reveal(id); _err(msg); return; }
            }
        }
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
                // FMEDA primitive path: validate base λ and the fractions.
                if (draft.lambdaBase != null) {
                    if (+draft.lambdaBase < 0) { _err('Base failure rate λ must be ≥ 0.'); return; }
                    if (draft.fmd < 0 || draft.fmd > 1) { _err('FMD must be between 0 % and 100 %.'); return; }
                    if (draft.dangerousFraction < 0 || draft.dangerousFraction > 1) {
                        _err('Dangerous fraction must be between 0 % and 100 %.'); return;
                    }
                } else if (draft.failureRateRaw < 0) {
                    _err('λ dangerous must be ≥ 0.'); return;
                }
                if (draft.diagnosticCoverage < 0 || draft.diagnosticCoverage > 1) {
                    _err('Diagnostic coverage must be between 0 % and 100 %.'); return;
                }
                if (draft.diagnosticCoverageLatent < 0 || draft.diagnosticCoverageLatent > 1) {
                    _err('Latent-fault coverage must be between 0 % and 100 %.'); return;
                }
            }
        }
        // Derive the λ_D / λ_S mirror from the primitives (when present) so the
        // stored failureRateRaw/failureRateSafe always agree with the dangerous
        // fraction and stay readable by ≤2.2.x builds. The current engine reads
        // the primitives directly, so the mirror can never affect the result.
        let mirrorRaw  = draft.failureRateRaw;
        let mirrorSafe = draft.failureRateSafe != null ? Math.max(0, +draft.failureRateSafe || 0) : 0;
        let primBase = null, primFmd = null, primDang = null;
        if (draft.probMode === 'coverage' && draft.lambdaBase != null) {
            primBase = Math.max(0, +draft.lambdaBase || 0);
            primFmd  = fmt.clamp(draft.fmd, 0, 1, 1);
            primDang = fmt.clamp(draft.dangerousFraction, 0, 1, 1);
            const lamMode = primBase * primFmd;
            mirrorRaw  = lamMode * primDang;
            mirrorSafe = lamMode * (1 - primDang);
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
            failureRateRaw:      mirrorRaw,
            lambdaBase:          primBase,
            fmd:                 primFmd,
            dangerousFraction:   primDang,
            diagnosticCoverage:  draft.diagnosticCoverage,
            diagnosticCoverageLatent: draft.diagnosticCoverageLatent != null ? draft.diagnosticCoverageLatent : 0,
            failureRateSafe:     mirrorSafe,
            diagnosticEvidence:  draft.diagnosticEvidence || '',
            mitigation:          draft.mitigation || '',
            x:                   draft.x, y: draft.y,
            // Target only meaningful on top — clear on others so
            // demoting a top doesn't leave stale data.
            target:              draft.kind === 'top' ? (draft.target || null) : null
        };
        const p = api.getProject();
        if (p.mode === 'FMEDA') {
            // Layered model: a failure mode carries NO own rate — it inherits the
            // element's λ and takes its FMD share. Store FMD / dangerous fraction
            // / coverages (and the mitigation self-diagnostic flag); clear the
            // per-mode λ and its vestigial λ_D/λ_S mirror.
            patch.lambdaBase = null;
            patch.fmd = fmt.clamp(draft.fmd, 0, 1, 1);
            patch.dangerousFraction = fmt.clamp(draft.dangerousFraction, 0, 1, 1);
            patch.failureRateRaw = 0;
            patch.failureRateSafe = 0;
            patch.coverageIncludesSelf = !!draft.coverageIncludesSelf;
        }
        if (p.mode === 'FMEDA') {
            // FMEDA failure mode: the function picker is multi for both create
            // and edit. CREATE makes an independent copy in each chosen function.
            // EDIT keeps the mode in the first chosen function and spawns a copy
            // into each additional one.
            const fnIds = picklist.values('fGroup');
            if (!fnIds.length) { _err('Choose the function this failure mode belongs to (pick one or more above).'); return; }
            const { groupId, ...spec } = patch;
            if (existing) {
                api.applyEventSpawn(existing.id, spec, fnIds);
            } else if (fnIds.length === 1) {
                api.applyEventCreate(Object.assign({}, spec, { groupId: fnIds[0] }));
            } else {
                api.applyEventCreateMulti(spec, fnIds);
            }
            modal.close();
            return;
        }
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
            <div class="dlg-label dlg-label--gap-sm">
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

    /* The searchable single/multi select that used to live here (_pickList
       and friends) now lives in its own shared primitive, picklist.js, and
       is reached through the module API: picklist.create / .wire / .value /
       .values. See that file for the full contract. */


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
            html = `<div class="ctrl-empty">${filter ? 'No matches.' : 'No selectable events.'}</div>`;
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
            mitigation: !!(draft && draft.mitigation),
            parentId: draft && draft.parentId ? draft.parentId : null
        };
        const isMitigation = !!(g.kind === 'element' && g.mitigation);

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

        // FMEDA-specific fields. For an element: which abstraction layer.
        // For a function: which parent element it lives in. Hidden for
        // plain FTA/ETA groups (kind 'group').
        const isFmeda = p.mode === 'FMEDA' &&
                        (g.kind === 'element' || g.kind === 'function');
        let fmedaFields = '';
        if (isFmeda) fmedaFields += `<input type="hidden" id="fGroupKind" value="${g.kind}">`;
        if (isMitigation) {
            // A Mitigation is always a low-level element. Lock the level and
            // carry the flag; show what makes it special instead of the chips.
            fmedaFields += `<input type="hidden" id="fIsMitigation" value="1">`;
            fmedaFields += `<div class="dlg-note">
                <strong>Mitigation element (M).</strong> A hardware element that acts
                as a <em>diagnostic layer</em>: draw a failure-net link from each
                cause it addresses INTO one of its failure modes (cause → M), then
                set that mode's coverage. It REDUCES the incoming rate by its
                coverage; its own failure rate is added (a diagnostic can itself
                fail) and is not self-covered unless you mark the mode
                self-diagnosing.</div>`;
        } else if (isFmeda && g.kind === 'element') {
            const levels = [['top','Top level'],['mid','Mid level'],['low','Low level']];
            const opts = levels.map(([v,l]) =>
                `<label class="dlg-chip ${g.level === v ? 'dlg-chip-on' : ''}">
                    <input type="radio" name="fLevel" value="${v}" ${g.level === v ? 'checked' : ''}>
                    <span>${l}</span></label>`).join('');
            fmedaFields += `<div class="dlg-label">Abstraction layer</div>
                <div class="dlg-chips" id="fLevelChips">${opts}</div>`;
        } else if (isFmeda && g.kind === 'function') {
            // Function realisation type (v7) — HW / SW / SYS. Software is a
            // function (never a standalone element); the type is a classification
            // and does not scale the rate.
            // An EXISTING function keeps its stored type; a NEW one starts with
            // NOTHING selected, so the user must choose HW / SW / SYS (no silent
            // HW default that quietly mislabels the function).
            const curFn = (existing && ['HW','SW','SYS'].includes(g.fnType)) ? g.fnType : '';
            const fnOpts = CONFIG.fnTypes.map(t =>
                `<label class="dlg-chip ${curFn === t.value ? 'dlg-chip-on' : ''}">
                    <input type="radio" name="fFnType" value="${t.value}" ${curFn === t.value ? 'checked' : ''}>
                    <span>${fmt.escHtml(t.label)}</span></label>`).join('');
            fmedaFields += `<div class="dlg-label dlg-label--gap-sm">Function type ${_help('fnType')}</div>
                <div class="dlg-chips" id="fFnTypeChips">${fnOpts}</div>`;
            fmedaFields += _field(existing ? 'Parent element(s)' : 'Parent element',
                picklist.create({ id: 'fParent', items: _elementPickItems(p),
                            selected: (existing && g.parentId) ? [g.parentId] : [], multi: true,
                            placeholder: 'Search elements…' }),
                existing
                    ? 'The element this function belongs to. The function stays in the first element selected; selecting additional elements places an independent copy — with its failure modes — in each.'
                    : 'The element this function belongs to. Selecting more than one places an independent copy of the function in each.');
            // Copy existing failure modes into this function: reuse
            // the text and properties of failure modes defined elsewhere.
            const fmItems = _failureModePickItems(p);
            if (fmItems.length) {
                fmedaFields += _field('Copy failure modes (optional)',
                    picklist.create({ id: 'fCopyFms', items: fmItems, selected: [],
                                multi: true,
                                placeholder: 'Search failure modes to copy…' }),
                    'Duplicate the selected failure modes into this function, reusing their description and properties. Each copy is independent of the original.');
            }
        }

        // Route 1ₕ inputs for any element (element kind, incl. mitigation
        // elements): IEC 61508 element Type A/B and hardware fault tolerance.
        // Help lives behind the (?) buttons (consistent with every other
        // field), not inline.
        if (isFmeda && g.kind === 'element') {
            const isLowInit = isMitigation || g.level === 'low';
            // ── Safety capability — the PRIMARY input (help behind the (?)). A
            // declared SIL/ASIL is the element's systematic-capability ceiling and
            // pre-fills the worst-case hardware numbers below; for a subsystem /
            // system it is optional (leave blank to compute from the leaves).
            const capOpts = ['<option value="">— none —</option>'].concat(
                CONFIG.targetCombined.map(t =>
                    `<option value="${t.value}" ${g.claimedCapability === t.value ? 'selected' : ''}>${fmt.escHtml(t.label)}</option>`)
            ).join('');
            fmedaFields += _field('Safety capability (SIL / ASIL) ' + _help('subsystemClaim'),
                `<select class="dlg-inp" id="fClaimCap">${capOpts}</select>`);

            // ── Hardware details — LOW-LEVEL (hardware) elements only, in a closed
            // drawer (refinements over the declared capability). Same layout as the
            // failure-mode editor: two-column numeric inputs, help behind (?).
            const lamUnit = (g.lambdaUnit === 'ph') ? 'ph' : 'fit';
            const lamVal  = (g.lambdaBase != null)
                ? (lamUnit === 'ph' ? g.lambdaBase * 1e-9 : g.lambdaBase) : '';
            const claimSff = (g.claimedSff != null) ? fmt.pctInputVal(g.claimedSff) : '';
            const et = (g.elementType === 'A') ? 'A' : 'B';
            const typeOpts = [['A', 'Type A — simple'], ['B', 'Type B — complex / subsystem']].map(([v, l]) =>
                `<label class="dlg-chip ${et === v ? 'dlg-chip-on' : ''}">
                    <input type="radio" name="fElType" value="${v}" ${et === v ? 'checked' : ''}>
                    <span>${l}</span></label>`).join('');
            // HFT is COMPUTED from the failure-net redundancy structure (never
            // entered); show, as a live note, the value the architecture yields.
            const hftComputed = existing ? p.fmedaComputedHft(g.id) : 0;
            const hftNote = hftComputed >= 1
                ? `HFT <strong>${hftComputed}</strong> — computed from ${hftComputed + 1} independent redundant channels that AND-converge in the failure net.`
                : `HFT <strong>0</strong> — no independent redundancy detected in the failure net (read from the architecture, never entered).`;
            fmedaFields += `<div id="fHwDrawerWrap" style="${isLowInit ? '' : 'display:none'}">
                <details class="dlg-drawer" id="fHwDrawer">
                    <summary class="dlg-drawer-sum">Hardware details</summary>
                    <div class="dlg-drawer-body">
                        <div class="dlg-row">
                            ${_field('Base failure rate, λ ' + _help('elementLambda'),
                                `<div class="dlg-affix-wrap"><input class="dlg-inp" id="fElemLambda" type="number" min="0" step="any" value="${lamVal}">` +
                                `<select class="dlg-affix-sel" id="fElemLambdaUnit" title="Rate unit">` +
                                `<option value="fit" ${lamUnit === 'fit' ? 'selected' : ''}>FIT</option>` +
                                `<option value="ph" ${lamUnit === 'ph' ? 'selected' : ''}>/h (PFH)</option>` +
                                `</select></div>`)}
                            ${_field('Claimed SFF ' + _help('subsystemClaim'),
                                `<div class="dlg-affix-wrap"><input class="dlg-inp" id="fClaimSff" type="number" min="0" max="100" step="0.001" value="${claimSff}"><span class="dlg-affix">%</span></div>`)}
                        </div>
                        <div class="dlg-label dlg-label--gap-sm">Element type — IEC 61508 Route 1ₕ ${_help('elementType')}</div>
                        <div class="dlg-chips" id="fElTypeChips">${typeOpts}</div>
                        <div class="dlg-note dlg-note--flush" id="fHftNote">${hftNote}</div>
                    </div>
                </details></div>`;
        }

        modal.open((existing ? 'Edit ' : 'New ') +
            (isMitigation ? 'mitigation'
                          : (isFmeda ? (g.kind === 'element' ? 'element' : 'function') : 'group')), `
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
            <div class="dlg-label dlg-label--gap-sm">Members</div>
            <div class="dlg-hint dlg-hint--mb">
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
            ...((existing && g.kind === 'element' && g.level === 'low') ? [{
                // Flip a low-level element between an ordinary element and a
                // Mitigation, e.g. when one was added with the wrong palette
                // item. Applies the flag and closes; functions, failure modes
                // and net edges are kept.
                label: g.mitigation ? 'Convert to element' : 'Convert to mitigation',
                cls: 'btn-sec',
                onClick: () => { api.applyConvertMitigation(existing.id, !g.mitigation); modal.close(); }
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
        // Route 1ₕ Type chips + archType / fnType chips: on-state toggle.
        ['fElTypeChips', 'fFnTypeChips'].forEach(id => {
            document.querySelectorAll('#' + id + ' input').forEach(r => {
                r.addEventListener('change', () => {
                    document.querySelectorAll('#' + id + ' .dlg-chip').forEach(c =>
                        c.classList.toggle('dlg-chip-on', c.querySelector('input').checked));
                });
            });
        });
        // The hardware-details drawer applies to a LOW-LEVEL (hardware) element
        // only. Show/hide it live as the abstraction layer changes.
        const _toggleHwDrawer = () => {
            const wrap = document.getElementById('fHwDrawerWrap');
            if (!wrap) return;
            const sel = document.querySelector('input[name="fLevel"]:checked');
            const lvl = sel ? sel.value : (g.level || '');
            wrap.style.display = (lvl === 'low') ? '' : 'none';
        };
        document.querySelectorAll('#fLevelChips input').forEach(r =>
            r.addEventListener('change', _toggleHwDrawer));
        _toggleHwDrawer();
        // Selecting a safety capability pre-fills the worst-case hardware numbers
        // the standard permits for that band — but only into EMPTY fields, so an
        // entered datasheet value is never overwritten — and opens the drawer so
        // they are visible for review/override.
        const _capSel = document.getElementById('fClaimCap');
        if (_capSel) {
            const SFF_FOR_BAND = { 'ASIL A': 0.60, 'ASIL B': 0.90, 'ASIL C': 0.97, 'ASIL D': 0.99,
                                   'SIL 1': 0.60, 'SIL 2': 0.90, 'SIL 3': 0.99, 'SIL 4': 0.99 };
            _capSel.addEventListener('change', () => {
                const band = _capSel.value;
                if (!band) return;
                const lamEl = document.getElementById('fElemLambda');
                const unit  = document.getElementById('fElemLambdaUnit');
                const sffEl = document.getElementById('fClaimSff');
                const wcFit = fmt.worstCaseFitForCapability(band);
                if (lamEl && lamEl.value.trim() === '' && wcFit != null)
                    lamEl.value = (unit && unit.value === 'ph') ? (wcFit * 1e-9) : wcFit;
                if (sffEl && sffEl.value.trim() === '' && SFF_FOR_BAND[band] != null)
                    sffEl.value = fmt.pctInputVal(SFF_FOR_BAND[band]);
                const drawer = document.getElementById('fHwDrawer');
                if (drawer) drawer.open = true;
            });
        }
        picklist.wire('fParent');
        picklist.wire('fCopyFms');

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
        // FMEDA: an element must sit on an abstraction layer, and a function must
        // declare its type — neither gets a silent default, so the group is only
        // created once the user has actually chosen (the chips start empty for a
        // new group). The chip containers are present only for the relevant kind
        // (a Mitigation element shows a note instead, and is locked to low), so
        // their presence is the right gate.
        if (document.getElementById('fLevelChips') &&
            !document.querySelector('input[name="fLevel"]:checked')) {
            _err('Choose an abstraction layer (top, mid, or low) for this element.'); return;
        }
        if (document.getElementById('fFnTypeChips') &&
            !document.querySelector('input[name="fFnType"]:checked')) {
            _err('Choose the function type (HW, SW, or SYS).'); return;
        }
        const patch = { name, description: desc };
        // Color is only set when the swatch picker is present (FTA/ETA).
        // FMEDA uses semantic colors, so leave the stored color untouched.
        if (col) patch.color = col;

        // FMEDA fields, if present in the dialog.
        const kindH = document.getElementById('fGroupKind');
        if (kindH && kindH.value) patch.kind = kindH.value;
        const mitH = document.getElementById('fIsMitigation');
        if (mitH && mitH.value === '1') { patch.mitigation = true; patch.level = 'low'; }
        const levelR = document.querySelector('input[name="fLevel"]:checked');
        if (levelR) patch.level = levelR.value;
        // Element fields are LEVEL-aware: a low-level element is hardware and
        // carries the hardware details; a mid/top element is systematic and
        // carries none (it is computed from its leaves). archType is derived
        // from the level so the two never drift.
        const _isElement = (patch.kind || (existing && existing.kind)) === 'element';
        const _effLevel  = patch.level || (existing && existing.level);
        const _isLowEl   = _isElement &&
            (patch.mitigation || _effLevel === 'low' || (existing && existing.mitigation));
        if (_isElement) {
            patch.archType = (patch.mitigation || _effLevel === 'low')
                ? 'hardware'
                : ((CONFIG.archTypeByLevel[_effLevel] || {}).default || 'subsystem');
        }
        if (_isLowEl) {
            const typeR = document.querySelector('input[name="fElType"]:checked');
            if (typeR) patch.elementType = (typeR.value === 'A') ? 'A' : 'B';
            // HFT is computed from the failure-net structure — never stored.
            patch.hft = null;
            const lamElEl = document.getElementById('fElemLambda');
            if (lamElEl) {
                const unitSel = document.getElementById('fElemLambdaUnit');
                const unit = unitSel ? unitSel.value : 'fit';
                const raw = lamElEl.value.trim();
                if (raw === '') { patch.lambdaBase = null; }
                else {
                    patch.lambdaUnit = (unit === 'ph') ? 'ph' : 'fit';
                    patch.lambdaBase = Math.max(0, (unit === 'ph') ? (+raw || 0) * 1e9 : (+raw || 0));
                }
            }
            const claimSffEl = document.getElementById('fClaimSff');
            if (claimSffEl) {
                const raw = claimSffEl.value.trim();
                patch.claimedSff = (raw === '') ? null : fmt.clamp(+raw / 100, 0, 1, null);
            }
        } else if (_isElement) {
            // Systematic (mid/top) element — no hardware rate or SFF of its own.
            patch.lambdaBase = null;
            patch.claimedSff = null;
            patch.hft = null;
        }
        // Function realization type (functions only).
        const fnTypeR = document.querySelector('input[name="fFnType"]:checked');
        if (fnTypeR) patch.fnType = fnTypeR.value;
        // Safety capability — the PRIMARY element field (optional for mid/top).
        const claimCapEl = document.getElementById('fClaimCap');
        if (claimCapEl) patch.claimedCapability = claimCapEl.value || null;

        // Failure modes selected to copy into this function.
        const copyIds = picklist.values('fCopyFms');

        // A FUNCTION carries the multi parent-element picker → spawn across the
        // chosen elements: on create, one independent copy per element; on edit,
        // the function stays in the first element and an independent copy (with
        // its failure modes) is spawned into each additional one. Elements have
        // no fParent picker and fall through to the ordinary single-group path.
        const hasParentPicker = !!document.querySelector('.picklist[data-pl="fParent"]');
        if (hasParentPicker) {
            const elementIds = picklist.values('fParent');
            if (!elementIds.length) { _err('Pick at least one parent element.'); return; }
            delete patch.parentId;
            api.applyFunctionSpawn(existing ? existing.id : null, patch, elementIds, copyIds);
            modal.close();
            return;
        }

        let targetId;
        // A hardware (low-level / mitigation) element must be CHARACTERISED before
        // it is saved — its integrity cannot be established from nothing, and a
        // blank rate is never assumed to be 0. It is characterised by EITHER a
        // declared safety capability (any band, including QM — the worst case for
        // that band is taken) OR an entered base failure rate λ. A claimed SFF
        // alone is only a refinement (it carries no rate), so it does not count.
        // Mid / top elements are systematic (computed from their leaves) and need
        // no input — they are not gated here.
        if (_isLowEl) {
            const _hasRate = patch.lambdaBase != null && +patch.lambdaBase > 0;
            const _hasCap  = !!patch.claimedCapability;
            if (!_hasRate && !_hasCap) {
                // Reveal the hardware drawer so the λ field is in view — the
                // capability dropdown above is always visible — and explain both
                // ways out, concisely.
                const dr = document.getElementById('fHwDrawer');
                if (dr) dr.open = true;
                _err('This element is not characterised yet. Select a safety capability (SIL / ASIL — choose QM if it carries no safety requirement), or enter a base failure rate λ in Hardware details.');
                return;
            }
        }
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
        if (!html.trim()) html = `<div class="ctrl-empty">${filter ? 'No matches.' : 'No events defined.'}</div>`;
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
        // Read the chosen analysis type at click time (the modal DOM is gone
        // once modal.close() runs, so capture before closing).
        const pickedMode = () => {
            const sel = document.getElementById('fMode');
            const m = sel ? sel.value : 'FTA';
            return ['FTA', 'ETA', 'FMEDA'].includes(m) ? m : 'FTA';
        };
        const footer = [];
        if (typeof onDemo === 'function') {
            footer.push({
                label: 'Load Demo', cls: 'btn-sec btn-left',
                onClick: () => {
                    const m = pickedMode();
                    // FMEDA has one canonical reference: the worked brake-by-wire
                    // model that exercises every feature and is correct end-to-end.
                    modal.close(); onDemo(m);
                }
            });
        }
        footer.push({ label: 'Cancel', cls: 'btn-sec', onClick: modal.close });
        footer.push({
            label: 'Create', cls: 'btn-primary',
            onClick: () => {
                const name = document.getElementById('fName').value.trim() || 'Untitled project';
                const mt   = parseFloat(document.getElementById('fMT').value);
                const mode = pickedMode();
                if (isNaN(mt) || mt <= 0) { _err('Mission time must be a positive number.'); return; }
                onSubmit({ name, missionTime: mt, mode });
                modal.close();
            }
        });
        modal.open('New project', `
            ${_errBox()}
            ${_field('Analysis type',
                `<select class="dlg-inp" id="fMode">
                    <option value="FTA">FTA — Fault Tree Analysis</option>
                    <option value="ETA">ETA — Event Tree Analysis</option>
                    <option value="FMEDA">FMEDA — Failure Modes, Effects &amp; Diagnostics</option>
                </select>`,
                'Pick the kind of analysis. <strong>Load Demo</strong> opens a ' +
                'worked example of this type to learn from or build on; ' +
                '<strong>Create</strong> starts an empty one. You can switch type later.')}
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
                ? '<div class="dlg-note">New here? Pick an analysis type and press <strong>Load Demo</strong> for a worked example that exercises every feature — it opens untitled, so you can rename it and make it your own.</div>'
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
       RENAME — name (or rename) the active project
       ════════════════════════════════════════════════════════════════ */

    function openRename(current, onSubmit) {
        const submit = () => {
            const name = document.getElementById('fRename').value.trim();
            modal.close();
            if (typeof onSubmit === 'function') onSubmit(name);
        };
        modal.open('Name this project', `
            ${_field('Project name',
                `<input class="dlg-inp" id="fRename" type="text" maxlength="60"
                        placeholder="e.g. Brake-by-wire FTA" value="${fmt.escHtml(current || '')}">`,
                'A demo opens untitled — give it a name to make it your own. ' +
                'Leave blank to keep it untitled.')}
        `, [
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            { label: 'Save name', cls: 'btn-primary', onClick: submit }
        ]);
        const f = document.getElementById('fRename');
        if (f) {
            f.focus();
            f.select();
            f.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
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

    /* Markdown for an FMEDA model. Built fresh from the project so
       the report always matches the current model. Includes element/function
       integrity, the per-failure-mode breakdown with ids, the numbered
       safety-requirement list (SRn) for tracing mitigation outside the tool,
       and common-cause findings. */
    function _fmedaReportLines(lines, p) {
        const ru = p.fmedaRollup();
        const pfhStr = fit => fmt.pfhDualStr(fit * 1e-9);
        // The report documents the project under its SELECTED integrity lens
        // (the standard is saved on the file), the same single scale the canvas
        // and right pane show — never a "SIL n / ASIL n" pair (a false
        // equivalence). The full λ / SFF / SPFM / LFM metrics below are listed
        // regardless of lens, as data; only the integrity VERDICTS follow it.
        const iso = (p.standard !== 'IEC61508');
        const bandRate = fit => iso ? fmt.asilForPfh(fit * 1e-9) : fmt.silForPfh(fit * 1e-9);
        // Per-function metric-gated bands (same basis as the canvas / system).
        const _fnMet = {};
        (p.fmedaMetrics().functions || []).forEach(fm => { _fnMet[fm.id] = fm; });
        const fnBandOf = f => {
            const fm = _fnMet[f.id];
            return fm ? (iso ? fm.achievedAsil : fm.achievedSil) : bandRate(f.residualFit);
        };
        lines.push('Mode: FMEDA · Mission time: ' + p.missionTime + ' h');
        lines.push('Integrity lens: ' + (iso ? 'ISO 26262 (ASIL)' : 'IEC 61508 (SIL)'));
        lines.push('');

        // Hardware metrics — IEC 61508 SFF and ISO 26262 SPF/RF/MPF.
        const m = p.fmedaMetrics();
        const t = m.total;
        const pct = v => (v == null) ? '—' : (Math.round(v * 1000) / 10) + '%';
        const fitU = v => fmt.fitStr(v);
        lines.push('## FMEDA metrics');
        if (!(t.lambdaTotal > 0)) {
            lines.push('- No quantified leaf failure modes.');
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
            lines.push('   - Basis: leaf failure modes. λ_S is the entered safe-failure rate (default 0); λ_SD = 0 (no safe-detected split), so λ_SU = λ_S. SFF = (Σλ_S + Σλ_DD)/Σλ_Total — a conservative floor when λ_S = 0.');
            if (m.elements.length) {
                lines.push('');
                lines.push('   Per element:');
                m.elements.slice().sort((a, b) => (b.lambdaTotal || 0) - (a.lambdaTotal || 0)).forEach(e => {
                    const pmhf = (e.lambdaSPF + e.lambdaRF) * 1e-9;
                    const mh   = fmt.mtbfHoursFromFit(e.lambdaTotal);
                    const band = iso ? e.achievedAsil : e.achievedSil;
                    lines.push('   - [' + (e.id || '—') + '] ' + e.name +
                        ': λ ' + fitU(e.lambdaTotal) +
                        ' · PMHF ' + fmt.perHourStr(pmhf) +
                        ' · MTBF ' + (mh == null ? '—' : mh.toExponential(2) + ' h') +
                        ' · SFF ' + pct(e.sff) + ' · SPFM ' + pct(e.spfm) + ' · LFM ' + pct(e.lfm) +
                        (band && band !== '—' ? ' -> ' + band : ''));
                });
            }
        }
        lines.push('');

        // Elements — DECLARED integrity. An architecture element's SIL/ASIL is
        // the integrity the user declares for it (a claimed SFF read through
        // Route 1ₕ, or a claimed SIL/ASIL capability). It is NOT inferred from
        // the functions; undeclared elements report no band. One source
        // (fmedaElementsForDisplay) so the report matches the canvas and panel.
        lines.push('## Architecture elements (' + ru.elements.length + ')');
        if (!ru.elements.length) lines.push('- None defined.');
        p.fmedaElementsForDisplay(iso).forEach(e => {
            const grp = p.groupById ? p.groupById(e.id) : null;
            let claimTxt = '';
            if (grp) {
                const bits = [];
                if (grp.claimedCapability) bits.push('capability ' + grp.claimedCapability);
                if (grp.claimedSff != null) bits.push('SFF ' + Math.round(grp.claimedSff * 100) + '%');
                if (bits.length) claimTxt = ' [declared: ' + bits.join(', ') + ' — assumption to validate]';
            }
            const band = e.bandComputed
                ? 'declared integrity ' + e.band + claimTxt
                : 'no integrity declared (set a claimed SFF or SIL/ASIL capability)';
            lines.push('- [' + e.id + '] ' + e.name +
                (e.level ? ' (' + e.level + ')' : '') +
                ' — ' + band +
                '; total residual λ_DU ' + fmt.fitStr(e.residualFit));
        });
        lines.push('');

        // Functions — residual & integrity (rate-band, active lens).
        lines.push('## Functions (' + ru.functions.length + ')');
        ru.functions.forEach(f => {
            lines.push('- [' + f.id + '] ' + f.name + '  (' + f.elementName + ')');
            lines.push('   - Residual λ_DU: ' + fmt.fitStr(f.residualFit) + ' = ' + pfhStr(f.residualFit) +
                '  →  ' + fnBandOf(f));
            lines.push('   - Raw λ_D: ' + fmt.fitStr(f.rawFit) +
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
            lines.push('   - raw λ_D ' + fmt.fitStr(raw) + ' · residual λ_DU ' + fmt.fitStr(res) +
                ' · DC ' + Math.round(dc * 100) + '%');
        });
        lines.push('');

        // Safety requirements — the traceable SRn list.
        const srs = p.safetyRequirements();
        lines.push('## Safety requirements (' + srs.length + ')');
        if (!srs.length) lines.push('- None. A requirement is listed for each low-level failure mode that has a written mitigation.');
        // Each requirement inherits, at the end of its text, the integrity
        // DECLARED on its element — " (ASIL C)" / " (SIL 3)" under the report's
        // lens; undeclared elements and empty text add nothing.
        const _srBands = p.fmedaElementBands(iso);
        srs.forEach(sr => {
            lines.push('- ' + sr.srId + ' [' + sr.eventId + '] — ' + sr.elementName +
                ' · ' + sr.functionName + ' · ' + sr.name);
            lines.push('   - ' + (sr.credited ? 'DC ' + Math.round(sr.dc * 100) + '%'
                                              : 'no diagnostic coverage credited') +
                ' — ' + sr.mitigation +
                fmt.mitigationBandSuffix(sr.mitigation, _srBands[sr.elementId]));
        });
        lines.push('');

        // Common-cause findings.
        const cc = p.commonCauseFindings();
        if (cc.length) {
            lines.push('## Common-cause findings (' + cc.length + ')');
            cc.forEach(f => {
                const src = p.eventById(f.sourceId);
                const status = f.addressedByM
                    ? ' — addressed by mitigation ' + (f.mitigationIds || []).join(', ')
                    : ((src && src.commonCauseMitigated) ? ' — manually flagged mitigated' : ' — OPEN');
                lines.push('- ' + f.sourceName + ' [' + f.sourceId + '] defeats ' +
                    f.functionCount + ' functions' + status + ':');
                f.targets.forEach(t =>
                    lines.push('   - ' + t.elementName + ' · ' + t.functionName + ' · ' + t.name));
            });
            lines.push('');
        }
    }

    function openExport(project, analysis) {
        const lines = [];
        lines.push('# ' + (project.name || 'Untitled project'));
        lines.push('Generated ' + fmt.isoDate() +
                   ' by Functional Analysis Studio (FAS) v' +
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
                               (ev.kind === 'basic' ? ', importance (FV) ' +
                                    (ev.contribution > 0 ? (ev.contribution*100).toFixed(2) + '%' : '—')
                                  : ''));
                });
            }
        }
        const text = lines.join('\n');
        const baseName = (project.name || 'fas-report').replace(/\s+/g, '_') +
                         '_' + fmt.isoDate();

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
            <div class="dlg-label dlg-label--gap">Report (Markdown)</div>
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
            // down one frame later.
            { label: 'OK',     cls: 'btn-primary',
              onClick: () => { modal.close(); onOk && onOk(); } }
        ]);
    }

    function _alert(title, message) {
        modal.open(title, `<div class="dlg-msg">${fmt.escHtml(message)}</div>`, [
            { label: 'OK', cls: 'btn-primary', onClick: modal.close }
        ]);
    }

    /* ── Domain boundary editor (v3.3.0) ─────────────────────────────────
       A purely-visual grouping of top-level nodes — architecture elements in
       FMEDA, events in FTA/ETA. Same modal shape as the group editor (name +
       colour + member picker), but it writes to the project's `domains` layer,
       which no metric or analysis ever reads. */
    function _domainMemberItems(p) {
        if (p.mode === 'FMEDA')
            return p.elementGroups().map(el => ({ value: el.id, idText: el.id, name: el.name || el.id }));
        // FTA / ETA: the diagram's own nodes are events.
        return p.events.map(e => ({ value: e.id, idText: e.id, name: e.name || e.id }));
    }

    function openDomainEdit(domainId) {
        const p = api.getProject();
        if (!p) return;
        const existing = domainId ? p.domainById(domainId) : null;
        const d = existing || {
            id: null, name: '',
            color: CONFIG.groupColors[p.domains.length % CONFIG.groupColors.length],
            members: []
        };
        const members = (existing ? existing.members : []).slice();
        const nodeWord = p.mode === 'FMEDA' ? 'elements' : 'events';

        const swatches = CONFIG.groupColors.map(c =>
            `<label class="dlg-swatch" style="background:${c}">
                <input type="radio" name="dColor" value="${c}" ${c === d.color ? 'checked' : ''}>
            </label>`).join('');

        modal.open((existing ? 'Edit ' : 'New ') + 'domain boundary', `
            ${_errBox()}
            ${_field('Name',
                `<input class="dlg-inp" id="dName" type="text" maxlength="40" value="${fmt.escHtml(d.name)}">`,
                'Visible label on the boundary drawn around the chosen ' + nodeWord + '.')}
            <div class="dlg-label">Color</div>
            <div class="dlg-swatches">${swatches}</div>
            ${_field('Members — ' + nodeWord,
                picklist.create({ id: 'dMembers', items: _domainMemberItems(p),
                            selected: members, multi: true,
                            placeholder: 'Search ' + nodeWord + '…' }),
                'A node belongs to at most one domain. This is a visual grouping only — it never changes any rate, metric or result.')}
        `, [
            ...(existing ? [{
                label: 'Delete', cls: 'btn-danger',
                onClick: () => confirm('Delete domain boundary?',
                    'Remove "' + (existing.name || 'this domain') + '". The ' + nodeWord + ' inside it are not affected.',
                    () => { api.applyDomainDelete(existing.id); modal.close(); })
            }] : []),
            { label: 'Cancel', cls: 'btn-sec', onClick: modal.close },
            {
                label: existing ? 'Save' : 'Create', cls: 'btn-primary',
                onClick: () => {
                    const name = (document.getElementById('dName').value || '').trim();
                    const colorEl = document.querySelector('input[name="dColor"]:checked');
                    const color = colorEl ? colorEl.value : d.color;
                    const picked = picklist.values('dMembers');
                    api.applyDomainSave(existing ? existing.id : null,
                        { name, color, members: picked });
                    modal.close();
                }
            }
        ]);

        document.querySelectorAll('.dlg-swatch input').forEach(r => {
            r.addEventListener('change', () => {
                document.querySelectorAll('.dlg-swatch').forEach(s =>
                    s.classList.toggle('dlg-swatch-on', s.querySelector('input').checked));
            });
        });
        document.querySelectorAll('.dlg-swatch').forEach(s =>
            s.classList.toggle('dlg-swatch-on', s.querySelector('input').checked));
        picklist.wire('dMembers');
    }

    return {
        init,
        openEventEdit, openGateEdit, openLinkEdit, openGroupEdit, openScenarioEdit,
        openDomainEdit,
        openNewProject, openRename, openExport, openHelp,
        confirm
    };
})();
