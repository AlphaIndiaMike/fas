/**
 * canvas.js
 * Functional Analysis Studio [FAS] — Cytoscape-backed diagram canvas.
 *
 * Owns the cytoscape instance. Translates Project → graph elements:
 *   · group  → compound (parent) node, labeled, coloured
 *   · event  → child node inside its group (or top-level if none)
 *   · gate   → standalone node
 *   · edges  → input arrows (event/event → gate), output arrow (gate → event)
 *
 * Public:
 *   canvas.init(containerId, callbacks)
 *     callbacks = {
 *       onEventClick(eventId),
 *       onGateClick(gateId),
 *       onGroupClick(groupId),
 *       onPositionChange(kind, id, x, y)   // kind: 'event' | 'gate'
 *     }
 *   canvas.render(project)              — full rebuild
 *   canvas.applyAnalysis(analysis)      — paint nodes by computed PFD,
 *                                         badges, FFI outlines, gate labels
 *   canvas.resetVisuals()               — clear analysis paint
 *   canvas.setEditable(bool)            — toggle drag affordance
 *   canvas.autoLayout()                 — dagre LR arrange
 *   canvas.fit()                        — fit-to-viewport
 *
 * Depends on: cytoscape, cytoscape-dagre, dagre (lib/),
 *             config.js, fmt.js, fas.js (Project type)
 */

