/* ===================================================================
 * Functional Analysis Studio [FAS] — Demo project.
 *
 * A small but COMPLETE FMEDA model (a brake-by-wire controller) that
 * exercises every path in the tool at least once, so it doubles as a
 * human-checkable backtest:
 *
 *   · all three architecture levels      — top (TAL), mid (MAL), low (LL)
 *   · functions inside elements          — FN
 *   · leaf failure modes in every input mode:
 *        – coverage (λ_D raw + DC)        — MCU "RAM bit flip"
 *        – rate (FIT)                     — MCU "ALU stuck-at"
 *        – PFD (probability, %)           — Power "Overvoltage" (2 %)
 *        – PFD catastrophic               — Sensor A "Implausible" (50 %)
 *   · handled vs unhandled failure modes
 *   · derived effects (read-only) at mid and top levels
 *   · OR convergence and AND convergence (redundant sensors)
 *   · a common-cause source feeding two functions
 *   · safety requirements (handled leaves → SR1, SR2 …)
 *
 * Built through the public Project API so ids (TAL_/MAL_/LL_/FN_/FM_)
 * and the auto-layout behave exactly as for a hand-built model.
 * =================================================================== */
const demo = (function () {
    'use strict';

    function build() {
        const p = new Project('Demo — Brake-by-Wire Controller (FMEDA)');
        p.setMode('FMEDA');
        p.missionTime = 10000;   // h — reference automotive mission time

        // ── Low-level elements (the leaves where rates are entered) ──
        const mcu = p.addGroup({ name: 'MCU', kind: 'element', level: 'low' });
        const mcuFn = p.addGroup({ name: 'Execute control loop', kind: 'function', parentId: mcu.id });
        const ram = p.addEvent({ name: 'RAM bit flip', kind: 'basic', groupId: mcuFn.id });
        p.updateEvent(ram.id, {
            probMode: 'coverage', failureRateRaw: 200, diagnosticCoverage: 0.92,
            mitigation: 'ECC on RAM; uncorrectable error forces the safe state within 10 ms.',
            diagnosticEvidence: 'ISO 26262-5:2018 Annex D, Table D.4 (EDC/ECC).'
        });
        const alu = p.addEvent({ name: 'ALU stuck-at fault', kind: 'basic', groupId: mcuFn.id });
        p.updateEvent(alu.id, { probMode: 'rate', failureRate: 60 });   // unhandled

        const pwr = p.addGroup({ name: 'Power Supply', kind: 'element', level: 'low' });
        const pwrFn = p.addGroup({ name: 'Provide regulated rail', kind: 'function', parentId: pwr.id });
        const ov = p.addEvent({ name: 'Overvoltage', kind: 'basic', groupId: pwrFn.id });
        p.updateEvent(ov.id, {
            probMode: 'direct', directUnit: 'PFD', probability: 0.02,   // 2 %
            diagnosticCoverage: 0.9,
            mitigation: 'Independent over-voltage comparator disables the rail and signals fault.'
        });
        const loss = p.addEvent({ name: 'Total loss of supply', kind: 'basic', groupId: pwrFn.id });
        p.updateEvent(loss.id, {
            probMode: 'rate', failureRate: 80, diagnosticCoverage: 0.99,
            mitigation: 'Redundant LDO with cross-monitoring; loss is detected and annunciated.'
        });

        const senA = p.addGroup({ name: 'Pedal Sensor A', kind: 'element', level: 'low' });
        const senAFn = p.addGroup({ name: 'Sense pedal (A)', kind: 'function', parentId: senA.id });
        const implA = p.addEvent({ name: 'Implausible reading', kind: 'basic', groupId: senAFn.id });
        // The deliberately catastrophic case: a 50 % probability of failure.
        // This MUST remain Quality-Managed (QM) — never a high integrity level.
        p.updateEvent(implA.id, { probMode: 'direct', directUnit: 'PFD', probability: 0.5 });

        const senB = p.addGroup({ name: 'Pedal Sensor B', kind: 'element', level: 'low' });
        const senBFn = p.addGroup({ name: 'Sense pedal (B)', kind: 'function', parentId: senB.id });
        const implB = p.addEvent({ name: 'Implausible reading', kind: 'basic', groupId: senBFn.id });
        p.updateEvent(implB.id, {
            probMode: 'rate', failureRate: 40, diagnosticCoverage: 0.7,
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
        const brakeFn = p.addGroup({ name: 'Deliver braking torque', kind: 'function', parentId: sys.id });
        const lossBraking = p.addEvent({ name: 'Loss of braking torque', kind: 'basic', groupId: brakeFn.id });

        // ── Failure network (causation) ──
        // Redundant sensors: an erroneous command needs BOTH channels wrong
        // → AND convergence (the plausibility cross-check defeats a single
        // sensor fault, so the catastrophic 50 % single fault does not
        // propagate on its own).
        p.addNetEdge({ net: 'fail', from: implA.id, to: erroneous.id });
        p.addNetEdge({ net: 'fail', from: implB.id, to: erroneous.id });
        p.setFailGate(erroneous.id, 'AND');

        // Controller faults: any of them propagates → OR convergence.
        p.addNetEdge({ net: 'fail', from: ram.id, to: mcuEffect.id });
        p.addNetEdge({ net: 'fail', from: alu.id, to: mcuEffect.id });

        // Loss of the rail → no command → OR convergence.
        p.addNetEdge({ net: 'fail', from: ov.id,   to: noCmd.id });
        p.addNetEdge({ net: 'fail', from: loss.id, to: noCmd.id });

        // System loss of braking: any mid-level effect → OR convergence.
        p.addNetEdge({ net: 'fail', from: erroneous.id, to: lossBraking.id });
        p.addNetEdge({ net: 'fail', from: mcuEffect.id, to: lossBraking.id });
        p.addNetEdge({ net: 'fail', from: noCmd.id,     to: lossBraking.id });

        // Common cause: the ALU fault also drives the top effect directly,
        // so it defeats two different functions (Form command + Deliver
        // braking) — a common-cause finding the tool should surface.
        p.addNetEdge({ net: 'fail', from: alu.id, to: lossBraking.id });

        return p;
    }

    return { build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { demo };
