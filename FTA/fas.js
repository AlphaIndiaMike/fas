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
        /* FMEDA results lens — which standard's vocabulary and targets the
           results panel reports under: 'ISO26262' (default) or 'IEC61508'.
           Per-project (a file remembers its domain) and persisted. Inputs are
           identical either way — only the output framing differs. */
        this.standard    = 'ISO26262';
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
         (low + mitigation) → M  (a Mitigation element — see below)
       Functions (any level) → FN.  FTA/ETA generic groups keep 'grp'.
       A Mitigation element is an ordinary LOW-level architecture element
       (it carries its own functions and failure modes, and its own failures
       roll up exactly like any other element's) distinguished only by the
       'M' prefix, its styling, and its role in the common-cause panel: an
       M→failure failure-net edge marks that failure's common-cause finding
       as addressed. The mitigation never subtracts a rate — it adds its own
       failure into the chain like any cause (see fmedaPropagatedResidual).
       Note: the id is a STABLE key — references (parentId, net edges, gate
       maps) and external traceability depend on it, so re-classifying an
       element's level later does NOT rewrite its id; the prefix reflects the
       level the element had when it was created. Failure-mode ids (FM_n) are
       assigned in addEvent. */
    static _groupIdPrefix(kind, level, mitigation) {
        if (kind === 'element') {
            if (mitigation)      return 'M';
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
        // domains: purely-VISUAL boundaries the user draws to group top-level
        // nodes (architecture elements in FMEDA, events in FTA/ETA) so a diagram
        // reads as their own sub-systems. They carry NO weight in any metric,
        // analysis or validation — membership lives on the domain, never on the
        // member, so the engine never sees them.
        return { groups: [], events: [], gates: [], links: [],
                 scenarios: [], netEdges: [], failGates: {}, failGatePos: {},
                 domains: [] };
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
        this.domains   = m.domains || (m.domains = []);
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
        m.domains = this.domains;
    }

    setMode(mode) {
        const m = ['ETA', 'FMEDA'].includes(mode) ? mode : 'FTA';
        if (m === this.mode) return m;
        this._syncActive();     // stash current live arrays
        this.mode = m;
        this._loadActive();     // bring the target sub-model live
        return m;
    }

    /* FMEDA results lens: 'ISO26262' | 'IEC61508'. Output framing only —
       inputs and the engine are identical either way. */
    setStandard(s) {
        this.standard = (s === 'IEC61508') ? 'IEC61508' : 'ISO26262';
        return this.standard;
    }

    /* ── Lookups ──────────────────────────────────────────────────── */

    eventById(id)    { return this.events.find(e => e.id === id) || null; }
    gateById(id)     { return this.gates.find(g => g.id === id)  || null; }
    linkById(id)     { return this.links.find(l => l.id === id)  || null; }
    groupById(id)    { return this.groups.find(gr => gr.id === id) || null; }
    scenarioById(id) { return this.scenarios.find(s => s.id === id) || null; }
    basicEvents() { return this.events.filter(e => e.kind === 'basic'); }


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
            /* FMEDA authoring primitives — null until the failure mode is
               authored through the editor (or supplied explicitly). While
               null, fmedaRawFit/fmedaSafeFit read the legacy λ_D (failureRateRaw)
               / λ_S (failureRateSafe), so quick-created or imported modes keep
               their exact previous numbers. The editor populates them on Save:
               λ_D = lambdaBase × fmd × dangerousFraction. */
            lambdaBase:          null,
            fmd:                 null,
            dangerousFraction:   null,
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
            /* Explicit "this common cause is mitigated" decision, set from the
               common-cause panel. A common cause is often handled
               architecturally — independence, separation, redundancy — which
               carries no diagnostic coverage on the cause itself, so the
               panel's ✓/⚠ must NOT be inferred from fmedaIsHandled (DC + text).
               It reads this flag instead. The flag is documentation/traceability
               only: it does NOT alter the residual rate (mitigating a common
               cause by independence does not lower the single mode's λ). */
            commonCauseMitigated: false,
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
        this._purgeDomainMembers(new Set([id]));
    }

    /* ── Domain boundaries (v3.3.0) ───────────────────────────────────────
       Purely-visual groupings of top-level nodes (architecture elements in
       FMEDA, events in FTA/ETA). Membership lives here, on the domain — never
       on the member — so NOTHING in the FMEDA engine, the FTA/ETA analyzer, or
       validation ever reads it. A domain has no effect on any computed number;
       it only changes how the diagram is drawn. */
    domainById(id) { return this.domains.find(d => d.id === id) || null; }

    // Which domain (if any) contains a given node id.
    domainOf(memberId) {
        return this.domains.find(d => (d.members || []).includes(memberId)) || null;
    }

    addDomain({ name = '', color = null, members = [] } = {}) {
        const d = {
            id:      fmt.uid('DOM'),
            name:    name || ('Domain ' + (this.domains.length + 1)),
            color:   color || CONFIG.groupColors[this.domains.length % CONFIG.groupColors.length],
            // A node belongs to at most one domain — drop any member already
            // claimed by another domain so boundaries never overlap in data.
            members: []
        };
        this.domains.push(d);
        this.setDomainMembers(d.id, members);
        return d;
    }

    updateDomain(id, patch) {
        const d = this.domainById(id);
        if (!d) return null;
        if (patch.name  !== undefined) d.name  = patch.name || '';
        if (patch.color !== undefined) d.color = patch.color || d.color;
        if (patch.members !== undefined) this.setDomainMembers(id, patch.members);
        return d;
    }

    // Set a domain's members, enforcing single-domain membership (a node moved
    // into this domain leaves whatever domain it was in).
    setDomainMembers(id, members) {
        const d = this.domainById(id);
        if (!d) return;
        const want = Array.from(new Set((members || []).filter(m => typeof m === 'string')));
        want.forEach(mid => {
            this.domains.forEach(other => {
                if (other.id !== id) other.members = other.members.filter(x => x !== mid);
            });
        });
        d.members = want;
    }

    deleteDomain(id) {
        // Removing a boundary never touches the nodes inside it.
        this.domains = this.domains.filter(d => d.id !== id);
    }

    // Drop deleted node ids from every domain (called on node deletion so a
    // boundary never references a node that no longer exists).
    _purgeDomainMembers(ids) {
        if (!ids || !ids.size || !this.domains) return;
        this.domains.forEach(d => { d.members = (d.members || []).filter(m => !ids.has(m)); });
    }

    /* ── Serialisation ────────────────────────────────────────────── */

    toJSON() {
        this._syncActive();   // make sure the live arrays are captured
        return {
            name:        this.name,
            version:     CONFIG.fileVersion,
            mode:        ['ETA','FMEDA'].includes(this.mode) ? this.mode : 'FTA',
            missionTime: this.missionTime,
            standard:    this.standard === 'IEC61508' ? 'IEC61508' : 'ISO26262',
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
            domains:   (m.domains || []).map(d => ({ ...d, members: (d.members || []).slice() })),
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
            // Mitigation flag (v6+). Absent in older files ⇒ false, so every
            // legacy element loads as an ordinary element. Only meaningful on
            // an element; a mitigation is always low-level.
            mitigation:  !!g.mitigation && g.kind === 'element',
            // Route 1ₕ inputs (v6.1+). Absent in older files ⇒ Type B / HFT 0
            // (the conservative default), so a legacy element loads unchanged.
            elementType: g.kind === 'element' ? (g.elementType === 'A' ? 'A' : 'B') : null,
            hft:         g.kind === 'element'
                         ? Math.max(0, Math.min(2, parseInt(g.hft, 10) || 0)) : null,
            // Declared integrity (v3.0.0). These were previously dropped on
            // load — a saved claimedSff / claimedCapability vanished on reopen,
            // silently erasing an element's declared band. Restored here,
            // mirroring addGroup (element-only, SFF clamped to 0..1).
            claimedSff:        g.kind === 'element'
                         ? (g.claimedSff != null ? fmt.clamp(g.claimedSff, 0, 1, null) : null) : null,
            claimedCapability: g.kind === 'element' ? (g.claimedCapability || null) : null,
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
                /* FMEDA primitives (v2.3.0). Absent in older files → null, so
                   fmedaRawFit/fmedaSafeFit fall back to the stored λ_D/λ_S.
                   The editor migrates an old event to primitives on Save. */
                lambdaBase:          e.lambdaBase != null ? Math.max(0, +e.lambdaBase || 0) : null,
                fmd:                 e.fmd != null ? fmt.clamp(e.fmd, 0, 1, 1) : null,
                dangerousFraction:   e.dangerousFraction != null ? fmt.clamp(e.dangerousFraction, 0, 1, 1) : null,
                diagnosticCoverage:  fmt.clamp(e.diagnosticCoverage, 0, 1,
                                                d.diagnosticCoverage),
                diagnosticCoverageLatent: fmt.clamp(e.diagnosticCoverageLatent, 0, 1,
                                                d.diagnosticCoverageLatent || 0),
                failureRateSafe:     _num(e.failureRateSafe, d.failureRateSafe || 0),
                diagnosticEvidence:  e.diagnosticEvidence || '',
                mitigation:          e.mitigation || '',
                commonCauseMitigated: !!e.commonCauseMitigated,
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

        // Visual domain boundaries (v3.3.0). Purely cosmetic: a name, a colour
        // and a list of member node ids. Endpoint existence is re-checked
        // lazily by the canvas; here we only sanity-filter the shape.
        const domains = (Array.isArray(src.domains) ? src.domains : [])
            .filter(d => d && d.id)
            .map((d, i) => ({
                id:      d.id,
                name:    d.name || '',
                color:   d.color || CONFIG.groupColors[i % CONFIG.groupColors.length],
                members: Array.isArray(d.members)
                         ? d.members.filter(m => typeof m === 'string') : []
            }));

        return { groups, events, gates, links, scenarios, netEdges, failGates, failGatePos, domains };
    }

    static fromJSON(obj) {
        if (!obj || typeof obj !== 'object') {
            throw new Error('Invalid file: not an object.');
        }
        const v = +obj.version || 1;
        const p = new Project(obj.name || '');
        p.missionTime = fmt.posNum(obj.missionTime, CONFIG.defaultMissionTime) ||
                        CONFIG.defaultMissionTime;
        // Results lens — older files (no `standard`) default to ISO 26262.
        p.standard = (obj.standard === 'IEC61508') ? 'IEC61508' : 'ISO26262';

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
                    p._models.FTA.netEdges || [], p._models.FTA.domains || [])
            .concat(p._models.ETA.events, p._models.ETA.gates, p._models.ETA.links,
                    p._models.ETA.groups, p._models.ETA.scenarios,
                    p._models.ETA.netEdges || [], p._models.ETA.domains || [])
            .concat(p._models.FMEDA.events, p._models.FMEDA.gates,
                    p._models.FMEDA.links, p._models.FMEDA.groups,
                    p._models.FMEDA.scenarios, p._models.FMEDA.netEdges || [],
                    p._models.FMEDA.domains || []);
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
