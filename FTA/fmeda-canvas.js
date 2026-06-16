/**
 * fmeda-canvas.js
 * Functional Analysis Studio [FAS] — FMEDA-mode canvas renderer.
 *
 * FMEDA renders very differently from FTA/ETA, so it lives in its own
 * module and `canvas.render` delegates here when the project mode is
 * FMEDA. The FTA/ETA build path is left completely untouched.
 *
 * What this draws:
 *   · Architecture elements laid out LEFT-TO-RIGHT by level (top level
 *     leftmost, then mid, then low) — the level is implied by the column,
 *     not drawn as a labelled band. Each element contains its functions
 *     (nested compound nodes); each function contains its failure-mode
 *     events.   element ⊃ function ⊃ failure mode
 *   · Edges for exactly ONE net at a time (the active net), chosen by the
 *     right-pane toggle:
 *       'arch' — element ↔ element
 *       'func' — function ↔ function
 *       'fail' — failure ↔ failure   (+ common-cause hubs highlighted)
 *   Failure-net edges may connect failures at the SAME level (LL → LL) as
 *   well as across levels; composition follows those edges additively. A
 *   Mitigation element (M_n) renders with a distinct teal "barrier" style.
 *
 * Public (called by canvas.js):
 *   fmedaCanvas.elements(project, activeNet, commonCause) -> cy element array
 *   fmedaCanvas.swimlaneStyles()                          -> extra cy styles
 *
 * Depends on: fmt.js (labels), fas.js (Project type). No cytoscape import —
 * it only produces the element/style descriptors canvas.js feeds to cy.
 */

