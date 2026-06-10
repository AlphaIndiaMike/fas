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

            <div class="ctrl-section ctrl-summary" id="ctrlSummary"></div>

            <div class="ctrl-section">
                <div class="ctrl-section-hd">Warnings</div>
                <div id="ctrlWarnings" class="ctrl-warnings">
                    <div class="ctrl-empty">No analysis yet. Press Recalculate.</div>
                </div>
            </div>

            <div class="ctrl-section">
                <div class="ctrl-section-hd">Scenarios</div>
                <div id="ctrlScenarios" class="ctrl-scenarios">
                    <div class="ctrl-empty">No scenarios. Add one from the Catalog.</div>
                </div>
            </div>

            <div class="ctrl-section">
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
    }

    /* Switch the panel between FTA and ETA. Both modes share the same
       skeleton; only the summary section renders differently (one top
       card vs one card per final), so the toggle just re-renders. */
    function setMode(mode) {
        const m = (mode === 'ETA') ? 'ETA' : 'FTA';
        if (m === _mode) return;
        _mode = m;
        _analysis = null;
        _dirty = true;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'none';
        if (_project) renderProject(_project);
    }

    function setViewMode(mode) {
        _viewMode = (mode === 'simplified') ? 'simplified' : 'technical';
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
        _dirty = true;
        const banner = document.getElementById('ctrlBanner');
        if (banner) banner.style.display = 'none';
        _renderSummary(null);
        _renderWarnings(null);
        _renderBreakdown(null);
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

    return {
        init,
        renderProject, applyAnalysis, clearAnalysis,
        markDirty, setActiveScenario, setViewMode, setMode
    };
})();
