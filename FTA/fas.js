/**
 * fas.js
 * Functional Analysis Studio [FAS] — Project model.
 *
 * Pure structural state. Knows nothing about the canvas (positions are
 * stored, rendering owned by canvas.js) and nothing about probability
 * propagation (runtime values are owned by analyzer.js). This
 * separation keeps each module focused.
 *
 * JSON file format (v5):
 *   {
 *     name, version, mode, missionTime,
 *     fta:   { …sub-model… },        // independent FTA model
 *     eta:   { …sub-model… },        // independent ETA model
 *     fmeda: { …sub-model… }         // independent FMEDA model
 *   }
 *   Each sub-model:
 *   {
 *     groups:    [{ id, name, color, description, parentId, kind, level, x, y }],
 *     events:    [{ id, name, kind, description, groupId, x, y,
 *                   probMode,             // 'direct' | 'rate' | 'coverage'
 *                   probability,          // direct
 *                   directUnit,           // 'PFD' | 'PFH' | 'FIT'  (direct)
 *                   failureRate,          // FIT (rate)
 *                   missionTimeOverride,  // h   (rate, optional)
 *                   failureRateRaw,       // FIT (coverage)
 *                   diagnosticCoverage,   // 0–1 (coverage, DC₁)
 *                   diagnosticCoverageLatent, // 0–1 (coverage, DC₂)
 *                   diagnosticEvidence, mitigation, target
 *                }],
 *     gates:     [{ id, type, inputs:[eventId], output:eventId,
 *                   k, inhibitProb, x, y }],
 *     links:     [{ id, from:eventId, to:eventId }],
 *     scenarios: [{ id, name, overrides:[{eventId, forcedProbability}] }],
 *     netEdges:  [{ id, net, from, to }],          // FMEDA only
 *     failGates: { targetFailureId: 'AND'|'OR' },  // FMEDA only
 *     failGatePos: { targetFailureId: {x,y} }      // FMEDA only
 *   }
 *   Legacy files (v1–v4 flat top-level arrays) load as the FTA sub-model;
 *   see fromJSON.
 *
 * kind  = 'basic' | 'intermediate' | 'top'         (events)
 * type  = 'AND' | 'OR' | 'VOTING' | 'INHIBIT'      (gates)
 *
 * A `link` is a direct event→event pass-through: the `to` event (an
 * intermediate or top) inherits the probability of the `from` event
 * verbatim. It is the single-child alternative to a gate. An event may
 * be fed by exactly one source — one gate OR one link, never both —
 * so two or more inputs always require a gate (see `feederOf`).
 *
 * Depends on: config.js, fmt.js
 */

class Project {

    constructor(name = '') {
        this.name        = name;
        this.missionTime = CONFIG.defaultMissionTime;
        /* Top-level mode. The project carries TWO fully independent
           sub-models — one for FTA, one for ETA — and the toggle simply
           chooses which one is live. They never share data; FTA keeps a
           single top event, ETA permits several final events. Authoring,
           gates and the propagation engine are identical for both. */
        this.mode        = 'FTA';
        this._models = {
            FTA:   Project._emptyModel(),
            ETA:   Project._emptyModel(),
            FMEDA: Project._emptyModel()
        };
        // Live arrays mirror the active sub-model (by reference). Every
        // CRUD method below operates on these, so the rest of the app
        // never needs to know which mode is active.
        this._loadActive();
    }

    /* Semantic id prefix for a group, decided at CREATION time from its
       FMEDA kind + level (item: human-traceable ids). Architecture elements:
         top → TAL (top architecture level)
         mid → MAL (mid  architecture level)
         low → LL  (low-level element)
       Functions (any level) → FN.  FTA/ETA generic groups keep 'grp'.
       Note: the id is a STABLE key — references (parentId, net edges, gate
       maps) and external traceability depend on it, so re-classifying an
       element's level later does NOT rewrite its id; the prefix reflects the
       level the element had when it was created. Failure-mode ids (FM_n) are
       assigned in addEvent. */
    static _groupIdPrefix(kind, level) {
        if (kind === 'element') {
            if (level === 'top') return 'TAL';
            if (level === 'mid') return 'MAL';
            if (level === 'low') return 'LL';
            return 'AEL';   // element with no level set yet
        }
        if (kind === 'function') return 'FN';
        return 'grp';       // FTA/ETA grouping boxes
    }

    static _emptyModel() {
        // groups/events/gates/links/scenarios are shared with FTA & ETA.
        // netEdges is FMEDA-only: typed edges for the three independent
        // nets (architecture / function / failure). FTA & ETA never touch
        // it, so their behaviour is unchanged.
        return { groups: [], events: [], gates: [], links: [],
                 scenarios: [], netEdges: [], failGates: {}, failGatePos: {} };
    }

    /* Point the live arrays at the active sub-model. */
    _loadActive() {
        const m = this._models[this.mode];
        this.groups    = m.groups;
        this.events    = m.events;
        this.gates     = m.gates;
        this.links     = m.links;
        this.scenarios = m.scenarios;
        this.netEdges  = m.netEdges || (m.netEdges = []);
        this._failGates = m.failGates || (m.failGates = {});
        this._failGatePos = m.failGatePos || (m.failGatePos = {});
    }

    /* Write the (possibly reassigned) live arrays back into the active
       sub-model. CRUD methods reassign arrays via .filter(), so the live
       reference can diverge from the slot — sync before switching/saving. */
    _syncActive() {
        const m = this._models[this.mode];
        m.groups    = this.groups;
        m.events    = this.events;
        m.gates     = this.gates;
        m.links     = this.links;
        m.scenarios = this.scenarios;
        m.netEdges  = this.netEdges;
        m.failGates = this._failGates;
        m.failGatePos = this._failGatePos;
    }

    setMode(mode) {
        const m = ['ETA', 'FMEDA'].includes(mode) ? mode : 'FTA';
        if (m === this.mode) return m;
        this._syncActive();     // stash current live arrays
        this.mode = m;
        this._loadActive();     // bring the target sub-model live
        return m;
    }

    /* ── Lookups ──────────────────────────────────────────────────── */

    eventById(id)    { return this.events.find(e => e.id === id) || null; }
    gateById(id)     { return this.gates.find(g => g.id === id)  || null; }
    linkById(id)     { return this.links.find(l => l.id === id)  || null; }
    groupById(id)    { return this.groups.find(gr => gr.id === id) || null; }
    scenarioById(id) { return this.scenarios.find(s => s.id === id) || null; }

    topEvent() { return this.events.find(e => e.kind === 'top') || null; }
    basicEvents() { return this.events.filter(e => e.kind === 'basic'); }

    /* Gate whose output is this event (drives the event's probability
       in the analyzer). v1 enforces ≤ 1 gate per output event. */
    gateFeeding(eventId) {
        return this.gates.find(g => g.output === eventId) || null;
    }

    /* Direct link whose `to` is this event — the single-child pass-through
       alternative to a gate. ≤ 1 link per `to` event. */
    linkFeeding(eventId) {
        return this.links.find(l => l.to === eventId) || null;
    }

    /* The single source feeding a derived event, whichever kind it is.
       Returns { kind:'gate', gate } | { kind:'link', link } | null.
       Used to enforce "one feeder per event" across both constructs. */
    feederOf(eventId) {
        const g = this.gateFeeding(eventId);
        if (g) return { kind: 'gate', gate: g };
        const l = this.linkFeeding(eventId);
        if (l) return { kind: 'link', link: l };
        return null;
    }

