/**
 * analyzer.js
 * Functional Analysis Studio [FAS] — Probability analyzer.
 *
 * Owns the math. Takes a Project, optionally a scenario id (forced
 * probabilities for selected events), and returns an Analysis object
 * with one entry per event plus a top-level rollup. Pure and
 * stateless — call analyzer.analyze() whenever the user triggers a
 * recalculation from the right panel.
 *
 * Per-event computation (in order):
 *
 *   BASIC events:
 *     probMode = 'direct':
 *       directUnit = 'PFD'  → P = probability;  λ = -ln(1-P) / t
 *       directUnit = 'PFH'  → λ = probability;  P = 1 - exp(-λ t)
 *       directUnit = 'FIT'  → λ = probability * 1e-9;  P = 1 - exp(-λ t)
 *     probMode = 'rate':
 *       λ = failureRate * 1e-9; t = override || project.missionTime
 *       P = 1 - exp(-λ t)
 *     probMode = 'coverage':
 *       λ_eff = failureRateRaw * (1 - DC) * 1e-9; P = 1 - exp(-λ_eff t)
 *
 *   INTERMEDIATE / TOP events:
 *     Find the single source feeding this event:
 *       · a direct link → inherit the child event's { pfd, pfh } verbatim
 *         (pass-through; used for a single-child parent), or
 *       · a gate → recurse into the inputs, then apply the gate formula:
 *           AND    P = ∏ Pᵢ
 *           OR     P = 1 - ∏(1 - Pᵢ)
 *           VOTING P = Σ_{|S|≥k} ∏_{i∈S}Pᵢ · ∏_{i∉S}(1 - Pᵢ)
 *           INHIBIT P = P_in · P_cond
 *     Then back-derive an effective per-hour rate exactly:
 *       PFH = -ln(1 - P) / t_mission
 *     This inverts the basic-event 1 - exp(-λt) so leaves and
 *     aggregates use the same PFD↔PFH relationship. The PFH is what
 *     bridges into IEC 61508-1 Table 3 (high-demand SIL) and ISO
 *     26262-5 Annex F (informative PMHF for ASIL).
 *
 * Scenario overrides: any event whose id is in the active scenario's
 * overrides list has its computed value REPLACED with the forced
 * probability before being consumed by downstream gates.
 *
 * Warnings emitted alongside the values:
 *   · FFI: AND/VOTING gate inputs trace back to the same group.
 *   · Repeated event: independence assumption broken (result optimistic).
 *     FTA flags an event feeding ≥ 2 gates/links anywhere (one top event,
 *     one cone). ETA flags only a repeat WITHIN a single final's cone, since
 *     sharing the initiating event and barriers across finals is the normal
 *     shape of an event tree, not a double-count.
 *   · Dangling: intermediate/top event with no feeder (no gate and no
 *     direct link) feeding it.
 *   · Missing inputs: gate has fewer than its required number of inputs.
 *
 * Depends on: config.js, fas.js (Project type)
 */

