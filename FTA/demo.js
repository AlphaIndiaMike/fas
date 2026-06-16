/* ===================================================================
 * Functional Analysis Studio [FAS] — Reference models.
 *
 * One worked, feature-complete reference per analysis mode. Each is a
 * small but COMPLETE model that exercises every path of its mode at
 * least once, so it doubles as a human-checkable backtest AND as a
 * starting point a user can rename and grow into a real project.
 *
 * All three are built UNTITLED (empty project name): a reference is a
 * scaffold, so the user names it when they make it their own.
 *
 *   demo.build(mode)   -> Project   ('FTA' | 'ETA' | 'FMEDA';
 *                                     unknown/blank → FMEDA for back-compat)
 *   demo.buildFTA()    -> Project   (single-top fault tree)
 *   demo.buildETA()    -> Project   (one initiating event → several finals)
 *   demo.buildFMEDApass() -> Project (architecture / function / failure nets;
 *                                     the worked ASIL-C brake-by-wire model)
 *   demo.modes()       -> ['FTA','ETA','FMEDA']
 *
 * Built through the public Project API so ids and the auto-layout behave
 * exactly as for a hand-built model.
 * =================================================================== */
const demo = (function () {
    'use strict';

    /* ═══════════════════════════════════════════════════════════════
       FTA — a Safety Instrumented Function (SIF) that fails to act.
       Exercises every FTA construct at least once:
         · basic events in ALL input modes:
             – coverage (λ_raw + DC)  — Transmitter A
             – rate (FIT)             — Transmitter B, ESD valve 2
             – direct FIT             — Transmitter C
             – direct PFH             — Logic solver dangerous failure
             – direct PFD (%)         — ESD valve 1
         · all four gate types:
             – VOTING 2-of-3  (sensor subsystem)
             – INHIBIT        (logic failure conditioned on a demand)
             – AND            (both final-element valves)
             – OR             (any subsystem defeats the SIF)
         · a direct LINK (single-child pass-through): the top event is a
           named view of the one "SIF fails on demand" intermediate
         · a GROUP used as an independence boundary — the two ESD valves
           share a hydraulic supply, so the AND over them raises an FFI
           warning (the group description records the accepted argument)
         · a SCENARIO (what-if: transmitter A held failed during a demand)
         · a safety TARGET on the top event (SIL 2), which the model meets
       ═══════════════════════════════════════════════════════════════ */
    function buildFTA() {
        const p = new Project('');           // untitled — user names it
        p.setMode('FTA');
        p.missionTime = 8760;                // h — one-year reference interval

        // ── Sensor subsystem: three pressure transmitters, 2-of-3 voting ──
        const txA = p.addEvent({ name: 'Transmitter A drift', kind: 'basic' });
        p.updateEvent(txA.id, {
            probMode: 'coverage', failureRateRaw: 500, diagnosticCoverage: 0.9,
            description: 'Pressure transmitter A. Self-diagnostics (range + ' +
                         'rate-of-change) cover 90 % of the dangerous rate.'
        });
        const txB = p.addEvent({ name: 'Transmitter B drift', kind: 'basic' });
        p.updateEvent(txB.id, { probMode: 'rate', failureRate: 300 });
        const txC = p.addEvent({ name: 'Transmitter C drift', kind: 'basic' });
        p.updateEvent(txC.id, { probMode: 'direct', directUnit: 'FIT', probability: 300 });

        const sensorSub = p.addEvent({ name: 'Sensor subsystem fails (2-of-3)', kind: 'intermediate' });
        const voteGate  = p.addGate({ type: 'VOTING', k: 2,
            inputs: [txA.id, txB.id, txC.id], output: sensorSub.id });

        // ── Logic solver: a dangerous PLC failure, only hazardous if it ──
        //    coincides with a demand → INHIBIT with a conditioning prob.
        const logic = p.addEvent({ name: 'Logic solver dangerous failure', kind: 'basic' });
        p.updateEvent(logic.id, { probMode: 'direct', directUnit: 'PFH', probability: 1e-7 });
        const logicFails = p.addEvent({ name: 'Logic solver fails on demand', kind: 'intermediate' });
        p.addGate({ type: 'INHIBIT', inputs: [logic.id], inhibitProb: 0.1, output: logicFails.id });

        // ── Final element: two redundant ESD valves (AND), sharing one ──
        //    hydraulic supply → grouped so the AND raises an FFI warning.
        const v1 = p.addEvent({ name: 'ESD valve 1 fails to close', kind: 'basic' });
        p.updateEvent(v1.id, { probMode: 'direct', directUnit: 'PFD', probability: 0.01 });
        const v2 = p.addEvent({ name: 'ESD valve 2 fails to close', kind: 'basic' });
        p.updateEvent(v2.id, { probMode: 'rate', failureRate: 1000 });
        const hydraulics = p.addGroup({ name: 'Final element (shared hydraulic supply)',
            description: 'Both ESD valves are driven from one hydraulic power unit. ' +
                         'The AND below is flagged for FFI because that shared supply ' +
                         'breaks the independence the AND assumes; the accepted ' +
                         'argument (separate accumulators, monitored pressure) is ' +
                         'recorded in the safety case.' });
        p.updateEvent(v1.id, { groupId: hydraulics.id });
        p.updateEvent(v2.id, { groupId: hydraulics.id });
        const finalElem = p.addEvent({ name: 'Final element fails (both valves)', kind: 'intermediate' });
        p.addGate({ type: 'AND', inputs: [v1.id, v2.id], output: finalElem.id });

        // ── SIF fails on demand = any subsystem fails (OR) ──
        const sifFails = p.addEvent({ name: 'SIF fails on demand', kind: 'intermediate' });
        p.addGate({ type: 'OR',
            inputs: [sensorSub.id, logicFails.id, finalElem.id], output: sifFails.id });

        // ── Top event = a named view of the SIF failure (single-child LINK) ──
        const top = p.addEvent({ name: 'Hazardous event — no protective action', kind: 'top' });
        p.updateEvent(top.id, { target: 'SIL 2' });
        p.addLink({ from: sifFails.id, to: top.id });

        // ── What-if scenario: a transmitter held failed during a demand ──
        p.addScenario({ name: 'Demand with Transmitter A failed',
            overrides: [{ eventId: txA.id, forcedProbability: 1 }] });

        return p;
    }

    /* ═══════════════════════════════════════════════════════════════
       ETA — one initiating event traced forward to several outcomes.
       A LOPA-style gas-release event tree. The tool computes each final
       independently as the AND of the failures along its path (it
       quantifies the failure-combination that reaches each outcome).
       Exercises:
         · one initiating event (basic, rate)
         · several FINAL events of escalating severity, each independent
         · AND gates of increasing depth along the sequence
         · an INHIBIT (ignition conditioned on a release)
         · intermediate events naming each accident sequence
         · a per-final safety TARGET
       NOTE (documented deviation, see CHANGELOG): the tool multiplies
       failures along a path but does NOT model the success-branch
       complements (1 − P) of a classical event tree, so the finals are
       failure-combination probabilities (conservative upper bounds for
       each outcome) and do not partition the initiating frequency.
       ═══════════════════════════════════════════════════════════════ */
    function buildETA() {
        const p = new Project('');           // untitled — user names it
        p.setMode('ETA');
        p.missionTime = 8760;                // h

        // ── Initiating event ──
        const init = p.addEvent({ name: 'Process pipe leak (initiating event)', kind: 'basic' });
        p.updateEvent(init.id, { probMode: 'rate', failureRate: 5000,
            description: 'Loss of containment from a process line — the initiating ' +
                         'event the protection layers respond to.' });

        // ── Protection-layer failures (independent barriers) ──
        const detFail = p.addEvent({ name: 'Gas detection fails', kind: 'basic' });
        p.updateEvent(detFail.id, { probMode: 'direct', directUnit: 'PFD', probability: 0.1 });
        const isoFail = p.addEvent({ name: 'Emergency isolation fails', kind: 'basic' });
        p.updateEvent(isoFail.id, { probMode: 'direct', directUnit: 'PFD', probability: 0.05 });

        // ── Outcome 1: detected & isolated leak escalates to a small release
        //    only if detection fails → initiating AND detection-fail. ──
        const o1 = p.addEvent({ name: 'Outcome: undetected gas release', kind: 'top' });
        p.updateEvent(o1.id, { target: 'SIL 1' });
        p.addGate({ type: 'AND', inputs: [init.id, detFail.id], output: o1.id });

        // ── Outcome 2: release that is also not isolated → 3-way AND. ──
        const o2release = p.addEvent({ name: 'Unisolated release', kind: 'intermediate' });
        p.addGate({ type: 'AND',
            inputs: [init.id, detFail.id, isoFail.id], output: o2release.id });
        const o2 = p.addEvent({ name: 'Outcome: large unisolated release', kind: 'top' });
        p.updateEvent(o2.id, { target: 'SIL 2' });
        p.addLink({ from: o2release.id, to: o2.id });

        // ── Outcome 3: the unisolated release that finds an ignition source
        //    → INHIBIT (input = unisolated release, condition = P(ignition)). ──
        const o3 = p.addEvent({ name: 'Outcome: vapour-cloud explosion', kind: 'top' });
        p.updateEvent(o3.id, { target: 'SIL 3' });
        p.addGate({ type: 'INHIBIT', inputs: [o2release.id], inhibitProb: 0.2, output: o3.id });

        // ── What-if scenario: a known weak detector (held failed). ──
        p.addScenario({ name: 'Detector out of service',
            overrides: [{ eventId: detFail.id, forcedProbability: 1 }] });

        return p;
    }

    /* ═══════════════════════════════════════════════════════════════
       FMEDA (worked PASS) — the same brake-by-wire controller, built as a
       design that MEETS a quantitative ISO 26262 target. This is the single
       FMEDA reference offered in the UI (Load reference). The earlier
       must-stay-QM calibration model is no longer shipped; it lives in the
       test suite as a fixture.

       Verified result (mission time 10 000 h, leaf roll-up):
         · λ_DU ≈ 18.5 FIT  → PMHF ≈ 1.85 × 10⁻⁸ /h
         · SPFM ≈ 99.4 %    · LFM ≈ 94.2 %    · SFF ≈ 99.4 %
         → ISO 26262 lens: ASIL C  (the highest ASIL whose PMHF AND SPFM
           AND LFM are ALL met). Note SPFM/LFM are individually at the
           ASIL D level, but PMHF (1.85e-8) does not clear ASIL D's 1e-8
           target, so the verdict is C — the honest minimum across the
           three metrics, never a cherry-pick.
         → IEC 61508 lens: PFH ≈ 1.85 × 10⁻⁸ /h → SIL 3 from the PFH band
           (the SFF / HFT Route 1ₕ architectural constraint is, as noted in
           the panel, not yet modelled — SFF is shown for reference).

       Exercises every FMEDA path: all three
       levels, functions, leaves in every input mode (coverage / rate /
       direct PFD), real safe rates (so SFF/SPFM are off the floor), latent
       coverage (so LFM is real), handled modes with written safety
       requirements, OR and AND convergence, and a common cause.
       ═══════════════════════════════════════════════════════════════ */
    function buildFMEDApass() {
        const p = new Project('');           // untitled — user names it
        p.setMode('FMEDA');
        p.missionTime = 10000;               // h — reference automotive mission time

        // ── Low-level elements (the leaves where rates are entered) ──
        const mcu = p.addGroup({ name: 'MCU', kind: 'element', level: 'low' });
        const mcuFn = p.addGroup({ name: 'Execute control loop', kind: 'function', parentId: mcu.id });
        const ram = p.addEvent({ name: 'RAM bit flip', kind: 'basic', groupId: mcuFn.id });
        p.updateEvent(ram.id, {
            probMode: 'coverage', failureRateRaw: 200, diagnosticCoverage: 0.99,
            diagnosticCoverageLatent: 0.9, failureRateSafe: 1800,
            mitigation: 'ECC on RAM; uncorrectable error forces the safe state within 10 ms.',
            diagnosticEvidence: 'ISO 26262-5:2018 Annex D, Table D.4 (EDC/ECC).'
        });
        const alu = p.addEvent({ name: 'ALU stuck-at fault', kind: 'basic', groupId: mcuFn.id });
        p.updateEvent(alu.id, {
            probMode: 'coverage', failureRateRaw: 40, diagnosticCoverage: 0.97,
            diagnosticCoverageLatent: 0.85, failureRateSafe: 160,
            mitigation: 'Lockstep core comparison; a mismatch latches the safe state.',
            diagnosticEvidence: 'ISO 26262-5:2018 Annex D, Table D.4 (redundant lockstep).'
        });

        const pwr = p.addGroup({ name: 'Power Supply', kind: 'element', level: 'low',
                                 elementType: 'B', hft: 1 });   // redundant LDO → HFT 1
        const pwrFn = p.addGroup({ name: 'Provide regulated rail', kind: 'function', parentId: pwr.id });
        const ov = p.addEvent({ name: 'Overvoltage', kind: 'basic', groupId: pwrFn.id });
        p.updateEvent(ov.id, {
            probMode: 'direct', directUnit: 'PFD', probability: 0.0005,   // 0.05 %
            diagnosticCoverage: 0.95,
            mitigation: 'Independent over-voltage comparator disables the rail and signals fault.'
        });
        const loss = p.addEvent({ name: 'Total loss of supply', kind: 'basic', groupId: pwrFn.id });
        p.updateEvent(loss.id, {
            probMode: 'rate', failureRate: 80, diagnosticCoverage: 0.99,
            diagnosticCoverageLatent: 0.7, failureRateSafe: 720,
            mitigation: 'Redundant LDO with cross-monitoring; loss is detected and annunciated.'
        });

        const senA = p.addGroup({ name: 'Pedal Sensor A', kind: 'element', level: 'low' });
        const senAFn = p.addGroup({ name: 'Sense pedal (A)', kind: 'function', parentId: senA.id });
        const implA = p.addEvent({ name: 'Implausible reading', kind: 'basic', groupId: senAFn.id });
        // Covered here (cf. the calibration model, where this same mode is the
        // deliberately uncovered 50 % single-point fault that stays QM).
        p.updateEvent(implA.id, {
            probMode: 'coverage', failureRateRaw: 60, diagnosticCoverage: 0.9,
            diagnosticCoverageLatent: 0.6, failureRateSafe: 540,
            mitigation: 'Cross-check against redundant channel B; disagreement enters the safe state.'
        });

        const senB = p.addGroup({ name: 'Pedal Sensor B', kind: 'element', level: 'low' });
        const senBFn = p.addGroup({ name: 'Sense pedal (B)', kind: 'function', parentId: senB.id });
        const implB = p.addEvent({ name: 'Implausible reading', kind: 'basic', groupId: senBFn.id });
        p.updateEvent(implB.id, {
            probMode: 'rate', failureRate: 60, diagnosticCoverage: 0.9,
            mitigation: 'Range and rate-of-change plausibility check on the channel.'
        });

        // ── Mid-level element (derived effects, computed bottom-up) ──
        const ecu = p.addGroup({ name: 'Brake ECU', kind: 'element', level: 'mid' });
        const cmdFn = p.addGroup({ name: 'Form brake command', kind: 'function', parentId: ecu.id });
        const erroneous = p.addEvent({ name: 'Erroneous brake command', kind: 'basic', groupId: cmdFn.id });
        const mcuEffect = p.addEvent({ name: 'Controller fault propagates', kind: 'basic', groupId: cmdFn.id });
        const availFn = p.addGroup({ name: 'Maintain command availability', kind: 'function', parentId: ecu.id });
        const noCmd = p.addEvent({ name: 'No brake command', kind: 'basic', groupId: availFn.id });

        // ── Top-level element (system effect) ──
        const sys = p.addGroup({ name: 'Brake-by-Wire System', kind: 'element', level: 'top' });
        p.updateGroup(sys.id, {
            description: 'Worked PASS reference. Leaf metrics roll up to PMHF ≈ ' +
                '1.85e-8 /h, SPFM ≈ 99.4 %, LFM ≈ 94.2 % → ASIL C under the ISO ' +
                '26262 lens (the highest ASIL whose PMHF, SPFM and LFM are all met). ' +
                'The verdict is the minimum across the three metrics: SPFM/LFM reach ' +
                'ASIL D level, but PMHF does not clear D\u2019s 1e-8 /h target. ' +
                'Under the IEC 61508 lens the PFH band is SIL 3, but the Route 1\u2095 ' +
                'architectural cap is SIL 2 — limited by the single-channel Pedal ' +
                'Sensor B (Type B, SFF 90 %, HFT 0) — so the claimable SIL is 2.'
        });
        const brakeFn = p.addGroup({ name: 'Deliver braking torque', kind: 'function', parentId: sys.id });
        const lossBraking = p.addEvent({ name: 'Loss of braking torque', kind: 'basic', groupId: brakeFn.id });

        // ── Failure network (causation) — same topology as the calibration
        //    model, so both references read the same way on the canvas. ──
        // Redundant sensors → AND convergence (cross-check defeats one fault).
        p.addNetEdge({ net: 'fail', from: implA.id, to: erroneous.id });
        p.addNetEdge({ net: 'fail', from: implB.id, to: erroneous.id });
        p.setFailGate(erroneous.id, 'AND');

        // Controller faults → OR convergence.
        p.addNetEdge({ net: 'fail', from: ram.id, to: mcuEffect.id });
        p.addNetEdge({ net: 'fail', from: alu.id, to: mcuEffect.id });

        // Loss of the rail → no command → OR convergence.
        p.addNetEdge({ net: 'fail', from: ov.id,   to: noCmd.id });
        p.addNetEdge({ net: 'fail', from: loss.id, to: noCmd.id });

        // System loss of braking: any mid-level effect → OR convergence.
        p.addNetEdge({ net: 'fail', from: erroneous.id, to: lossBraking.id });
        p.addNetEdge({ net: 'fail', from: mcuEffect.id, to: lossBraking.id });
        p.addNetEdge({ net: 'fail', from: noCmd.id,     to: lossBraking.id });

        // Common cause: the ALU fault also drives the top effect directly.
        p.addNetEdge({ net: 'fail', from: alu.id, to: lossBraking.id });

        return p;
    }

    const BUILDERS = { FTA: buildFTA, ETA: buildETA, FMEDA: buildFMEDApass };

    /* Default to FMEDA when the mode is unknown/blank, so the historical
       demo.build() call (and any ≤2.4 saved expectation) still resolves. The
       FMEDA reference is the worked brake-by-wire model (buildFMEDApass) — the
       single reference offered in the UI; it exercises every feature and rolls
       up to a clean ASIL C. (The QM calibration case is now a test-suite
       fixture, not shipped, so no alternative model is selectable here.) */
    function build(mode) {
        const fn = BUILDERS[mode] || buildFMEDApass;
        return fn();
    }

    function modes() { return ['FTA', 'ETA', 'FMEDA']; }

    return { build, buildFTA, buildETA, buildFMEDApass, modes };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { demo };