    /* All gates this event feeds into (as one of their inputs). */
    gatesFedBy(eventId) {
        return this.gates.filter(g => g.inputs.includes(eventId));
    }

    /* All direct links this event feeds (as their `from`). */
    linksFedBy(eventId) {
        return this.links.filter(l => l.from === eventId);
    }

    /* ── Group CRUD ───────────────────────────────────────────────── */

    addGroup({ name, color, description, parentId = null,
               kind = 'group', level = null, x = 0, y = 0 }) {
        const col = color ||
            CONFIG.groupColors[this.groups.length % CONFIG.groupColors.length];
        const gr = {
            id:          fmt.uid(Project._groupIdPrefix(kind, level)),
            name:        name || this._uniqueGroupName(),
            color:       col,
            description: description || '',
            // FMEDA containment fields. FTA & ETA leave these at the
            // defaults (parentId null, kind 'group') and ignore them.
            //   kind:  'element' | 'function' | 'group'
            //   parentId: a function's parent element (null otherwise)
            //   level: 'top' | 'mid' | 'low' swimlane (elements only)
            //   x/y: saved position. Empty FMEDA elements/functions persist
            //        their spot here; populated ones derive it from children.
            parentId:    parentId,
            kind:        kind,
            level:       level,
            x:           x || 0,
            y:           y || 0
        };
        this.groups.push(gr);
        return gr;
    }

    /* FMEDA helpers — null/empty in FTA & ETA. */
    elementGroups()   { return this.groups.filter(g => g.kind === 'element'); }
    functionGroups()  { return this.groups.filter(g => g.kind === 'function'); }
    childGroups(parentId) {
        return this.groups.filter(g => g.parentId === parentId);
    }
    /* The element a group ultimately belongs to (walk up parentId). */
    elementOf(groupId) {
        let g = this.groupById(groupId), guard = 0;
        while (g && g.parentId && guard++ < 20) g = this.groupById(g.parentId);
        return g && g.kind === 'element' ? g : (g || null);
    }

    _uniqueGroupName() {
        let n = this.groups.length + 1;
        let nm;
        do { nm = 'Group ' + n; n++; }
        while (this.groups.some(g => g.name === nm));
        return nm;
    }

    updateGroup(id, patch) {
        const gr = this.groupById(id);
        if (!gr) return false;
        Object.assign(gr, patch);
        return true;
    }

    deleteGroup(id) {
        // Collect this group and any descendant groups (FMEDA: an element
        // owns its function-groups). FTA & ETA have no children, so this
        // reduces to just `id`.
        const doomed = new Set([id]);
        let added = true;
        while (added) {
            added = false;
            this.groups.forEach(g => {
                if (g.parentId && doomed.has(g.parentId) && !doomed.has(g.id)) {
                    doomed.add(g.id); added = true;
                }
            });
        }
        this.groups = this.groups.filter(g => !doomed.has(g.id));
        if (this.mode === 'FMEDA') {
            // FMEDA: a failure mode is CONTAINED by its function — deleting
            // the function (or its element) deletes the modes inside it,
            // and any net edges touching those modes.
            const goneEvents = new Set(
                this.events.filter(e => doomed.has(e.groupId)).map(e => e.id));
            this.events = this.events.filter(e => !doomed.has(e.groupId));
            if (this.netEdges && this.netEdges.length) {
                this.netEdges = this.netEdges.filter(ed =>
                    !doomed.has(ed.from) && !doomed.has(ed.to) &&
                    !goneEvents.has(ed.from) && !goneEvents.has(ed.to));
            }
            // Drop convergence-gate state (AND/OR choice, saved position) for
            // any failure mode removed with its function/element.
            this._purgeFailRefs(goneEvents);
        } else {
            // FTA & ETA: the group is only a label — events survive and
            // fall back to "ungrouped" (unchanged legacy behaviour).
            this.events.forEach(e => { if (doomed.has(e.groupId)) e.groupId = null; });
            if (this.netEdges && this.netEdges.length) {
                this.netEdges = this.netEdges.filter(
                    ed => !doomed.has(ed.from) && !doomed.has(ed.to));
            }
        }
    }

    /* ── FMEDA residual & handled-state ───────────────────────────────
       A failure mode is "handled" (green) when it has BOTH a diagnostic
       coverage > 0 AND a written mitigation requirement. Otherwise it is
       unhandled (red) and its full dangerous rate flows up.

       Residual dangerous-undetected rate (FIT) for one failure mode:
         · coverage mode: λ_DU = λ_D(raw) × (1 − DC)        [diagnostic credit]
         · rate mode (FIT): λ                                [no credit unless
            a mitigation+DC is present, then λ × (1 − DC)]
         · direct PFD/PFH: converted to an equivalent FIT for roll-up.
       All rates returned in FIT (failures / 10⁹ h). */
    fmedaIsHandled(e) {
        if (!e) return false;
        const dc = +e.diagnosticCoverage || 0;
        const hasMit = !!(e.mitigation && e.mitigation.trim());
        return dc > 0 && hasMit;
    }

    /* Documentation status of a leaf failure mode, independent of the residual
       math (which always applies the DC). Used to FLAG gaps without ever
       withholding the number:
         · 'handled'           — DC > 0 and a mitigation requirement is written.
         · 'dc-no-mitigation'  — DC > 0 but no mitigation written. INCONSISTENT:
                                 credit is being taken for a diagnostic whose
                                 reaction requirement is undocumented.
         · 'no-mitigation'     — no mitigation written (and no DC credit taken).
       Derived modes have no own mitigation, so they report 'derived'. */
    fmedaMitigationStatus(e) {
        if (!e) return 'no-mitigation';
        if (e.id && this.fmedaIsDerived(e.id)) return 'derived';
        const dc = +e.diagnosticCoverage || 0;
        const hasMit = !!(e.mitigation && e.mitigation.trim());
        if (dc > 0 && hasMit)  return 'handled';
        if (dc > 0 && !hasMit) return 'dc-no-mitigation';
        return 'no-mitigation';
    }

    /* Raw dangerous rate in FIT, before any diagnostic credit. */
    fmedaRawFit(e) {
        if (!e) return 0;
        if (e.probMode === 'coverage') return Math.max(0, +e.failureRateRaw || 0);
        if (e.probMode === 'rate')     return Math.max(0, +e.failureRate || 0);
        // direct: PFH given per hour -> FIT = PFH × 1e9; PFD has no rate,
        // approximate via equivalent constant rate over mission time.
        if (e.probMode === 'direct') {
            if (e.directUnit === 'PFH') return Math.max(0, +e.probability || 0) * 1e9;
            // PFD → equivalent FIT. Combine two effects and take the WORSE
            // (higher) one:
            //   • mission-time rate (PFD / t)·1e9 — so that, combined with
            //     other rates over the mission, its contribution equals PFD;
            //   • a band floor PFD·1e5 FIT (= PFD·1e-4 /h) — the IEC 61508
            //     low↔high-demand correspondence (a PFD band maps to the PFH
            //     band of the same SIL). Without the floor a long mission
            //     time would dilute a catastrophic probability into a tiny
            //     rate, letting a 50 % PFD masquerade as ASIL D. The two
            //     coincide at t = 1e4 h (the reference mission time), so
            //     normal automotive models are unchanged.
            // Linear PFD / t is used deliberately, not −ln(1−PFD)/t: the log
            // form turned an entered 2 % into a displayed 2.02 %.
            const t = e.missionTimeOverride || this.missionTime || 1;
            const pfd = Math.max(0, +e.probability || 0);
            const rate  = t > 0 ? (pfd / t) * 1e9 : 0;
            const floor = pfd * 1e5;
            return Math.max(rate, floor);
        }
        return 0;
    }