const fmedaCanvas = (() => {

    const LEVELS = ['top', 'mid', 'low'];

    // Layout geometry (cytoscape uses these as seed positions; elements are
    // compound so they auto-size around children, but seeding keeps the
    // left-to-right ordering of element columns stable).
    const LANE_H   = 240;   // vertical spacing between stacked elements in a column
    const LANE_GAP = 40;
    const COL_W    = 360;   // horizontal slot per level column
    const FN_GAP_Y = 130;   // vertical spacing between stacked functions in an element
    const FM_W     = 150;
    const FM_H     = 52;

    /* Build the cytoscape element array for the whole FMEDA model. */
    function elements(project, activeNet, commonCause) {
        const els = [];
        const ccSourceIds = new Set((commonCause || []).map(f => f.sourceId));
        const ccTargetIds = new Set();
        (commonCause || []).forEach(f =>
            f.targets.forEach(t => ccTargetIds.add(t.eventId)));

        // ── Integrity lens (mirror of the right-pane behaviour) ──────────
        // The results panel reports under ONE scale — ASIL under the ISO
        // 26262 lens, SIL under the IEC 61508 lens — and never the pair: a
        // "SIL 4 / ASIL D" pairing reads as a false equivalence (an ASIL D
        // element does not satisfy SIL 4). The canvas follows the same lens,
        // so `bandFor` yields the active rate-band scale only.
        const iso = (project.standard !== 'IEC61508');
        const bandFor = pfh => iso ? fmt.asilForPfh(pfh) : fmt.silForPfh(pfh);
        // What the canvas labels carry, per the methodology (see the v2.7.3
        // changelog):
        //   · a FAILURE MODE shows its FIT only — a mode is classified and
        //     counted, it is NOT assigned an integrity level, so no band.
        //   · a FUNCTION shows its residual FIT and the rate-band that rate
        //     reaches (the informative per-function integrity; functions have
        //     no SPFM/LFM of their own). Read from the residual roll-up.
        //   · an ELEMENT shows ONLY its achieved integrity band, from
        //     `fmedaElementBands`: a LEAF (low) element from its AGGREGATED
        //     random-hardware metrics; a ROLL-UP (mid/top) element from those
        //     same metrics aggregated over the leaves that feed it (so MAL_/
        //     TAL_ reflect their subtree's real SPFM/LFM/PMHF, capped by Route
        //     1ₕ — the system verdict, never an optimistic rate-only band).
        //     The same map drives the right pane and the report. The element's
        //     summed FIT is not shown (that detail lives in the right pane).
        const roll   = project.fmedaRollup();
        const fnRoll = {}; roll.functions.forEach(f => { fnRoll[f.id] = f; });
        const elBands = project.fmedaElementBands(iso);

        // ── Deterministic absolute layout ────────────────────────────────
        // Compute every node's absolute (x,y) in one pass, top-down, so:
        //   · adding a function drops it into the NEXT free slot in its
        //     element without disturbing existing functions/elements;
        //   · compound parents get GENEROUS internal padding (the user
        //     can't drag children, so the auto-layout must breathe);
        //   · elements flow left→right by level.
        // All child coordinates are absolute canvas coords (cytoscape
        // compound children use absolute positions, not parent-relative).
        const PAD_TOP_EL = 96;   // tall title band so the element label sits INSIDE
        const PAD_TOP_FN = 64;   // title band for the function label
        const PAD_SIDE   = 28;   // left inset of a function inside its element
        const FM_INSET   = 26;   // left inset of an FM inside its function
        const FN_W       = COL_W - 2 * PAD_SIDE - 24;   // function inner width
        const fnsByEl = {};      // elementId -> [function,...]
        project.functionGroups().forEach(fn => {
            (fnsByEl[fn.parentId] = fnsByEl[fn.parentId] || []).push(fn);
        });
        const fmsByFn = {};      // functionId -> [event,...]
        project.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            (fmsByFn[e.groupId] = fmsByFn[e.groupId] || []).push(e);
        });
        // Height a function occupies = its title pad + stacked FMs (or a
        // minimum if empty) + bottom pad.
        function fnHeight(fnId) {
            const n = (fmsByFn[fnId] || []).length;
            const body = n > 0 ? n * FM_H + (n - 1) * 16 : FM_H;
            return PAD_TOP_FN + body + 20;
        }
        // Height an element occupies = title pad + stacked functions + pads.
        function elHeight(elId) {
            const fns = fnsByEl[elId] || [];
            if (!fns.length) return PAD_TOP_EL + 70;
            const body = fns.reduce((s, fn) => s + fnHeight(fn.id), 0) +
                         (fns.length - 1) * 24;
            return PAD_TOP_EL + body + 24;
        }

        // ── Elements, left→right by level, stacked top→bottom in a column ──
        const byLevel = { top: [], mid: [], low: [] };
        project.elementGroups().forEach(el => {
            const lv = LEVELS.includes(el.level) ? el.level : 'mid';
            byLevel[lv].push(el);
        });
        const elOrigin = {};   // elementId -> {x, yTop}
        let colX = 80;
        LEVELS.forEach(level => {
            let yCursor = 60;
            byLevel[level].forEach(el => {
                const h = elHeight(el.id);
                // The element's *center* is what cytoscape positions on, but
                // since it's a compound it derives size from children; we
                // still seed a position so empty elements have a spot.
                // elOrigin is the TOP-LEFT reference used to lay out this
                // element's (unplaced) descendants. It must track where the
                // element ACTUALLY is: if the element was dragged we derive
                // the top-left from its saved center, so newly-added
                // functions/failure modes land NEXT TO the element instead of
                // snapping back to the original column (bug: adding a child
                // made the whole group jump to origin).
                elOrigin[el.id] = (el.x || el.y)
                    ? { x: el.x - COL_W / 2, yTop: el.y - h / 2 }
                    : { x: colX, yTop: yCursor };
                // Element headline: ONLY its achieved integrity band, in the
                // active lens (leaf → aggregated metrics; mid/top → subtree
                // aggregate). Empty elements are absent from the map → no band.
                const elBand = elBands[el.id];
                const elMetric = (elBand && elBand !== '—') ? elBand : '';
                els.push({
                    group: 'nodes',
                    data: {
                        id:    el.id,
                        type:  'fmeda-element',
                        label: el.id + '  ·  ' + el.name +
                               (elMetric ? '\n' + elMetric : ''),
                        color: el.color,
                        level: el.level || '',
                        mit:   el.mitigation ? 1 : 0,
                        netActive: activeNet === 'arch' ? 1 : 0
                    },
                    // Honour a saved position (dragged, or seeded on load);
                    // only seed the computed column slot when none exists.
                    // For a populated element cytoscape derives the position
                    // from its children, so this matters mainly for EMPTY
                    // elements — which must still keep where they were put.
                    position: (el.x || el.y)
                        ? { x: el.x, y: el.y }
                        : { x: colX + COL_W / 2, y: yCursor + h / 2 },
                    selectable: true
                });
                yCursor += h + LANE_GAP;
            });
            if (byLevel[level].length) colX += COL_W + 60;
        });

        // ── Functions, stacked inside their element ──
        const fnOrigin = {};   // functionId -> {x, yTop}
        project.elementGroups().forEach(el => {
            const o = elOrigin[el.id];
            if (!o) return;
            let yCursor = o.yTop + PAD_TOP_EL;
            (fnsByEl[el.id] || []).forEach(fn => {
                const h = fnHeight(fn.id);
                const x = o.x + PAD_SIDE;
                // Same idea as elements: the function's top-left reference
                // (used to place its unplaced failure modes) follows the
                // function's saved position when present, otherwise it flows
                // from the (saved-aware) element origin above.
                fnOrigin[fn.id] = (fn.x || fn.y)
                    ? { x: fn.x - FN_W / 2, yTop: fn.y - h / 2 }
                    : { x, yTop: yCursor };
                // Function headline: its residual FIT and the integrity band
                // that rate reaches, in the active lens. A function with no
                // failure modes has no roll-up entry, so it shows no line.
                const fr = fnRoll[fn.id];
                const fnMetric = fr
                    ? fmt.fitStr(fr.residualFit) + ' · ' +
                      bandFor(fr.residualFit * 1e-9)
                    : '';
                els.push({
                    group: 'nodes',
                    data: {
                        id:    fn.id,
                        type:  'fmeda-function',
                        label: fn.id + '  ·  ' + fn.name +
                               (fnMetric ? '\n' + fnMetric : ''),
                        color: fn.color,
                        netActive: activeNet === 'func' ? 1 : 0
                    },
                    position: (fn.x || fn.y)
                        ? { x: fn.x, y: fn.y }
                        : { x: x + FN_W / 2, y: yCursor + h / 2 },
                    selectable: true
                });
                yCursor += h + 24;
            });
        });

        // ── Failure modes, stacked inside their function ──
        project.functionGroups().forEach(fn => {
            const o = fnOrigin[fn.id];
            if (!o) return;
            const fms = fmsByFn[fn.id] || [];
            // Where do UNPLACED failure modes go? If this function already has
            // placed (dragged/saved) failure modes, stack new ones directly
            // below them, aligned to their column — so adding a failure mode
            // never drags the whole function/element back to the origin. Only
            // when nothing is placed yet do we fall back to the function's
            // (saved-aware) origin.
            const placedFms = fms.filter(e => e.x || e.y);
            let autoX, autoY;
            if (placedFms.length) {
                autoX = Math.min.apply(null, placedFms.map(e => e.x));
                autoY = Math.max.apply(null, placedFms.map(e => e.y)) + FM_H + 16;
            } else {
                autoX = o.x + FM_INSET + FM_W / 2;
                autoY = o.yTop + PAD_TOP_FN + FM_H / 2;
            }
            fms.forEach(e => {
                const derived = project.fmedaIsDerived(e.id);
                // Handled: a leaf with DC+mitigation, OR a derived mode that
                // its upstream mitigations actually reduce.
                const handled = derived
                    ? project.fmedaComputedDC(e.id) > 0
                    : (project.fmedaIsHandled(e) || e.probMode === 'coverage');
                const dc = derived ? project.fmedaComputedDC(e.id)
                                   : (+e.diagnosticCoverage || 0);
                // Sub-label: SR id for a handled leaf (traceability), or the
                // diagnostic coverage, or the plain handled/derived state.
                const srId = project.fmedaSrIdOf(e.id);
                let sub;
                if (srId)            sub = srId + ' · DC ' + Math.round(dc * 100) + '%';
                else if (derived)    sub = 'derived' + (dc > 0 ? ' · DC ' + Math.round(dc * 100) + '%' : '');
                else if (handled && dc > 0) sub = 'DC ' + Math.round(dc * 100) + '%';
                else if (handled)    sub = 'handled';
                else                 sub = '';
                // Severity tint: shade the node by whether the dangerous mode
                // is covered, and by the band its residual rate reaches — this
                // is a graphical cue only (QM/No-SIL worst, a covered mode is
                // ok). It is NOT a claim that the mode "has" that integrity.
                const resFit = project.fmedaPropagatedResidual(e.id);
                const band = fmt.asilForPfh(resFit * 1e-9);
                const severity = !handled && resFit > 0
                    ? (band === 'QM' ? 'bad' : 'warn')
                    : 'ok';
                // Metric line: the mode's residual FIT, and nothing more. A
                // failure mode is classified and counted (FIT, DC), but it is
                // NOT assigned a SIL/ASIL/QM integrity level — that belongs to
                // the function and the element. So the band is shown there, not
                // here. Rebuilt every render, so it tracks edits / Recalculate.
                const metricLine = fmt.fitStr(resFit);
                // Saved position wins (like FTA); unplaced ones stack under
                // the placed siblings computed above.
                const placed = (e.x || e.y);
                const pos = placed ? { x: e.x, y: e.y } : { x: autoX, y: autoY };
                if (!placed) autoY += FM_H + 16;
                els.push({
                    group: 'nodes',
                    data: {
                        id:    e.id,
                        type:  'fmeda-fm',
                        label: e.id + '  ·  ' + e.name +
                               (sub ? '\n' + sub : '') + '\n' + metricLine,
                        parent: fn.id,
                        handled: handled ? 1 : 0,
                        derived: derived ? 1 : 0,
                        severity,
                        cc:    ccSourceIds.has(e.id) ? 'source'
                             : ccTargetIds.has(e.id) ? 'target' : '',
                        netActive: activeNet === 'fail' ? 1 : 0
                    },
                    position: pos
                });
            });
        });

        // Ensure each function node carries its element parent so cytoscape
        // nests it inside the right element compound.
        els.forEach(node => {
            if (node.data && node.data.type === 'fmeda-function') {
                const fn = project.groupById(node.data.id);
                if (fn && fn.parentId) node.data.parent = fn.parentId;
            }
        });

        // ── Active-net edges only (one net at a time) ──
        const net = ['arch', 'func', 'fail'].includes(activeNet) ? activeNet : 'arch';
        if (net !== 'fail') {
            // Architecture / function nets: plain edges, no gates.
            project.netEdgesOf(net).forEach(ed => {
                if (!project.groupById(ed.from) || !project.groupById(ed.to)) return;
                els.push({
                    group: 'edges',
                    data: { id: ed.id, type: 'fmeda-net', net,
                            source: ed.from, target: ed.to }
                });
            });
        } else {
            // Failure net: cause → effect, with a visible AND/OR gate node
            // wherever 2+ causes converge on the same target (like FTA).
            const failEdges = project.netEdgesOf('fail').filter(ed =>
                project.eventById(ed.from) && project.eventById(ed.to));
            // Position lookup for already-emitted FM nodes, so the gate can
            // sit at the midpoint of the failures it connects (not at 0,0).
            const posOf = {};
            els.forEach(n => {
                if (n.group === 'nodes' && n.position && n.data) posOf[n.data.id] = n.position;
            });
            const byTarget = {};
            failEdges.forEach(ed => { (byTarget[ed.to] = byTarget[ed.to] || []).push(ed); });
            Object.keys(byTarget).forEach(targetId => {
                const incoming = byTarget[targetId];
                const isCC = ccSourceIds.has(targetId) ||
                    incoming.some(ed => ccSourceIds.has(ed.from));
                if (incoming.length < 2) {
                    const ed = incoming[0];
                    els.push({
                        group: 'edges',
                        data: { id: ed.id, type: 'fmeda-net', net: 'fail',
                                cc: ccSourceIds.has(ed.from) ? 1 : 0,
                                source: ed.from, target: ed.to }
                    });
                    return;
                }
                // Convergence gate. Use the saved position if the user has
                // dragged it; otherwise seed at the average of its target and
                // all its sources so it sits between them.
                const gateType = project.failGateOf(targetId);
                const gateId = '_fgate_' + targetId;
                const saved = project.failGatePos(targetId);
                let gatePos = { x: 200, y: 200 };
                if (saved) {
                    gatePos = { x: saved.x, y: saved.y };
                } else {
                    const pts = [posOf[targetId]].concat(incoming.map(ed => posOf[ed.from]))
                        .filter(Boolean);
                    if (pts.length) {
                        gatePos = {
                            x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
                            y: pts.reduce((s, p) => s + p.y, 0) / pts.length
                        };
                    }
                }
                els.push({
                    group: 'nodes',
                    data: { id: gateId, type: 'fmeda-failgate',
                            label: gateType, target: targetId,
                            gateType: gateType },
                    position: gatePos,
                    selectable: true
                });
                incoming.forEach(ed => {
                    els.push({
                        group: 'edges',
                        data: { id: ed.id, type: 'fmeda-net', net: 'fail',
                                cc: ccSourceIds.has(ed.from) ? 1 : 0,
                                source: ed.from, target: gateId }
                    });
                });
                els.push({
                    group: 'edges',
                    data: { id: gateId + '_out', type: 'fmeda-net', net: 'fail',
                            cc: isCC ? 1 : 0,
                            source: gateId, target: targetId }
                });
            });
        }

        return els;
    }

    /* Cytoscape style rules specific to FMEDA. Merged into canvas styles. */
    function swimlaneStyles() {
        return [
            {
                selector: 'node[type="fmeda-element"]',
                style: {
                    'shape': 'round-rectangle',
                    // Architecture elements: shade of GREY / gainsboro.
                    'background-color': '#F1EFE8', 'background-opacity': 0.7,
                    'border-width': 1.5, 'border-color': '#888780',
                    'label': 'data(label)',
                    'text-valign': 'top', 'text-halign': 'center',
                    'text-margin-y': 26, 'font-size': 13, 'font-weight': 600,
                    'color': '#2C2C2A',
                    'padding-top': 56, 'padding-bottom': 28,
                    'padding-left': 28, 'padding-right': 28,
                    'text-wrap': 'wrap', 'text-max-width': 280,
                    'min-width': 180, 'min-height': 100, 'z-index': 1
                }
            },
            {
                // Active-net element gets a stronger border.
                selector: 'node[type="fmeda-element"][netActive=1]',
                style: { 'border-width': 3 }
            },
            {
                // Mitigation element (M_n): teal "barrier" treatment so it
                // reads as a protective measure, not a failure container.
                selector: 'node[type="fmeda-element"][mit=1]',
                style: {
                    'background-color': '#DCEFEA', 'background-opacity': 0.75,
                    'border-color': '#1F8A7A', 'border-width': 2,
                    'color': '#0E4F46'
                }
            },
            {
                selector: 'node[type="fmeda-function"]',
                style: {
                    'shape': 'round-rectangle',
                    // Functions: muted SLATE-SAGE. Deliberately de-saturated
                    // and shifted toward blue-grey so the only vivid green in
                    // the diagram is a HANDLED failure mode — the two greens
                    // no longer read as the same signal.
                    'background-color': '#E4E9E4', 'background-opacity': 0.7,
                    'border-width': 1, 'border-color': '#7E8C84',
                    'label': 'data(label)',
                    'text-valign': 'top', 'text-halign': 'center',
                    'text-margin-y': 24, 'font-size': 12, 'font-weight': 500,
                    'color': '#3A4A42',
                    // Wider title band so two-line function names breathe.
                    'padding-top': 56, 'padding-bottom': 24,
                    'padding-left': 24, 'padding-right': 24,
                    'text-wrap': 'wrap', 'text-max-width': 240,
                    'min-width': 180, 'min-height': 90, 'z-index': 2
                }
            },
            {
                selector: 'node[type="fmeda-function"][netActive=1]',
                style: { 'border-width': 2.5 }
            },
            {
                // Failure mode — UNHANDLED by default: shade of RED.
                selector: 'node[type="fmeda-fm"]',
                style: {
                    'shape': 'round-rectangle',
                    'width': FM_W, 'height': FM_H,
                    'background-color': '#FCEBEB',
                    'border-width': 1.5, 'border-color': '#E24B4A',
                    'label': 'data(label)',
                    'text-valign': 'center', 'text-halign': 'center',
                    'text-wrap': 'wrap', 'text-max-width': FM_W - 16,
                    'font-size': 11, 'color': '#791F1F', 'z-index': 3
                }
            },
            {
                // Item B — graphical problem severity by achieved band.
                // 'warn' (clears a SIL band but still unhandled): amber.
                selector: 'node[type="fmeda-fm"][severity="warn"]',
                style: {
                    'background-color': '#FBEFD8',
                    'border-color': '#C98A24', 'color': '#6A4410'
                }
            },
            {
                // 'bad' (QM / no integrity, unhandled): deep red.
                selector: 'node[type="fmeda-fm"][severity="bad"]',
                style: {
                    'background-color': '#F6D2D0',
                    'border-color': '#B0322F', 'color': '#5E1714',
                    'border-width': 2
                }
            },
            {
                // Failure mode — HANDLED (DC + mitigation): vivid EMERALD,
                // clearly distinct from the slate-sage function container.
                selector: 'node[type="fmeda-fm"][handled=1]',
                style: {
                    'background-color': '#CBEFD7',
                    'border-color': '#1F9D5B', 'color': '#0E5A30',
                    'border-width': 2
                }
            },
            {
                // DERIVED failure mode (top/mid level): read-only, computed.
                // Dashed border signals "not directly entered" and a cool
                // tint sets it apart from the editable red/green leaves.
                selector: 'node[type="fmeda-fm"][derived=1]',
                style: {
                    'border-style': 'dashed', 'border-color': '#5E7C9B',
                    'background-color': '#E8EEF5', 'color': '#243B52'
                }
            },
            {
                // A derived mode that its upstream actually reduces still
                // reads as handled (emerald), but keeps the dashed border.
                selector: 'node[type="fmeda-fm"][derived=1][handled=1]',
                style: {
                    'border-style': 'dashed', 'border-color': '#1F9D5B',
                    'background-color': '#D7EEDF', 'color': '#0E5A30'
                }
            },
            {
                // Common-cause source FM — emphasised border (kept on top of
                // the red/green fill so the hub still stands out).
                selector: 'node[type="fmeda-fm"][cc="source"]',
                style: {
                    'border-width': 3, 'border-color': '#A32D2D'
                }
            },
            {
                selector: 'node[type="fmeda-fm"][cc="target"]',
                style: { 'border-color': '#BA7517', 'border-width': 2 }
            },
            {
                // Export-only legend chips (added/removed during PNG capture).
                selector: 'node[type="fmeda-legend"]',
                style: {
                    'shape': 'round-rectangle',
                    'width': 180, 'height': 34,
                    'label': 'data(label)',
                    'text-valign': 'center', 'text-halign': 'center',
                    'font-size': 11, 'border-width': 1.5, 'z-index': 20
                }
            },
            { selector: 'node[lg="lg-el"]',
              style: { 'background-color': '#F1EFE8', 'border-color': '#888780', 'color': '#2C2C2A' } },
            { selector: 'node[lg="lg-fn"]',
              style: { 'background-color': '#E4E9E4', 'border-color': '#7E8C84', 'color': '#3A4A42' } },
            { selector: 'node[lg="lg-un"]',
              style: { 'background-color': '#FCEBEB', 'border-color': '#E24B4A', 'color': '#791F1F' } },
            { selector: 'node[lg="lg-ha"]',
              style: { 'background-color': '#CBEFD7', 'border-color': '#1F9D5B', 'color': '#0E5A30' } },
            { selector: 'node[lg="lg-de"]',
              style: { 'background-color': '#E8EEF5', 'border-color': '#5E7C9B', 'color': '#243B52', 'border-style': 'dashed' } },
            {
                // AND/OR gate at a failure-net convergence point.
                selector: 'node[type="fmeda-failgate"]',
                style: {
                    'shape': 'round-rectangle',
                    'width': 44, 'height': 30,
                    'background-color': '#FAEEDA',
                    'border-width': 1.5, 'border-color': '#BA7517',
                    'label': 'data(label)',
                    'text-valign': 'center', 'text-halign': 'center',
                    'font-size': 11, 'font-weight': 600, 'color': '#633806',
                    'z-index': 15
                }
            },
            {
                selector: 'edge[type="fmeda-net"]',
                style: {
                    'width': 1.5,
                    'line-color': '#8a887e',
                    'curve-style': 'bezier',
                    'target-arrow-shape': 'triangle',
                    'target-arrow-color': '#8a887e',
                    'arrow-scale': 0.9
                }
            },
            {
                selector: 'edge[type="fmeda-net"][cc=1]',
                style: {
                    'width': 2.5, 'line-color': '#A32D2D',
                    'target-arrow-color': '#A32D2D'
                }
            }
        ];
    }

    return { elements, swimlaneStyles, LEVELS };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = fmedaCanvas;
}