const canvas = (() => {

    let cy            = null;
    let api           = {};
    let lastProject   = null;
    let lastAnalysis  = null;
    let editable      = true;
    let _dagreLoaded  = false;
    let viewMode      = 'technical';   // 'technical' | 'simplified'

    /* ── init ─────────────────────────────────────────────────────── */

    function init(containerId, callbacks) {
        api = callbacks || {};

        if (!_dagreLoaded && typeof cytoscapeDagre !== 'undefined') {
            cytoscape.use(cytoscapeDagre);
            _dagreLoaded = true;
        }

        cy = cytoscape({
            container: document.getElementById(containerId),
            wheelSensitivity: 0.25,
            minZoom: 0.3,
            maxZoom: 2.5,
            boxSelectionEnabled: false,
            selectionType: 'single',
            style: _styles(),
            elements: []
        });

        cy.on('tap', 'node', evt => {
            if (!editable) return;
            const n = evt.target;
            const t = n.data('type');
            if (t === 'event' && api.onEventClick) api.onEventClick(n.id());
            if (t === 'gate'  && api.onGateClick)  api.onGateClick(n.id());
            if (t === 'group' && api.onGroupClick) api.onGroupClick(n.id());
        });

        cy.on('dragfree', 'node', evt => {
            if (!api.onPositionChange) return;
            const n  = evt.target;
            const p  = n.position();
            const tp = n.data('type');
            if (tp === 'event' || tp === 'gate') {
                api.onPositionChange(tp, n.id(), p.x, p.y);
            }
        });
    }

    /* ── Cytoscape stylesheet ─────────────────────────────────────── */

    function _styles() {
        return [
            /* ── Group compound nodes ────────────────────────────── */
            {
                selector: 'node[type="group"]',
                style: {
                    'shape':                'round-rectangle',
                    'background-color':     'data(bg)',
                    'background-opacity':   0.18,
                    'border-color':         'data(color)',
                    'border-width':         1.5,
                    'border-style':         'dashed',
                    'label':                'data(label)',
                    'text-valign':          'top',
                    'text-halign':          'center',
                    'text-margin-y':        -8,
                    'font-family':          'Outfit, sans-serif',
                    'font-size':            10,
                    'font-weight':          700,
                    'color':                'data(color)',
                    'letter-spacing':       1.2,
                    'text-transform':       'uppercase',
                    'padding':              '14px',
                    'compound-sizing-wrt-labels': 'include'
                }
            },

            /* ── Event nodes (default neutral) ──────────────────── */
            {
                selector: 'node[type="event"]',
                style: {
                    'shape':                'round-rectangle',
                    'width':                'label',
                    'height':               'label',
                    'padding':              '12px',
                    'background-color':     '#efeadb',
                    'border-color':         '#a89e7e',
                    'border-width':         1.5,
                    'label':                'data(label)',
                    'text-wrap':            'wrap',
                    'text-valign':          'center',
                    'text-halign':          'center',
                    'color':                '#2a2417',
                    'font-family':          'Outfit, sans-serif',
                    'font-size':            12,
                    'font-weight':          500,
                    'line-height':          1.4,
                    'transition-property':  'background-color, border-color, color',
                    'transition-duration':  '180ms'
                }
            },
            /* Basic events: ellipse (FTA convention). */
            {
                selector: 'node[type="event"][kind="basic"]',
                style: {
                    'shape':   'ellipse',
                    'padding': '16px'
                }
            },
            /* Top event: square, dark gold (system-level visual anchor). */
            {
                selector: 'node[type="event"][kind="top"]',
                style: {
                    'shape':            'rectangle',
                    'background-color': '#3a2e0a',
                    'border-color':     '#1f1805',
                    'color':            '#f6efce',
                    'font-weight':      600
                }
            },

            /* ── Heatmap classes for basic events ────────────────── */
            {
                selector: 'node[type="event"].heat-cool',
                style: {
                    'background-color': '#c8e7d2',
                    'border-color':     '#7bbf95',
                    'color':            '#1c4d31'
                }
            },
            {
                selector: 'node[type="event"].heat-warm',
                style: {
                    'background-color': '#f1ecbe',
                    'border-color':     '#cdb96b',
                    'color':            '#5a4b1a'
                }
            },
            {
                selector: 'node[type="event"].heat-hot',
                style: {
                    'background-color': '#f3c7a6',
                    'border-color':     '#d99466',
                    'color':            '#5b3414'
                }
            },
            {
                selector: 'node[type="event"].heat-burn',
                style: {
                    'background-color': '#e8b1a9',
                    'border-color':     '#c45f55',
                    'color':            '#5b1814'
                }
            },
            {
                selector: 'node[type="event"].forced',
                style: {
                    'border-width': 3,
                    'border-style': 'double'
                }
            },

            /* ── Gate nodes ──────────────────────────────────────── */
            {
                selector: 'node[type="gate"]',
                style: {
                    'shape':            'round-rectangle',
                    'width':            60,
                    'height':           42,
                    'background-color': '#2a2417',
                    'border-color':     '#15110a',
                    'border-width':     2,
                    'label':            'data(label)',
                    'color':            '#f6efce',
                    'text-valign':      'center',
                    'text-halign':      'center',
                    'font-family':      'Outfit, sans-serif',
                    'font-size':        11,
                    'font-weight':      700,
                    'letter-spacing':   1
                }
            },
            {
                selector: 'node[type="gate"].ffi',
                style: {
                    'border-color': '#c0392b',
                    'border-width': 3,
                    'border-style': 'dashed'
                }
            },

            /* ── Edges ───────────────────────────────────────────── */
            {
                selector: 'edge',
                style: {
                    'width':              2,
                    'line-color':         '#9c907a',
                    'target-arrow-color': '#9c907a',
                    'target-arrow-shape': 'triangle',
                    'curve-style':        'bezier',
                    'arrow-scale':        0.9
                }
            },
            {
                selector: 'edge[type="gate-in"]',
                style: { 'line-color': '#6b6045', 'target-arrow-color': '#6b6045' }
            },
            {
                selector: 'edge[type="gate-out"]',
                style: {
                    'line-color':         '#3d2f0c',
                    'target-arrow-color': '#3d2f0c',
                    'width':              2.5
                }
            },
            {
                selector: 'node:active',
                style: { 'overlay-opacity': 0 }
            }
        ];
    }

    /* ── render: Project → cytoscape elements ────────────────────── */

    function render(project) {
        if (!cy) return;
        lastProject = project;
        cy.elements().remove();
        cy.add(_projectToElements(project));
        _refreshGrabbable();
    }

    function _projectToElements(project) {
        const els = [];

        // Groups first (cytoscape needs parents present before children
        // reference them).
        project.groups.forEach((gr, i) => {
            els.push({
                group: 'nodes',
                data: {
                    id:    gr.id,
                    type:  'group',
                    label: gr.name,
                    color: gr.color,
                    bg:    gr.color
                },
                /* Compound nodes derive position from children — no
                   need to seed it. */
                selectable: true
            });
        });

        project.events.forEach((e, i) => {
            const pos = (e.x || e.y) ? { x: e.x, y: e.y } : _gridSpot(i);
            const data = {
                id:    e.id,
                type:  'event',
                kind:  e.kind,
                label: _eventLabel(e, null)
            };
            if (e.groupId && project.groupById(e.groupId)) {
                data.parent = e.groupId;
            }
            els.push({
                group: 'nodes',
                data,
                position: pos
            });
        });

        project.gates.forEach((g, i) => {
            const pos = (g.x || g.y) ? { x: g.x, y: g.y }
                                     : _gridSpot(project.events.length + i);
            els.push({
                group: 'nodes',
                data:  { id: g.id, type: 'gate', label: _gateLabel(g) },
                position: pos
            });

            // Input edges (event → gate)
            g.inputs.forEach(srcId => {
                if (!project.eventById(srcId)) return;
                els.push({
                    group: 'edges',
                    data: {
                        id:     g.id + '__in__' + srcId,
                        source: srcId, target: g.id,
                        type:   'gate-in'
                    }
                });
            });
            // Output edge (gate → event)
            if (g.output && project.eventById(g.output)) {
                els.push({
                    group: 'edges',
                    data: {
                        id:     g.id + '__out',
                        source: g.id, target: g.output,
                        type:   'gate-out'
                    }
                });
            }
        });

        return els;
    }

    function _eventLabel(e, analysisEntry) {
        // No analysis yet → just the name.
        if (!analysisEntry || analysisEntry.pfd == null) {
            return e.name;
        }
        const t = (lastProject && lastProject.missionTime) ||
                  CONFIG.defaultMissionTime;
        const pfd = analysisEntry.pfd;
        const pfh = analysisEntry.pfh;

        // Blank line after the name separates it from the data block.
        // Cytoscape renders a node label as a single piece of text, so
        // per-line bold/size isn't possible — the blank line gives the
        // visual breathing room without any tricks.
        if (viewMode === 'simplified') {
            let s = e.name + '\n\nPoF: ' + fmt.inHoursStr(pfd, t);
            if (analysisEntry.forced) s += '  ◆';
            return s;
        }

        const lines = [e.name, ''];
        if (e.kind === 'basic') {
            lines.push('λ = ' + fmt.fitStr(pfh * 1e9));
        }
        lines.push('PFH = ' + fmt.perHourStr(pfh));
        lines.push('PFD = ' + fmt.probStr(pfd) + ' (' + fmt.pctStr(pfd) + ')');
        let label = lines.join('\n');
        if (analysisEntry.forced) label += '  ◆';
        return label;
    }

    function _gateLabel(g) {
        if (g.type === 'VOTING') return g.k + '-of-' + g.inputs.length;
        return g.type;
    }

    function _gridSpot(i) {
        const cols = 4;
        const gx   = 220;
        const gy   = 150;
        return { x: 120 + (i % cols) * gx, y: 100 + Math.floor(i / cols) * gy };
    }

    /* ── analysis paint (heatmap + FFI + labels) ─────────────────── */

    function applyAnalysis(analysis) {
        if (!cy || !lastProject) return;
        lastAnalysis = analysis;

        // Clear previous classes/state.
        cy.nodes('[type="event"]').removeClass('heat-cool heat-warm heat-hot heat-burn forced');
        cy.nodes('[type="gate"]').removeClass('ffi');

        // Per-event paint.
        analysis.events.forEach(ae => {
            const n = cy.getElementById(ae.id);
            if (!n || n.length === 0) return;
            const ev = lastProject.eventById(ae.id);
            if (!ev) return;
            // Update label.
            n.data('label', _eventLabel(ev, ae));
            // Heatmap only for basic events (others derive from the
            // gates and would mislead — the colour should reflect leaf
            // contribution, not aggregate position).
            if (ev.kind === 'basic') {
                n.addClass(_heatClass(ae.pfd));
            }
            if (ae.forced) n.addClass('forced');
        });

        // FFI gates.
        const ffiGateIds = new Set(
            analysis.warnings.filter(w => w.kind === 'ffi')
                             .map(w => w.gateId)
        );
        ffiGateIds.forEach(gid => {
            const n = cy.getElementById(gid);
            if (n && n.length) n.addClass('ffi');
        });
    }

    function _heatClass(pfd) {
        if (pfd == null || isNaN(pfd) || pfd <= 0) return 'heat-cool';
        const h    = CONFIG.heatmap;
        const logP = Math.log10(pfd);
        const logLo = Math.log10(h.minP);
        const logHi = Math.log10(h.maxP);
        const t = (logP - logLo) / (logHi - logLo);
        if (t < 0.25) return 'heat-cool';
        if (t < 0.55) return 'heat-warm';
        if (t < 0.80) return 'heat-hot';
        return 'heat-burn';
    }

    /* Reset every event back to its neutral palette (no analysis). */
    function resetVisuals() {
        if (!cy || !lastProject) return;
        lastAnalysis = null;
        cy.nodes('[type="event"]').forEach(n => {
            const ev = lastProject.eventById(n.id());
            if (!ev) return;
            n.data('label', _eventLabel(ev, null));
            n.removeClass('heat-cool heat-warm heat-hot heat-burn forced');
        });
        cy.nodes('[type="gate"]').removeClass('ffi');
    }

    /* ── editable / readonly ─────────────────────────────────────── */

    function setEditable(on) {
        editable = !!on;
        _refreshGrabbable();
    }

    function _refreshGrabbable() {
        if (!cy) return;
        if (editable) cy.nodes().grabify();
        else          cy.nodes().ungrabify();
    }

    /* ── auto-layout ─────────────────────────────────────────────── */

    function autoLayout() {
        if (!cy) return;
        try {
            cy.layout({
                name:    'dagre',
                rankDir: 'LR',
                nodeSep: 55,
                edgeSep: 25,
                rankSep: 100,
                animate: true,
                animationDuration: 320
            }).run();
        } catch (err) {
            cy.layout({ name: 'grid', cols: 4 }).run();
        }
        // Persist positions back into the model after the layout
        // settles. Only fire for true nodes (events, gates) — compound
        // group nodes derive their position from children.
        setTimeout(() => {
            if (!lastProject || !api.onPositionChange) return;
            cy.nodes().forEach(n => {
                const tp = n.data('type');
                if (tp !== 'event' && tp !== 'gate') return;
                const p = n.position();
                api.onPositionChange(tp, n.id(), p.x, p.y);
            });
        }, 360);
    }

    function fit() {
        if (!cy) return;
        cy.resize();
        cy.fit(undefined, 40);
    }

    /* ── helpers for smart positioning of new entities ───────────── */

    /* Centre of the visible viewport in model coordinates. Used as the
       default spawn point for new events so they appear where the user
       is actually looking. */
    function viewportCenter() {
        if (!cy) return { x: 200, y: 200 };
        const ext = cy.extent();   // {x1,y1,x2,y2} in model coords
        return {
            x: (ext.x1 + ext.x2) / 2,
            y: (ext.y1 + ext.y2) / 2
        };
    }

    /* Position of a single node id (event or gate) in model coordinates,
       or null if not present. Used by main.js to place a new gate at the
       centroid of its inputs + output. */
    function nodePosition(id) {
        if (!cy) return null;
        const n = cy.getElementById(id);
        if (!n || n.length === 0) return null;
        const p = n.position();
        return { x: p.x, y: p.y };
    }

    /* ── View mode (technical / simplified) ──────────────────────── */

    function setViewMode(mode) {
        viewMode = (mode === 'simplified') ? 'simplified' : 'technical';
        if (!cy || !lastProject) return;
        // Repaint every event label in the new mode.
        cy.nodes('[type="event"]').forEach(n => {
            const ev = lastProject.eventById(n.id());
            if (!ev) return;
            const ae = lastAnalysis ?
                lastAnalysis.events.find(x => x.id === ev.id) : null;
            n.data('label', _eventLabel(ev, ae));
        });
    }

    function getViewMode() { return viewMode; }

    /* ── PNG export ──────────────────────────────────────────────── */

    /* Build a PNG data URL of the current canvas. `mode` controls label
       style ('technical' | 'simplified'); the canvas reverts to its
       previous mode after the export so the user's view isn't disturbed.
       Background is forced to pure white so the PNG drops cleanly into
       docs and slides without a tinted rectangle around the graph. */
    function exportPNG(mode) {
        if (!cy) return null;
        const prev = viewMode;
        setViewMode(mode || prev);
        const png = cy.png({
            output:    'blob',
            bg:        '#ffffff',
            full:      true,
            scale:     2,
            maxWidth:  4000,
            maxHeight: 4000
        });
        // Restore previous label mode.
        setViewMode(prev);
        return png;
    }

    return {
        init, render,
        applyAnalysis, resetVisuals,
        setEditable, autoLayout, fit,
        viewportCenter, nodePosition,
        setViewMode, getViewMode,
        exportPNG
    };
})();
