/**
 * controls.js
 * Functional Analysis Studio [FAS] — Right-pane Analysis & Report.
 *
 * Renders:
 *   · the "stale" banner (set whenever the model changes since last analyze)
 *   · the top-event summary card (PFD, PFH, SIL, ASIL)
 *   · the warnings list (FFI, repeated events, dangling, cycles, …)
 *   · scenario picker (active scenario for the next recalc)
 *   · per-event breakdown (sorted by contribution to top)
 *   · global controls (Recalculate, Auto-arrange, Mission time)
 *
 * Public:
 *   controls.init(containerId, callbacks)
 *     callbacks = {
 *       onRecalculate(scenarioId),
 *       onClearAnalysis(),
 *       onAutoLayout(),
 *       onMissionTimeChange(hours),
 *       onScenarioPick(scenarioId),
 *       onEditScenario(scenarioId),
 *       onDeleteScenario(scenarioId),
 *       onEventClick(eventId),
 *       onGateClick(gateId)
 *     }
 *   controls.renderProject(project)
 *   controls.applyAnalysis(analysis)
 *   controls.markDirty()                 — show stale banner
 *   controls.setActiveScenario(scenarioId)
 *
 * Depends on: fmt.js, config.js, fas.js (Project type)
 */

const controls = (() => {

    let root           = null;
    let cb             = {};
    let _project       = null;
    let _analysis      = null;
    let _activeScenario = null;
    let _dirty         = true;
    let _viewMode      = 'technical';   // 'technical' | 'simplified'
    let _lastFmedaRollup = null;        // remembered FMEDA rollup for re-render
    let _mode          = 'FTA';         // 'FTA' | 'ETA'

    function init(containerId, callbacks) {
        root = document.getElementById(containerId);
        cb   = callbacks || {};
        _buildFtaSkeleton();
    }

    /* Build the FTA panel skeleton and bind its controls. Unchanged from
       the original single-mode panel — kept intact so FTA behaves exactly
       as before regardless of the new mode switch. */
    function _buildFtaSkeleton() {
        _mode = 'FTA';
        root.innerHTML = `
            <div class="ctrl-banner" id="ctrlBanner" style="display:none">
                <span class="ctrl-banner-dot">●</span>
                <span class="ctrl-banner-text">Inputs changed — analysis is stale.</span>
            </div>

            <div class="ctrl-section ctrl-fmeda" id="ctrlFmeda" style="display:none">
                <div class="ctrl-section-hd">FMEDA — show connections</div>
                <div class="fmeda-net-toggle" id="fmedaNetToggle">
                    <button type="button" class="fmeda-net-btn on" data-net="arch">Architecture</button>
                    <button type="button" class="fmeda-net-btn"    data-net="func">Function net</button>
                    <button type="button" class="fmeda-net-btn"    data-net="fail">Failure net</button>
                </div>
                <div class="ctrl-section-hd" style="margin-top:12px">Common-cause findings</div>
                <div id="ctrlCommonCause" class="ctrl-commoncause">
                    <div class="ctrl-empty">Build the failure net — one failure
                        reaching two functions is flagged here.</div>
                </div>
                <div class="ctrl-section-hd" style="margin-top:12px">Residual failure rate
                    <button type="button" class="dlg-help" data-help="fmedaResidual" title="What is this?">?</button>
                </div>
                <div id="ctrlResidual" class="ctrl-residual">
                    <div class="ctrl-empty">Press Recalculate to compute residual
                        λ (FIT) per function after diagnostic credit.</div>
                </div>
            </div>

            <div class="ctrl-section ctrl-summary" id="ctrlSummary"></div>

            <div class="ctrl-section" id="ctrlWarningsSec">
                <div class="ctrl-section-hd">Warnings</div>
                <div id="ctrlWarnings" class="ctrl-warnings">
                    <div class="ctrl-empty">No analysis yet. Press Recalculate.</div>
                </div>
            </div>

            <div class="ctrl-section" id="ctrlScenariosSec">
                <div class="ctrl-section-hd">Scenarios</div>
                <div id="ctrlScenarios" class="ctrl-scenarios">
                    <div class="ctrl-empty">No scenarios. Add one from the Catalog.</div>
                </div>
            </div>

            <div class="ctrl-section" id="ctrlBreakdownSec">
                <div class="ctrl-section-hd">Event breakdown</div>
                <div id="ctrlBreakdown" class="ctrl-breakdown">
                    <div class="ctrl-empty">No analysis yet.</div>
                </div>
            </div>

            <div class="ctrl-section ctrl-section-foot">
                <div class="ctrl-section-hd">Project</div>
                <label class="ctrl-mt">
                    <span>Mission time (h)
                        <button type="button" class="dlg-help" data-help="missionTime"
                                title="What is mission time?">?</button>
                    </span>
                    <input id="ctrlMT" type="number" class="dlg-inp" min="1" step="1">
                </label>
                <div class="ctrl-global">
                    <button class="btn btn-primary" id="btnRecalc">▶ Recalculate</button>
                    <button class="btn btn-sec"     id="btnClearAnalysis">↺ Clear analysis</button>
                    <button class="btn btn-sec"     id="btnAutoLayout" title="Auto-arrange (dagre, left-to-right)">⇄ Auto-arrange</button>
                </div>
            </div>
        `;
        document.getElementById('btnRecalc').addEventListener('click', () =>
            cb.onRecalculate && cb.onRecalculate(_activeScenario));
        document.getElementById('btnClearAnalysis').addEventListener('click', () =>
            cb.onClearAnalysis && cb.onClearAnalysis());
        document.getElementById('btnAutoLayout').addEventListener('click', () =>
            cb.onAutoLayout && cb.onAutoLayout());
        document.getElementById('ctrlMT').addEventListener('change', (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v) && v > 0 && cb.onMissionTimeChange) cb.onMissionTimeChange(v);
        });
        // FMEDA net toggle — one net visible at a time.
        const netToggle = document.getElementById('fmedaNetToggle');
        if (netToggle) {
            netToggle.querySelectorAll('.fmeda-net-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    netToggle.querySelectorAll('.fmeda-net-btn')
                        .forEach(b => b.classList.toggle('on', b === btn));
                    if (cb.onNetChange) cb.onNetChange(btn.getAttribute('data-net'));
                });
            });
        }
    }

    /* Switch the panel between FTA and ETA. Both modes share the same
       skeleton; only the summary section renders differently (one top
       card vs one card per final), so the toggle just re-renders. */
    function setMode(mode) {
        const m = ['ETA','FMEDA'].includes(mode) ? mode : 'FTA';
        if (m === _mode) return;
        _mode = m;
        _analysis = null;
        _dirty = true;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'none';
        _applyModeChrome();
        if (_project) renderProject(_project);
    }

    /* Show the FMEDA-only panel (net toggle + common cause) in FMEDA mode;
       hide the analysis-oriented sections that don't apply there. */
    function _applyModeChrome() {
        const fmeda = document.getElementById('ctrlFmeda');
        if (fmeda) fmeda.style.display = (_mode === 'FMEDA') ? 'block' : 'none';
        // The top-event summary, warnings, scenarios and event breakdown are
        // FTA/ETA analysis outputs with no meaning in FMEDA (no single top
        // event, no scenarios, no event contributions). Hide them in FMEDA so
        // the panel shows only what applies — mirroring how the FMEDA panel is
        // hidden in FTA/ETA. FTA/ETA are unaffected.
        const ftaOnly = (_mode !== 'FMEDA');
        ['ctrlSummary', 'ctrlWarningsSec', 'ctrlScenariosSec', 'ctrlBreakdownSec']
            .forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = ftaOnly ? '' : 'none';
            });
    }

    function setViewMode(mode) {
        _viewMode = (mode === 'simplified') ? 'simplified' : 'technical';
        // FMEDA residual respects the Technical/Simplified toggle too:
        // Technical = numbers (FIT/PFH), Simplified = ASIL/SIL achieved.
        if (_mode === 'FMEDA' && _lastFmedaRollup) {
            applyFmedaRollup(_lastFmedaRollup);
        }
        if (!_analysis) return;
        _renderSummary(_analysis);
        _renderBreakdown(_analysis);
    }

    /* ── Project change → repaint the static parts ───────────────── */

    function renderProject(project) {
        _project = project;
        const mt = document.getElementById('ctrlMT');
        if (mt) mt.value = project.missionTime;
        _renderScenarios();
        if (_mode === 'FMEDA') _renderCommonCause(project);
        if (!_analysis) {
            // Reset summary / warnings / breakdown to "no analysis yet"
            _renderSummary(null);
            _renderWarnings(null);
            _renderBreakdown(null);
        } else {
            // Re-render existing analysis sections with up-to-date names
            applyAnalysis(_analysis);
        }
    }

    /* The FMEDA payoff panel: list each failure mode that, via the failure
       net, reaches two or more functions — i.e. defeats things assumed
       independent. This is the project-manager argument made visible. */
    function _renderCommonCause(project) {
        const el = document.getElementById('ctrlCommonCause');
        if (!el) return;
        const findings = project.commonCauseFindings();
        if (!findings.length) {
            el.innerHTML = `<div class="ctrl-empty">No common-cause findings.
                Draw a failure-net link from a CAUSE failure to the failures it
                propagates to. If one cause reaches failures in two different
                functions, it shows here.</div>`;
            return;
        }
        let html = '';
        findings.forEach(f => {
            const fnNames = [...new Set(f.targets.map(t =>
                fmt.escHtml(t.functionName) + ' <span class="cc-el">(' +
                fmt.escHtml(t.elementName) + ')</span>'))].join(', ');
            // Is the common cause itself mitigated? If so, note it as
            // addressed (information retained) rather than a raw red flag.
            const src = project.eventById(f.sourceId);
            const mitigated = src && project.fmedaIsHandled(src);
            html += `
                <div class="cc-card ${mitigated ? 'cc-card-ok' : ''}">
                    <div class="cc-src">${mitigated ? '✓' : '⚠'}
                        <strong class="cc-link" data-cc-src="${f.sourceId}">${fmt.escHtml(f.sourceName)}</strong>
                        is a common cause across ${f.functionCount} functions</div>
                    <div class="cc-targets">Reaches: ${fnNames}</div>
                    <div class="cc-fix">${mitigated
                        ? 'Mitigated at the cause (diagnostic + reaction). Kept here for traceability.'
                        : 'To address: open the cause and add a diagnostic + reaction mitigation, or eliminate the shared dependency.'}</div>
                </div>`;
        });
        el.innerHTML = html;
        // Clicking the cause name opens its editor so a mitigation can be
        // added right away (the "how to fix" path, not a dead flag).
        el.querySelectorAll('.cc-link').forEach(n => {
            n.addEventListener('click', () => {
                if (cb.onEventClick) cb.onEventClick(n.getAttribute('data-cc-src'));
            });
        });
    }

    function applyAnalysis(analysis) {
        _analysis = analysis;
        _dirty = false;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'none';
        _renderSummary(analysis);
        _renderWarnings(analysis);
        _renderBreakdown(analysis);
    }

    function clearAnalysis() {
        _analysis = null;
        _lastFmedaRollup = null;
        _dirty = true;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'none';
        _renderSummary(null);
        _renderWarnings(null);
        _renderBreakdown(null);
        // FMEDA residual panel back to its empty prompt (the button did
        // nothing here before — this is the fix).
        const res = document.getElementById('ctrlResidual');
        if (res) res.innerHTML =
            `<div class="ctrl-empty">Press Recalculate to compute the residual ` +
            `failure rate per function and element.</div>`;
    }

    function markDirty() {
        if (!_analysis) return;
        _dirty = true;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'flex';
    }

    function setActiveScenario(sid) {
        _activeScenario = sid || null;
        _renderScenarios();
    }

    /* ── Top event summary ───────────────────────────────────────── */

    function _renderSummary(analysis) {
        const el = document.getElementById('ctrlSummary');
        if (!el) return;
        const mt = (analysis && analysis.missionTime) ||
                   (_project && _project.missionTime) || CONFIG.defaultMissionTime;

        // ETA: one card per final event.
        if (analysis && Array.isArray(analysis.finals)) {
            if (analysis.finals.length === 0) {
                el.innerHTML = `
                    <div class="ctrl-section-hd">Final events</div>
                    <div class="ctrl-empty">
                        No final events yet. Add events and mark one or more
                        as "final", then Recalculate.
                    </div>`;
                return;
            }
            el.innerHTML =
                `<div class="ctrl-section-hd">Final events (${analysis.finals.length}) ${dialogsHelpBtn('etaMode')}</div>` +
                analysis.finals.map(f => _topCardHtml(f, mt, analysis)).join('');
            return;
        }

        // FTA: single top event.
        if (!analysis || !analysis.top) {
            el.innerHTML = `
                <div class="ctrl-section-hd">Top event</div>
                <div class="ctrl-empty">
                    No top event set, or analysis not yet run.
                </div>`;
            return;
        }
        el.innerHTML =
            `<div class="ctrl-section-hd">Top event ${dialogsHelpBtn('viewMode')}</div>` +
            _topCardHtml(analysis.top, mt, analysis);
    }

    /* Build one result card (used for the FTA top and each ETA final).
       Identical presentation in both modes — the per-final probability
       with the "in N hours, ≈ x%" gloss you wanted. */
    function _topCardHtml(t, mt, analysis) {
        const simple = (_viewMode === 'simplified');

        let valuesHtml;
        if (simple) {
            valuesHtml = `
                <div class="ctrl-top-grid ctrl-top-grid-single">
                    <div>
                        <span class="ctrl-top-key">Chance of failure</span>
                        <span class="ctrl-top-val">${fmt.inHoursStr(t.pfd, mt)}</span>
                    </div>
                </div>`;
        } else {
            valuesHtml = `
                <div class="ctrl-top-grid">
                    <div>
                        <span class="ctrl-top-key">PFD</span>
                        <span class="ctrl-top-val">${fmt.probStr(t.pfd)}</span>
                    </div>
                    <div>
                        <span class="ctrl-top-key">PFH</span>
                        <span class="ctrl-top-val">${fmt.perHourStr(t.pfh)}</span>
                    </div>
                </div>`;
        }

        let silDisp  = simple ? (CONFIG.simpleLabels.sil[t.sil]   || t.sil)  : t.sil;
        let asilDisp = simple ? (CONFIG.simpleLabels.asil[t.asil] || t.asil) : t.asil;
        if (simple) {
            silDisp  = silDisp.replace(' (', '\n(');
            asilDisp = asilDisp.replace(' (', '\n(');
        }

        let targetHtml;
        if (t.target) {
            const isMet  = t.targetMet === true;
            const isMiss = t.targetMet === false;
            const cls    = isMet ? 'target-met' : isMiss ? 'target-miss' : 'target-pending';
            const status = isMet  ? '✓ Target met'
                         : isMiss ? '✗ Target missed'
                         :          '— Awaiting recalc';
            targetHtml = `
                <div class="ctrl-target ${cls}">
                    <div class="ctrl-target-hd">Target ${dialogsHelpBtn('target')}</div>
                    <div class="ctrl-target-body">
                        <span class="ctrl-target-val">${fmt.escHtml(t.target)}</span>
                        <span class="ctrl-target-status">${status}</span>
                    </div>
                </div>`;
        } else {
            targetHtml = `
                <div class="ctrl-target target-empty">
                    <div class="ctrl-target-hd">Target ${dialogsHelpBtn('target')}</div>
                    <div class="ctrl-target-empty-msg">
                        No safety target set. Open the event and pick one
                        to see whether the design meets it.
                    </div>
                </div>`;
        }

        return `
            <div class="ctrl-top-card">
                <div class="ctrl-top-name" title="${fmt.escHtml(t.name)}">${fmt.escHtml(t.name)}</div>
                ${valuesHtml}
                <div class="ctrl-top-chips-hd">Current rating</div>
                <div class="ctrl-top-chips">
                    <span class="ctrl-chip ctrl-chip-sil ${_silClass(t.sil)}${simple ? ' chip-multi' : ''}"
                          title="IEC 61508-1 Table 3 (high demand)">${fmt.escHtml(silDisp)}</span>
                    <span class="ctrl-chip ctrl-chip-asil ${_asilClass(t.asil)}${simple ? ' chip-multi' : ''}"
                          title="ISO 26262-5 Annex F PMHF target only.">${fmt.escHtml(asilDisp)}</span>
                </div>
                ${targetHtml}
                <div class="ctrl-top-foot">Mission time ${fmt.intDot(mt)} h${analysis && analysis.scenarioId ? ' · scenario active' : ''}</div>
            </div>`;
    }

    /* Inline helper-button HTML — same shape as dialogs._help but
       reachable from controls without circular reference. The global
       click handler in dialogs.js will pick it up. */
    function dialogsHelpBtn(topic) {
        return `<button type="button" class="dlg-help" data-help="${topic}" title="What is this?">?</button>`;
    }

    function _silClass(s) {
        if (!s) return '';
        if (s === 'SIL 4') return 'lvl-4';
        if (s === 'SIL 3') return 'lvl-3';
        if (s === 'SIL 2') return 'lvl-2';
        if (s === 'SIL 1') return 'lvl-1';
        return 'lvl-0';
    }
    function _asilClass(a) {
        if (!a) return '';
        if (a === 'ASIL D')   return 'lvl-4';
        if (a === 'ASIL B/C') return 'lvl-3';
        if (a === 'ASIL A')   return 'lvl-2';
        return 'lvl-0';
    }

    /* ── Warnings ─────────────────────────────────────────────────── */

    function _renderWarnings(analysis) {
        const el = document.getElementById('ctrlWarnings');
        if (!el) return;
        if (!analysis) {
            el.innerHTML = `<div class="ctrl-empty">No analysis yet. Press Recalculate.</div>`;
            return;
        }
        if (!analysis.warnings || analysis.warnings.length === 0) {
            el.innerHTML = `<div class="ctrl-ok">No warnings — analysis is clean.</div>`;
            return;
        }
        let html = '';
        analysis.warnings.forEach(w => {
            const cls   = 'warn-' + w.kind;
            const click = w.eventId ? `data-event="${w.eventId}"`
                       : w.gateId  ? `data-gate="${w.gateId}"`
                       : '';
            html += `
                <div class="ctrl-warn ${cls}" ${click}>
                    <span class="ctrl-warn-tag">${_warnTag(w.kind)}</span>
                    <span class="ctrl-warn-msg">${fmt.escHtml(w.msg)}</span>
                </div>`;
        });
        el.innerHTML = html;
        el.querySelectorAll('[data-event]').forEach(n => {
            n.addEventListener('click', () => cb.onEventClick &&
                cb.onEventClick(n.getAttribute('data-event')));
        });
        el.querySelectorAll('[data-gate]').forEach(n => {
            n.addEventListener('click', () => cb.onGateClick &&
                cb.onGateClick(n.getAttribute('data-gate')));
        });
    }

    function _warnTag(kind) {
        switch (kind) {
            case 'ffi':       return 'FFI';
            case 'repeated':  return 'REP';
            case 'dangling':  return 'NIL';
            case 'cycle':     return 'CYC';
            case 'underwired': return 'UW';
            case 'no-target': return 'TGT';
            default:          return '!';
        }
    }

    /* ── Scenarios ───────────────────────────────────────────────── */

    function _renderScenarios() {
        const el = document.getElementById('ctrlScenarios');
        if (!el) return;
        if (!_project || _project.scenarios.length === 0) {
            el.innerHTML = `<div class="ctrl-empty">No scenarios. Add one from the Catalog.</div>`;
            return;
        }
        let html = `
            <label class="ctrl-scn-row ${_activeScenario ? '' : 'ctrl-scn-on'}" data-id="">
                <input type="radio" name="scn" ${_activeScenario ? '' : 'checked'}>
                <span class="ctrl-scn-name"><em>Baseline (no overrides)</em></span>
            </label>`;
        _project.scenarios.forEach(s => {
            const on = _activeScenario === s.id;
            html += `
                <div class="ctrl-scn-row ${on ? 'ctrl-scn-on' : ''}" data-id="${s.id}">
                    <label class="ctrl-scn-pick">
                        <input type="radio" name="scn" ${on ? 'checked' : ''} data-id="${s.id}">
                        <span class="ctrl-scn-name">${fmt.escHtml(s.name)}</span>
                        <span class="ctrl-scn-meta">${s.overrides.length} override${s.overrides.length===1?'':'s'}</span>
                    </label>
                    <span class="ctrl-scn-actions">
                        <button class="btn-mini scn-edit" data-id="${s.id}" title="Edit">✏</button>
                        <button class="btn-mini scn-del"  data-id="${s.id}" title="Delete">×</button>
                    </span>
                </div>`;
        });
        el.innerHTML = html;
        el.querySelectorAll('input[type="radio"]').forEach(r => {
            r.addEventListener('change', () => {
                _activeScenario = r.getAttribute('data-id') || null;
                if (cb.onScenarioPick) cb.onScenarioPick(_activeScenario);
                _renderScenarios();
            });
        });
        el.querySelectorAll('.scn-edit').forEach(b =>
            b.addEventListener('click', e => {
                e.stopPropagation();
                cb.onEditScenario && cb.onEditScenario(b.getAttribute('data-id'));
            }));
        el.querySelectorAll('.scn-del').forEach(b =>
            b.addEventListener('click', e => {
                e.stopPropagation();
                cb.onDeleteScenario && cb.onDeleteScenario(b.getAttribute('data-id'));
            }));
    }

    /* ── Per-event breakdown ─────────────────────────────────────── */

    function _renderBreakdown(analysis) {
        const el = document.getElementById('ctrlBreakdown');
        if (!el) return;
        if (!analysis || analysis.events.length === 0) {
            el.innerHTML = `<div class="ctrl-empty">No analysis yet.</div>`;
            return;
        }
        const simple = (_viewMode === 'simplified');
        const mt = analysis.missionTime || (_project && _project.missionTime) ||
                   CONFIG.defaultMissionTime;
        // Sort by kind priority T → I → B, then by descending PFD inside
        // each kind. Top first because it's the verdict; intermediate
        // before basic so the user can scan the hierarchy as they read
        // (aggregated outcomes ahead of their contributing leaves).
        const kindOrder = { top: 0, intermediate: 1, basic: 2 };
        const list = analysis.events.slice().sort((a, b) => {
            const ka = kindOrder[a.kind] != null ? kindOrder[a.kind] : 99;
            const kb = kindOrder[b.kind] != null ? kindOrder[b.kind] : 99;
            if (ka !== kb) return ka - kb;
            return (b.pfd || 0) - (a.pfd || 0);
        });
        let html = '';
        list.forEach(ev => {
            const kindLetter = ev.kind === 'top'   ? 'T'
                            : ev.kind === 'basic' ? 'B'
                            : 'I';
            const cls = ev.kind === 'top'   ? 'kind-top'
                      : ev.kind === 'basic' ? 'kind-basic'
                      : 'kind-int';
            const contrib = ev.contribution > 0
                ? Math.min(100, ev.contribution * 100).toFixed(1) + '%'
                : '—';
            const val = simple ? fmt.pctStr(ev.pfd) : fmt.probStr(ev.pfd);
            // Hover label on the PFD value — tells the reader which
            // number they're looking at. Top events show "Top PFD" so
            // every row has a tooltip and the table reads consistently.
            const valTitle = ev.kind === 'top' ? 'Top PFD' : 'Individual PFD';
            html += `
                <div class="ctrl-bd-row" data-id="${ev.id}">
                    <span class="ctrl-bd-kind ${cls}">${kindLetter}</span>
                    <span class="ctrl-bd-name" title="${fmt.escHtml(ev.name)}">${fmt.escHtml(ev.name)}</span>
                    <span class="ctrl-bd-val" title="${valTitle}">${val}</span>
                    ${ev.kind === 'top' ? '' :
                        `<span class="ctrl-bd-pct" title="Approx contribution to top PFD">${contrib}</span>`}
                </div>`;
        });
        el.innerHTML = html;
        el.querySelectorAll('.ctrl-bd-row').forEach(n => {
            n.addEventListener('click', () => cb.onEventClick &&
                cb.onEventClick(n.getAttribute('data-id')));
        });
    }

    /* Reflect the active FMEDA net in the toggle highlight (called when the
       net is changed programmatically, e.g. starting a net link). */
    function setActiveNet(net) {
        const toggle = document.getElementById('fmedaNetToggle');
        if (!toggle) return;
        toggle.querySelectorAll('.fmeda-net-btn').forEach(b =>
            b.classList.toggle('on', b.getAttribute('data-net') === net));
    }

    /* Render the FMEDA residual roll-up (from Recalculate). Three sections:
         1. ELEMENTS — each architecture element with its achieved integrity
            band (SIL/ASIL chips, shaded). The most stringent function sets
            the element band (item E).
         2. FUNCTIONS — per-function residual presented integrity-first with
            a plain QM remark when there is no integrity claim (item 9).
         3. SAFETY REQUIREMENTS — the numbered SRn list for traceability
            (item D). */
    /* Render the FMEDA hardware-metric breakdown: the IEC 61508 λ split and
       SFF, plus the ISO 26262 SPF/RF/MPF mapping and SPFM/LFM. Computed over
       leaf failure modes; λ_S = 0 (no safe-failure portion modelled). */
    function _fmedaMetricsHtml(metrics, simple) {
        const t   = metrics.total;
        const fit = v => fmt.fitStr(v);
        const pct = v => (v == null) ? '—' : (Math.round(v * 1000) / 10) + '%';
        const row = (k, v) => `<div class="res-m-row"><span>${k}</span><strong>${v}</strong></div>`;
        let h = `<div class="res-section">FMEDA metrics</div>
            <div class="res-card res-metrics-card">
                ${row('λ<sub>Total, Safety</sub>', fit(t.lambdaTotal))}
                ${row('λ<sub>SD</sub> · λ<sub>SU</sub>', fit(t.lambdaSD) + ' · ' + fit(t.lambdaSU))}
                ${row('λ<sub>DD</sub> — detected dangerous', fit(t.lambdaDD))}
                ${row('λ<sub>DU</sub> — undetected dangerous', fit(t.lambdaDU))}
                ${row('<strong>Safe Failure Fraction (SFF)</strong>', '<strong>' + pct(t.sff) + '</strong>')}
                <div class="res-m-sub">ISO 26262 terminology</div>
                ${row('λ<sub>SPF</sub> — single-point fault', fit(t.lambdaSPF))}
                ${row('λ<sub>RF</sub> — residual fault', fit(t.lambdaRF))}
                ${row('λ<sub>MPF,dp</sub> — multiple-point, detected', fit(t.lambdaMPFdp))}
                ${row('λ<sub>MPF,latent</sub> — latent', fit(t.lambdaMPFlatent))}
                ${row('Single-Point Fault Metric (SPFM)', pct(t.spfm))}
                ${row('Latent-Fault Metric (LFM)', pct(t.lfm))}
                <div class="res-m-note">No safe-failure portion modelled (λ<sub>S</sub> = 0), so λ<sub>SD</sub> = λ<sub>SU</sub> = 0; λ<sub>Total</sub> sums dangerous rates only and SFF is a conservative floor (safe failures would raise it). Computed over leaf failure modes — the achieved metric to check against your HARA target.</div>
            </div>`;
        if (metrics.elements && metrics.elements.length > 1) {
            metrics.elements.slice()
                .sort((a, b) => (b.lambdaTotal || 0) - (a.lambdaTotal || 0))
                .forEach(e => {
                    h += `<div class="res-card res-metrics-el">
                        <div class="res-fn">${fmt.escHtml(e.name)}
                            <span class="res-id">${fmt.escHtml(e.id || '')}</span>
                            ${e.level ? `<span class="res-lvl">${fmt.escHtml(e.level)}</span>` : ''}</div>
                        <div class="res-pfh">λ ${fit(e.lambdaTotal)} FIT · SFF ${pct(e.sff)} · SPFM ${pct(e.spfm)} · LFM ${pct(e.lfm)}</div>
                    </div>`;
                });
        }
        return h;
    }

    function applyFmedaRollup(rollup) {
        _lastFmedaRollup = rollup || null;   // remember for view-mode re-render
        const el = document.getElementById('ctrlResidual');
        if (!el) return;
        if (!rollup || !rollup.functions.length) {
            el.innerHTML = `<div class="ctrl-empty">No failure modes yet.</div>`;
            return;
        }
        const simple = (_viewMode === 'simplified');
        const toPfh  = fit => fit * 1e-9;
        const fitStr = v => fmt.fitStr(v);

        // Band helpers — single source of truth (fmt.* == FTA analyzer).
        const bandChips = (pfh) => {
            const sil  = fmt.silForPfh(pfh);
            const asil = fmt.asilForPfh(pfh);
            const silLbl  = simple ? (CONFIG.simpleLabels.sil[sil]   || sil)  : sil;
            const asilLbl = simple ? (CONFIG.simpleLabels.asil[asil] || asil) : asil;
            return `<span class="ctrl-chip ctrl-chip-sil ${_silClass(sil)}">${fmt.escHtml(silLbl)}</span>
                    <span class="ctrl-chip ctrl-chip-asil ${_asilClass(asil)}">${fmt.escHtml(asilLbl)}</span>`;
        };
        // QM remark when neither standard grants an integrity claim.
        const qmRemark = (pfh) => {
            const noClaim = fmt.silForPfh(pfh) === 'No SIL' && fmt.asilForPfh(pfh) === 'QM';
            return noClaim
                ? `<div class="res-qm">Quality-managed (QM) — no integrity claim at this rate.</div>`
                : '';
        };

        let html = '';

        // ── 0. FMEDA metrics: λ breakdown, SFF, SPFM/LFM ─────────────
        if (rollup.metrics && rollup.metrics.total &&
            rollup.metrics.total.lambdaTotal > 0) {
            html += _fmedaMetricsHtml(rollup.metrics, simple);
        }

        // ── 1. Elements: achieved integrity ──────────────────────────
        if (rollup.elements && rollup.elements.length) {
            html += `<div class="res-section">Architecture elements</div>`;
            rollup.elements.slice().sort((a, b) => a.integrityFit - b.integrityFit)
              .forEach(elr => {
                const pfh = toPfh(elr.integrityFit);
                html += `
                    <div class="res-card res-el-card">
                        <div class="res-fn">${fmt.escHtml(elr.name)}
                            <span class="res-id">${fmt.escHtml(elr.id)}</span>
                            ${elr.level ? `<span class="res-lvl">${fmt.escHtml(elr.level)}</span>` : ''}</div>
                        <div class="res-levels">${bandChips(pfh)}</div>
                        <div class="res-pfh">integrity ${fmt.pfhDualStr(pfh)} · total residual ${fitStr(elr.residualFit)}</div>
                        ${qmRemark(pfh)}
                    </div>`;
            });
        }

        // ── 2. Functions: residual, integrity-first ──────────────────
        html += `<div class="res-section">Functions</div>`;
        rollup.functions.forEach(f => {
            const pfh = toPfh(f.residualFit);
            const reduced = f.rawFit > 0
                ? Math.round((1 - f.residualFit / f.rawFit) * 100) : 0;
            let body;
            if (simple) {
                body = `
                    <div class="res-nums">achieved ${fmt.pfhDualStr(pfh)}</div>
                    <div class="res-levels">${bandChips(pfh)}</div>
                    ${qmRemark(pfh)}`;
            } else {
                // Integrity-first, then the rate, then the reduction. When
                // nothing was reduced we say so plainly instead of the
                // confusing "X FIT of X FIT raw" (item 9).
                const reductionLine = reduced > 0
                    ? `<span class="res-cut">−${reduced}% vs ${fitStr(f.rawFit)} raw</span>`
                    : `<span class="res-raw">no diagnostic credit (raw = residual)</span>`;
                body = `
                    <div class="res-levels">${bandChips(pfh)}</div>
                    <div class="res-nums">residual <strong>${fitStr(f.residualFit)}</strong>
                        &nbsp;·&nbsp; ${fmt.pfhDualStr(pfh)}</div>
                    <div class="res-pfh">${reductionLine}</div>
                    ${qmRemark(pfh)}`;
            }
            const allUnhandled = f.handledCount === 0 && f.total > 0;
            const dInfo = f.derivedCount > 0
                ? ` · ${f.derivedCount} derived` : '';
            html += `
                <div class="res-card">
                    <div class="res-fn">${fmt.escHtml(f.name)}
                        <span class="res-id">${fmt.escHtml(f.id)}</span>
                        <span class="res-el">(${fmt.escHtml(f.elementName)})</span></div>
                    ${body}
                    <div class="res-handled ${allUnhandled ? 'res-handled-none' : ''}">${f.handledCount}/${f.total} failure modes handled${dInfo}</div>
                </div>`;
        });

        // ── 3. Safety requirements (traceability) ────────────────────
        const srs = (rollup.safetyRequirements && rollup.safetyRequirements.length)
            ? rollup.safetyRequirements
            : ((cb.getProject && cb.getProject() && cb.getProject().safetyRequirements)
                ? cb.getProject().safetyRequirements() : []);
        if (srs.length) {
            html += `<div class="res-section">Safety requirements</div>`;
            srs.forEach(sr => {
                html += `
                    <div class="res-card res-sr-card">
                        <div class="res-fn"><span class="res-sr-id">${sr.srId}</span>
                            ${fmt.escHtml(sr.name)}
                            <span class="res-el">(${fmt.escHtml(sr.elementName)} · ${fmt.escHtml(sr.functionName)})</span></div>
                        <div class="res-sr-mit">${fmt.escHtml(sr.mitigation)} <span class="res-raw">— DC ${Math.round(sr.dc * 100)}%</span></div>
                    </div>`;
            });
        }

        el.innerHTML = html;
    }

    return {
        init,
        renderProject, applyAnalysis, clearAnalysis,
        markDirty, setActiveScenario, setViewMode, setMode,
        setActiveNet, applyFmedaRollup
    };
})();
