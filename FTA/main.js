/**
 * main.js
 * Functional Analysis Studio [FAS] — Application orchestrator.
 *
 * Wires Project, analyzer, canvas, catalog, controls, dialogs.
 * Owns the single render cycle, file I/O, dirty flag and the
 * responsive drawer behaviour. Exposes a small `main` surface to
 * the HTML onclick attributes.
 */

const main = (() => {

    let project        = null;
    let activeScenario = null;
    let viewMode       = 'technical';   // 'technical' | 'simplified'
    let _unsaved       = false;         // model changed since last save/load/new

    /* ── init ─────────────────────────────────────────────────────── */

    function init() {
        canvas.init('cyCanvas', {
            onEventClick:     id => dialogs.openEventEdit(id),
            onGateClick:      id => dialogs.openGateEdit(id, null),
            onGroupClick:     id => dialogs.openGroupEdit(id),
            onLinkClick:      id => dialogs.openLinkEdit(id),
            onFmedaNodeClick: _onFmedaNodeClick,
            onNetEdgeClick:   _onNetEdgeClick,
            onPositionChange: _onPositionChange
        });

        catalog.render('catalogList', _onCatalogPick, 'FTA');

        controls.init('controlsPane', {
            onRecalculate:       _runAnalysis,
            onClearAnalysis:     _clearAnalysis,
            onAutoLayout:        () => { canvas.autoLayout(); setTimeout(canvas.fit, 380); },
            onMissionTimeChange: _onMissionTimeChange,
            onScenarioPick:      sid => { activeScenario = sid; controls.markDirty(); },
            onEditScenario:      sid => dialogs.openScenarioEdit(sid),
            onDeleteScenario:    _onDeleteScenario,
            onEventClick:        id  => dialogs.openEventEdit(id),
            onGateClick:         id  => dialogs.openGateEdit(id, null),
            onNetChange:         net => { canvas.setActiveNet(net); }
        });

        dialogs.init({
            getProject:           () => project,
            applyEventCreate:     d => { const id = _placeNewEvent(d); _modelChanged(); _revealNew(id); },
            applyEventUpdate:     (id, p) => { project.updateEvent(id, p); _modelChanged(); },
            applyEventDelete:     id => { project.deleteEvent(id);   _modelChanged(); },
            applyGateCreate:      d => { _placeNewGate(d);             _modelChanged(); },
            applyGateUpdate:      (id, p) => { project.updateGate(id, p);  _modelChanged(); },
            applyGateDelete:      id => { project.deleteGate(id);    _modelChanged(); },
            applyLinkCreate:      d => { project.addLink(d);             _modelChanged(); },
            applyLinkUpdate:      (id, p) => { project.updateLink(id, p); _modelChanged(); },
            applyLinkDelete:      id => { project.deleteLink(id);    _modelChanged(); },
            applyGroupCreate:     (d, members) => {
                                    const g = project.addGroup(d);
                                    if (members) _setGroupMembers(g.id, members);
                                    _modelChanged();
                                    _revealNew(g.id);
                                    return g.id;
                                  },
            applyGroupUpdate:     (id, p, members) => {
                                    project.updateGroup(id, p);
                                    if (members) _setGroupMembers(id, members);
                                    _modelChanged();
                                  },
            applyGroupDelete:     id => { project.deleteGroup(id);   _modelChanged(); },
            applyCopyFailureModes: (targetFnId, sourceIds) => {
                                    (sourceIds || []).forEach(sid =>
                                        project.copyFailureModeInto(sid, targetFnId));
                                    _modelChanged();
                                  },
            applyScenarioCreate:  d => { project.addScenario(d);     _modelChanged(); },
            applyScenarioUpdate:  (id, p) => { project.updateScenario(id, p); _modelChanged(); },
            applyScenarioDelete:  id => { project.deleteScenario(id); _modelChanged(); }
        });

        _bindEvents();
        _bindViewModeToggle();
        _bindModeToggle();
        _showVersion();
        _showIntro();

        // Guard against losing work on refresh/close. The browser shows its
        // own generic confirmation when we set returnValue; we only arm it
        // while there are unsaved changes, so a clean/just-saved project
        // closes without nagging.
        window.addEventListener('beforeunload', e => {
            if (!_unsaved) return;
            e.preventDefault();
            e.returnValue = '';   // required for the prompt to show in Chrome
            return '';
        });
    }

    /* ── FTA / ETA mode toggle (header) ──────────────────────────────── */

    function _bindModeToggle() {
        document.querySelectorAll('.mode-btn').forEach(b => {
            b.addEventListener('click', () => {
                if (b.classList.contains('disabled')) return;  // no project yet
                _setMode(b.getAttribute('data-appmode'));
            });
        });
        _setModeButtonsEnabled(false);   // disabled until a project exists
    }

    /* Enable/disable the FTA/ETA/FMEDA toggle. Before a project is started
       there is nothing to switch, so the buttons are disabled and carry a
       tooltip explaining why. */
    function _setModeButtonsEnabled(on) {
        document.querySelectorAll('.mode-btn').forEach(b => {
            b.classList.toggle('disabled', !on);
            if (on) {
                // Restore the per-mode descriptive tooltip.
                b.title = b.getAttribute('data-tip') || '';
            } else {
                if (!b.getAttribute('data-tip')) b.setAttribute('data-tip', b.title);
                b.title = 'Start or open a project first to choose an analysis mode.';
            }
        });
    }

    /* Switch the whole studio between fault-tree and event-tree mode.
       The two models are independent — switching never migrates data,
       it just shows the other model and its tooling. */
    function _setMode(mode) {
        if (!project) return;
        const m = project.setMode(mode);
        _lastAnalysis = null;
        _syncModeUI(m);
        canvas.resetVisuals();
        _refreshCanvas();
        controls.renderProject(project);
        setTimeout(() => { canvas.fit(); }, 60);
    }

    /* Push the current mode into the header pill, the catalog and the
       controls panel. Used both by the toggle and on project load. */
    function _syncModeUI(mode) {
        const m = ['ETA','FMEDA'].includes(mode) ? mode : 'FTA';
        document.querySelectorAll('.mode-btn').forEach(b =>
            b.classList.toggle('on', b.getAttribute('data-appmode') === m));
        catalog.setMode(m);
        controls.setMode(m);
    }

    /* Stamp the tool version into the header. Sourced from CONFIG so the
       single bump per iteration propagates everywhere it's shown. */
    function _showVersion() {
        const el = document.getElementById('appVersion');
        if (el) el.textContent = 'v' + (CONFIG.appVersion || '?');
    }

    function _bindEvents() {
        document.getElementById('fileInput')
            .addEventListener('change', _handleUpload);

        const lT = document.getElementById('drawerCatalog');
        const rT = document.getElementById('drawerControls');
        if (lT) lT.addEventListener('click', e => {
            e.stopPropagation();
            document.body.classList.toggle('show-catalog');
            document.body.classList.remove('show-controls');
        });
        if (rT) rT.addEventListener('click', e => {
            e.stopPropagation();
            document.body.classList.toggle('show-controls');
            document.body.classList.remove('show-catalog');
        });
        document.addEventListener('click', e => {
            const b = document.body;
            if (!b.classList.contains('show-catalog') &&
                !b.classList.contains('show-controls')) return;
            if (e.target.closest('.panel-left,.panel-right,.drawer-btn')) return;
            b.classList.remove('show-catalog', 'show-controls');
        });
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (_netLink) { _netLink = null; _flash('Net link cancelled.'); }
                document.body.classList.remove('show-catalog', 'show-controls');
            }
        });
    }

    /* ── View mode toggle (canvas toolbar) ───────────────────────── */

    function _bindViewModeToggle() {
        document.querySelectorAll('.viewmode-btn').forEach(b => {
            b.addEventListener('click', () => {
                const m = b.getAttribute('data-mode');
                _setViewMode(m);
            });
        });
    }

    function _setViewMode(mode) {
        viewMode = (mode === 'simplified') ? 'simplified' : 'technical';
        document.querySelectorAll('.viewmode-btn').forEach(b => {
            b.classList.toggle('on', b.getAttribute('data-mode') === viewMode);
        });
        canvas.setViewMode(viewMode);
        controls.setViewMode(viewMode);
    }

    /* ── Smart positioning of newly-created entities ──────────────── */

    /* Place a new event at the centre of the visible viewport so it
       appears near where the user is looking. Falls back to the model's
       default (200,200) if cytoscape isn't ready yet. */
    function _placeNewEvent(data) {
        // FMEDA failure modes auto-stack inside their function; leave them
        // unplaced (x/y = 0) so the FMEDA layout positions them. FTA/ETA
        // events get dropped at the viewport center as before.
        if (project.mode === 'FMEDA') {
            data.x = 0; data.y = 0;
        } else {
            const pos = canvas.viewportCenter ? canvas.viewportCenter() : null;
            if (pos) { data.x = pos.x; data.y = pos.y; }
        }
        const created = project.addEvent(data);
        // addEvent only consumes name/kind/x/y/description/groupId and fills
        // everything else from defaults. Apply the REMAINING draft fields
        // (probMode, rate, DC, mitigation, evidence, target, …) so values
        // typed in the CREATE dialog are not silently dropped. kind/name/pos/
        // group are deliberately excluded — addEvent already set them, and
        // re-applying kind here would re-trigger the single-top demotion.
        const { name, kind, x, y, description, groupId, ...rest } = data;
        project.updateEvent(created.id, rest);
        return created.id;
    }

    /* After a create + re-render, pan a new FMEDA node into view if it would
       otherwise sit off-screen (a freshly-added element shouldn't appear
       outside the viewport). FTA/ETA nodes already spawn at the viewport
       centre, so this is FMEDA-only. Deferred a tick so the canvas has laid
       the node out first. */
    function _revealNew(id) {
        if (!id || !project || project.mode !== 'FMEDA') return;
        if (!canvas.revealNode) return;
        setTimeout(() => canvas.revealNode(id), 0);
    }

    /* Place a new gate at the centroid of its inputs + output so the
       wiring fans naturally instead of starting from (300,300). */
    function _placeNewGate(data) {
        const inIds = (data.inputs || []).slice();
        if (data.output) inIds.push(data.output);
        const pts = inIds
            .map(id => canvas.nodePosition && canvas.nodePosition(id))
            .filter(Boolean);
        if (pts.length > 0) {
            const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
            const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
            data.x = cx;
            data.y = cy;
        } else {
            const c = canvas.viewportCenter ? canvas.viewportCenter() : null;
            if (c) { data.x = c.x; data.y = c.y; }
        }
        project.addGate(data);
    }

    /* Atomic membership update for groups — mutates each affected event's
       groupId directly so the whole save fires only one _modelChanged. */
    function _setGroupMembers(gid, memberIds) {
        const sel = new Set(memberIds);
        project.events.forEach(ev => {
            const wasIn = ev.groupId === gid;
            const nowIn = sel.has(ev.id);
            if (wasIn && !nowIn)      project.updateEvent(ev.id, { groupId: null });
            else if (!wasIn && nowIn) project.updateEvent(ev.id, { groupId: gid });
        });
    }

    /* ── intro / studio screens ──────────────────────────────────── */

    function _showIntro() {
        document.getElementById('introScreen').style.display = 'flex';
        document.getElementById('studio').style.display      = 'none';
    }
    function _showStudio() {
        document.getElementById('introScreen').style.display = 'none';
        document.getElementById('studio').style.display      = 'flex';
        setTimeout(() => { canvas.fit(); }, 0);
    }

    /* ── render cycle ────────────────────────────────────────────── */

    function _refreshCanvas() {
        if (!project) return;
        canvas.render(project);
    }

    /* Lightweight transient status toast (used by FMEDA net-link flow to
       guide the two-click connect). Self-removing; no dependencies. */
    let _flashTimer = null;
    function _flash(msg) {
        let el = document.getElementById('fasFlash');
        if (!el) {
            el = document.createElement('div');
            el.id = 'fasFlash';
            el.setAttribute('role', 'status');
            el.style.cssText =
                'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
                'background:#2c2c2a;color:#fbfaf6;padding:8px 14px;border-radius:6px;' +
                'font-size:13px;z-index:9999;max-width:520px;box-shadow:0 2px 8px rgba(0,0,0,0.25);';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'block';
        clearTimeout(_flashTimer);
        _flashTimer = setTimeout(() => { el.style.display = 'none'; }, 4200);
    }

    function _modelChanged() {
        _unsaved = true;
        _refreshCanvas();
        controls.renderProject(project);
        // A model edit invalidates the last computed result. In FMEDA the
        // residual roll-up is cleared outright (it must be recomputed before
        // it means anything); FTA/ETA keep their last analysis on screen but
        // flag it stale.
        if (project && project.mode === 'FMEDA') {
            _lastAnalysis = null;
            controls.clearAnalysis();
        } else {
            controls.markDirty();
        }
        _updateHeaderName();
    }

    function _updateHeaderName() {
        const el = document.getElementById('projectNamePill');
        if (!el) return;
        if (project && project.name) {
            el.textContent   = project.name;
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    }

    /* ── catalog handlers ────────────────────────────────────────── */

    function _onCatalogPick(kind) {
        if (!project) return;
        switch (kind) {
            case 'event-basic':
            case 'event-intermediate':
            case 'event-top':
                dialogs.openEventEdit(null, kind);
                break;
            case 'gate-AND':
            case 'gate-OR':
            case 'gate-VOTING':
            case 'gate-INHIBIT':
                dialogs.openGateEdit(null, kind.replace('gate-', ''));
                break;
            case 'link':
                dialogs.openLinkEdit(null);
                break;
            case 'group':
                dialogs.openGroupEdit(null);
                break;
            case 'scenario':
                dialogs.openScenarioEdit(null);
                break;
            // ── FMEDA ──
            case 'fmeda-element':
                _fmedaAddElement('low');
                break;
            case 'fmeda-function':
                _fmedaAddFunction();
                break;
            case 'fmeda-fm':
                _fmedaAddFailureMode();
                break;
            case 'fmeda-net-arch':
            case 'fmeda-net-func':
            case 'fmeda-net-fail':
                _fmedaStartNetLink(kind.replace('fmeda-net-', ''));
                break;
        }
    }

    /* ── FMEDA create flows ──────────────────────────────────────────
       Kept deliberately lightweight: create the node, re-render, and let
       the user rename/edit it via its normal edit dialog. Elements and
       functions reuse the group edit dialog; failure modes reuse the
       event editor (basic event), which already has λ/coverage/evidence. */

    function _fmedaAddElement(level) {
        // Open the editor in CREATE mode with a draft — the element is only
        // committed when the user clicks Save (Cancel leaves nothing behind).
        dialogs.openGroupEdit(null, {
            kind: 'element', level: level,
            name: 'Element ' + (project.elementGroups().length + 1)
        });
    }

    function _fmedaAddFunction() {
        const elements = project.elementGroups();
        if (!elements.length) {
            alert('Add an architecture element first — a function lives inside one.');
            return;
        }
        const parentId = (_fmedaSel.elementId &&
                          project.groupById(_fmedaSel.elementId) &&
                          project.groupById(_fmedaSel.elementId).kind === 'element')
            ? _fmedaSel.elementId : elements[0].id;
        dialogs.openGroupEdit(null, {
            kind: 'function', parentId,
            name: 'Function ' + (project.functionGroups().length + 1)
        });
    }

    function _fmedaAddFailureMode() {
        const fns = project.functionGroups();
        if (!fns.length) {
            alert('Add a function first — a failure mode lives inside one.');
            return;
        }
        const fnId = (_fmedaSel.functionId &&
                      project.groupById(_fmedaSel.functionId) &&
                      project.groupById(_fmedaSel.functionId).kind === 'function')
            ? _fmedaSel.functionId : fns[0].id;
        // Draft a new failure mode; openEventEdit(null, draft) commits only
        // on Save.
        dialogs.openEventEdit(null, 'event-basic', {
            groupId: fnId, x: 0, y: 0,
            name: 'Failure mode ' + (project.basicEvents().length + 1)
        });
    }

    /* Remember the last element/function the user touched, so "add
       function / add failure mode" target the right container. */
    const _fmedaSel = { elementId: null, functionId: null };

    /* Net-link connect flow: prompt the user to click two nodes of the
       right type. State is held in _netLink; the canvas tap handler
       (below) completes the edge. */
    let _netLink = null;
    function _fmedaStartNetLink(net) {
        _netLink = { net, from: null };
        canvas.setActiveNet(net);     // show the net we're editing
        controls.setActiveNet(net);   // and sync the toggle highlight
        const first = net === 'fail'
            ? 'Click the CAUSE failure first (the root), then the failure it propagates to.'
            : (net === 'arch' ? 'Click the first element, then the one it connects to.'
                              : 'Click the first function, then the one it connects to.');
        _flash(first + ' Esc to cancel.');
    }
    function _fmedaNetClick(nodeId, nodeType) {
        if (!_netLink) return false;
        const wantType = _netLink.net === 'arch' ? 'fmeda-element'
                       : _netLink.net === 'func' ? 'fmeda-function'
                       : 'fmeda-fm';
        if (nodeType !== wantType) return false;   // ignore wrong-type taps
        if (!_netLink.from) {
            _netLink.from = nodeId;
            _flash(_netLink.net === 'fail'
                ? 'Now click the EFFECT failure (the one this cause defeats).'
                : 'Now click the second node to connect.');
            return true;
        }
        // from = cause/source, to = effect/target. Direction matters for the
        // failure net (cause → effect drives the common-cause finding).
        const ed = project.addNetEdge({
            net: _netLink.net, from: _netLink.from, to: nodeId });
        _netLink = null;
        if (ed) { _unsaved = true; controls.markDirty(); _refreshCanvas(); controls.renderProject(project); }
        else    { _flash('These two could not be connected.'); }
        return true;
    }

    /* Canvas tap on any FMEDA node. If a net-link is being drawn, try to
       complete it; otherwise open the node's editor. */
    /* Delete a failure/architecture/function net connection. Reuses the
       same confirm-then-delete pattern as FTA links. */
    function _onNetEdgeClick(edgeId) {
        if (_netLink) return;   // mid-connect: ignore taps on edges
        dialogs.confirm('Delete connection?',
            'Remove this connection. (If it was one of several converging on a '
            + 'target, the AND/OR gate collapses automatically.)',
            () => {
                project.deleteNetEdge(edgeId);
                _unsaved = true;
                _refreshCanvas();
                controls.renderProject(project);
            });
    }

    function _onFmedaNodeClick(id, type, targetId) {
        if (_netLink && _fmedaNetClick(id, type)) return;
        // Convergence gate: toggle AND/OR.
        if (type === 'fmeda-failgate' && targetId) {
            const cur = project.failGateOf(targetId);
            project.setFailGate(targetId, cur === 'OR' ? 'AND' : 'OR');
            _unsaved = true;
            _refreshCanvas();
            _flash('Convergence set to ' + project.failGateOf(targetId) +
                   ' for this effect.');
            return;
        }
        // Remember context so the next "add function/FM" targets here.
        if (type === 'fmeda-element') {
            _fmedaSel.elementId = id;
            _fmedaSel.functionId = null;
            dialogs.openGroupEdit(id);
        } else if (type === 'fmeda-function') {
            _fmedaSel.functionId = id;
            const fn = project.groupById(id);
            _fmedaSel.elementId = fn ? fn.parentId : _fmedaSel.elementId;
            dialogs.openGroupEdit(id);
        } else if (type === 'fmeda-fm') {
            const e = project.eventById(id);
            if (e && e.groupId) {
                _fmedaSel.functionId = e.groupId;
                const fn = project.groupById(e.groupId);
                _fmedaSel.elementId = fn ? fn.parentId : _fmedaSel.elementId;
            }
            dialogs.openEventEdit(id);
        }
    }

    /* ── canvas handlers ─────────────────────────────────────────── */

    function _onPositionChange(kind, id, x, y) {
        if (!project) return;
        if (kind === 'event') project.updateEvent(id, { x, y });
        if (kind === 'gate')  project.updateGate(id,  { x, y });
        if (kind === 'fmeda-fm') {
            // FMEDA failure modes save their position; a moved layout is
            // unsaved work worth guarding.
            project.updateEvent(id, { x, y });
            _unsaved = true;
        }
        if (kind === 'fmeda-element' || kind === 'fmeda-function') {
            // Save the group's own spot (matters for EMPTY groups; populated
            // ones derive from their children, whose positions are persisted
            // alongside in the same drag).
            project.updateGroup(id, { x, y });
            _unsaved = true;
        }
        if (kind === 'fmeda-failgate') {
            // The gate node id is '_fgate_<targetFailureId>'. Persist keyed by
            // the target so the gate keeps its spot through re-render/reload.
            const targetId = id.replace(/^_fgate_/, '');
            project.setFailGatePos(targetId, x, y);
            _unsaved = true;
        }
        // Probability math doesn't depend on (x, y); no re-render needed.
    }

    /* ── controls handlers ───────────────────────────────────────── */

    function _onMissionTimeChange(h) {
        if (!project) return;
        project.missionTime = h;
        _modelChanged();
    }

    function _onDeleteScenario(sid) {
        const s = project.scenarioById(sid);
        if (!s) return;
        dialogs.confirm('Delete scenario?',
            'Remove "' + s.name + '".',
            () => {
                if (activeScenario === sid) activeScenario = null;
                project.deleteScenario(sid);
                _modelChanged();
                controls.setActiveScenario(activeScenario);
            });
    }

    /* ── analysis run ────────────────────────────────────────────── */

    function _runAnalysis(scenarioId) {
        if (!project) return;
        // FMEDA mode: no top event — Recalculate computes the residual
        // dangerous-undetected rate per failure mode, rolled up per
        // function and element, and shows it in the panel.
        if (project.mode === 'FMEDA') {
            const rollup = project.fmedaRollup();
            rollup.safetyRequirements = project.safetyRequirements();
            rollup.metrics = project.fmedaMetrics();
            controls.applyFmedaRollup(rollup);
            _refreshCanvas();   // refresh handled/green coloring too
            return;
        }
        // ETA mode: forward enumeration, no top event required.
        if (project.mode === 'ETA') {
            const result = analyzer.analyzeETA(project, scenarioId || null);
            canvas.applyAnalysis(result);
            controls.applyAnalysis(result);
            _lastAnalysis = result;
            return;
        }
        if (!project.topEvent()) {
            dialogs.confirm('No top event',
                'Mark one event as kind = "top" before running an analysis. Open the event and switch its kind.',
                () => {});
            return;
        }
        const result = analyzer.analyze(project, scenarioId || null);
        canvas.applyAnalysis(result);
        controls.applyAnalysis(result);
        _lastAnalysis = result;
    }

    function _clearAnalysis() {
        _lastAnalysis = null;
        canvas.resetVisuals();
        controls.clearAnalysis();
    }

    let _lastAnalysis = null;

    /* ── file I/O ────────────────────────────────────────────────── */

    function newProject() {
        const hasContent = project &&
            (project.events.length > 0 || project.gates.length > 0 ||
             project.groups.length > 0 || project.scenarios.length > 0);
        if (hasContent) {
            dialogs.confirm('Discard current project?',
                'You\'ll lose any unsaved changes to "' +
                (project.name || 'this project') +
                '". Use Save first if you want to keep it.',
                () => dialogs.openNewProject(_proceedNewProject, _proceedDemo));
            return;
        }
        dialogs.openNewProject(_proceedNewProject, _proceedDemo);
    }

    function _proceedDemo() {
        fmt.resetUid();
        project = (typeof demo !== 'undefined' && demo.build)
            ? demo.build() : new Project('Demo');
        activeScenario = null;
        _lastAnalysis  = null;
        _activate();
    }

    function _proceedNewProject(opts) {
        fmt.resetUid();
        project = new Project(opts.name || '');
        project.missionTime = opts.missionTime;
        activeScenario = null;
        _lastAnalysis  = null;
        _activate();
    }

    function exportReport() {
        if (!project) return;
        dialogs.openExport(project, _lastAnalysis);
    }

    function downloadProject() {
        if (!project) return;
        const json = JSON.stringify(project.toJSON(), null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = (project.name || 'fas-project').replace(/\s+/g, '_') + '.json';
        a.click();
        URL.revokeObjectURL(url);
        _unsaved = false;   // work has been saved to a file
    }

    function triggerUpload() {
        document.getElementById('fileInput').click();
    }

    function _handleUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = e => {
            try {
                project = Project.fromJSON(JSON.parse(e.target.result));
                activeScenario = null;
                _lastAnalysis  = null;
                _activate();
            } catch (err) {
                alert('Could not load project: ' + err.message);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }

    function _activate() {
        _showStudio();
        _unsaved = false;   // freshly created or loaded — nothing unsaved yet
        canvas.setEditable(true);
        catalog.setEnabled(true);
        _setModeButtonsEnabled(true);
        // Reflect the loaded project's mode across the pill, catalog and
        // panel before the first render so ETA files open as event trees.
        _syncModeUI(project.mode);
        controls.setActiveScenario(activeScenario);
        _refreshCanvas();
        controls.renderProject(project);
        controls.clearAnalysis();
        _updateHeaderName();
        // Sync view mode across canvas + controls (toolbar pill is the
        // source of truth in the DOM).
        _setViewMode(viewMode);
        const anyPositioned = project.events.some(e => e.x || e.y);
        if (!anyPositioned && project.events.length > 0) {
            setTimeout(() => { canvas.autoLayout(); }, 60);
        } else {
            setTimeout(() => { canvas.fit(); }, 60);
        }
    }

    return {
        init,
        newProject, downloadProject, triggerUpload, exportReport,
        getProject: () => project,
        _test_pickCatalog: (kind) => _onCatalogPick(kind)
    };
})();

/* Bootstrapping. */
window.addEventListener('DOMContentLoaded', () => {
    if (typeof cytoscape === 'undefined') {
        document.body.innerHTML = `
            <div style="display:flex;flex-direction:column;align-items:center;
                justify-content:center;height:100vh;gap:1rem;
                font-family:'Outfit',sans-serif;color:#5b1814;
                background:#f3c1bd;text-align:center;padding:2rem;">
                <div style="font-size:1.1rem;font-weight:600;">Cytoscape not loaded</div>
                <div style="font-size:0.82rem;color:#555;max-width:520px;line-height:1.6;">
                    The diagram library is missing. Make sure
                    <code>lib/cytoscape.min.js</code>,
                    <code>lib/dagre.min.js</code> and
                    <code>lib/cytoscape-dagre.js</code>
                    are next to <code>index.html</code>.
                </div>
            </div>`;
        return;
    }
    main.init();
});