const analyzer = (() => {

    /* ── Public entry point ──────────────────────────────────────── */

    function analyze(project, scenarioId) {
        const { ctx, events, t } = _core(project, scenarioId);
        // FTA: one top event → the whole model is its cone, so the global
        // repeated-event count is exactly the right independence check.
        _pushRepeated(ctx, project, project.repeatedEvents());
        // FTA: a single top event is the verdict.
        const top = project.topEvent();
        const topAnalysis = top ? _summaryFor(top, ctx, events, true) : null;
        return {
            mode:        'FTA',
            missionTime: t,
            events,
            top:         topAnalysis,
            warnings:    ctx.warnings,
            scenarioId:  scenarioId || null
        };
    }

    /* ETA: same propagation engine, but every event of kind 'top' is a
       final output, each computed independently. No initiating event, no
       auto-generated paths — the user authors the tree exactly as in FTA;
       ETA simply allows more than one final. */
    function analyzeETA(project, scenarioId) {
        const { ctx, events, t } = _core(project, scenarioId);
        const finalEvents = project.events.filter(e => e.kind === 'top');
        // ETA: the initiating event and barriers are shared across finals by
        // design and each final is computed independently — so only a repeat
        // WITHIN a single final's cone is a real double-count. Union the
        // per-final findings; a global count would false-alarm on every tree.
        const repeated = new Set();
        finalEvents.forEach(fe =>
            project.repeatedEventsFor(fe.id).forEach(id => repeated.add(id)));
        _pushRepeated(ctx, project, Array.from(repeated));
        const finals = finalEvents
            .map(ev => _summaryFor(ev, ctx, events, false))
            .sort((a, b) => (b.pfd || 0) - (a.pfd || 0));
        return {
            mode:        'ETA',
            missionTime: t,
            events,
            finals,
            warnings:    ctx.warnings,
            scenarioId:  scenarioId || null
        };
    }

    /* Shared work for both modes: compute every event, then push the
       repeated-event and FFI warnings. Returns the ctx (with cache +
       warnings) and the per-event result list. */
    function _core(project, scenarioId) {
        const t = project.missionTime || CONFIG.defaultMissionTime;
        const overrides = _scenarioOverrides(project, scenarioId);

        const ctx = {
            project,
            t,
            overrides,
            cache:    new Map(),    // eventId → { pfd, pfh }
            warnings: []            // free-form { kind, eventId?, gateId?, msg }
        };

        // Compute every event so the breakdown view has data for all.
        const events = project.events.map(e => {
            const v = _computeEvent(e.id, ctx, new Set());
            return {
                id:           e.id,
                name:         e.name,
                kind:         e.kind,
                groupId:      e.groupId,
                pfd:          v.pfd,
                pfh:          v.pfh,
                forced:       overrides.has(e.id),
                contribution: 0   // populated below for non-top events
            };
        });

        // FFI warning for AND / VOTING.
        project.gates.forEach(g => {
            const shared = project.ffiSharedGroups(g.id);
            if (!shared || shared.length === 0) return;
            const groupNames = shared
                .map(id => project.groupById(id))
                .filter(Boolean)
                .map(gr => '"' + gr.name + '"')
                .join(', ');
            ctx.warnings.push({
                kind:    'ffi',
                gateId:  g.id,
                msg:     g.type + ' gate inputs share group ' + groupNames +
                         ' — independence may not hold (FFI).'
            });
        });

        return { ctx, events, t };
    }

    /* Push the "repeated event" independence warning for a set of event ids.
       What counts as "repeated" is mode-specific and decided by the caller:
         · FTA — global: an event feeding two or more gates/links anywhere is
           double-counted in the single top calculation (project.repeatedEvents).
         · ETA — per-final cone: the initiating event and the barriers are
           SHARED across finals by design, and each final is computed
           independently, so a global count would false-alarm on every event
           tree. The caller unions repeatedEventsFor(final) over the finals, so
           only a genuine repeat WITHIN one final's cone is flagged. */
    function _pushRepeated(ctx, project, ids) {
        ids.forEach(id => {
            const ev = project.eventById(id);
            ctx.warnings.push({
                kind:    'repeated',
                eventId: id,
                msg:     'Event "' + (ev ? ev.name : id) +
                         '" feeds more than one place in the same result — ' +
                         'independence assumption may not hold; result is optimistic.'
            });
        });
    }

    /* Top-event PFD recomputed with one extra event forced to a fixed value,
       on top of the active scenario overrides. Reuses the per-event recursion
       and override mechanism, so every gate type (AND/OR/VOTING/INHIBIT) is
       handled exactly as in the live calculation. Used for Fussell–Vesely
       importance. */
    function _topPfdWithForced(ctx, forcedId, forcedVal) {
        const top = ctx.project.topEvent();
        if (!top) return null;
        const ov = new Map(ctx.overrides);
        ov.set(forcedId, _clip01(forcedVal));
        const sub = {
            project:  ctx.project,
            t:        ctx.t,
            overrides: ov,
            cache:    new Map(),
            warnings: []
        };
        return _computeEvent(top.id, sub, new Set()).pfd;
    }

    /* Build the result-summary object for one final/top event (PFD, PFH,
       SIL, ASIL, target verdict). Shared by FTA's single top and each ETA
       final. When `withContribution` is set, also fills the per-event
       % contribution to this event's PFD (FTA only — with several finals
       a single contribution column would be ambiguous). */
    function _summaryFor(top, ctx, events, withContribution) {
        const tv = ctx.cache.get(top.id) || { pfd: null, pfh: null };
        // If the event is dangling (nothing feeding it) the 0 it returned
        // is meaningless — show "—" rather than claiming SIL 4 / ASIL D.
        const dangling = ctx.warnings.some(w =>
            w.kind === 'dangling' && w.eventId === top.id);
        const showPfd = dangling ? null : tv.pfd;
        const showPfh = dangling ? null : tv.pfh;

        const target = _evaluateTarget(top, showPfh);

        if (!top.target) {
            ctx.warnings.push({
                kind:    'no-target',
                eventId: top.id,
                msg:     'No safety target set on "' + top.name + '". ' +
                         'Open the event and pick a SIL or ASIL target to ' +
                         'evaluate Met / Missed.'
            });
        }

        if (withContribution) {
            // Importance per basic event = Fussell–Vesely: the fractional drop
            // in the top-event PFD when this basic event is made perfectly
            // reliable (forced to 0). FV ∈ [0,1] and is correct for every gate
            // type — unlike a raw PFD ÷ top-PFD ratio, which exceeds 100 % the
            // moment an AND/VOTING/INHIBIT gate drives the top below its leaves.
            // Defined for basic events (the inputs an importance ranking acts
            // on); derived events stay at 0 and read "—".
            events.forEach(ev => {
                ev.contribution = 0;
                if (ev.id === top.id || ev.kind !== 'basic') return;
                if (!(showPfd > 0)) return;
                const reduced = _topPfdWithForced(ctx, ev.id, 0);
                if (reduced == null) return;
                const fv = (showPfd - reduced) / showPfd;
                ev.contribution = fv > 0 ? Math.min(1, fv) : 0;
            });
        }

        return {
            eventId:    top.id,
            name:       top.name,
            pfd:        showPfd,
            pfh:        showPfh,
            sil:        showPfh == null ? '—' : _silFor(showPfh),
            asil:       showPfh == null ? '—' : _asilFor(showPfh),
            target:     top.target || null,
            targetPFH:  target.pfh,
            targetMet:  target.met
        };
    }

    /* ── Per-event recursion ─────────────────────────────────────── */

    function _computeEvent(eventId, ctx, stack) {
        if (ctx.cache.has(eventId)) return ctx.cache.get(eventId);

        if (stack.has(eventId)) {
            // Cycle detected — record warning, treat as 0.
            ctx.warnings.push({
                kind:    'cycle',
                eventId: eventId,
                msg:     'Cycle detected involving event "' +
                         (ctx.project.eventById(eventId) || {}).name + '".'
            });
            const v = { pfd: 0, pfh: 0 };
            ctx.cache.set(eventId, v);
            return v;
        }
        stack.add(eventId);

        const ev = ctx.project.eventById(eventId);
        if (!ev) {
            const v = { pfd: 0, pfh: 0 };
            ctx.cache.set(eventId, v);
            stack.delete(eventId);
            return v;
        }

        let v;
        // Scenario override wins over everything else.
        if (ctx.overrides.has(eventId)) {
            const p = ctx.overrides.get(eventId);
            // Forced value is interpreted as a mission-integrated PFD;
            // back-derive PFH exactly. The linear p/t approximation was
            // off by up to ×3 once p exceeded ~0.5, which under-reported
            // SIL/ASIL severity for high-PFD scenarios. -ln(1-p)/t is
            // the inverse of the basic-event formula 1-exp(-λt) and is
            // exact for any p ∈ [0,1).
            const pfh = (ctx.t > 0 && p < 1)
                ? -Math.log(1 - p) / ctx.t
                : 0;
            v = { pfd: p, pfh };
        } else if (ev.kind === 'basic') {
            v = _basicProb(ev, ctx);
        } else {
            v = _derivedProb(ev, ctx, stack);
        }

        ctx.cache.set(eventId, v);
        stack.delete(eventId);
        return v;
    }

    /* ── Basic event formulas ────────────────────────────────────── */

    function _basicProb(ev, ctx) {
        const t = ctx.t;
        if (ev.probMode === 'direct') {
            const val = +ev.probability || 0;
            if (ev.directUnit === 'PFD') {
                const p = _clip01(val);
                // λ such that 1 - exp(-λ t) = p  →  λ = -ln(1-p)/t.
                const lam = (p < 1 && t > 0) ? -Math.log(1 - p) / t : 0;
                return { pfd: p, pfh: lam };
            }
            if (ev.directUnit === 'PFH') {
                const lam = Math.max(0, val);
                const p   = 1 - Math.exp(-lam * t);
                return { pfd: _clip01(p), pfh: lam };
            }
            if (ev.directUnit === 'FIT') {
                const lam = Math.max(0, val) * 1e-9;
                const p   = 1 - Math.exp(-lam * t);
                return { pfd: _clip01(p), pfh: lam };
            }
        }
        if (ev.probMode === 'rate') {
            const lam = Math.max(0, +ev.failureRate || 0) * 1e-9;
            const tt  = ev.missionTimeOverride || t;
            const p   = 1 - Math.exp(-lam * tt);
            // pfh is still expressed per hour — same number.
            return { pfd: _clip01(p), pfh: lam };
        }
        if (ev.probMode === 'coverage') {
            const lamRaw = Math.max(0, +ev.failureRateRaw || 0) * 1e-9;
            const dc     = fmt.clamp(ev.diagnosticCoverage, 0, 1, 0);
            const lam    = lamRaw * (1 - dc);
            const tt     = ev.missionTimeOverride || t;
            const p      = 1 - Math.exp(-lam * tt);
            return { pfd: _clip01(p), pfh: lam };
        }
        return { pfd: 0, pfh: 0 };
    }

    /* ── Intermediate / top via feeding gate ─────────────────────── */

    function _derivedProb(ev, ctx, stack) {
        const g = ctx.project.gateFeeding(ev.id);
        if (!g) {
            // No gate — a direct link is the single-child alternative.
            // The parent simply inherits its child's probability (a
            // pass-through), preserving both PFD and the intrinsic PFH.
            const link = ctx.project.linkFeeding(ev.id);
            if (link) {
                const child = _computeEvent(link.from, ctx, stack);
                return { pfd: child.pfd, pfh: child.pfh };
            }
            ctx.warnings.push({
                kind:    'dangling',
                eventId: ev.id,
                msg:     'Event "' + ev.name + '" has no feeder — value is 0. ' +
                         'Add a gate, or link a single child event directly to it.'
            });
            return { pfd: 0, pfh: 0 };
        }
        const inputProbs = g.inputs.map(iid => _computeEvent(iid, ctx, stack).pfd);

        const required = _minInputs(g);
        if (inputProbs.length < required) {
            ctx.warnings.push({
                kind:   'underwired',
                gateId: g.id,
                msg:    g.type + ' gate "' + g.id + '" needs at least ' +
                        required + ' input' + (required === 1 ? '' : 's') +
                        ' — has ' + inputProbs.length + '. Skipped.'
            });
            return { pfd: 0, pfh: 0 };
        }

        let p;
        switch (g.type) {
            case 'AND':     p = _gateAND(inputProbs);            break;
            case 'OR':      p = _gateOR(inputProbs);             break;
            case 'VOTING':  p = _gateVOTING(inputProbs, g.k);    break;
            case 'INHIBIT': p = _gateINHIBIT(inputProbs[0], g.inhibitProb); break;
            default:        p = 0;
        }
        p = _clip01(p);
        // Back-derive PFH exactly from the cumulative PFD: PFH is the
        // intrinsic rate λ such that 1 - exp(-λ·t) = p. The earlier p/t
        // approximation under-reported PFH (and therefore SIL/ASIL
        // severity) once p climbed above ~0.01 — matters most for
        // deliberately stressful what-if scenarios. Same formula as
        // basic events in direct-PFD mode, so leaves and aggregates
        // stay internally consistent.
        const pfh = (ctx.t > 0 && p < 1)
            ? -Math.log(1 - p) / ctx.t
            : 0;
        return { pfd: p, pfh };
    }

    /* ── Gate formulas ───────────────────────────────────────────── */

    function _gateAND(ps) {
        return ps.reduce((acc, p) => acc * p, 1);
    }
    function _gateOR(ps) {
        return 1 - ps.reduce((acc, p) => acc * (1 - p), 1);
    }
    function _gateINHIBIT(p_in, p_cond) {
        return (p_in || 0) * (p_cond == null ? 0 : p_cond);
    }
    /* k-of-n voting via exact enumeration of subsets ≥ k. n is small
       in practice (gate inputs), so 2^n is fine up to ~16. */
    function _gateVOTING(ps, k) {
        const n = ps.length;
        const kk = Math.max(1, Math.min(k || 1, n));
        let total = 0;
        for (let mask = 0; mask < (1 << n); mask++) {
            const bits = _popcount(mask);
            if (bits < kk) continue;
            let term = 1;
            for (let i = 0; i < n; i++) {
                term *= ((mask >> i) & 1) ? ps[i] : (1 - ps[i]);
            }
            total += term;
        }
        return total;
    }

    function _popcount(x) {
        let c = 0; while (x) { c += x & 1; x >>>= 1; } return c;
    }

    function _minInputs(g) {
        if (g.type === 'INHIBIT') return 1;
        return 2;
    }

    /* ── SIL / ASIL bridges ──────────────────────────────────────── */

    function _silFor(pfh) {
        if (pfh == null || isNaN(pfh)) return '—';
        for (const b of CONFIG.silBands) {
            if (pfh < b.max) return b.sil;
        }
        return 'No SIL';
    }
    function _asilFor(pfh) {
        if (pfh == null || isNaN(pfh)) return '—';
        for (const b of CONFIG.asilBands) {
            if (pfh < b.max) return b.asil;
        }
        return 'QM';
    }

    /* Evaluate a user-set target against the computed PFH. The target
       lookup uses the SAME PFH bounds as the SIL/ASIL derivation bands
       so the target chip and the computed chip can never disagree.

       Returns:
         { pfh: numeric bound or null (null = no target / no value),
           met: true | false | null }
       QM as a target has pfh = Infinity → always met when a value
       exists. */
    function _evaluateTarget(topEvent, pfh) {
        const t = topEvent.target || null;
        if (!t)          return { pfh: null, met: null };
        if (pfh == null) return { pfh: null, met: null };
        const list = CONFIG.targetCombined || [];
        const hit  = list.find(o => o.value === t);
        if (!hit) return { pfh: null, met: null };
        // QM has pfh = Infinity — any computed PFH satisfies it.
        return { pfh: hit.pfh, met: pfh < hit.pfh };
    }

    /* ── Scenario overrides ──────────────────────────────────────── */

    function _scenarioOverrides(project, scenarioId) {
        const map = new Map();
        if (!scenarioId) return map;
        const s = project.scenarioById(scenarioId);
        if (!s) return map;
        s.overrides.forEach(o => {
            if (o.eventId != null) map.set(o.eventId, _clip01(+o.forcedProbability));
        });
        return map;
    }

    function _clip01(p) {
        if (isNaN(p)) return 0;
        if (p < 0) return 0;
        if (p > 1) return 1;
        return p;
    }

    return { analyze, analyzeETA };
})();
