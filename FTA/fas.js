/**
 * fas.js
 * Functional Analysis Studio [FAS] — Project model.
 *
 * Pure structural state. Knows nothing about the canvas (positions are
 * stored, rendering owned by canvas.js) and nothing about probability
 * propagation (runtime values are owned by analyzer.js). This
 * separation keeps each module focused.
 *
 * JSON file format (v1):
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
 *     scenarios: [{ id, name, overrides:[{eventId, forcedProbability}] }]
 *   }
 *
 * kind  = 'basic' | 'intermediate' | 'top'         (events)
 * type  = 'AND' | 'OR' | 'VOTING' | 'INHIBIT'      (gates)
 *
 * Depends on: config.js, fmt.js
 */

class Project {

    constructor(name = '') {
        this.name        = name;
        this.missionTime = CONFIG.defaultMissionTime;
        this.groups      = [];
        this.events      = [];
        this.gates       = [];
        this.scenarios   = [];
    }

    /* ── Lookups ──────────────────────────────────────────────────── */

    eventById(id)    { return this.events.find(e => e.id === id) || null; }
    gateById(id)     { return this.gates.find(g => g.id === id)  || null; }
    groupById(id)    { return this.groups.find(gr => gr.id === id) || null; }
    scenarioById(id) { return this.scenarios.find(s => s.id === id) || null; }

    topEvent() { return this.events.find(e => e.kind === 'top') || null; }
    basicEvents() { return this.events.filter(e => e.kind === 'basic'); }

    /* Gate whose output is this event (drives the event's probability
       in the analyzer). v1 enforces ≤ 1 gate per output event. */
    gateFeeding(eventId) {
        return this.gates.find(g => g.output === eventId) || null;
    }

    /* All gates this event feeds into (as one of their inputs). */
    gatesFedBy(eventId) {
        return this.gates.filter(g => g.inputs.includes(eventId));
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
        // Enforce single top event: if 'top' requested and one already
        // exists, demote the new one to 'intermediate'.
        if (kind === 'top' && this.topEvent()) kind = 'intermediate';

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
        if (patch.kind === 'top') {
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
        if (!feeding) {
            // Leaf event — return its group if any.
            const s = new Set();
            if (ev.groupId) s.add(ev.groupId);
            return s;
        }
        const all = new Set();
        feeding.inputs.forEach(i => {
            this._collectLeafGroups(i, visited).forEach(g => all.add(g));
        });
        return all;
    }

    /* Events that appear as input to more than one gate. Naive
       propagation double-counts; the analyzer flags these to the user. */
    repeatedEvents() {
        const count = new Map();
        this.gates.forEach(g => {
            g.inputs.forEach(i => count.set(i, (count.get(i) || 0) + 1));
        });
        const out = [];
        count.forEach((c, id) => { if (c >= 2) out.push(id); });
        return out;
    }

    /* ── Serialisation ────────────────────────────────────────────── */

    toJSON() {
        return {
            name:        this.name,
            version:     CONFIG.fileVersion,
            missionTime: this.missionTime,
            groups:      this.groups.map(g => ({ ...g })),
            events:      this.events.map(e => ({ ...e })),
            gates:       this.gates.map(g => ({
                ...g,
                inputs: g.inputs.slice()
            })),
            scenarios:   this.scenarios.map(s => ({
                ...s,
                overrides: s.overrides.map(o => ({ ...o }))
            }))
        };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        // Required arrays (scenarios optional for back-compat).
        if (!Array.isArray(obj.events) || !Array.isArray(obj.gates) ||
            !Array.isArray(obj.groups)) {
            throw new Error(
                'Invalid file: expected { events, gates, groups, ... }.'
            );
        }
        const p = new Project(obj.name || '');
        p.missionTime = fmt.posNum(obj.missionTime, CONFIG.defaultMissionTime) ||
                        CONFIG.defaultMissionTime;

        p.groups = obj.groups.map(g => ({
            id:          g.id,
            name:        g.name || '',
            color:       g.color ||
                         CONFIG.groupColors[0],
            description: g.description || ''
        }));

        p.events = obj.events.map(e => {
            const d = CONFIG.eventDefaults;
            const kind = ['basic', 'intermediate', 'top'].includes(e.kind)
                       ? e.kind : 'basic';

            // Forward-compat: if the file was written by an older FAS
            // build that used targetSIL + targetASIL, fold them into the
            // single `target` field. Prefer ASIL (typically stricter for
            // automotive use), then SIL, then null.
            const target = e.target
                       || e.targetASIL
                       || e.targetSIL
                       || null;

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

        p.gates = obj.gates.map(g => ({
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

        p.scenarios = (obj.scenarios || []).map(s => ({
            id:        s.id,
            name:      s.name || '',
            overrides: Array.isArray(s.overrides)
                       ? s.overrides.map(o => ({
                           eventId:           o.eventId,
                           forcedProbability: fmt.clamp(o.forcedProbability, 0, 1, 1)
                         }))
                       : []
        }));

        // Rehydrate id counters past every existing id so subsequent
        // creates don't collide.
        fmt.resetUid();
        const all = []
            .concat(p.events)
            .concat(p.gates)
            .concat(p.groups)
            .concat(p.scenarios);
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
