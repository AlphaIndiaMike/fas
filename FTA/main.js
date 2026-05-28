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

    /* ── init ─────────────────────────────────────────────────────── */

    function init() {
        canvas.init('cyCanvas', {
            onEventClick:     id => dialogs.openEventEdit(id),
            onGateClick:      id => dialogs.openGateEdit(id, null),
            onGroupClick:     id => dialogs.openGroupEdit(id),
            onPositionChange: _onPositionChange
        });

        catalog.render('catalogList', _onCatalogPick);

        controls.init('controlsPane', {
            onRecalculate:       _runAnalysis,
            onClearAnalysis:     _clearAnalysis,
            onAutoLayout:        () => { canvas.autoLayout(); setTimeout(canvas.fit, 380); },
            onMissionTimeChange: _onMissionTimeChange,
            onScenarioPick:      sid => { activeScenario = sid; controls.markDirty(); },
            onEditScenario:      sid => dialogs.openScenarioEdit(sid),
            onDeleteScenario:    _onDeleteScenario,
            onEventClick:        id  => dialogs.openEventEdit(id),
            onGateClick:         id  => dialogs.openGateEdit(id, null)
        });

        dialogs.init({
            getProject:           () => project,
            applyEventCreate:     d => { _placeNewEvent(d);            _modelChanged(); },
            applyEventUpdate:     (id, p) => { project.updateEvent(id, p); _modelChanged(); },
            applyEventDelete:     id => { project.deleteEvent(id);   _modelChanged(); },
            applyGateCreate:      d => { _placeNewGate(d);             _modelChanged(); },
            applyGateUpdate:      (id, p) => { project.updateGate(id, p);  _modelChanged(); },
            applyGateDelete:      id => { project.deleteGate(id);    _modelChanged(); },
            applyGroupCreate:     (d, members) => {
                                    const g = project.addGroup(d);
                                    if (members) _setGroupMembers(g.id, members);
                                    _modelChanged();
                                    return g.id;
                                  },
            applyGroupUpdate:     (id, p, members) => {
                                    project.updateGroup(id, p);
                                    if (members) _setGroupMembers(id, members);
                                    _modelChanged();
                                  },
            applyGroupDelete:     id => { project.deleteGroup(id);   _modelChanged(); },
            applyScenarioCreate:  d => { project.addScenario(d);     _modelChanged(); },
            applyScenarioUpdate:  (id, p) => { project.updateScenario(id, p); _modelChanged(); },
            applyScenarioDelete:  id => { project.deleteScenario(id); _modelChanged(); }
        });

        _bindEvents();
        _bindViewModeToggle();
        _showIntro();
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
            if (e.key === 'Escape')
                document.body.classList.remove('show-catalog', 'show-controls');
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
        const pos = canvas.viewportCenter ? canvas.viewportCenter() : null;
        if (pos) { data.x = pos.x; data.y = pos.y; }
        project.addEvent(data);
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

    function _modelChanged() {
        _refreshCanvas();
        controls.renderProject(project);
        controls.markDirty();
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
            case 'group':
                dialogs.openGroupEdit(null);
                break;
            case 'scenario':
                dialogs.openScenarioEdit(null);
                break;
        }
    }

    /* ── canvas handlers ─────────────────────────────────────────── */

    function _onPositionChange(kind, id, x, y) {
        if (!project) return;
        if (kind === 'event') project.updateEvent(id, { x, y });
        if (kind === 'gate')  project.updateGate(id,  { x, y });
        // Position changes don't need a re-render — but they do
        // technically "change" the model, so we do NOT mark dirty.
        // Probability math doesn't depend on (x, y).
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
                () => dialogs.openNewProject(_proceedNewProject));
            return;
        }
        dialogs.openNewProject(_proceedNewProject);
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
        canvas.setEditable(true);
        catalog.setEnabled(true);
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
        newProject, downloadProject, triggerUpload, exportReport
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