    /* LOCAL residual: dangerous-undetected rate in FIT from this failure's
       OWN inputs, after diagnostic credit. Used for leaf failures and as
       the base of a derived failure's own contribution.

       Diagnostic coverage drives the math, ALWAYS: residual = raw × (1 − DC),
       whether or not a mitigation requirement is written. The mitigation text
       is documentation (a safety requirement to trace), not a gate on the
       number — decoupling them stops a mid-level mitigation note from silently
       changing a rate, and stops a missing note from withholding earned
       diagnostic credit. The "handled / unhandled / DC-without-mitigation"
       state is reported separately (fmedaMitigationStatus) without ever
       hiding the residual. */
    fmedaResidualFit(e) {
        const raw = this.fmedaRawFit(e);
        const dc  = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
        return raw * (1 - dc);
    }

    /* The swimlane level ('top' | 'mid' | 'low' | null) of the element that
       ultimately owns a failure mode. A failure mode lives in a function,
       which lives in an element; the element carries the level. */
    fmedaLevelOf(eventId) {
        const e = this.eventById(eventId);
        if (!e || !e.groupId) return null;
        const el = this.elementOf(e.groupId);
        return el ? (el.level || null) : null;
    }

    /* DERIVED is decided by LEVEL, not by net topology (decision: a top/mid
       architecture element's failure modes are SYSTEM-level effects whose
       rate must come bottom-up from the low-level causes that feed them —
       they may not carry their own typed rate or their own mitigation).
       Only LOW-level (leaf) failure modes are entered directly. A mode with
       no level is treated as a leaf so legacy/loose models still edit. */
    fmedaIsDerived(eventId) {
        const lvl = this.fmedaLevelOf(eventId);
        return lvl === 'top' || lvl === 'mid';
    }

    /* PROPAGATED RAW (FIT) — the dangerous rate flowing INTO a failure mode
       before this node's own diagnostic credit. For a leaf it is the mode's
       own raw FIT; for a derived mode it is the OR/AND combination of the
       RAW propagated rates of its causes. Used to express the diagnostic
       coverage a derived mode achieves (raw → residual reduction). */
    fmedaPropagatedRaw(eventId, _stack) {
        const e = this.eventById(eventId);
        if (!e) return 0;
        if (!this.fmedaIsDerived(eventId)) return this.fmedaRawFit(e);   // leaf
        _stack = _stack || new Set();
        if (_stack.has(eventId)) { this._failCycleSeen = true; return 0; }
        const incoming = this.failIncoming(eventId);
        if (!incoming.length) return 0;                 // derived, no causes yet
        _stack.add(eventId);
        const srcRaw = incoming.map(ed => this.fmedaPropagatedRaw(ed.from, _stack));
        _stack.delete(eventId);
        return this._combineFit(srcRaw, this.failGateOf(eventId),
                                e.missionTimeOverride || this.missionTime || 1);
    }

    /* PROPAGATED residual (FIT) — the value actually used for a failure once
       the failure net is taken into account.

       · A LEAF (low-level) failure uses its OWN local residual (its typed
         rate after its own diagnostic credit). Incoming edges to a leaf are
         ignored — the leaf is, by definition, where a rate is entered.
       · A DERIVED (top/mid-level) failure ignores any typed value and is
         computed from its source failures' propagated residuals, combined
         by the target's gate:
             OR  → rates sum (any cause defeats it; first-order)
             AND → all causes needed; combine in probability space over the
                   mission time, then convert back to an equivalent rate.
         A derived failure carries NO diagnostic credit of its own — its
         reduction comes entirely from the mitigations on the low-level
         causes that feed it (which are already baked into the propagated
         residuals). The credit it shows is COMPUTED, see fmedaComputedDC.
       Cycle-guarded: a failure currently being evaluated contributes 0 if
       reached again, and the cycle is reported via fmedaPropagationCycle(). */
    fmedaPropagatedResidual(eventId, _stack) {
        const e = this.eventById(eventId);
        if (!e) return 0;
        if (!this.fmedaIsDerived(eventId)) return this.fmedaResidualFit(e);  // leaf
        _stack = _stack || new Set();
        if (_stack.has(eventId)) {           // cycle — break it
            this._failCycleSeen = true;
            return 0;
        }
        const incoming = this.failIncoming(eventId);
        if (!incoming.length) return 0;      // derived but no causes wired yet

        _stack.add(eventId);
        const srcRates = incoming.map(ed =>
            this.fmedaPropagatedResidual(ed.from, _stack));
        _stack.delete(eventId);

        return this._combineFit(srcRates, this.failGateOf(eventId),
                                e.missionTimeOverride || this.missionTime || 1);
    }

    /* Combine a list of FIT rates by an AND/OR gate (shared by the raw and
       the residual propagation walks so they stay consistent). */
    _combineFit(rates, gate, t) {
        if (gate === 'AND') {
            // All causes needed. Convert each FIT to a mission-time
            // probability, multiply, convert the joint probability back to
            // an equivalent FIT (first-order, mirrors the FTA AND handling).
            let pJoint = 1;
            rates.forEach(fit => {
                const lambda = fit * 1e-9;             // FIT -> per hour
                const p = 1 - Math.exp(-lambda * t);   // mission-time prob
                pJoint *= p;
            });
            return t > 0 ? (-Math.log(1 - Math.min(0.999999, pJoint)) / t) * 1e9 : 0;
        }
        // OR — sum the rates (first-order rare-event approximation).
        return rates.reduce((s, r) => s + r, 0);
    }

    /* Diagnostic coverage a DERIVED failure mode achieves, COMPUTED from the
       reduction between the raw rate flowing in and the residual after the
       low-level mitigations — never entered by hand. 0 when nothing flows in
       or nothing is reduced. Leaves return their own entered DC. */
    fmedaComputedDC(eventId) {
        if (!this.fmedaIsDerived(eventId)) {
            const e = this.eventById(eventId);
            return e ? (+e.diagnosticCoverage || 0) : 0;
        }
        const raw = this.fmedaPropagatedRaw(eventId);
        if (!(raw > 0)) return 0;
        const res = this.fmedaPropagatedResidual(eventId);
        return Math.max(0, Math.min(1, 1 - res / raw));
    }

    /* True if the last rollup/propagation walk encountered a cycle. */
    fmedaPropagationCycle() { return !!this._failCycleSeen; }

