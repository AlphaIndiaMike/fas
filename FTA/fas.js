/**
 * fas.js
 * Functional Analysis Studio [FAS] — Project model.
 *
 * Pure structural state. Knows nothing about the canvas (positions are
 * stored, rendering owned by canvas.js) and nothing about probability
 * propagation (runtime values are owned by analyzer.js). This
 * separation keeps each module focused.
 *
 * JSON file format (v2):
 *   {
 *     name, version, missionTime,
 *     groups:    [{ id, name, color, description }],
 *     events:    [{ id, name, kind, description, groupId, x, y,
 *                   probMode,             // 'direct' | 'rate' | 'coverage'
 *                   probability,          // direct
 *                   directUnit,           // 'PFD' | 'PFH' | 'FIT'  (direct)
 *                   failureRate,          // FIT (rate)
 *                   missionTimeOverride,  // h   (rate, optional)
 *                   failureRateRaw,       // FIT (coverage)
 *                   diagnosticCoverage    // 0–1 (coverage)
 *                }],
 *     gates:     [{ id, type, inputs:[eventId], output:eventId,
 *                   k, inhibitProb, x, y }],
 *     links:     [{ id, from:eventId, to:eventId }],   // v2+ (optional)
 *     scenarios: [{ id, name, overrides:[{eventId, forcedProbability}] }]
 *   }
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
            FTA: Project._emptyModel(),
            ETA: Project._emptyModel()
        };
        // Live arrays mirror the active sub-model (by reference). Every
        // CRUD method below operates on these, so the rest of the app
        // never needs to know which mode is active.
        this._loadActive();
    }

    static _emptyModel() {
        return { groups: [], events: [], gates: [], links: [], scenarios: [] };
    }

    /* Point the live arrays at the active sub-model. */
    _loadActive() {
        const m = this._models[this.mode];
        this.groups    = m.groups;
        this.events    = m.events;
        this.gates     = m.gates;
        this.links     = m.links;
        this.scenarios = m.scenarios;
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
    }

    setMode(mode) {
        const m = (mode === 'ETA') ? 'ETA' : 'FTA';
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

    addGroup({ name, color, description }) {
        const col = color ||
            CONFIG.groupColors[this.groups.length % CONFIG.groupColors.length];
        const gr = {
            id:          fmt.uid('grp'),
            name:        name || this._uniqueGroupName(),
            color:       col,
            description: description || ''
        };
        this.groups.push(gr);
        return gr;
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
        this.groups = this.groups.filter(g => g.id !== id);
        // Events that were in this group fall back to "ungrouped".
        this.events.forEach(e => { if (e.groupId === id) e.groupId = null; });
    }

    /* ── Event CRUD ───────────────────────────────────────────────── */

    addEvent({ name, kind = 'basic', x = 200, y = 200,
               description = '', groupId = null }) {
        // FTA keeps a single top event: if 'top' is requested and one
        // already exists, demote the new one to 'intermediate'. ETA mode
        // permits several final events, so the rule is skipped there.
        if (this.mode !== 'ETA' && kind === 'top' && this.topEvent()) kind = 'intermediate';

        const d = CONFIG.eventDefaults;
        const e = {
            id:                  fmt.uid('e'),
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
            /* Evidence / justification for the coverage claim — empty by
               default. Surfaced in dialogs only when probMode='coverage'. */
            diagnosticEvidence:  '',
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
            mode:        this.mode === 'ETA' ? 'ETA' : 'FTA',
            missionTime: this.missionTime,
            fta:         Project._dumpModel(this._models.FTA),
            eta:         Project._dumpModel(this._models.ETA)
        };
    }

    static _dumpModel(m) {
        return {
            groups:    m.groups.map(g => ({ ...g })),
            events:    m.events.map(e => ({ ...e })),
            gates:     m.gates.map(g => ({ ...g, inputs: g.inputs.slice() })),
            links:     m.links.map(l => ({ ...l })),
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
            description: g.description || ''
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
                diagnosticEvidence:  e.diagnosticEvidence || '',
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

        return { groups, events, gates, links, scenarios };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        const v = +obj.version || 1;
        const p = new Project(obj.name || '');
        p.missionTime = fmt.posNum(obj.missionTime, CONFIG.defaultMissionTime) ||
                        CONFIG.defaultMissionTime;

        if (v >= 4 && (obj.fta || obj.eta)) {
            // Current format: two independent sub-models.
            p._models.FTA = Project._parseModel(obj.fta);
            p._models.ETA = Project._parseModel(obj.eta);
            p.mode = (obj.mode === 'ETA') ? 'ETA' : 'FTA';
        } else {
            // Legacy (v1–v3): the flat top-level arrays ARE the fault tree.
            // The old v3 `eta` block (initiating event + pivots) belonged
            // to a different ETA concept and is intentionally dropped; the
            // ETA sub-model starts empty. Always open as FTA.
            if (!Array.isArray(obj.events) || !Array.isArray(obj.gates) ||
                !Array.isArray(obj.groups)) {
                throw new Error('Invalid file: expected { events, gates, groups, ... }.');
            }
            p._models.FTA = Project._parseModel(obj);
            p._models.ETA = Project._emptyModel();
            p.mode = 'FTA';
        }
        p._loadActive();

        // Rehydrate id counters past every existing id (both sub-models)
        // so subsequent creates don't collide.
        fmt.resetUid();
        const all = []
            .concat(p._models.FTA.events, p._models.FTA.gates, p._models.FTA.links,
                    p._models.FTA.groups, p._models.FTA.scenarios)
            .concat(p._models.ETA.events, p._models.ETA.gates, p._models.ETA.links,
                    p._models.ETA.groups, p._models.ETA.scenarios);
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
