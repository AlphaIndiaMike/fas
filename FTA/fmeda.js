/* fmeda.js — FMEDA / functional-safety engine (model + analysis)

   The element/function/failure-mode hierarchy, the architecture and
   failure nets, mitigation, the bottom-up rate/coverage propagation, the
   ISO 26262 + IEC 61508 metrics & banding (including the derived-function
   subtree banding), validation/cross-checks, common-cause and safety
   requirements. This is the bulk of what used to crowd fas.js.

   Part of the Project class, split out for separation of concerns
   (v3.2.1). These methods are attached to Project.prototype, so a
   Project instance uses them exactly as before — e.g. p.addGroup().
   Loaded AFTER fas.js (which defines class Project). */
'use strict';
(function () {
    Object.assign(Project.prototype, {

    /* ── Group CRUD ───────────────────────────────────────────────── */

    addGroup({ name, color, description, parentId = null,
               kind = 'group', level = null, mitigation = false,
               elementType = null, hft = null, claimedSff = null,
               claimedCapability = null, archType = null, lambdaBase = null,
               lambdaUnit = 'fit', fnType = null, x = 0, y = 0 }) {
        // A Mitigation element is a low-level architecture element with the
        // 'M' id prefix. Normalise: mitigation ⇒ element, low level.
        mitigation = !!mitigation && kind === 'element';
        if (mitigation) level = 'low';
        const col = color ||
            CONFIG.groupColors[this.groups.length % CONFIG.groupColors.length];
        const gr = {
            id:          fmt.uid(Project._groupIdPrefix(kind, level, mitigation)),
            name:        name || this._uniqueGroupName(),
            color:       col,
            description: description || '',
            // FMEDA containment fields. FTA & ETA leave these at the
            // defaults (parentId null, kind 'group') and ignore them.
            //   kind:  'element' | 'function' | 'group'
            //   parentId: a function's parent element (null otherwise)
            //   level: 'top' | 'mid' | 'low' swimlane (elements only)
            //   mitigation: true ⇒ this element is a Mitigation (M_n). It is
            //        an ordinary low element in every computation; the flag
            //        only drives its id prefix, styling and common-cause role.
            //   x/y: saved position. Empty FMEDA elements/functions persist
            //        their spot here; populated ones derive it from children.
            parentId:    parentId,
            kind:        kind,
            level:       level,
            mitigation:  mitigation,
            // IEC 61508-2 Route 1ₕ inputs (elements only; ignored elsewhere).
            //   elementType: 'A' (simple) | 'B' (complex). Default 'B' — the
            //        conservative assumption for programmable / complex HW.
            //   hft: hardware fault tolerance 0 | 1 | 2. Default 0.
            elementType: kind === 'element' ? ((elementType === 'A') ? 'A' : 'B') : null,
            hft:         kind === 'element' ? Math.max(0, Math.min(2, parseInt(hft, 10) || 0)) : null,
            // Subsystem supplier claim (elements only; optional, both null by
            // default). A black-box subsystem may carry the supplier's already-
            // discharged result instead of being computed from internal modes:
            //   claimedSff: 0..1 — stated safe-failure fraction, fed to Route 1ₕ.
            //   claimedCapability: a CONFIG.targetCombined value ('SIL n'/'ASIL x')
            //        — the certified integrity, used directly under its lens.
            // Both are ASSUMPTIONS, flagged as such in the results/report.
            claimedSff:        kind === 'element' ? (claimedSff != null ? fmt.clamp(claimedSff, 0, 1, null) : null) : null,
            claimedCapability: kind === 'element' ? (claimedCapability || null) : null,
            // Layered model (v7). An element's structural type decides where its
            // rate comes from: 'hardware' (low, carries λ), 'subsystem' (mid) or
            // 'system' (top) — the latter two systematic (fed from below). A new
            // element defaults to the type for its level; a mitigation is always
            // hardware. λ (FIT) lives on the element; a function is typed HW/SW/SYS.
            archType:    kind === 'element'
                         ? (mitigation ? 'hardware'
                            : (['hardware','system','subsystem'].includes(archType) ? archType
                               : ((CONFIG.archTypeByLevel[level] && CONFIG.archTypeByLevel[level].default) || null)))
                         : null,
            lambdaBase:  kind === 'element' ? (lambdaBase != null ? Math.max(0, +lambdaBase || 0) : null) : null,
            lambdaUnit:  kind === 'element' ? (lambdaUnit === 'ph' ? 'ph' : 'fit') : null,
            fnType:      kind === 'function' ? (['HW','SW','SYS'].includes(fnType) ? fnType : 'HW') : null,
            x:           x || 0,
            y:           y || 0
        };
        this.groups.push(gr);
        return gr;
    },

    /* FMEDA helpers — null/empty in FTA & ETA. */
    elementGroups()   { return this.groups.filter(g => g.kind === 'element'); },
    functionGroups()  { return this.groups.filter(g => g.kind === 'function'); },
    /* A Mitigation element is an ordinary element carrying the mitigation
       flag. mitigationElements() lists them; isMitigationElement() tests a
       group; isMitigationFailure() tests whether a failure mode lives inside
       a Mitigation element (used by the common-cause "addressed by M" rule). */
    mitigationElements() {
        return this.groups.filter(g => g.kind === 'element' && g.mitigation);
    },
    isMitigationElement(g) { return !!(g && g.kind === 'element' && g.mitigation); },
    /* Flip a LOW-LEVEL element between an ordinary element and a Mitigation.
       Only the flag changes — functions, failure modes and net edges are kept,
       so a misclassified element can be corrected without rebuilding it. (The id
       prefix, fixed at creation, is cosmetic; every rule keys off this flag.)
       Refuses anything that is not an existing low-level element. */
    setElementMitigation(id, isMit) {
        const g = this.groupById(id);
        if (!g || g.kind !== 'element' || g.level !== 'low') return false;
        g.mitigation = !!isMit;
        return true;
    },
    isMitigationFailure(eventId) {
        const e = this.eventById(eventId);
        if (!e || !e.groupId) return false;
        const el = this.elementOf(e.groupId);
        return this.isMitigationElement(el);
    },
    childGroups(parentId) {
        return this.groups.filter(g => g.parentId === parentId);
    },
    /* The element a group ultimately belongs to (walk up parentId). */
    elementOf(groupId) {
        let g = this.groupById(groupId), guard = 0;
        while (g && g.parentId && guard++ < 20) g = this.groupById(g.parentId);
        return g && g.kind === 'element' ? g : (g || null);
    },

    /* ── Layered model (v7) helpers ───────────────────────────────────────
       The structural type of an element, falling back to the default for its
       level when unset (a legacy element, flagged for review on load, still
       computes sensibly: low ⇒ hardware, mid ⇒ subsystem, top ⇒ system). A
       Mitigation is always hardware. */
    archTypeOf(el) {
        if (!el || el.kind !== 'element') return null;
        if (el.mitigation) return 'hardware';
        if (['hardware','system','subsystem'].includes(el.archType)) return el.archType;
        const byLvl = CONFIG.archTypeByLevel[el.level];
        return byLvl ? byLvl.default : null;
    },
    /* A systematic element (system / subsystem) carries no own rate — it is fed
       bottom-up through the failure net. Hardware elements carry λ. */
    isSystematicElement(el) {
        const t = this.archTypeOf(el);
        return t === 'system' || t === 'subsystem';
    },
    /* The base failure rate λ (FIT) an element provides to its failure modes.
       Only hardware elements carry one; a systematic element returns 0 (its
       modes are derived). null λ (not yet entered) reads as 0. */
    elementLambdaFit(el) {
        if (!el || el.kind !== 'element') return 0;
        if (this.isSystematicElement(el)) return 0;
        return Math.max(0, +el.lambdaBase || 0);
    },
    /* The element that owns a failure mode (via its function), or null. */
    elementOfMode(eventId) {
        const e = this.eventById(eventId);
        if (!e || !e.groupId) return null;
        return this.elementOf(e.groupId);
    },

    _uniqueGroupName() {
        let n = this.groups.length + 1;
        let nm;
        do { nm = 'Group ' + n; n++; }
        while (this.groups.some(g => g.name === nm));
        return nm;
    },

    updateGroup(id, patch) {
        const gr = this.groupById(id);
        if (!gr) return false;
        Object.assign(gr, patch);
        return true;
    },

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
            this._purgeDomainMembers(new Set([...doomed, ...goneEvents]));
        } else {
            // FTA & ETA: the group is only a label — events survive and
            // fall back to "ungrouped" (unchanged legacy behaviour).
            this.events.forEach(e => { if (doomed.has(e.groupId)) e.groupId = null; });
            if (this.netEdges && this.netEdges.length) {
                this.netEdges = this.netEdges.filter(
                    ed => !doomed.has(ed.from) && !doomed.has(ed.to));
            }
            this._purgeDomainMembers(doomed);
        }
    },

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
    },

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
    },

    /* Raw dangerous rate λ_D in FIT, before any diagnostic credit. LAYERED
       model (v7): the rate is NOT entered on the failure mode — the mode
       INHERITS its element's base rate λ and takes its FMD share, then the
       dangerous fraction splits off the dangerous part:
           λ_mode = λ_element × FMD ;   λ_D = λ_mode × dangerous-fraction
       Only a hardware element carries λ, so a mode under a systematic (mid/top)
       element returns 0 here — it is a derived effect fed through the failure
       net, never a typed rate. A hardware element whose λ is not yet entered
       also returns 0 (the element is flagged "not characterised" until set). */
    fmedaRawFit(e) {
        if (!e) return 0;
        const base = this.elementLambdaFit(e.groupId ? this.elementOf(e.groupId) : null);
        if (!(base > 0)) return 0;
        const fmd  = fmt.clamp(e.fmd, 0, 1, 1);
        const dang = fmt.clamp(e.dangerousFraction, 0, 1, 1);
        return base * fmd * dang;
    },

    /* Safe failure rate λ_S in FIT — the non-dangerous part of the mode's
       inherited rate: λ_S = λ_element × FMD × (1 − dangerous-fraction). 0 when
       the element carries no rate (systematic, or λ not yet entered). */
    fmedaSafeFit(e) {
        if (!e) return 0;
        const base = this.elementLambdaFit(e.groupId ? this.elementOf(e.groupId) : null);
        if (!(base > 0)) return 0;
        const fmd  = fmt.clamp(e.fmd, 0, 1, 1);
        const dang = fmt.clamp(e.dangerousFraction, 0, 1, 1);
        return base * fmd * (1 - dang);
    },

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
    },

    /* The swimlane level ('top' | 'mid' | 'low' | null) of the element that
       ultimately owns a failure mode. A failure mode lives in a function,
       which lives in an element; the element carries the level. */
    fmedaLevelOf(eventId) {
        const e = this.eventById(eventId);
        if (!e || !e.groupId) return null;
        const el = this.elementOf(e.groupId);
        return el ? (el.level || null) : null;
    },

    /* DERIVED is decided by LEVEL, not by net topology (decision: a top/mid
       architecture element's failure modes are SYSTEM-level effects whose
       rate must come bottom-up from the low-level causes that feed them —
       they may not carry their own typed rate or their own mitigation).
       Only LOW-level (leaf) failure modes are entered directly. A mode with
       no level is treated as a leaf so legacy/loose models still edit. */
    fmedaIsDerived(eventId) {
        const lvl = this.fmedaLevelOf(eventId);
        return lvl === 'top' || lvl === 'mid';
    },

    /* PROPAGATED RAW (FIT) — the dangerous rate flowing through a failure mode
       before this node's own diagnostic credit, under the ADDITIVE model:

           propagatedRaw = ownRaw + combine(incoming propagatedRaw, gate)

       · ownRaw is the mode's OWN typed raw rate (fmedaRawFit) for a LEAF
         (low-level, incl. Mitigation elements), and 0 for a DERIVED top/mid
         mode (those carry no own rate — they are pure roll-ups).
       · incoming are the failure-net causes (cause → effect). A leaf with no
         incoming reduces to its own raw (unchanged from earlier behaviour);
         a leaf WITH incoming (e.g. an LL fed by another LL or by an M) now
         ADDS the incoming on top of its own — composition is edge-driven, not
         level-gated.
       Cycle-guarded across ALL nodes (an LL→LL loop is now possible): a node
       reached again contributes its own raw only and the cycle is reported. */
    fmedaPropagatedRaw(eventId, _stack) {
        const e = this.eventById(eventId);
        if (!e) return 0;
        const own = this.fmedaIsDerived(eventId) ? 0 : this.fmedaRawFit(e);
        const incoming = this.failIncoming(eventId);
        if (!incoming.length) return own;
        _stack = _stack || new Set();
        if (_stack.has(eventId)) { this._failCycleSeen = true; return own; }
        _stack.add(eventId);
        const srcRaw = incoming.map(ed => this.fmedaPropagatedRaw(ed.from, _stack));
        _stack.delete(eventId);
        return own + this._combineFit(srcRaw, this.failGateOf(eventId),
                                e.missionTimeOverride || this.missionTime || 1);
    },

    /* PROPAGATED residual (FIT) — the value actually used for a failure once
       the failure net is taken into account, under the ADDITIVE model:

           propagatedResidual = ownResidual + combine(incoming residuals, gate)

       · ownResidual is the mode's OWN local residual (its typed rate after its
         own diagnostic credit, fmedaResidualFit) for a LEAF, and 0 for a
         DERIVED top/mid mode.
       · incoming residuals are the causes' propagated residuals, combined by
         the target's gate:
             OR  → rates sum (any cause defeats it; first-order)
             AND → all causes needed; combine in probability space over the
                   mission time, then convert back to an equivalent rate.
       A leaf with NO incoming returns its own residual exactly as before
       (so files/demos that never feed an LL are bit-for-bit unchanged). A
       leaf WITH incoming ADDS the incoming on top — this is how the entered
       number "sits on top of what's already flowing in". A DERIVED mode has
       own = 0, so it remains the pure combination of its causes, identical to
       earlier behaviour. The diagnostic credit a derived mode shows is
       COMPUTED, see fmedaComputedDC.
       Cycle-guarded across ALL nodes: a node reached again contributes its
       own residual only, and the cycle is reported via fmedaPropagationCycle(). */
    fmedaPropagatedResidual(eventId, _stack) {
        const e = this.eventById(eventId);
        if (!e) return 0;
        const derived = this.fmedaIsDerived(eventId);
        const isMit   = this.isMitigationFailure(eventId);
        // Own contribution:
        //  · derived (systematic mid/top): 0 — a pure roll-up of its causes.
        //  · MITIGATION leaf: its own RAW dangerous rate. A mitigation has no
        //    separate self-DC — its diagnostic coverage acts on the rate flowing
        //    THROUGH it (the incoming), not on itself, unless coverageIncludesSelf
        //    is set (handled in _mitigationResidual).
        //  · ordinary leaf: its local residual = raw after its own DC.
        const ownRaw = derived ? 0 : this.fmedaRawFit(e);
        const own    = isMit ? ownRaw : (derived ? 0 : this.fmedaResidualFit(e));

        const incomingEdges = this.failIncoming(eventId);
        let incoming = 0;
        if (incomingEdges.length) {
            _stack = _stack || new Set();
            if (_stack.has(eventId)) {           // cycle — break it, keep own
                this._failCycleSeen = true;
                return isMit ? this._mitigationResidual(e, 0, ownRaw) : own;
            }
            _stack.add(eventId);
            const srcRates = incomingEdges.map(ed =>
                this.fmedaPropagatedResidual(ed.from, _stack));
            _stack.delete(eventId);
            incoming = this._combineFit(srcRates, this.failGateOf(eventId),
                                e.missionTimeOverride || this.missionTime || 1);
        }

        // A MITIGATION reduces the incoming rate by its DC and adds its own
        // (un-self-diagnosed) rate; an ordinary node adds the incoming on top of
        // its own residual unchanged (the incoming is not re-covered here).
        if (isMit) return this._mitigationResidual(e, incoming, ownRaw);
        return own + incoming;
    },

    /* The residual leaving a MITIGATION failure mode, per the layered model:
         coverageIncludesSelf = false →  incoming × (1 − DC) + own
         coverageIncludesSelf = true  → (incoming + own) × (1 − DC)
       `own` is the mitigation's RAW dangerous rate (it has no separate self-DC;
       DC is the coverage it applies to what flows through it). */
    _mitigationResidual(e, incoming, ownRaw) {
        const dc = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
        return e.coverageIncludesSelf
            ? (incoming + ownRaw) * (1 - dc)
            : incoming * (1 - dc) + ownRaw;
    },

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
    },

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
    },

    /* True if the last rollup/propagation walk encountered a cycle. */
    fmedaPropagationCycle() { return !!this._failCycleSeen; },

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
            // Effective raw under the additive model: the raw rate that
            // PROPAGATES through the mode (own + incoming). For a leaf with no
            // incoming this equals its own typed raw (unchanged); for a leaf
            // fed by another failure (LL←LL, M→LL) or a derived mode it folds
            // the incoming in, so "raw vs residual" stays consistent (raw ≥
            // residual) instead of a leaf showing residual > raw.
            const raw = this.fmedaPropagatedRaw(e.id);
            const res = this.fmedaPropagatedResidual(e.id);
            const handled = derived
                ? this.fmedaComputedDC(e.id) > 0           // derived: handled by upstream
                : (this.fmedaIsHandled(e) || (+e.diagnosticCoverage || 0) > 0);
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
    },

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
        const byFn = new Map();
        if (this.mode !== 'FMEDA') return { total, elements: [], functions: [] };
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            if (this.fmedaIsDerived(e.id)) return;             // leaves only
            const fn = this.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const contrib = this._fmedaLeafContribution(e);
            if (!contrib) return;                              // nothing to count
            const el = this.elementOf(fn.id);
            const elId = el ? el.id : '__none__';
            if (!byEl.has(elId)) {
                byEl.set(elId, Object.assign(blank(), {
                    id: el ? el.id : null,
                    name: el ? el.name : '—',
                    level: el ? (el.level || null) : null,
                    elementType: (el && el.elementType === 'A') ? 'A' : 'B',
                    hft: el ? Math.max(0, Math.min(2, parseInt(el.hft, 10) || 0)) : 0,
                    claimedSff: (el && el.claimedSff != null) ? fmt.clamp(el.claimedSff, 0, 1, null) : null,
                    claimedCapability: el ? (el.claimedCapability || null) : null
                }));
            }
            const acc = byEl.get(elId);
            Object.keys(contrib).forEach(k => { acc[k] += contrib[k]; total[k] += contrib[k]; });
            // Per-FUNCTION accumulation, so a function carries its OWN SPFM/LFM
            // and earns the SAME metric-gated band the element/system use (not a
            // rate-only proxy that cannot express ASIL C). Functions have no
            // Route 1ₕ cap of their own — that is an element property.
            if (!byFn.has(fn.id)) {
                byFn.set(fn.id, Object.assign(blank(), {
                    id: fn.id, name: fn.name,
                    elementId: el ? el.id : null,
                    level: el ? (el.level || null) : null
                }));
            }
            const accFn = byFn.get(fn.id);
            Object.keys(contrib).forEach(k => { accFn[k] += contrib[k]; });
        });
        const finalize = (a, isElement) => {
            const rf = a.lambdaSPF + a.lambdaRF;
            // SFF = (safe + dangerous-detected) / total. With a real λ_S this
            // is no longer pinned to the detected-dangerous fraction.
            a.sff  = a.lambdaTotal > 0
                ? (a.lambdaSD + a.lambdaSU + a.lambdaDD) / a.lambdaTotal : null;
            a.spfm = a.lambdaTotal > 0 ? 1 - rf / a.lambdaTotal : null;
            const mpfBase = a.lambdaTotal - rf;
            a.lfm  = mpfBase > 0 ? 1 - a.lambdaMPFlatent / mpfBase : null;
            // IEC 61508-2 Route 1ₕ architectural cap from this element's Type and
            // SFF, with the HFT COMPUTED from its redundancy structure (never the
            // stale stored field). A datasheet-declared SFF (claimedSff), when
            // present, is the SFF of record — it overrides the computed one for
            // both the headline and Route 1ₕ. Per-element only; the total is an
            // aggregate.
            if (isElement) {
                if (a.claimedSff != null) a.sff = a.claimedSff;
                a.hft = this.fmedaComputedHft(a.id);
                a.route1hSil = fmt.route1hMaxSil(a.elementType, a.sff, a.hft);
                if (a.claimedSff != null) a.claimed = true;
            }
            // Achieved integrity per standard, from these AGGREGATED metrics —
            // the standard-correct element/item band (NOT a single function's).
            // ISO is metric-gated (PMHF/SPFM/LFM); IEC is the PFH band capped by
            // Route 1ₕ. The TOTAL's IEC cap is the system limiter, assigned by the
            // caller below; the ASIL has no such dependency and is stamped here.
            a.achievedAsil = fmt.achievedBand(a, true);
            if (isElement) a.achievedSil = fmt.achievedBand(a, false);
            // Declared capability = SYSTEMATIC-CAPABILITY CEILING (elements only).
            // It is ALWAYS a ceiling — the entered failure data drives the band,
            // and the declaration can only pull it DOWN, never lift it. There is
            // no policy toggle: "an ASIL-B controller cannot self-diagnose its way
            // to ASIL-D." The cap applies per matching lens (ASIL claim → ASIL
            // band; SIL claim → SIL band). The uncapped bands are kept for the UI.
            //   The ONE exception is a DECLARED-ONLY element — one with a
            // capability but no entered failure data (its row was filled at the
            // band's worst case below): there the band simply IS the declaration,
            // since there is no measured evidence to drive or contradict it.
            if (isElement) {
                a.achievedAsilUncapped = a.achievedAsil;
                a.achievedSilUncapped  = a.achievedSil;
                if (a.claimedSff != null || a.claimedCapability) {
                    const c = this._resolveClaim(a);
                    if (c.has) {
                        a.claimed = true;
                        a.claimSff = c.sff;
                        a.claimCapability = a.claimedCapability || null;
                        if (a._worstCase) {
                            // No measured data — the declaration is the band.
                            if (c.sff != null)          a.sff         = c.sff;
                            if (c.route1hSil != null)   a.route1hSil  = c.route1hSil;
                            if (c.achievedSil != null)  a.achievedSil = c.achievedSil;
                            if (c.achievedAsil != null) a.achievedAsil = c.achievedAsil;
                        } else {
                            if (c.achievedSil  != null) a.achievedSil  = fmt.silMin(a.achievedSil,  c.achievedSil);
                            if (c.achievedAsil != null) a.achievedAsil = fmt.asilMin(a.achievedAsil, c.achievedAsil);
                        }
                    }
                }
                a.cappedByCapability = (a.achievedAsil !== a.achievedAsilUncapped) ||
                                       (a.achievedSil  !== a.achievedSilUncapped);
            }
            return a;
        };
        // ── Declared-capability worst-case roll-up for an UN-detailed element.
        // When a low-level element carries a declared capability but no entered
        // failure rate, its contribution is taken at the WORST CASE of that band
        // (top of the band) so a declared "SIL 2 / ASIL B" element still rolls up
        // correctly before its datasheet numbers are filled in. Once a base λ is
        // entered, that data drives the element and this fallback steps aside (the
        // declared capability remains the ceiling, applied in finalize).
        const _wcKeys = { lambdaSD: 0, lambdaSU: 0, lambdaDD: 0, lambdaRF: 0,
                          lambdaMPFdp: 0, lambdaMPFlatent: 0 };
        this.elementGroups().forEach(el => {
            const isLeaf = !!(el.mitigation || el.level === 'low');
            if (!isLeaf || !el.claimedCapability) return;
            // Entered failure data drives the element; the worst-case fallback is
            // only for a declared element that has NO base rate yet.
            if (this.elementLambdaFit(el) > 0) return;
            const wc = fmt.worstCaseFitForCapability(el.claimedCapability);
            if (wc == null) return;                              // QM → no rate
            let row = byEl.get(el.id);
            if (row) {
                // Remove this element's entered-data λ from the total, then set
                // it to the worst-case rate and add that back.
                Object.keys(total).forEach(k => { if (typeof total[k] === 'number') total[k] -= (row[k] || 0); });
                Object.assign(row, _wcKeys, { lambdaTotal: wc, lambdaDU: wc, lambdaSPF: wc, count: 1, _worstCase: true });
            } else {
                row = Object.assign(blank(), _wcKeys, {
                    id: el.id, name: el.name, level: el.level || null,
                    elementType: (el.elementType === 'A') ? 'A' : 'B',
                    hft: Math.max(0, Math.min(2, parseInt(el.hft, 10) || 0)),
                    claimedSff: (el.claimedSff != null) ? fmt.clamp(el.claimedSff, 0, 1, null) : null,
                    claimedCapability: el.claimedCapability || null, _worstCase: true,
                    lambdaTotal: wc, lambdaDU: wc, lambdaSPF: wc, count: 1
                });
                byEl.set(el.id, row);
            }
            Object.keys(row).forEach(k => { if (typeof row[k] === 'number' && k in total) total[k] += (row[k] || 0); });
        });
        finalize(total, false);
        const elements = Array.from(byEl.values()).map(a => finalize(a, true));
        // System architectural cap = the most limiting element's Route 1ₕ SIL
        // (a safety function is no better than its weakest constrained element).
        let cap = null, limiter = null;
        elements.forEach(e => {
            if (e.route1hSil == null || e.route1hSil === '—') return;
            if (cap == null || fmt.silRank(e.route1hSil) < fmt.silRank(cap)) {
                cap = e.route1hSil; limiter = e.name;
            }
        });
        total.route1hSil     = cap;       // null when no element has a computed SFF
        total.route1hLimiter = limiter;
        // The system claimable SIL depends on the limiter cap just computed.
        total.achievedSil = fmt.achievedBand(total, false);

        // ── DERIVED functions (top/mid) — band them, don't leave them rate-only.
        // The leaf loop above only banded functions that OWN a leaf mode. A
        // top/mid function whose modes are all DERIVED never entered `byFn`, so
        // until now it fell back (in the canvas/panel/report) to the rate-only
        // ASIL ladder — which cannot tell ASIL C from B (they share the PMHF
        // range; only SPFM/LFM separate them). That made an identical residual
        // read ASIL C at the leaf and ASIL B one level up: a band that DROPS as
        // the same failure propagates LL → ML → TL. Fix: give each derived
        // function the SAME metric-gated ASIL the leaf/element/system earn,
        // aggregated over the LEAVES that feed its modes through the fail net
        // (its subtree). These rows are for BANDING ONLY — they are deliberately
        // NOT folded into `total` or `byEl` (their leaves are already counted
        // there once; folding them in would double-count). The SIL is left
        // exactly as before — the PFH band of the function's OWN residual rate
        // (a function carries no Route 1ₕ cap) — so the IEC lens is untouched.
        const fnIds = new Set();
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const fn = this.groupById(e.groupId);
            if (fn && fn.kind === 'function') fnIds.add(fn.id);
        });
        fnIds.forEach(fnId => {
            if (byFn.has(fnId)) return;                 // already banded from its own leaves
            const fn = this.groupById(fnId);
            if (!fn) return;
            const el  = this.elementOf(fnId);
            const agg = this._fmedaAggregateLeaves(this._fmedaFunctionLeaves(fnId), null);
            let residual = 0;
            this.events.forEach(e => {
                if (e.kind === 'basic' && e.groupId === fnId)
                    residual += this.fmedaPropagatedResidual(e.id);
            });
            agg.id = fnId; agg.name = fn.name;
            agg.elementId = el ? el.id : null;
            agg.level = el ? (el.level || null) : null;
            agg.residualFit = residual;   // marks a derived-function (subtree) row
            byFn.set(fnId, agg);
        });

        // Functions: rate-driven ASIL (PMHF) and SIL (λ_DU / propagated
        // residual), then CAPPED to the owning element's achieved band — a
        // function is no more integrous than the hardware element that
        // implements it (kills "SIL-4 function on a SIL-2 element"). A function
        // with no rate is not characterised → '—' (no claim on the canvas).
        const elBandById = {};
        elements.forEach(e => { elBandById[e.id] = { asil: e.achievedAsil, sil: e.achievedSil }; });
        const _asilOrder = ['—', 'QM', 'ASIL A', 'ASIL B', 'ASIL C', 'ASIL D'];
        const _arank = b => _asilOrder.indexOf(b);
        const capAsil = (b, ceil) => {
            if (b === '—') return '—';
            if (ceil == null) return b;
            if (ceil === '—') return '—';
            const rb = _arank(b), rc = _arank(ceil);
            return (rb < 0 || rc < 0) ? b : (rb <= rc ? b : ceil);
        };
        const capSil = (b, ceil) => {
            if (b === '—') return '—';
            if (ceil == null) return b;
            if (ceil === '—') return '—';
            return fmt.silMin(b, ceil);
        };
        const functions = Array.from(byFn.values()).map(a => {
            finalize(a, false);                       // sets spfm/lfm/achievedAsil (rate-driven)
            // A subtree-aggregated (derived) function bands its SIL off its OWN
            // propagated residual; a residual of 0 is not characterised → '—'.
            if (a.residualFit != null) {
                a.achievedSil = (a.residualFit > 0)
                    ? fmt.silForPfh(a.residualFit * 1e-9)
                    : (a.lambdaTotal > 0 ? fmt.achievedBand(a, false) : '—');
            } else {
                a.achievedSil = fmt.achievedBand(a, false);
            }
            // Cap both scales to the owning element's achieved band.
            const ec = a.elementId != null ? elBandById[a.elementId] : null;
            if (ec) {
                a.achievedAsilUncapped = a.achievedAsil;
                a.achievedSilUncapped  = a.achievedSil;
                a.achievedAsil = capAsil(a.achievedAsil, ec.asil);
                a.achievedSil  = capSil(a.achievedSil, ec.sil);
                a.cappedByElement = (a.achievedAsil !== a.achievedAsilUncapped) ||
                                    (a.achievedSil  !== a.achievedSilUncapped);
            }
            return a;
        });
        return { total, elements, functions };
    },

    /* CHECKS — a single, headless validation pass shared by the right pane and
       the test suite. Two kinds:
         · 'error'  internal-consistency INVARIANTS that must never fire on valid
                    data (a metric out of [0,1], a λ split that doesn't reconcile,
                    a non-finite/negative rate, a failure-net cycle, a bad mission
                    time). If one fires it means a modelling error OR a tool bug —
                    the demos are asserted error-free, so a future regression that
                    breaks the maths shows up here in development.
         · 'warn'   modelling smells worth catching by eye (coverage with no rate,
                    DC₂ without DC₁, a derived effect with no wired cause, a
                    declared claim the rate cannot support).
       Returns [{ level, msg }]. */
    fmedaValidate(lensIso) {
        const out = [];
        if (this.mode !== 'FMEDA') return out;
        const add = (level, msg) => out.push({ level, msg });
        const m  = this.fmedaMetrics();
        const ru = this.fmedaRollup();          // resets + sets the cycle flag
        const inRange = x => x == null || (isFinite(x) && x >= -1e-9 && x <= 1 + 1e-9);

        // ── Invariants (per element + system total) ───────────────────────
        const checkRow = (a, label) => {
            if (!inRange(a.sff))  add('error', `${label}: SFF out of range (${a.sff}).`);
            if (!inRange(a.spfm)) add('error', `${label}: SPFM out of range (${a.spfm}).`);
            if (!inRange(a.lfm))  add('error', `${label}: LFM out of range (${a.lfm}).`);
            if (!isFinite(a.lambdaTotal) || a.lambdaTotal < -1e-9)
                add('error', `${label}: λ_total is invalid.`);
            const tol = 1e-6 * Math.max(1, a.lambdaDU);
            if (Math.abs((a.lambdaSPF + a.lambdaRF) - a.lambdaDU) > tol)
                add('error', `${label}: λ_SPF + λ_RF does not reconcile with λ_DU.`);
            if (!isFinite(a.lambdaSPF + a.lambdaRF))
                add('error', `${label}: PMHF is non-finite.`);
        };
        checkRow(m.total, 'System');
        m.elements.forEach(e => checkRow(e, 'Element ' + (e.name || e.id)));
        if (this.fmedaPropagationCycle())
            add('error', 'The failure net contains a cycle — a cause eventually feeds back into itself. Break the loop so rates can propagate.');
        if (!(this.missionTime > 0))
            add('error', `Mission time must be greater than 0 h (it is ${this.missionTime}).`);
        (ru.functions || []).forEach(f => {
            if (!isFinite(f.residualFit) || f.residualFit < -1e-9)
                add('error', `Function ${f.name} (${f.id}) has an invalid residual rate — check its failure-mode inputs.`);
        });

        // ── Domain / user-input smells ────────────────────────────────────
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const nm = e.name || e.id;
            if (this.fmedaIsDerived(e.id)) {
                // A derived (top/mid) effect IS the effect, not the cause: it takes
                // its numbers BOTTOM-UP from the leaf failure modes wired into it.
                // A wired effect is the intended pattern (no warning); an UN-wired
                // one has no rate to inherit, so its rate stays 0.
                if (this.failIncoming(e.id).length === 0)
                    add('warn', `Derived effect "${nm}" has no contributing cause wired — draw a failure-net link from the leaf failure mode(s) that cause it, or its rate stays 0.`);
                return;
            }
            const dc1  = +e.diagnosticCoverage || 0;
            const dc2  = +e.diagnosticCoverageLatent || 0;
            // The rate is now inherited from the element (λ × FMD), so "DC with no
            // rate" means the element has no λ, or this mode's FMD/dangerous
            // fraction is 0 — the coverage then has nothing to act on.
            const base = this.fmedaRawFit(e);
            const dang = e.dangerousFraction;
            if (dc1 > 0 && base <= 0)
                add('warn', `Failure mode "${nm}" has diagnostic coverage but no dangerous rate — set its element's base λ, and the mode's FMD / dangerous fraction, or the coverage has nothing to act on.`);
            if (dc2 > 0 && dc1 <= 0)
                add('warn', `Failure mode "${nm}" has latent-fault coverage (DC₂) but no single-point coverage (DC₁) — DC₂ credits the check that follows the primary mechanism, so it has no effect without DC₁.`);
            if (dang != null && (dang < 0 || dang > 1))
                add('warn', `Failure mode "${nm}" has a dangerous fraction outside 0–100%.`);
        });

        // ── Layered-model element checks (v7) ─────────────────────────────
        // (i)  FMD shares of one element's modes must not exceed 100% — the FMD
        //      apportions ONE component rate across its modes.
        // (ii) A hardware element that owns modes but has no base λ entered is not
        //      yet characterised — its modes compute 0 until λ is set.
        // (iii)A systematic element (system / subsystem) owning modes but fed by
        //      nothing rolls up to 0 — wire its causes.
        // (iv) A computed band that disagrees with a declared claim (either way).
        const fmdByEl = new Map();   // elementId → { sum, name, count }
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            if (this.fmedaIsDerived(e.id)) return;
            const el = this.elementOf(e.groupId);
            if (!el) return;
            const rec = fmdByEl.get(el.id) || { sum: 0, name: el.name, count: 0 };
            rec.sum += fmt.clamp(e.fmd, 0, 1, 1);
            rec.count += 1;
            fmdByEl.set(el.id, rec);
        });
        fmdByEl.forEach((rec, id) => {
            if (rec.sum > 1 + 1e-9)
                add('warn', `Element "${rec.name}" (${id}): its failure mode distribution sums to ${Math.round(rec.sum * 100)}% and must not exceed 100%. Adjust the failure mode shares.`);
        });
        this.elementGroups().forEach(el => {
            const ownModes = this.events.some(e =>
                e.kind === 'basic' && e.groupId && this.elementOf(e.groupId) === el);
            if (!ownModes) return;
            if (!this.isSystematicElement(el)) {
                if (!(this.elementLambdaFit(el) > 0))
                    add('warn', `Element "${el.name}" (${el.id}): no failure rate or declared safety capability has been provided, so its integrity cannot be established.`);
            } else {
                const fed = this.events.some(e =>
                    e.kind === 'basic' && e.groupId && this.elementOf(e.groupId) === el &&
                    this.failIncoming(e.id).length > 0);
                if (!fed)
                    add('warn', `Element "${el.name}" (${el.id}) is not yet realized by lower-level elements; its integrity cannot be determined until they are defined.`);
            }
        });
        // A leaf whose integrity is taken from its DECLARED CAPABILITY but has no
        // failure data entered: accepted at the band's worst case, with a concise
        // notice pointing to the element (incomplete information is normal).
        this.elementGroups().forEach(el => {
            const isLeaf = !!(el.mitigation || el.level === 'low');
            if (!isLeaf || !el.claimedCapability) return;
            const hasModes = this.events.some(e => e.kind === 'basic' && e.groupId && this.elementOf(e.groupId) === el);
            const hasData  = hasModes || (this.elementLambdaFit(el) > 0);
            if (!hasData)
                add('info', `Element "${el.name}" (${el.id}): integrity is taken from its declared capability; detailed failure data has not been provided.`);
        });
        // ── ASIL-D-without-redundancy advisory (ISO lens only) ───────────────
        // ISO 26262 has no Route 1ₕ table, so HFT is NOT a hard cap on the ASIL
        // band — but reaching ASIL D on a single channel is unusual and must be
        // argued (decomposition / dedicated measures). When an element reaches or
        // claims ASIL D and the tool detects no hardware fault tolerance from the
        // diagram (computed HFT < 1), raise an INFO inviting that justification.
        // It never moves the band — it is purely advisory, the SIL lens is
        // untouched, and the two lenses do not interfere.
        if (lensIso) {
            const bandState = this.fmedaElementBandState(true);
            this.elementGroups().forEach(el => {
                const st = bandState[el.id];
                if (!st || st.band !== 'ASIL D') return;
                if (this.fmedaComputedHft(el.id) >= 1) return;
                add('info', `Element "${el.name}" (${el.id}) reaches ASIL D but no hardware redundancy (HFT ≥ 1) is detected in the architecture — ASIL D on a single channel must be justified (e.g. ASIL decomposition over independent, redundant elements, or dedicated measures with a freedom-from-interference argument).`);
            });
        }

        // A computed-vs-declared mismatch is surfaced in the UI via the band
        // state's `mismatch` flag (computed headline + declared note). The
        // OPTIMISTIC direction (a claim the evidence cannot back) is also caught
        // by the over-claim cross-check above; a conservative claim (the element
        // computes better than it declares) is fine and not warned.

        // ── Declared capability the computed metrics cannot back ──────────
        // Since v3.0.0 an element's band is a DECLARATION, not inferred from
        // its functions. This cross-check confirms the FMEDA evidence actually
        // supports the claim (the "target not met" check professional tools
        // run): take the BEST band any of the element's functions achieves on
        // the metrics (already B/C-correct via asilFromMetrics), and warn if
        // the declared capability outranks it. Equal or lower is fine.
        const iso = this.standard !== 'IEC61508';
        const ASIL_ORDER = ['QM', 'ASIL A', 'ASIL B', 'ASIL C', 'ASIL D'];
        const rankOf = band => iso ? ASIL_ORDER.indexOf(band) : fmt.silRank(band);
        const bestBand = {};            // elementId → { rank, band } over its functions
        (m.functions || []).forEach(f => {
            if (f.elementId == null) return;
            const band = iso ? f.achievedAsil : f.achievedSil;
            const r = rankOf(band);
            if (r < 0) return;
            if (bestBand[f.elementId] == null || r > bestBand[f.elementId].rank)
                bestBand[f.elementId] = { rank: r, band };
        });
        this.elementGroups().forEach(el => {
            const claim = this._resolveClaim(el);
            const claimedBand = iso ? claim.achievedAsil : claim.achievedSil;
            if (!claimedBand) return;                 // nothing declared in this lens
            const cr = rankOf(claimedBand);
            const sup = bestBand[el.id];
            if (cr < 0 || !sup) return;               // no rankable functions
            if (cr > sup.rank)
                add('warn', `Element "${el.name}" (${el.id}) declares ${claimedBand}, but the supporting evidence reaches only ${sup.band}. Review the declared capability or the underlying analysis.`);
        });
        // ── Structural monitors (architecture vs failure net) ─────────────
        // These only run when an architecture net has actually been drawn —
        // a model with no 'arch' edges has no architecture to check against, so
        // it is silent rather than nagging about every cross-element failure.
        const archEdges = this.netEdgesOf('arch');
        if (archEdges.length) {
            const comp = this._fmedaArchComponents();           // elementId → component id
            // (a) A failure path that crosses two architecture elements which are
            //     NOT connected in the architecture net — the rate travels along
            //     an interface the architecture does not have. This is the usual
            //     "why does mid feed that top?" surprise.
            this.netEdgesOf('fail').forEach(ed => {
                const ef = this.eventById(ed.from), et = this.eventById(ed.to);
                if (!ef || !et || !ef.groupId || !et.groupId) return;
                const elf = this.elementOf(ef.groupId), elt = this.elementOf(et.groupId);
                if (!elf || !elt || elf.id === elt.id) return;   // same element = local
                if (comp[elf.id] != null && comp[elf.id] === comp[elt.id]) return;
                add('warn', `Failure path "${ef.name || ef.from}" (${elf.name}) → "${et.name || et.to}" (${elt.name}) crosses two elements that are NOT connected in the architecture net. Connect ${elf.name} and ${elt.name} in the architecture, or correct the failure path.`);
            });
            // (b) An architecture element that owns failure modes but sits OUTSIDE
            //     the architecture net entirely (no arch edge in or out) — a
            //     floating element whose place in the system is undefined.
            const inArch = new Set();
            archEdges.forEach(ed => { inArch.add(ed.from); inArch.add(ed.to); });
            const elHasMode = {};
            this.events.forEach(e => {
                if (e.kind !== 'basic' || !e.groupId) return;
                const el = this.elementOf(e.groupId);
                if (el) elHasMode[el.id] = true;
            });
            this.elementGroups().forEach(el => {
                if (elHasMode[el.id] && !inArch.has(el.id))
                    add('warn', `Element "${el.name}" (${el.id}) carries failure modes but is not connected to the architecture net — place it in the architecture so its role in the system is defined.`);
            });
        }

        // (c) A LEAF failure mode whose failures never reach a top-level effect
        //     through the fail net — it is counted in the metrics but has no
        //     modelled system consequence. Only meaningful once a top element
        //     exists (otherwise there is nothing to reach).
        const hasTop = this.elementGroups().some(el => (el.level || null) === 'top');
        if (hasTop) {
            this.events.forEach(e => {
                if (e.kind !== 'basic' || !e.groupId) return;
                if (this.fmedaIsDerived(e.id)) return;             // leaves only
                if (this.fmedaLevelOf(e.id) === 'top') return;     // a top leaf IS the effect
                if (!(this.fmedaRawFit(e) > 0)) return;            // unrated — other checks cover it
                if (!this._fmedaReachesTop(e.id))
                    add('warn', `Failure mode "${e.name || e.id}" never propagates to a top-level effect through the failure net — wire it to the effect(s) it causes, or its contribution has no modelled system consequence.`);
            });
        }
        // ── Lens-mismatch info (only when a results lens is supplied) ──────
        // An element may declare an integrity the active lens cannot render: a
        // SIL capability (or a claimed SFF → Route 1ₕ) viewed under the
        // ISO 26262 (ASIL) lens, or an ASIL capability viewed under the
        // IEC 61508 (SIL) lens. The declaration is still there — it simply does
        // not resolve in the current vocabulary. Point the user at the lens that
        // does show it, so they know the picture is incomplete. Info-level: it is
        // guidance, not an error or a modelling smell. Skipped when no lens is
        // given (programmatic / invariant calls), so existing behaviour and the
        // report are unaffected.
        if (lensIso !== undefined) {
            const lensNow   = lensIso ? 'ISO 26262 (ASIL)' : 'IEC 61508 (SIL)';
            const lensOther = lensIso ? 'IEC 61508 (SIL)'  : 'ISO 26262 (ASIL)';
            const stNow   = this.fmedaElementBandState(!!lensIso);
            const stOther = this.fmedaElementBandState(!lensIso);
            this.elementGroups().forEach(el => {
                const now = stNow[el.id], other = stOther[el.id];
                if (now && other && !now.computed && other.computed) {
                    add('info', `${el.name || el.id} declares an integrity level that the active ${lensNow} lens cannot display; it resolves only under ${lensOther}. Switch the results lens to ${lensOther} to see the complete picture for this element.`);
                }
            });
        }

        return out;
    },

    /* Undirected connected components of the architecture net, as a map
       elementId → component index. Elements absent from every arch edge are
       NOT in the map (callers treat "not in the same component" as a crossing).
       Used by fmedaValidate to flag failure paths that cross elements the
       architecture does not connect. */
    _fmedaArchComponents() {
        const adj = new Map();
        const add = (a, b) => {
            if (!adj.has(a)) adj.set(a, new Set());
            adj.get(a).add(b);
        };
        this.netEdgesOf('arch').forEach(ed => { add(ed.from, ed.to); add(ed.to, ed.from); });
        const comp = {};
        let idx = 0;
        adj.forEach((_set, node) => {
            if (comp[node] != null) return;
            const stack = [node];
            comp[node] = idx;
            while (stack.length) {
                const n = stack.pop();
                (adj.get(n) || []).forEach(m => {
                    if (comp[m] == null) { comp[m] = idx; stack.push(m); }
                });
            }
            idx++;
        });
        return comp;
    },

    /* True if failure `modeId` reaches any failure mode owned by a TOP-level
       element through the directed fail net (cause → effect). Cycle-safe. */
    _fmedaReachesTop(modeId, _seen) {
        _seen = _seen || new Set();
        if (_seen.has(modeId)) return false;
        _seen.add(modeId);
        const outs = this.netEdgesOf('fail').filter(ed => ed.from === modeId);
        for (const ed of outs) {
            if (this.fmedaLevelOf(ed.to) === 'top') return true;
            if (this._fmedaReachesTop(ed.to, _seen)) return true;
        }
        return false;
    },

    /* The random-hardware contribution of ONE leaf failure mode, or null when
       it carries no rate. Shared by fmedaMetrics (per-element / total) and the
       roll-up subtree aggregation below, so both count a leaf identically. */
    _fmedaLeafContribution(e) {
        const lamD = this.fmedaRawFit(e);                  // dangerous rate
        const lamS = this.fmedaSafeFit(e);                 // safe rate λ_S
        if (!(lamD > 0) && !(lamS > 0)) return null;
        // A MITIGATION mode's diagnostic coverage acts on the rate flowing
        // THROUGH it, not on its own faults — so for the mitigation's OWN
        // metric contribution it self-detects only when marked self-diagnosing.
        // An ordinary mode's DC₁ covers its own dangerous rate as usual.
        const isMit = this.isMitigationFailure(e.id);
        const dc1 = isMit
            ? (e.coverageIncludesSelf ? fmt.clamp(e.diagnosticCoverage, 0, 1, 0) : 0)
            : fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
        const dc2 = fmt.clamp(e.diagnosticCoverageLatent, 0, 1, 0);
        const hasSM = dc1 > 0;
        return {
            lambdaTotal: lamD + lamS,
            // λ_S is credited as safe regardless of any safe diagnostic, so the
            // whole λ_S sits in λ_SU (no safe-detected split is modelled).
            lambdaSD: 0, lambdaSU: lamS,
            lambdaDD: lamD * dc1,
            lambdaDU: lamD * (1 - dc1),
            lambdaSPF: hasSM ? 0 : lamD,
            lambdaRF:  hasSM ? lamD * (1 - dc1) : 0,
            lambdaMPFdp:     lamD * dc1,
            lambdaMPFlatent: lamD * dc1 * (1 - dc2),
            count: 1
        };
    },

    /* The LEAF failure-mode ids whose failures reach any mode of `elementId`
       through the fail net. A low element resolves to its own leaves (its
       modes are leaves, not derived, so the walk stops at them); a mid/top
       roll-up resolves to every leaf that feeds its derived modes, transitively
       (cycle-safe via `seen`). Used to give a roll-up element a band from the
       AGGREGATED metrics of its subtree, not a rate-only band. */
    fmedaElementLeaves(elementId) {
        if (this.mode !== 'FMEDA') return [];
        const leaves = new Set();
        const seen = new Set();
        const visit = (modeId) => {
            if (seen.has(modeId)) return;
            seen.add(modeId);
            if (!this.fmedaIsDerived(modeId)) { leaves.add(modeId); return; }
            this.failIncoming(modeId).forEach(ed => visit(ed.from));
        };
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const el = this.elementOf(e.groupId);
            if (el && el.id === elementId) visit(e.id);
        });
        return Array.from(leaves);
    },

    /* The LEAF failure-mode ids whose failures reach `modeId` through the fail
       net (the mode itself if it is a leaf). Cycle-safe. The shared primitive
       behind the element- and function-scoped resolvers and the per-mode band. */
    _fmedaModeLeaves(modeId) {
        const leaves = new Set();
        const seen = new Set();
        const visit = (id) => {
            if (seen.has(id)) return;
            seen.add(id);
            if (!this.fmedaIsDerived(id)) { leaves.add(id); return; }
            this.failIncoming(id).forEach(ed => visit(ed.from));
        };
        visit(modeId);
        return Array.from(leaves);
    },

    /* Metric-gated achieved band for ONE failure mode, in the active lens.
       Under ISO it is the band the leaves feeding this mode's subtree earn
       (PMHF·SPFM·LFM) — so a derived effect's readout reads ASIL C, agreeing
       with its function and the system, never a rate-only ASIL B. Under IEC a
       mode's band is the PFH band of its propagated residual (a mode/function
       carries no Route 1ₕ cap). Returns a band string. */
    fmedaModeBand(modeId, iso) {
        const e = this.eventById(modeId);
        if (!e) return iso ? '—' : 'No SIL';
        if (!iso) return fmt.silForPfh(this.fmedaPropagatedResidual(modeId) * 1e-9);
        const agg = this._fmedaAggregateLeaves(this._fmedaModeLeaves(modeId), null);
        return fmt.achievedBand(agg, true);
    },

    /* The LEAF failure-mode ids whose failures reach any mode of `functionId`
       through the fail net — the function-scoped analogue of
       fmedaElementLeaves. A function that owns a leaf resolves to that leaf;
       a derived (top/mid) function resolves to every leaf feeding its derived
       modes, transitively (cycle-safe). Used to give a derived function a band
       from the AGGREGATED metrics of its subtree, so its ASIL matches the
       leaf/element/system instead of a rate-only ladder. */
    _fmedaFunctionLeaves(functionId) {
        if (this.mode !== 'FMEDA') return [];
        const leaves = new Set();
        this.events.forEach(e => {
            if (e.kind === 'basic' && e.groupId === functionId)
                this._fmedaModeLeaves(e.id).forEach(id => leaves.add(id));
        });
        return Array.from(leaves);
    },

    /* Aggregate the random-hardware metrics of a set of leaf modes into one
       metrics row (the same SFF / SPFM / LFM finalisation fmedaMetrics uses),
       optionally carrying a Route 1ₕ cap. Used for roll-up element bands. */
    _fmedaAggregateLeaves(leafIds, route1hCap) {
        const a = {
            lambdaTotal: 0, lambdaSD: 0, lambdaSU: 0, lambdaDD: 0, lambdaDU: 0,
            lambdaSPF: 0, lambdaRF: 0, lambdaMPFdp: 0, lambdaMPFlatent: 0, count: 0
        };
        leafIds.forEach(id => {
            const e = this.eventById(id);
            const c = e ? this._fmedaLeafContribution(e) : null;
            if (c) Object.keys(c).forEach(k => { a[k] += c[k]; });
        });
        const rf = a.lambdaSPF + a.lambdaRF;
        a.sff  = a.lambdaTotal > 0 ? (a.lambdaSD + a.lambdaSU + a.lambdaDD) / a.lambdaTotal : null;
        a.spfm = a.lambdaTotal > 0 ? 1 - rf / a.lambdaTotal : null;
        const mpfBase = a.lambdaTotal - rf;
        a.lfm  = mpfBase > 0 ? 1 - a.lambdaMPFlatent / mpfBase : null;
        a.route1hSil = (route1hCap == null) ? null : route1hCap;
        return a;
    },

    /* ── Hardware fault tolerance (HFT), COMPUTED from the failure net ─────────
       HFT is never entered by hand — it is read from the architecture, per the
       standard definition (the number of faults an element tolerates before its
       safety function is lost). Redundancy is an AND convergence in the failure
       net: the higher failure occurs only if ALL its causes fail (parallel), so
       losing one leaves the others holding the function. Crucially, redundancy is
       only HARDWARE fault tolerance when the channels are genuinely independent —
       on DISTINCT elements AND free from interference (no shared upstream cause).
       Two modes in one element, or two "channels" with a common cause behind
       them, are one channel, not two. This is also why you cannot self-diagnose
       your way up: adding diagnostic coverage changes SFF/SPFM but never HFT;
       only an independent redundant element raises HFT.

         HFT(element) = max over its safety-relevant failure modes of
                        (independent distinct-element channels AND-converging
                         into the mode − 1), clamped to [0, 2] (Route 1ₕ stops
                        at 2). A leaf with no incoming, a single cause, or an OR
                        convergence ⇒ HFT 0. */
    fmedaComputedHft(elementId) {
        const el = this.groupById(elementId);
        if (!el || el.kind !== 'element') return 0;
        const modes = this.events.filter(e =>
            e.kind === 'basic' && e.groupId && this.elementOf(e.groupId) === el);
        let best = 0;
        modes.forEach(m => { best = Math.max(best, this._fmedaModeHft(m.id)); });
        return Math.max(0, Math.min(2, best));
    },

    /* The fault tolerance of ONE failure mode: independent AND-converging
       channels minus one. The incoming causes are grouped into independent
       channels — two causes sharing an owning element OR a common ancestor cause
       fall into the same channel (no independence between them). Only channels
       anchored to a real element count as hardware. OR / single cause ⇒ 0. */
    _fmedaModeHft(modeId) {
        if (this.failGateOf(modeId) !== 'AND') return 0;
        const incoming = this.failIncoming(modeId);
        if (incoming.length < 2) return 0;
        const channels = [];   // [{ elements:Set<id>, ancestors:Set<modeId> }]
        incoming.forEach(ed => {
            const ev   = this.eventById(ed.from);
            const elId = ev && ev.groupId ? ((this.elementOf(ev.groupId) || {}).id || null) : null;
            const anc  = this._fmedaAncestors(ed.from);     // Set, includes ed.from
            let host = null;
            for (const ch of channels) {
                const shareEl  = elId && ch.elements.has(elId);
                const shareAnc = [...anc].some(a => ch.ancestors.has(a));
                if (shareEl || shareAnc) { host = ch; break; }
            }
            if (host) {
                if (elId) host.elements.add(elId);
                anc.forEach(a => host.ancestors.add(a));
            } else {
                channels.push({ elements: new Set(elId ? [elId] : []), ancestors: new Set(anc) });
            }
        });
        const hwChannels = channels.filter(ch => ch.elements.size > 0);
        return Math.max(0, hwChannels.length - 1);
    },

    /* Every upstream cause failure-mode id feeding `modeId` transitively
       (including itself). Cycle-safe — used to test channel independence. */
    _fmedaAncestors(modeId, _seen) {
        _seen = _seen || new Set();
        if (_seen.has(modeId)) return _seen;
        _seen.add(modeId);
        this.failIncoming(modeId).forEach(ed => this._fmedaAncestors(ed.from, _seen));
        return _seen;
    },

    /* Achieved-integrity STATE per architecture element, in the active lens
       (iso=true → ASIL, false → SIL). The SINGLE source the canvas, the right
       pane and the report all read, so they can never disagree on whether an
       element shows a band — or why it doesn't. v7 (the layered model) bands an
       element from BOTH its computed numbers and any declared claim:
         · COMPUTED — a hardware element from its own modes' roll-up; a systematic
                      element from what the failure net feeds into it. This is the
                      headline band (the contract reversed from the v3.0.0
                      declared-only rule, which was a stopgap while the computed
                      band was wrong).
         · DECLARED — a supplier SFF→Route 1ₕ or a claimed SIL/ASIL, shown
                      alongside the computed band (and flagged when they disagree).
         · ERROR    — neither numbers nor a declaration: the element is not yet
                      characterised, rendered red.
       The per-element subtree aggregation (fmedaElementLeaves / _fmedaAggregate-
       Leaves) is now what bands the element (via _fmedaElementComputedBand), and
       also bands a derived FUNCTION (see fmedaMetrics). */
    /* Resolve an element's declared integrity into a band, purely from the
       user's declaration (Route 1ₕ on a claimed SFF with the element's Type/HFT,
       or a claimed capability used directly). If both a claimed SFF and a claimed
       capability are given, the more limiting governs.
       Returns { has, route1hSil, achievedSil, achievedAsil, sff }. */
    _resolveClaim(el) {
        const out = { has: false, route1hSil: null, achievedSil: null, achievedAsil: null, sff: null };
        if (!el) return out;
        const cap = el.claimedCapability || null;
        const sff = (el.claimedSff != null && !isNaN(el.claimedSff))
            ? fmt.clamp(el.claimedSff, 0, 1, null) : null;
        if (!cap && sff == null) return out;
        if (cap) {
            out.has = true;
            if (/^SIL/.test(cap)) { out.route1hSil = cap; out.achievedSil = cap; }
            else                  { out.achievedAsil = cap; }   // QM / ASIL x
        }
        if (sff != null) {
            out.has = true;
            out.sff = sff;
            const r1 = fmt.route1hMaxSil(el.elementType === 'A' ? 'A' : 'B', sff, el.hft);
            out.route1hSil  = (out.route1hSil  == null) ? r1 : fmt.silMin(out.route1hSil, r1);
            out.achievedSil = (out.achievedSil == null) ? r1 : fmt.silMin(out.achievedSil, r1);
        }
        return out;
    },

    /* The achieved band an element earns FROM ITS NUMBERS, in the active lens
       (iso=true → ASIL, false → SIL), plus whether it has the numbers to compute
       one at all. The single computed-band primitive behind the element state.
         · A HARDWARE element is banded from its own failure modes: PMHF/PFH from
           the propagated residual of its modes (which captures any internal
           mitigation reduction or AND-gate convergence), with SPFM/LFM/SFF and
           the Route 1ₕ cap from those modes. It "has numbers" once its base λ is
           entered AND it owns at least one failure mode.
         · A SYSTEMATIC element (system / subsystem) carries no own λ — it is
           banded from what rolls up into its (derived) modes through the failure
           net. It "has numbers" once at least one of its modes is FED by an
           incoming failure-net edge (gated on the connection, not the rate, so a
           deliberate 0-FIT input still counts), and the band uses the propagated
           residual + the aggregated metrics of the feeding subtree.
       Returns { band, hasNumbers, needs } where `needs` (when hasNumbers is
       false) is 'lambda' | 'modes' | 'incoming' — what the element is missing. */
    _fmedaElementComputedBand(el, iso) {
        if (!el || el.kind !== 'element') return { band: null, hasNumbers: false, needs: 'modes' };
        const systematic = this.isSystematicElement(el);
        const ownModes = this.events.filter(e =>
            e.kind === 'basic' && e.groupId && this.elementOf(e.groupId) === el);
        if (!ownModes.length) {
            return { band: null, hasNumbers: false,
                     needs: systematic ? 'incoming' : (this.elementLambdaFit(el) > 0 ? 'modes' : 'lambda') };
        }
        if (systematic) {
            if (!ownModes.some(m => this.failIncoming(m.id).length > 0))
                return { band: null, hasNumbers: false, needs: 'incoming' };
        } else {
            if (!(this.elementLambdaFit(el) > 0))
                return { band: null, hasNumbers: false, needs: 'lambda' };
        }
        // Band from the AGGREGATED metrics of the leaves feeding this element's
        // modes (Σλ_DU → PMHF, gated by SPFM/LFM under ISO; PFH band capped by
        // Route 1ₕ under IEC). The Route 1ₕ cap is computed for THIS element from
        // its own Type, its aggregate SFF, and the HFT deduced from the
        // redundancy structure (fmedaComputedHft) — so a redundant subsystem
        // earns the higher tier its independence buys, and a single channel does
        // not. A systematic (subsystem/system) element is by nature complex, so
        // its Route 1ₕ Type is B; a low element uses its declared Type.
        const leaves = this.fmedaElementLeaves(el.id);
        const agg = this._fmedaAggregateLeaves(leaves, null);
        // A datasheet-declared SFF overrides the computed one (same rule the
        // per-element metrics use); Type is B for a complex subsystem, the
        // declared Type for a low element; HFT is the computed redundancy.
        const sff  = (el.claimedSff != null) ? fmt.clamp(el.claimedSff, 0, 1, agg.sff) : agg.sff;
        const type = systematic ? 'B' : (el.elementType === 'A' ? 'A' : 'B');
        const r1   = fmt.route1hMaxSil(type, sff, this.fmedaComputedHft(el.id));
        agg.sff = sff;
        agg.route1hSil = (r1 && r1 !== '—') ? r1 : null;
        return { band: fmt.achievedBand(agg, iso), hasNumbers: true, needs: null };
    },

    fmedaElementBandState(iso) {
        const out = {};
        if (this.mode !== 'FMEDA') return out;
        // An element's band now comes from BOTH sources (v7): the COMPUTED band
        // from its own numbers (the layered roll-up) is the headline, and a
        // DECLARED supplier claim is shown alongside (as today). When both exist
        // and disagree, that is surfaced as a mismatch. An element with NEITHER
        // numbers NOR a declaration is an ERROR (rendered red) — it is not yet
        // characterised. Returns, per element:
        //   { id, band, computed, reason, computedBand, declaredBand,
        //     hasNumbers, hasClaim, mismatch, needs }
        // reason ∈ 'computed' | 'claimed' | 'computed+claimed' | 'lens' | 'error'.
        this.elementGroups().forEach(el => {
            const claim = this._resolveClaim(el);
            const claimedBand = claim.has ? (iso ? claim.achievedAsil : claim.achievedSil) : null;
            const comp = this._fmedaElementComputedBand(el, iso);
            const rawComputed = (comp.hasNumbers && comp.band && comp.band !== '—') ? comp.band : null;

            // The declared capability is the SYSTEMATIC-CAPABILITY CEILING: the
            // computed (hardware) band may be pulled DOWN to it, never shown above
            // it — an ASIL-B controller cannot self-diagnose its way to ASIL-D.
            // The cap applies only within the matching lens (an ASIL claim caps
            // the ASIL band; a SIL claim the SIL band), so a cross-lens claim
            // leaves the computed band untouched.
            let computedBand = rawComputed;
            let capped = false;
            if (rawComputed && claimedBand) {
                const lim = iso ? fmt.asilMin(rawComputed, claimedBand)
                                : fmt.silMin(rawComputed, claimedBand);
                capped = (lim !== rawComputed);
                computedBand = lim;
            }

            const band = computedBand || claimedBand || null;
            let reason;
            if (computedBand && claimedBand)    reason = 'computed+claimed';
            else if (computedBand)              reason = 'computed';
            else if (claimedBand)               reason = 'claimed';
            else if (claim.has)                 reason = 'lens';   // declared, but not in this lens
            else                                reason = 'error';  // no numbers, no claim → red

            out[el.id] = {
                id: el.id,
                band,
                computed: !!band,           // a band is shown (computed OR claimed)
                reason,
                computedBand,
                rawComputedBand: rawComputed,   // the hardware band BEFORE the ceiling
                declaredBand: claimedBand,
                cappedByCapability: capped,
                hasNumbers: comp.hasNumbers,
                hasClaim: claim.has,
                // A mismatch worth flagging is an OVER-claim: the declaration is
                // higher than the hardware supports. The hardware computing better
                // than (and being capped to) the declaration is expected, not a
                // mismatch.
                mismatch: !!(rawComputed && claimedBand &&
                             (iso ? fmt.asilRank(claimedBand) > fmt.asilRank(rawComputed)
                                  : fmt.silRank(claimedBand) > fmt.silRank(rawComputed))),
                needs: comp.needs           // what's missing when hasNumbers is false
            };
        });
        return out;
    },

    /* Band-only projection of fmedaElementBandState: { elementId: bandString }
       for the elements that HAVE a computed band (omitting the rest). Kept as a
       stable, narrow accessor for the canvas/report/right-pane band lookups. */
    fmedaElementBands(iso) {
        const out = {};
        const st = this.fmedaElementBandState(iso);
        Object.keys(st).forEach(id => { if (st[id].computed) out[id] = st[id].band; });
        return out;
    },

    /* The architecture elements in the order the results panel and the report
       should present them: elements WITH a computed band first (most stringent
       first, by residual), then those still awaiting input (roll-ups not yet
       wired into the failure net, or leaves with no rate) — so a "not yet
       computed" element can never sort ABOVE one that has a real band (the v2.8.0
       bug: zero-residual unbanded elements sorted to the top as if best). Each
       returned row is a fmedaRollup element annotated with its band state. */
    fmedaElementsForDisplay(iso) {
        const ru = this.fmedaRollup();
        const st = this.fmedaElementBandState(iso);
        const annotate = (base, s) => Object.assign({}, base, {
            band: s.band, bandComputed: s.computed, bandReason: s.reason,
            declaredBand: s.declaredBand, computedBand: s.computedBand,
            rawComputedBand: s.rawComputedBand, cappedByCapability: s.cappedByCapability,
            hasNumbers: s.hasNumbers, hasClaim: s.hasClaim,
            mismatch: s.mismatch, needs: s.needs,
            archType: this.archTypeOf(this.groupById(s.id))
        });
        const rows = ru.elements.map(e =>
            annotate(e, st[e.id] || { band: null, computed: false, reason: 'error' }));
        // Append elements that are NOT in the roll-up (no rate-bearing modes):
        // a claim-only black-box subsystem, an element awaiting input (lens), or
        // an uncharacterised element (error → red). So every declared OR
        // not-yet-characterised element still appears.
        const present = new Set(rows.map(r => r.id));
        this.elementGroups().forEach(el => {
            if (present.has(el.id)) return;
            const s = st[el.id];
            if (!s) return;
            if (s.reason === 'claimed' || s.reason === 'error' || s.reason === 'lens') {
                rows.push(annotate({
                    id: el.id, name: el.name, level: el.level || null,
                    rawFit: 0, residualFit: 0, integrityFit: 0, pfh: 0
                }, s));
            }
        });
        return rows.sort((a, b) => {
            if (a.bandComputed !== b.bandComputed) return a.bandComputed ? -1 : 1;
            return a.integrityFit - b.integrityFit;
        });
    },

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
    },

    deleteNetEdge(id) {
        this.netEdges = this.netEdges.filter(e => e.id !== id);
    },

    netEdgesOf(net) { return this.netEdges.filter(e => e.net === net); },

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
    },

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
    },

    /* ── Failure-net propagation gates ────────────────────────────────
       When two or more failure-net edges converge on the SAME target
       failure, the user chooses how the incoming causes combine: OR (any
       cause defeats the target — the default) or AND (all causes needed).
       The choice is stored per target failure id. A target with <2 incoming
       edges needs no gate. */
    failGateOf(targetId) {
        return (this._failGates && this._failGates[targetId]) || 'OR';
    },
    setFailGate(targetId, type) {
        if (!this._failGates) this._failGates = {};
        this._failGates[targetId] = (type === 'AND') ? 'AND' : 'OR';
    },
    /* Incoming failure-net edges (causes) of a target failure. */
    failIncoming(targetId) {
        return this.netEdgesOf('fail').filter(e => e.to === targetId);
    },

    /* Should a node display a COMPUTED integrity band on the canvas / panel?
       A LEAF node (low-level element, or a mitigation — both hold editable leaf
       failure modes) always may. A DERIVED node (mid- or top-level element, and
       the functions on it) may ONLY once a failure-net connection actually feeds
       it. Until then its propagated rate is an empty 0 FIT, which would read as a
       spurious ASIL D / SIL 4 ("everything is max by default"). Note this gates
       on the CONNECTION, not on the rate: a deliberately 0-FIT leaf wired into a
       mid/top node (e.g. "software never fails") IS fed, so its band still shows. */
    fmedaFunctionFed(fnId) {
        const el = this.elementOf(fnId);
        const derived = !!el && (el.level === 'mid' || el.level === 'top');
        if (!derived) return true;
        return this.events.some(e =>
            e.kind === 'basic' && e.groupId === fnId &&
            this.failIncoming(e.id).length > 0);
    },
    fmedaElementFed(elId) {
        const el = this.groupById(elId);
        const derived = !!el && (el.level === 'mid' || el.level === 'top');
        if (!derived) return true;
        return this.functionGroups().some(fn => {
            const owner = this.elementOf(fn.id);
            return owner && owner.id === elId && this.fmedaFunctionFed(fn.id);
        });
    },
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
    },
    setFailGatePos(targetId, x, y) {
        if (!this._failGatePos) this._failGatePos = {};
        this._failGatePos[targetId] = { x, y };
    },

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
            // A safety requirement is the written safety mechanism. List it as
            // soon as it is written — whether or not a diagnostic coverage has
            // been credited yet — so a freshly-added mitigation always appears
            // (the DC>0 "handled" state only governs residual credit/colour).
            const hasMit = !!(e.mitigation && e.mitigation.trim());
            if (!hasMit) return;
            if (this.fmedaIsDerived(e.id)) return;      // mitigation lives at leaf level
            const fn = this.groupById(e.groupId);
            if (!fn || fn.kind !== 'function') return;
            const el = this.elementOf(fn.id);
            const dc = +e.diagnosticCoverage || 0;
            rows.push({
                eventId:      e.id,
                name:         e.name,
                mitigation:   (e.mitigation || '').trim(),
                dc:           dc,
                credited:     dc > 0,           // DC credited (handled) vs written-only
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
    },

    /* The SR id assigned to one failure mode (or null if it is not a
       requirement-bearing handled leaf). Convenience for the canvas. */
    fmedaSrIdOf(eventId) {
        const hit = this.safetyRequirements().find(r => r.eventId === eventId);
        return hit ? hit.srId : null;
    },

    _validNetEndpoint(net, id) {
        if (net === 'fail') {
            const e = this.eventById(id);
            return !!e && e.kind === 'basic';
        }
        const g = this.groupById(id);
        if (!g) return false;
        return net === 'arch' ? g.kind === 'element' : g.kind === 'function';
    },

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
       <function A>, <function B>".

       Each finding also reports whether a MITIGATION addresses it. A
       Mitigation element (M_n) addresses a common cause when one of its own
       failure modes feeds the common cause directly (an  M → cause  edge in
       the failure net): the mitigation sits upstream of the failure it
       suppresses. This is QUALITATIVE — it flips the finding from open (⚠) to
       addressed (✓) — and does NOT subtract any rate; the mitigation's own
       failure already rides up the chain as a normal additive cause.
       A Mitigation element is itself an ordinary cause for DETECTION: if one
       shared M reaches two functions it is reported as a common cause like
       any other (the "same mitigation everywhere" trap is surfaced, not
       hidden). `addressedByM` / `mitigationIds` are advisory metadata only. */
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
                // Mitigation: any failure-net edge whose source is a failure
                // mode inside a Mitigation element and whose target is THIS
                // common cause addresses the finding.
                const mitigationIds = [];
                this.failIncoming(causeId).forEach(ed => {
                    if (!this.isMitigationFailure(ed.from)) return;
                    const src = this.eventById(ed.from);
                    const mEl = src && src.groupId ? this.elementOf(src.groupId) : null;
                    if (mEl && mitigationIds.indexOf(mEl.id) === -1) mitigationIds.push(mEl.id);
                });
                findings.push({
                    sourceId:      causeId,
                    sourceName:    cause.name,
                    targets,
                    functionCount: byFunction.size,
                    addressedByM:  mitigationIds.length > 0,
                    mitigationIds: mitigationIds
                });
            }
        });
        return findings;
    },

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
            lambdaBase:         src.lambdaBase != null ? src.lambdaBase : null,
            fmd:                src.fmd != null ? src.fmd : null,
            dangerousFraction:  src.dangerousFraction != null ? src.dangerousFraction : null,
            diagnosticCoverage: src.diagnosticCoverage,
            diagnosticCoverageLatent: src.diagnosticCoverageLatent || 0,
            failureRateSafe:    src.failureRateSafe || 0,
            diagnosticEvidence: src.diagnosticEvidence || '',
            mitigation:         src.mitigation || '',
            missionTimeOverride: src.missionTimeOverride
        });
        return this.eventById(copy.id);
    },

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
    });
})();
