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
               claimedCapability = null, x = 0, y = 0 }) {
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

    /* Raw dangerous rate λ_D in FIT, before any diagnostic credit. */
    fmedaRawFit(e) {
        if (!e) return 0;
        if (e.probMode === 'coverage') {
            // Primitives are the source of truth when present (v2.3.0+):
            //   λ_D = base λ × FMD × dangerous-fraction.
            // Older events carry no primitives — fall back to the stored λ_D.
            if (e.lambdaBase != null) {
                const base = Math.max(0, +e.lambdaBase || 0);
                const fmd  = fmt.clamp(e.fmd, 0, 1, 1);
                const dang = fmt.clamp(e.dangerousFraction, 0, 1, 1);
                return base * fmd * dang;
            }
            return Math.max(0, +e.failureRateRaw || 0);
        }
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
    },

    /* Safe failure rate λ_S in FIT. Derived from the primitives when present
       (λ_S = base λ × FMD × (1 − dangerous-fraction)); older events fall back
       to the stored λ_S mirror. Only meaningful in coverage mode — direct/rate
       modes carry no safe/dangerous split (λ_S = 0). */
    fmedaSafeFit(e) {
        if (!e) return 0;
        if (e.probMode !== 'coverage') return 0;
        if (e.lambdaBase != null) {
            const base = Math.max(0, +e.lambdaBase || 0);
            const fmd  = fmt.clamp(e.fmd, 0, 1, 1);
            const dang = fmt.clamp(e.dangerousFraction, 0, 1, 1);
            return base * fmd * (1 - dang);
        }
        return Math.max(0, +e.failureRateSafe || 0);
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
        const own = this.fmedaIsDerived(eventId) ? 0 : this.fmedaResidualFit(e);
        const incoming = this.failIncoming(eventId);
        if (!incoming.length) return own;
        _stack = _stack || new Set();
        if (_stack.has(eventId)) {           // cycle — break it, keep own
            this._failCycleSeen = true;
            return own;
        }
        _stack.add(eventId);
        const srcRates = incoming.map(ed =>
            this.fmedaPropagatedResidual(ed.from, _stack));
        _stack.delete(eventId);

        return own + this._combineFit(srcRates, this.failGateOf(eventId),
                                e.missionTimeOverride || this.missionTime || 1);
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
            // IEC 61508-2 Route 1ₕ architectural cap from this element's SFF,
            // type and HFT (per-element only; the total is an aggregate).
            if (isElement) a.route1hSil = fmt.route1hMaxSil(a.elementType, a.sff, a.hft);
            // Achieved integrity per standard, from these AGGREGATED metrics —
            // the standard-correct element/item band (NOT a single function's).
            // ISO uses PMHF/SPFM/LFM; IEC uses the claimable SIL (PFH band
            // capped by Route 1ₕ). The TOTAL's IEC cap is the system limiter,
            // assigned by the caller below, so its `achievedSil` is stamped
            // there; the ASIL has no such dependency and is stamped here.
            a.achievedAsil = fmt.achievedBand(a, true);
            if (isElement) a.achievedSil = fmt.achievedBand(a, false);
            // Supplier claim (elements only): the element's integrity is the
            // user's declaration, computed purely from it (Route 1ₕ on the
            // claimed SFF, or the claimed capability used directly).
            if (isElement && (a.claimedSff != null || a.claimedCapability)) {
                const c = this._resolveClaim(a);
                if (c.has) {
                    a.claimed = true;
                    a.claimSff = c.sff;
                    a.claimCapability = a.claimedCapability || null;
                    if (c.sff != null)          a.sff = c.sff;
                    if (c.route1hSil != null)   a.route1hSil  = c.route1hSil;
                    if (c.achievedSil != null)  a.achievedSil = c.achievedSil;
                    if (c.achievedAsil != null) a.achievedAsil = c.achievedAsil;
                }
            }
            return a;
        };
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

        // Functions: metric-gated band over their modes (ISO via PMHF/SPFM/LFM,
        // IEC via the PFH band — no Route 1ₕ cap, which is element-level).
        const functions = Array.from(byFn.values()).map(a => {
            finalize(a, false);                       // sets spfm/lfm/achievedAsil
            a.achievedSil = fmt.achievedBand(a, false);
            // A subtree-aggregated (derived) function: keep its SIL the PFH band
            // of its OWN propagated residual, unchanged from the pre-fix value
            // (finalize would otherwise band it off Σλ_DU of the leaves, which
            // differs from the residual once an AND gate collapses faults).
            if (a.residualFit != null) a.achievedSil = fmt.silForPfh(a.residualFit * 1e-9);
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
    fmedaValidate() {
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
                // That is the intended pattern, so a derived effect that inherits its
                // figures from a wired source is NOT a problem and must not warn.
                if (this.failIncoming(e.id).length === 0) {
                    add('warn', `Derived effect "${nm}" has no contributing cause wired — draw a failure-net link from the leaf failure mode(s) that cause it, or its rate stays 0.`);
                    // Only an UN-WIRED derived effect that STILL carries authored
                    // numbers is the genuine data-loss case: a mode authored as a leaf
                    // (rate / diagnostic coverage / safe rate), then its element
                    // promoted to mid/top WITHOUT re-wiring it to its leaf causes. The
                    // old figures linger in the file but no longer count, so the rate
                    // silently reads 0. We surface them ONLY here — once the effect is
                    // wired to its source (the intended case), inheriting the leaf
                    // numbers is exactly what should happen and any value stored on the
                    // effect is simply unused, not an error, so we stay silent.
                    const ignored = [];
                    const authoredRate =
                        (e.probMode === 'coverage' && ((+e.lambdaBase > 0) || (e.lambdaBase == null && +e.failureRateRaw > 0))) ||
                        (e.probMode === 'rate' && +e.failureRate > 0);
                    if (authoredRate)                       ignored.push('a failure rate');
                    if (+e.diagnosticCoverage > 0)          ignored.push('a diagnostic coverage (DC₁)');
                    if (+e.diagnosticCoverageLatent > 0)    ignored.push('a latent-fault coverage (DC₂)');
                    if (+e.failureRateSafe > 0)             ignored.push('a safe failure rate (λ_S)');
                    if (ignored.length)
                        add('warn', `Derived effect "${nm}" also stores ${ignored.join(', ')} that is IGNORED — wire it to its leaf cause(s), then clear these fields (or move the value to the leaf cause) so the model reads what it computes.`);
                }
                return;
            }
            const dc1  = +e.diagnosticCoverage || 0;
            const dc2  = +e.diagnosticCoverageLatent || 0;
            const base = +e.lambdaBase || +e.failureRateRaw || 0;
            const dang = e.dangerousFraction;
            if (dc1 > 0 && base <= 0)
                add('warn', `Failure mode "${nm}" has diagnostic coverage but no failure rate — the coverage has no effect until a rate is entered.`);
            if (dc2 > 0 && dc1 <= 0)
                add('warn', `Failure mode "${nm}" has latent-fault coverage (DC₂) but no single-point coverage (DC₁) — DC₂ credits the check that follows the primary mechanism, so it has no effect without DC₁.`);
            if (dang != null && (dang < 0 || dang > 1))
                add('warn', `Failure mode "${nm}" has a dangerous fraction outside 0–100%.`);
        });

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
                add('warn', `Element "${el.name}" (${el.id}) declares ${claimedBand}, but its functions' computed metrics reach only ${sup.band}. Either the claim is optimistic, or the failure-mode coverage / rates must improve to back it.`);
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
        const dc1 = fmt.clamp(e.diagnosticCoverage, 0, 1, 0);
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

    /* Achieved-integrity STATE per architecture element, in the active lens
       (iso=true → ASIL, false → SIL). The SINGLE source the canvas, the right
       pane and the report all read, so they can never disagree on whether an
       element shows a band — or on why it doesn't. Returns a map
         { elementId: { id, band, computed, reason } }
       with `band` the integrity string (null when none), `computed` true when a
       band is shown, and `reason` one of:
         · 'claimed'    — the element DECLARES its integrity (a claimed SFF read
                          through Route 1ₕ with its Type/HFT, or a claimed
                          SIL/ASIL capability used directly). Since v3.0.0 an
                          architecture element's band comes ONLY from this
                          declaration — it is NOT inferred from its functions or
                          their aggregated metrics. The quantitative numbers live
                          on the functions and failure modes (and the system
                          total); the element carries the engineering claim.
         · 'undeclared' — the element owns failure modes but declares no SFF or
                          capability, so it shows no band (only its functions/FMs
                          carry computed figures).
         · 'empty'      — the element owns no failure modes at all.
       NOTE: the per-element subtree aggregation (fmedaElementLeaves /
       _fmedaAggregateLeaves) is retained and tested, but is NOT used to band an
       ELEMENT — that contract changed in v3.0.0. It is the basis for the
       metric-gated band of a derived FUNCTION (see fmedaMetrics), so a top/mid
       function's ASIL matches the leaf/system instead of a rate-only ladder. */
    /* Resolve an element's declared integrity into a band, purely from the
       user's declaration (Route 1ₕ on a claimed SFF with the element's Type/HFT,
       or a claimed capability used directly). The architecture element relies
       ONLY on this declaration — never on the functions' rates. If both a
       claimed SFF and a claimed capability are given, the more limiting governs.
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

    fmedaElementBandState(iso) {
        const out = {};
        if (this.mode !== 'FMEDA') return out;
        // Elements that own at least one failure mode (so they are "started").
        const hasModes = {};
        this.events.forEach(e => {
            if (e.kind !== 'basic' || !e.groupId) return;
            const el = this.elementOf(e.groupId);
            if (el) hasModes[el.id] = true;
        });
        const set = (id, band, computed, reason) => {
            out[id] = { id, band, computed, reason };
        };
        // An architecture element's SIL/ASIL is the integrity the user DECLARES
        // for it (claimed SFF → Route 1ₕ with its Type/HFT, or a claimed
        // capability used directly). It is NOT inferred from the functions or
        // their metrics — the functions and failure modes carry the computed
        // numbers; the element carries the engineering claim. No declaration ⇒
        // the element shows no band ('undeclared'), only its functions/FMs.
        this.elementGroups().forEach(el => {
            if (el.claimedCapability || el.claimedSff != null) {
                const c = this._resolveClaim(el);
                const band = iso ? c.achievedAsil : c.achievedSil;
                if (band) { set(el.id, band, true, 'claimed'); return; }
                // e.g. a SFF-only claim under the ISO lens has no ASIL meaning.
                set(el.id, null, false, 'undeclared'); return;
            }
            set(el.id, null, false, hasModes[el.id] ? 'undeclared' : 'empty');
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
        const rows = ru.elements.map(e => {
            const s = st[e.id] || { band: null, computed: false, reason: 'empty' };
            return Object.assign({}, e, {
                band: s.band, bandComputed: s.computed, bandReason: s.reason
            });
        });
        // A pure black-box subsystem (a supplier claim but no internal modes)
        // won't be in the roll-up — append it so its claimed band still shows.
        const present = new Set(rows.map(r => r.id));
        this.elementGroups().forEach(el => {
            if (present.has(el.id)) return;
            const s = st[el.id];
            if (!s || !s.computed || s.reason !== 'claimed') return;
            rows.push({
                id: el.id, name: el.name, level: el.level || null,
                rawFit: 0, residualFit: 0, integrityFit: 0, pfh: 0,
                band: s.band, bandComputed: true, bandReason: 'claimed'
            });
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