    /* Roll up residual per function and per element. Returns:
       { functions: [{id,name,elementId,elementName,level,rawFit,residualFit,
                       pfh,total,handledCount,derivedCount}],
         elements:  [{id,name,level,rawFit,residualFit,integrityFit}] }
       Within a function, failure modes combine as an OR of independent
       dangerous failures → residual rates simply sum (first-order).
       A function's `rawFit` uses each mode's EFFECTIVE raw (a derived mode's
       raw is the rate flowing in, not a typed value). An element's
       `integrityFit` is the residual of its MOST STRINGENT (lowest-residual,
       highest-integrity) populated function — the band that function reaches
       is the band attributed to the whole element (one SIL-2 function makes
       the element SIL-2 even if the rest are QM). */
    fmedaRollup() {
        if (this.mode !== 'FMEDA') return { functions: [], elements: [] };
        this._failCycleSeen = false;   // reset cycle detection for this walk
        const fnAgg = new Map();
        const elAgg = new Map();
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const fn = this.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const derived = this.fmedaIsDerived(e.id);
            // Effective raw: leaf → its own typed raw; derived → the raw rate
            // that propagates in (so "raw vs residual" reads sensibly).
            const raw = derived ? this.fmedaPropagatedRaw(e.id) : this.fmedaRawFit(e);
            const res = this.fmedaPropagatedResidual(e.id);
            const handled = derived
                ? this.fmedaComputedDC(e.id) > 0           // derived: handled by upstream
                : (this.fmedaIsHandled(e) || e.probMode === 'coverage');
            if (!fnAgg.has(fn.id)) {
                const el = this.elementOf(fn.id);
                fnAgg.set(fn.id, {
                    id: fn.id, name: fn.name,
                    elementId: el ? el.id : null,
                    elementName: el ? el.name : '—',
                    level: el ? (el.level || null) : null,
                    rawFit: 0, residualFit: 0, total: 0, handledCount: 0,
                    derivedCount: 0
                });
            }
            const a = fnAgg.get(fn.id);
            a.rawFit += raw; a.residualFit += res; a.total += 1;
            if (handled) a.handledCount += 1;
            if (derived) a.derivedCount += 1;
        });
        fnAgg.forEach(a => {
            a.pfh = a.residualFit * 1e-9;
            if (!a.elementId) return;
            if (!elAgg.has(a.elementId)) {
                const el = this.groupById(a.elementId);
                elAgg.set(a.elementId, {
                    id: a.elementId, name: el ? el.name : '—',
                    level: el ? (el.level || null) : null,
                    rawFit: 0, residualFit: 0, integrityFit: null
                });
            }
            const e = elAgg.get(a.elementId);
            e.rawFit += a.rawFit; e.residualFit += a.residualFit;
            // Most stringent populated function drives the element band.
            if (a.total > 0) {
                e.integrityFit = (e.integrityFit == null)
                    ? a.residualFit : Math.min(e.integrityFit, a.residualFit);
            }
        });
        elAgg.forEach(e => {
            if (e.integrityFit == null) e.integrityFit = e.residualFit;
            e.pfh = e.integrityFit * 1e-9;
        });
        return {
            functions: Array.from(fnAgg.values()),
            elements:  Array.from(elAgg.values())
        };
    }

    /* ── FMEDA hardware metrics (IEC 61508 SFF; ISO 26262 SPF/RF/MPF) ──────
       Computed over the LEAF (low-level) failure modes. Derived (top/mid)
       modes are roll-ups of those leaves, not independent contributors, so
       summing them too would double-count; they are excluded here.

       Per leaf: dangerous rate λ_D (from fmedaRawFit), safe rate λ_S
       (failureRateSafe, default 0), primary coverage DC₁, latent coverage DC₂.
         λ_total       = λ_D + λ_S
         λ_SU          = λ_S                    safe (no safe-DC modelled)
         λ_DD          = λ_D·DC₁                detected dangerous
         λ_DU          = λ_D·(1−DC₁)            undetected dangerous (= residual)
         λ_SPF         = λ_D          (DC₁ = 0) single-point fault, no mechanism
         λ_RF          = λ_D·(1−DC₁)  (DC₁ > 0) residual of a covered fault
                          (λ_SPF + λ_RF = λ_DU)
         λ_MPF,dp      = λ_D·DC₁                caught by the primary mechanism
         λ_MPF,latent  = λ_D·DC₁·(1−DC₂)        missed by the latent-fault check
       Aggregated (per element and grand total):
         SFF  = Σ(λ_S + λ_DD) / Σλ_total
         SPFM = 1 − Σ(λ_SPF + λ_RF) / Σλ_total
         LFM  = 1 − Σλ_MPF,latent / Σ(λ_total − λ_SPF − λ_RF)
       With λ_S = 0 (the default) SFF collapses to the detected-dangerous
       fraction, exactly as before this field existed — so untouched models
       keep their numbers; entering λ_S lifts SFF/SPFM off that floor. */
    fmedaMetrics() {
        const blank = () => ({
            lambdaTotal: 0, lambdaSD: 0, lambdaSU: 0, lambdaDD: 0, lambdaDU: 0,
            lambdaSPF: 0, lambdaRF: 0, lambdaMPFdp: 0, lambdaMPFlatent: 0, count: 0
        });
        const total = blank();
        const byEl = new Map();
        if (this.mode !== 'FMEDA') return { total, elements: [] };
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            if (this.fmedaIsDerived(e.id)) return;             // leaves only
            const fn = this.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const lamD = this.fmedaRawFit(e);                  // dangerous rate
            const lamS = Math.max(0, +e.failureRateSafe || 0); // safe rate λ_S
            if (!(lamD > 0) && !(lamS > 0)) return;            // nothing to count
            const dc1 = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
            const dc2 = fmt.clamp(e.diagnosticCoverageLatent, 0, 1, 0);
            const hasSM = dc1 > 0;
            const contrib = {
                lambdaTotal: lamD + lamS,
                // Safe failures are credited as safe regardless of any safe
                // diagnostic, so the whole λ_S sits in λ_SU (no safe-detected
                // split is modelled — it would not change SFF/SPFM/LFM).
                lambdaSD: 0, lambdaSU: lamS,
                lambdaDD: lamD * dc1,
                lambdaDU: lamD * (1 - dc1),
                lambdaSPF: hasSM ? 0 : lamD,
                lambdaRF:  hasSM ? lamD * (1 - dc1) : 0,
                lambdaMPFdp:     lamD * dc1,
                lambdaMPFlatent: lamD * dc1 * (1 - dc2),
                count: 1
            };
            const el = this.elementOf(fn.id);
            const elId = el ? el.id : '__none__';
            if (!byEl.has(elId)) {
                byEl.set(elId, Object.assign(blank(), {
                    id: el ? el.id : null,
                    name: el ? el.name : '—',
                    level: el ? (el.level || null) : null
                }));
            }
            const acc = byEl.get(elId);
            Object.keys(contrib).forEach(k => { acc[k] += contrib[k]; total[k] += contrib[k]; });
        });
        const finalize = (a) => {
            const rf = a.lambdaSPF + a.lambdaRF;
            // SFF = (safe + dangerous-detected) / total. With a real λ_S this
            // is no longer pinned to the detected-dangerous fraction.
            a.sff  = a.lambdaTotal > 0
                ? (a.lambdaSD + a.lambdaSU + a.lambdaDD) / a.lambdaTotal : null;
            a.spfm = a.lambdaTotal > 0 ? 1 - rf / a.lambdaTotal : null;
            const mpfBase = a.lambdaTotal - rf;
            a.lfm  = mpfBase > 0 ? 1 - a.lambdaMPFlatent / mpfBase : null;
            return a;
        };
        finalize(total);
        const elements = Array.from(byEl.values()).map(finalize);
        return { total, elements };
    }

    /* ── FMEDA net edges ──────────────────────────────────────────────
       Three independent nets over the same nodes, never shown together:
         · 'arch' — element ↔ element  (endpoints are element groups)
         · 'func' — function ↔ function (endpoints are function groups)
         · 'fail' — failure ↔ failure  (endpoints are basic events / FMs)
       Each edge is { id, net, from, to }. The toggle in the right pane
       chooses which net the canvas draws. Connections are like-to-like;
       this method enforces that the endpoints match the net type. */
    addNetEdge({ net, from, to }) {
        if (!['arch', 'func', 'fail'].includes(net)) return null;
        if (!from || !to || from === to) return null;
        if (!this._validNetEndpoint(net, from) ||
            !this._validNetEndpoint(net, to)) return null;
        const dup = this.netEdges.find(e => e.net === net &&
            ((e.from === from && e.to === to) ||
             (e.from === to && e.to === from)));
        if (dup) return null;
        const ed = { id: fmt.uid('net'), net, from, to };
        this.netEdges.push(ed);
        return ed;
    }

    deleteNetEdge(id) {
        this.netEdges = this.netEdges.filter(e => e.id !== id);
    }

    netEdgesOf(net) { return this.netEdges.filter(e => e.net === net); }

    /* ── Bulk auto-connect (scaffolding helpers) ──────────────────────
       Build the lower nets from the higher one so a model can be wired in
       bulk and then pruned, instead of edge-by-edge. Both are additive and
       idempotent — addNetEdge dedups (either direction), so re-running adds
       only what is missing and never removes anything. Each returns the
       number of NEW edges created. */

    /* For every architecture edge (elementA → elementB), connect every
       function of A to every function of B, in the edge's direction. */
    autoConnectFunctionsFromArch() {
        if (this.mode !== 'FMEDA') return 0;
        let created = 0;
        this.netEdgesOf('arch').forEach(ed => {
            const srcFns = this.functionGroups().filter(f => f.parentId === ed.from);
            const dstFns = this.functionGroups().filter(f => f.parentId === ed.to);
            srcFns.forEach(sf => dstFns.forEach(df => {
                if (this.addNetEdge({ net: 'func', from: sf.id, to: df.id })) created++;
            }));
        });
        return created;
    }

    /* For every function edge (functionA → functionB), connect every failure
       mode of A to every failure mode of B, in the edge's direction
       (from = cause, to = effect). This is a complete bipartite scaffold —
       expect to prune links that don't physically apply. */
    autoConnectFailuresFromFunctions() {
        if (this.mode !== 'FMEDA') return 0;
        let created = 0;
        const fmsOf = fnId =>
            this.events.filter(e => e.kind === 'basic' && e.groupId === fnId);
        this.netEdgesOf('func').forEach(ed => {
            const srcFms = fmsOf(ed.from);
            const dstFms = fmsOf(ed.to);
            srcFms.forEach(sf => dstFms.forEach(df => {
                if (this.addNetEdge({ net: 'fail', from: sf.id, to: df.id })) created++;
            }));
        });
        return created;
    }

    /* ── Failure-net propagation gates ────────────────────────────────
       When two or more failure-net edges converge on the SAME target
       failure, the user chooses how the incoming causes combine: OR (any
       cause defeats the target — the default) or AND (all causes needed).
       The choice is stored per target failure id. A target with <2 incoming
       edges needs no gate. */
    failGateOf(targetId) {
        return (this._failGates && this._failGates[targetId]) || 'OR';
    }
    setFailGate(targetId, type) {
        if (!this._failGates) this._failGates = {};
        this._failGates[targetId] = (type === 'AND') ? 'AND' : 'OR';
    }
    /* Incoming failure-net edges (causes) of a target failure. */
    failIncoming(targetId) {
        return this.netEdgesOf('fail').filter(e => e.to === targetId);
    }
    /* (fmedaIsDerived now lives next to the propagation logic above and is
       decided by element LEVEL, not by incoming edges.) */

    /* ── Failure-net convergence-gate POSITION ───────────────────────
       The AND/OR gate node sits between the failures it joins. Its default
       position is the average of its endpoints, but once the user drags it
       the chosen position is saved here (keyed by the target failure id)
       and survives re-render and reload — just like a dragged failure mode
       keeps its x/y. */
    failGatePos(targetId) {
        return (this._failGatePos && this._failGatePos[targetId]) || null;
    }
    setFailGatePos(targetId, x, y) {
        if (!this._failGatePos) this._failGatePos = {};
        this._failGatePos[targetId] = { x, y };
    }

    /* ── Safety requirements (traceability) ──────────────────────────
       Every HANDLED failure mode carries a mitigation that IS a safety
       requirement. We expose them as a stable, numbered list (SR1, SR2 …)
       so the requirement can be traced outside the tool and referenced on
       the canvas and in the report. Numbering is deterministic: ordered by
       element level (top→mid→low), then element, function and creation
       order, so the same model always yields the same SR ids. */
    safetyRequirements() {
        if (this.mode !== 'FMEDA') return [];
        const levelRank = { top: 0, mid: 1, low: 2 };
        const rows = [];
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            if (!this.fmedaIsHandled(e)) return;        // only handled FMs
            if (this.fmedaIsDerived(e.id)) return;      // mitigation lives at leaf level
            const fn = this.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const el = this.elementOf(fn.id);
            rows.push({
                eventId:      e.id,
                name:         e.name,
                mitigation:   (e.mitigation || '').trim(),
                dc:           +e.diagnosticCoverage || 0,
                functionId:   fn.id,
                functionName: fn.name,
                elementId:    el ? el.id : null,
                elementName:  el ? el.name : '—',
                _lvl:         el ? (levelRank[el.level] != null ? levelRank[el.level] : 9) : 9
            });
        });
        rows.sort((a, b) =>
            a._lvl - b._lvl ||
            String(a.elementId).localeCompare(String(b.elementId)) ||
            String(a.functionId).localeCompare(String(b.functionId)) ||
            String(a.eventId).localeCompare(String(b.eventId)));
        rows.forEach((r, i) => { r.srId = 'SR' + (i + 1); delete r._lvl; });
        return rows;
    }

    /* The SR id assigned to one failure mode (or null if it is not a
       requirement-bearing handled leaf). Convenience for the canvas. */
    fmedaSrIdOf(eventId) {
        const hit = this.safetyRequirements().find(r => r.eventId === eventId);
        return hit ? hit.srId : null;
    }

    _validNetEndpoint(net, id) {
        if (net === 'fail') {
            const e = this.eventById(id);
            return !!e && e.kind === 'basic';
        }
        const g = this.groupById(id);
        if (!g) return false;
        return net === 'arch' ? g.kind === 'element' : g.kind === 'function';
    }

    /* Common-cause findings (the FMEDA payoff).
       A failure-net edge is DIRECTIONAL: from = the cause failure, to = a
       failure it propagates to (the effect). A common-cause finding is a
       single CAUSE failure whose outgoing edges reach effect-failures in
       two or more DIFFERENT functions: one root defeating things that were
       assumed independent. We also require those effect functions to differ
       from the cause's own function (a cause taking out other failures in
       its *own* function is just local propagation, not common cause).

       Direction makes the statement sensible: it is the cause that defeats
       multiple functions, never the effect. The edge arrow (cause → effect)
       encodes this; the finding reads "<cause> is a common cause across
       <function A>, <function B>". */
    commonCauseFindings() {
        if (this.mode !== 'FMEDA') return [];
        const failEdges = this.netEdgesOf('fail');
        // Directed adjacency: cause -> set of effect failure ids.
        const out = new Map();
        failEdges.forEach(e => {
            if (!out.has(e.from)) out.set(e.from, new Set());
            out.get(e.from).add(e.to);
        });

        const findings = [];
        out.forEach((effects, causeId) => {
            const cause = this.eventById(causeId);
            if (!cause) return;
            const causeFnId = cause.groupId || null;
            const byFunction = new Map();
            effects.forEach(effId => {
                const eff = this.eventById(effId);
                if (!eff || !eff.groupId) return;
                const fn = this.groupById(eff.groupId);
                if (!fn || fn.kind !== 'function') return;
                if (fn.id === causeFnId) return;   // local propagation, skip
                if (!byFunction.has(fn.id)) byFunction.set(fn.id, []);
                byFunction.get(fn.id).push({ event: eff, fn });
            });
            if (byFunction.size >= 2) {
                const targets = [];
                byFunction.forEach(list => list.forEach(({ event, fn }) => {
                    const el = this.elementOf(fn.id);
                    targets.push({
                        eventId:      event.id,
                        name:         event.name,
                        functionId:   fn.id,
                        functionName: fn.name,
                        elementName:  el ? el.name : '—'
                    });
                }));
                findings.push({
                    sourceId:      causeId,
                    sourceName:    cause.name,
                    targets,
                    functionCount: byFunction.size
                });
            }
        });
        return findings;
    }

    /* Copy an existing failure mode into a target function as a NEW, fully
       independent failure mode. The description and all reliability
       properties are duplicated; the copy gets its own FM_n id, no saved
       position (so it auto-places) and no net edges (a copy is a fresh node,
       not the same node). Returns the new event, or null if inputs are bad. */
    copyFailureModeInto(sourceEventId, targetFunctionId) {
        const src = this.eventById(sourceEventId);
        const fn  = this.groupById(targetFunctionId);
        if (!src || src.kind !== 'basic') return null;
        if (!fn  || fn.kind !== 'function') return null;
        const copy = this.addEvent({
            name:    src.name,
            kind:    'basic',
            groupId: targetFunctionId
            // x/y omitted → unplaced → canvas auto-places it.
        });
        // Duplicate the reliability + mitigation properties.
        this.updateEvent(copy.id, {
            description:         src.description || '',
            probMode:           src.probMode,
            directUnit:         src.directUnit,
            probability:        src.probability,
            failureRate:        src.failureRate,
            failureRateRaw:     src.failureRateRaw,
            diagnosticCoverage: src.diagnosticCoverage,
            diagnosticCoverageLatent: src.diagnosticCoverageLatent || 0,
            failureRateSafe:    src.failureRateSafe || 0,
            diagnosticEvidence: src.diagnosticEvidence || '',
            mitigation:         src.mitigation || '',
            missionTimeOverride: src.missionTimeOverride
        });
        return this.eventById(copy.id);
    }


    addEvent({ name, kind = 'basic', x, y,
               description = '', groupId = null }) {
        // Default drop position depends on mode. FTA/ETA drop a new event at
        // (200,200). In FMEDA, x/y of 0 means "unplaced" — the canvas then
        // auto-places the failure mode next to its siblings; defaulting to
        // 200 here would mark it as already-placed and defeat that (and make
        // every new FM land on the same spot).
        const _dft = this.mode === 'FMEDA' ? 0 : 200;
        x = (x == null) ? _dft : x;
        y = (y == null) ? _dft : y;
        // FTA keeps a single top event: if 'top' is requested and one
        // already exists, demote the new one to 'intermediate'. ETA mode
        // permits several final events, so the rule is skipped there.
        if (this.mode !== 'ETA' && kind === 'top' && this.topEvent()) kind = 'intermediate';

        const d = CONFIG.eventDefaults;
        const e = {
            // In FMEDA every event is a failure mode (FM_n); FTA/ETA keep e_n.
            id:                  fmt.uid(this.mode === 'FMEDA' ? 'FM' : 'e'),
            name:                name || this._uniqueEventName(kind),
            kind,
            description,
            groupId,
            x, y,
            probMode:            d.probMode,
            directUnit:          d.directUnit,
            probability:         d.probability,
            failureRate:         d.failureRate,
            missionTimeOverride: null,
            failureRateRaw:      d.failureRateRaw,
            diagnosticCoverage:  d.diagnosticCoverage,
            /* DC₂ — latent-fault coverage (ISO 26262 LFM). Default 0. */
            diagnosticCoverageLatent: d.diagnosticCoverageLatent || 0,
            /* Safe failure rate λ_S (FIT) — failures of this mode with no
               hazardous effect. Default 0 (nothing credited as safe). Feeds
               λ_total and the SFF / SPFM numerators; does NOT affect the
               residual (PMHF) rate, which is dangerous-undetected only. */
            failureRateSafe:     d.failureRateSafe || 0,
            /* Evidence / justification for the coverage claim — empty by
               default. Surfaced in dialogs only when probMode='coverage'. */
            diagnosticEvidence:  '',
            /* FMEDA mitigation: the diagnostic + reaction requirement that
               handles this failure mode (free text). A failure mode counts
               as "handled" (green) when it has BOTH a diagnostic coverage
               > 0 AND a written mitigation requirement here. */
            mitigation:          '',
            /* Safety target — meaningful only on the top event. A single
               value from CONFIG.targetCombined (e.g. 'ASIL A', 'SIL 2',
               'QM'). The previous design carried separate targetSIL and
               targetASIL fields which could disagree; fromJSON migrates
               those forward into this single field. */
            target:              null
        };
        this.events.push(e);
        return e;
    }

    _uniqueEventName(kind) {
        const prefix = kind === 'top' ? 'Top event'
                     : kind === 'intermediate' ? 'Event'
                     : 'Basic event';
        let n = 1;
        let nm;
        do { nm = prefix + ' ' + n; n++; }
        while (this.events.some(e => e.name === nm));
        return nm;
    }

    updateEvent(id, patch) {
        const e = this.eventById(id);
        if (!e) return false;
        if (patch.kind === 'top' && this.mode !== 'ETA') {
            this.events.forEach(o => {
                if (o.id !== id && o.kind === 'top') o.kind = 'intermediate';
            });
        }
        Object.assign(e, patch);
        return true;
    }

    deleteEvent(id) {
        this.events = this.events.filter(e => e.id !== id);
        // Cascading delete: any gate that referenced this event as
        // input or output. Drop the gate entirely if its output is
        // gone; trim its inputs list otherwise.
        this.gates = this.gates.filter(g => g.output !== id);
        this.gates.forEach(g => {
            g.inputs = g.inputs.filter(i => i !== id);
        });
        // Direct links touching this event (either end) drop too.
        this.links = this.links.filter(l => l.from !== id && l.to !== id);
        // Scenario overrides referencing this event drop too.
        this.scenarios.forEach(s => {
            s.overrides = s.overrides.filter(o => o.eventId !== id);
        });
        // FMEDA: a failure mode is a failure-net node. Drop any failure-net
        // edge touching it and any convergence-gate state keyed to it, so a
        // deleted mode never leaves orphan edges or a stale AND/OR gate
        // behind (no-op in FTA/ETA, where these are empty).
        this._purgeFailRefs(new Set([id]));
    }

    /* Remove failure-net edges and convergence-gate state (AND/OR choice and
       saved gate position) referencing any of the given failure ids. Shared
       by deleteEvent and deleteGroup so a removed failure mode is fully
       detached from the failure net. */
    _purgeFailRefs(ids) {
        if (!ids || ids.size === 0) return;
        if (this.netEdges && this.netEdges.length) {
            this.netEdges = this.netEdges.filter(
                ed => !ids.has(ed.from) && !ids.has(ed.to));
        }
        if (this._failGates) ids.forEach(id => delete this._failGates[id]);
        if (this._failGatePos) ids.forEach(id => delete this._failGatePos[id]);
    }

    /* ── Gate CRUD ────────────────────────────────────────────────── */

    addGate({ type, inputs = [], output = null,
              k = null, inhibitProb = null, x = 300, y = 300 }) {
        if (!['AND', 'OR', 'VOTING', 'INHIBIT'].includes(type)) return null;
        const g = {
            id:          fmt.uid('g'),
            type,
            inputs:      inputs.slice(),
            output,
            k:           type === 'VOTING'  ? (k || CONFIG.gateDefaults.k)
                                            : null,
            inhibitProb: type === 'INHIBIT' ? (inhibitProb != null ? inhibitProb
                                                                  : CONFIG.gateDefaults.inhibitProb)
                                            : null,
            x, y
        };
        this.gates.push(g);
        return g;
    }

    updateGate(id, patch) {
        const g = this.gateById(id);
        if (!g) return false;
        if (patch.inputs) patch.inputs = patch.inputs.slice();
        Object.assign(g, patch);
        return true;
    }

    deleteGate(id) {
        this.gates = this.gates.filter(g => g.id !== id);
    }

    /* ── Link CRUD ────────────────────────────────────────────────────
       A link is a single-child pass-through feeding `to` from `from`.
       Validation mirrors gate output rules so the two feeder kinds stay
       mutually exclusive and consistent. */

    /* Why a candidate (from → to) link is or isn't allowed. Returns an
       error string, or null if the link is valid. Pure — used by both
       addLink and the dialog so the UI and model never disagree. */
    linkError(from, to, ignoreLinkId) {
        const f = this.eventById(from);
        const t = this.eventById(to);
        if (!f || !t)        return 'Both ends of the link must be existing events.';
        if (from === to)     return 'An event cannot link to itself.';
        if (t.kind === 'basic')
            return 'The parent (to) must be an intermediate or top event.';
        if (f.kind === 'top')
            return 'A top event cannot feed another event — it is the apex.';
        // One feeder per parent: reject if `to` is already fed by a gate
        // or by a different link.
        if (this.gateFeeding(to))
            return 'Event "' + t.name + '" is already fed by a gate. ' +
                   'Remove that gate first, or link a different event.';
        const existingLink = this.linkFeeding(to);
        if (existingLink && existingLink.id !== ignoreLinkId)
            return 'Event "' + t.name + '" is already fed by a direct link. ' +
                   'An event can have only one feeder; use a gate to combine ' +
                   'two or more inputs.';
        return null;
    }

    addLink({ from, to }) {
        if (this.linkError(from, to)) return null;
        const l = { id: fmt.uid('lnk'), from, to };
        this.links.push(l);
        return l;
    }

    updateLink(id, patch) {
        const l = this.linkById(id);
        if (!l) return false;
        const from = patch.from != null ? patch.from : l.from;
        const to   = patch.to   != null ? patch.to   : l.to;
        if (this.linkError(from, to, id)) return false;
        l.from = from;
        l.to   = to;
        return true;
    }

    deleteLink(id) {
        this.links = this.links.filter(l => l.id !== id);
    }

    /* ── Scenario CRUD ────────────────────────────────────────────── */

    addScenario({ name, overrides = [] }) {
        const s = {
            id:        fmt.uid('scn'),
            name:      name || this._uniqueScenarioName(),
            overrides: overrides.map(o => ({ ...o }))
        };
        this.scenarios.push(s);
        return s;
    }

    _uniqueScenarioName() {
        let n = this.scenarios.length + 1;
        let nm;
        do { nm = 'Scenario ' + n; n++; }
        while (this.scenarios.some(s => s.name === nm));
        return nm;
    }

    updateScenario(id, patch) {
        const s = this.scenarioById(id);
        if (!s) return false;
        if (patch.overrides) patch.overrides = patch.overrides.map(o => ({ ...o }));
        Object.assign(s, patch);
        return true;
    }

    deleteScenario(id) {
        this.scenarios = this.scenarios.filter(s => s.id !== id);
    }

    /* ── Validation helpers ───────────────────────────────────────── */

    /* Returns the set of event ids that two AND/VOTING inputs share
       via the `groupId` membership — used by the FFI checker.
       Returns null for gate types where it doesn't apply. */
    ffiSharedGroups(gateId) {
        const g = this.gateById(gateId);
        if (!g) return null;
        if (g.type !== 'AND' && g.type !== 'VOTING') return null;
        if (g.inputs.length < 2) return null;

        // Walk each input back to all basic events that contribute to
        // it. Any group id that appears in ≥ 2 of those leaf-sets
        // means two branches share an independence boundary.
        const leafGroupsByInput = g.inputs.map(inpId =>
            this._collectLeafGroups(inpId, new Set()));

        const counts = new Map();
        leafGroupsByInput.forEach(set => {
            set.forEach(gid => counts.set(gid, (counts.get(gid) || 0) + 1));
        });
        const shared = [];
        counts.forEach((c, gid) => { if (c >= 2 && gid) shared.push(gid); });
        return shared;
    }

    _collectLeafGroups(eventId, visited) {
        if (visited.has(eventId)) return new Set();    // cycle guard
        visited.add(eventId);
        const ev = this.eventById(eventId);
        if (!ev) return new Set();
        const feeding = this.gateFeeding(eventId);
        if (feeding) {
            const all = new Set();
            feeding.inputs.forEach(i => {
                this._collectLeafGroups(i, visited).forEach(g => all.add(g));
            });
            return all;
        }
        // A direct link forwards its single child's leaf groups unchanged.
        const link = this.linkFeeding(eventId);
        if (link) {
            return this._collectLeafGroups(link.from, visited);
        }
        // Leaf event — return its group if any.
        const s = new Set();
        if (ev.groupId) s.add(ev.groupId);
        return s;
    }

    /* Events that appear as input to more than one feeder (gate input or
       link source). Naive propagation double-counts; the analyzer flags
       these to the user. */
    repeatedEvents() {
        const count = new Map();
        const bump  = id => count.set(id, (count.get(id) || 0) + 1);
        this.gates.forEach(g => g.inputs.forEach(bump));
        this.links.forEach(l => bump(l.from));
        const out = [];
        count.forEach((c, id) => { if (c >= 2) out.push(id); });
        return out;
    }

    /* ── Serialisation ────────────────────────────────────────────── */

    toJSON() {
        this._syncActive();   // make sure the live arrays are captured
        return {
            name:        this.name,
            version:     CONFIG.fileVersion,
            mode:        ['ETA','FMEDA'].includes(this.mode) ? this.mode : 'FTA',
            missionTime: this.missionTime,
            fta:         Project._dumpModel(this._models.FTA),
            eta:         Project._dumpModel(this._models.ETA),
            fmeda:       Project._dumpModel(this._models.FMEDA)
        };
    }

    static _dumpModel(m) {
        return {
            groups:    m.groups.map(g => ({ ...g })),
            events:    m.events.map(e => ({ ...e })),
            gates:     m.gates.map(g => ({ ...g, inputs: g.inputs.slice() })),
            links:     m.links.map(l => ({ ...l })),
            netEdges:  (m.netEdges || []).map(e => ({ ...e })),
            failGates: Object.assign({}, m.failGates || {}),
            failGatePos: Object.assign({}, m.failGatePos || {}),
            scenarios: m.scenarios.map(s => ({
                ...s,
                overrides: s.overrides.map(o => ({ ...o }))
            }))
        };
    }

    /* Parse one sub-model's arrays from raw JSON. Tolerant of missing
       keys so legacy files (flat top-level arrays) parse the same way. */
    static _parseModel(src) {
        src = src || {};
        const groups = (Array.isArray(src.groups) ? src.groups : []).map(g => ({
            id:          g.id,
            name:        g.name || '',
            color:       g.color || CONFIG.groupColors[0],
            description: g.description || '',
            parentId:    g.parentId || null,
            kind:        ['element','function','group'].includes(g.kind)
                         ? g.kind : 'group',
            level:       ['top','mid','low'].includes(g.level) ? g.level : null,
            x: +g.x || 0, y: +g.y || 0
        }));

        const events = (Array.isArray(src.events) ? src.events : []).map(e => {
            const d = CONFIG.eventDefaults;
            const kind = ['basic', 'intermediate', 'top'].includes(e.kind)
                       ? e.kind : 'basic';
            const target = e.target || e.targetASIL || e.targetSIL || null;
            return {
                id:                  e.id,
                name:                e.name || '',
                kind,
                description:         e.description || '',
                groupId:             e.groupId || null,
                x: +e.x || 0, y: +e.y || 0,
                probMode:            ['direct','rate','coverage'].includes(e.probMode)
                                     ? e.probMode : d.probMode,
                directUnit:          ['PFD','PFH','FIT'].includes(e.directUnit)
                                     ? e.directUnit : d.directUnit,
                probability:         _num(e.probability,        d.probability),
                failureRate:         _num(e.failureRate,        d.failureRate),
                missionTimeOverride: e.missionTimeOverride == null ? null
                                     : _num(e.missionTimeOverride, null),
                failureRateRaw:      _num(e.failureRateRaw,     d.failureRateRaw),
                diagnosticCoverage:  fmt.clamp(e.diagnosticCoverage, 0, 1,
                                                d.diagnosticCoverage),
                diagnosticCoverageLatent: fmt.clamp(e.diagnosticCoverageLatent, 0, 1,
                                                d.diagnosticCoverageLatent || 0),
                failureRateSafe:     _num(e.failureRateSafe, d.failureRateSafe || 0),
                diagnosticEvidence:  e.diagnosticEvidence || '',
                mitigation:          e.mitigation || '',
                target:              target
            };
        });

        const gates = (Array.isArray(src.gates) ? src.gates : []).map(g => ({
            id:          g.id,
            type:        ['AND','OR','VOTING','INHIBIT'].includes(g.type)
                         ? g.type : 'AND',
            inputs:      Array.isArray(g.inputs) ? g.inputs.slice() : [],
            output:      g.output || null,
            k:           g.type === 'VOTING'
                         ? (fmt.posInt(g.k, CONFIG.gateDefaults.k) || CONFIG.gateDefaults.k)
                         : null,
            inhibitProb: g.type === 'INHIBIT'
                         ? fmt.clamp(g.inhibitProb, 0, 1, CONFIG.gateDefaults.inhibitProb)
                         : null,
            x: +g.x || 0, y: +g.y || 0
        }));

        // Direct links: keep only well-formed links whose endpoints exist
        // and whose `to` isn't already fed by a gate or another link.
        const eventIds = new Set(events.map(e => e.id));
        const gateFed  = new Set(gates.map(g => g.output).filter(Boolean));
        const linkedTo = new Set();
        const links = (Array.isArray(src.links) ? src.links : [])
            .map(l => ({ id: l.id, from: l.from, to: l.to }))
            .filter(l => l.from && l.to &&
                         eventIds.has(l.from) && eventIds.has(l.to) &&
                         l.from !== l.to &&
                         !gateFed.has(l.to) &&
                         !linkedTo.has(l.to) &&
                         linkedTo.add(l.to));

        const scenarios = (Array.isArray(src.scenarios) ? src.scenarios : []).map(s => ({
            id:        s.id,
            name:      s.name || '',
            overrides: Array.isArray(s.overrides)
                       ? s.overrides.map(o => ({
                           eventId:           o.eventId,
                           forcedProbability: fmt.clamp(o.forcedProbability, 0, 1, 1)
                         }))
                       : []
        }));

        // FMEDA net edges. Keep only well-formed edges whose net type is
        // valid; endpoint existence is re-checked lazily by the canvas, so
        // here we only sanity-filter shape.
        const netEdges = (Array.isArray(src.netEdges) ? src.netEdges : [])
            .map(e => ({
                id:   e.id,
                net:  ['arch','func','fail'].includes(e.net) ? e.net : null,
                from: e.from, to: e.to
            }))
            .filter(e => e.net && e.from && e.to && e.from !== e.to);

        // Failure-net convergence gates: { targetFailureId: 'AND'|'OR' }.
        const failGates = {};
        if (src.failGates && typeof src.failGates === 'object') {
            Object.keys(src.failGates).forEach(k => {
                failGates[k] = src.failGates[k] === 'AND' ? 'AND' : 'OR';
            });
        }

        // Saved convergence-gate positions: { targetFailureId: {x,y} }.
        const failGatePos = {};
        if (src.failGatePos && typeof src.failGatePos === 'object') {
            Object.keys(src.failGatePos).forEach(k => {
                const p = src.failGatePos[k];
                if (p && isFinite(p.x) && isFinite(p.y)) failGatePos[k] = { x: +p.x, y: +p.y };
            });
        }

        return { groups, events, gates, links, scenarios, netEdges, failGates, failGatePos };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        const v = +obj.version || 1;
        const p = new Project(obj.name || '');
        p.missionTime = fmt.posNum(obj.missionTime, CONFIG.defaultMissionTime) ||
                        CONFIG.defaultMissionTime;

        if (v >= 4 && (obj.fta || obj.eta || obj.fmeda)) {
            // Current format: independent sub-models.
            p._models.FTA   = Project._parseModel(obj.fta);
            p._models.ETA   = Project._parseModel(obj.eta);
            p._models.FMEDA = Project._parseModel(obj.fmeda);
            p.mode = ['ETA','FMEDA'].includes(obj.mode) ? obj.mode : 'FTA';
        } else {
            // Legacy (v1–v3): the flat top-level arrays ARE the fault tree.
            // The old v3 `eta` block (initiating event + pivots) belonged
            // to a different ETA concept and is intentionally dropped; the
            // ETA sub-model starts empty. Always open as FTA.
            if (!Array.isArray(obj.events) || !Array.isArray(obj.gates) ||
                !Array.isArray(obj.groups)) {
                throw new Error('Invalid file: expected { events, gates, groups, ... }.');
            }
            p._models.FTA   = Project._parseModel(obj);
            p._models.ETA   = Project._emptyModel();
            p._models.FMEDA = Project._emptyModel();
            p.mode = 'FTA';
        }
        p._loadActive();

        // Rehydrate id counters past every existing id (all sub-models)
        // so subsequent creates don't collide.
        fmt.resetUid();
        const all = []
            .concat(p._models.FTA.events, p._models.FTA.gates, p._models.FTA.links,
                    p._models.FTA.groups, p._models.FTA.scenarios,
                    p._models.FTA.netEdges || [])
            .concat(p._models.ETA.events, p._models.ETA.gates, p._models.ETA.links,
                    p._models.ETA.groups, p._models.ETA.scenarios,
                    p._models.ETA.netEdges || [])
            .concat(p._models.FMEDA.events, p._models.FMEDA.gates,
                    p._models.FMEDA.links, p._models.FMEDA.groups,
                    p._models.FMEDA.scenarios, p._models.FMEDA.netEdges || []);
        all.forEach(item => {
            const match = String(item.id || '').match(/^([A-Za-z]+)_(\d+)$/);
            if (match) fmt.bumpUid(match[1], parseInt(match[2], 10));
        });

        return p;
    }
}

/* Internal helper: numeric coerce with fallback. */
function _num(v, fb) {
    const n = parseFloat(v);
    return (isNaN(n) || n < 0) ? fb : n;
}
