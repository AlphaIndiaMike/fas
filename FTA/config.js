/**
 * config.js
 * Functional Analysis Studio [FAS] — Central configuration.
 *
 * Pure data — no computation. Loaded first so every module can read
 * CONFIG. Tune defaults, SIL/ASIL bands and the probability heatmap
 * in this single place.
 */

const CONFIG = {

    /* Software version of the tool itself (semver). Shown in the header
       and stamped into exported reports / saved projects. BUMP THIS ON
       EVERY ITERATION of development — patch for fixes, minor for new
       features, major for breaking changes. */
    appVersion:  '1.9.3',
    releaseDate: '2026-06-14',

    /* JSON file-format version. v2 added direct links; v3 was an earlier
       (now removed) ETA experiment; v4 stores two fully independent
       sub-models — `fta` and `eta` — selected by `mode`. Older files load
       as FTA: their flat top-level arrays become the FTA sub-model and the
       ETA sub-model starts empty. */
    fileVersion: 5,

    /* Project-wide default mission time, in hours. Used by `rate` and
       `coverage` events that don't override it. 10 000h ≈ 1.14 years
       of continuous operation — a common "automotive lifetime per
       year" assumption. */
    defaultMissionTime: 10000,

    /* Defaults applied to every newly-created event. */
    eventDefaults: {
        probMode:           'direct',
        directUnit:         'PFD',      // 'PFD' | 'PFH' | 'FIT'
        probability:        0.001,      // direct value
        failureRate:        100,        // FIT (rate mode)
        failureRateRaw:     1000,       // FIT (coverage mode, before DC)
        diagnosticCoverage: 0,          // 0–1 (coverage mode). Default 0: a
                                        // fresh failure mode carries its FULL
                                        // raw rate until a DC is entered — no
                                        // unearned diagnostic credit.
        diagnosticCoverageLatent: 0     // 0–1 (DC₂). Coverage of the mechanism
                                        // that reveals a LATENT (multiple-point)
                                        // fault. Drives the ISO 26262 latent-
                                        // fault metric (λ_MPF,latent / LFM).
    },

    /* FMEDA-specific defaults. A failure mode is most naturally entered as a
       dangerous failure rate plus its diagnostic coverage (IEC 61508 λ_D +
       DC), so a new FMEDA failure mode opens in coverage mode rather than the
       FTA default (direct PFD). */
    fmedaEventDefaults: {
        probMode: 'coverage'
    },

    /* Defaults for newly-created gates. */
    gateDefaults: {
        k:           2,          // VOTING: 2-of-N
        inhibitProb: 0.1         // INHIBIT: P_cond default
    },

    /* IEC 61508-1:2010 Table 3 — SIL bands for high-demand /
       continuous mode (PFH per hour). Tested top-down: first band
       whose `max` exceeds PFH wins. */
    silBands: [
        { sil: 'SIL 4',  max: 1e-8 },
        { sil: 'SIL 3',  max: 1e-7 },
        { sil: 'SIL 2',  max: 1e-6 },
        { sil: 'SIL 1',  max: 1e-5 },
        { sil: 'No SIL', max: Infinity }
    ],

    /* ISO 26262-5:2018 informative PMHF targets. ASIL B and C share
       the numeric PMHF target (10⁻⁷); the distinction lives in the
       SPFM/LFM hardware metrics which v1 does not address. */
    asilBands: [
        { asil: 'ASIL D',   max: 1e-8 },
        { asil: 'ASIL B/C', max: 1e-7 },
        { asil: 'ASIL A',   max: 1e-6 },
        { asil: 'QM',       max: Infinity }
    ],

    /* Heatmap stops applied to event nodes by their effective PFD on
       a log scale. Anything ≤ minP is fully green; ≥ maxP fully red. */
    heatmap: {
        minP: 1e-9,
        maxP: 1e-2,
        stops: [
            /* fraction t (0 → minP, 1 → maxP), CSS color */
            { t: 0.0,  bg: '#c8e7d2', border: '#7bbf95', fg: '#1c4d31' },
            { t: 0.33, bg: '#f1ecbe', border: '#cdb96b', fg: '#5a4b1a' },
            { t: 0.66, bg: '#f3c7a6', border: '#d99466', fg: '#5b3414' },
            { t: 1.0,  bg: '#e8b1a9', border: '#c45f55', fg: '#5b1814' }
        ]
    },

    /* Standard FTA palette for non-basic event kinds (no heatmap). */
    eventStyles: {
        intermediate: { bg: '#e6e8eb', border: '#a4adba', fg: '#1a2030' },
        top:          { bg: '#1f242d', border: '#0d1117', fg: '#ffffff' }
    },

    /* Default colour for newly-created groups. Cycled through this
       palette so consecutive groups don't collide visually. */
    groupColors: [
        '#e8a87c', '#c38d9e', '#85b8cb', '#a8d8a8',
        '#d4a5c8', '#b8a07b', '#8aa1bf', '#c9c46e'
    ],

    /* Responsive breakpoint: at/under this width the side panels
       become toggleable drawers. Mirrors styles.css @media value. */
    layout: {
        minMainWidth:     800,
        mobileBreakpoint: 1000
    },

    /* Target options for the top event. ONE combined list — the
       previous dual SIL+ASIL list invited misconfiguration. Each entry
       carries the standard it comes from (rendered in the label) and
       the PFH bound the computed top event must beat to be "met".

       Bounds are aligned with `silBands` / `asilBands` above (the same
       thresholds used for derivation), so the chip the tool computes
       for a top event and the chip the user sets as a target use
       identical numeric meaning. */
    targetCombined: [
        { value: 'QM',     pfh: Infinity, standard: 'ISO 26262', label: 'QM (ISO 26262)' },
        { value: 'ASIL A', pfh: 1e-6,     standard: 'ISO 26262', label: 'ASIL A (ISO 26262)' },
        { value: 'ASIL B', pfh: 1e-7,     standard: 'ISO 26262', label: 'ASIL B (ISO 26262)' },
        { value: 'ASIL C', pfh: 1e-7,     standard: 'ISO 26262', label: 'ASIL C (ISO 26262)' },
        { value: 'ASIL D', pfh: 1e-8,     standard: 'ISO 26262', label: 'ASIL D (ISO 26262)' },
        { value: 'SIL 1',  pfh: 1e-5,     standard: 'IEC 61508', label: 'SIL 1 (IEC 61508)' },
        { value: 'SIL 2',  pfh: 1e-6,     standard: 'IEC 61508', label: 'SIL 2 (IEC 61508)' },
        { value: 'SIL 3',  pfh: 1e-7,     standard: 'IEC 61508', label: 'SIL 3 (IEC 61508)' },
        { value: 'SIL 4',  pfh: 1e-8,     standard: 'IEC 61508', label: 'SIL 4 (IEC 61508)' }
    ],

    /* Mission-time presets — common values across industries with the
       label spelling out the assumption so the user picks deliberately. */
    missionTimePresets: [
        { hours: 8760,   label: '1 year continuous (8 760 h)' },
        { hours: 10000,  label: 'Automotive lifetime baseline (10 000 h)' },
        { hours: 15000,  label: 'Automotive heavy duty (15 000 h)' },
        { hours: 25000,  label: 'Aviation typical (25 000 h)' },
        { hours: 87600,  label: '10 years continuous (87 600 h)' },
        { hours: 175200, label: '20 years continuous (175 200 h)' }
    ],

    /* Plain-language SIL/ASIL labels for "Simplified" view mode. The
       technical code is appended in parens so the stakeholder reading
       the simplified label can still trace back to the standard. */
    simpleLabels: {
        sil: {
            'SIL 4':  'Highest integrity (SIL 4)',
            'SIL 3':  'High integrity (SIL 3)',
            'SIL 2':  'Medium integrity (SIL 2)',
            'SIL 1':  'Basic integrity (SIL 1)',
            'No SIL': 'No safety claim',
            '—':      '—'
        },
        asil: {
            'ASIL D':   'Highest automotive integrity (ASIL D)',
            'ASIL B/C': 'High automotive integrity (ASIL B/C)',
            'ASIL A':   'Basic automotive integrity (ASIL A)',
            'QM':       'Quality-managed only (QM)',
            '—':        '—'
        }
    },

    /* Help topic registry — clickable (?) buttons reference these by key.
       Centralised so the same explanation never drifts between dialogs. */
    helpTopics: {
        missionTime: {
            title: 'Mission time',
            body:
                '<p><strong>Mission time</strong> is the operating duration over which the failure probability accumulates — typically the lifetime of the system between renewals (per <em>IEC 61508-4 §3.6.16</em>) or per ISO 26262\'s vehicle lifetime convention.</p>' +
                '<p>For an event with a constant failure rate λ, the probability of having failed at least once by time t is <code>P = 1 − e<sup>−λ·t</sup></code>. Longer mission time → higher accumulated probability, even with the same hourly rate.</p>' +
                '<p><strong>Typical values:</strong></p>' +
                '<ul>' +
                '<li>Automotive (ISO 26262): <strong>10 000 h</strong> (≈ vehicle lifetime, 1 h/day avg over 15 yrs).</li>' +
                '<li>Aviation: <strong>25 000 h</strong> (mean time between heavy maintenance).</li>' +
                '<li>Industrial process (IEC 61511): often <strong>87 600 h</strong> (10 yrs continuous).</li>' +
                '<li>Per-trip / per-demand systems: pick the demand interval, not the lifetime.</li>' +
                '</ul>' +
                '<p><strong>The three numbers</strong></p>' +
                '<p><strong>PFD</strong> — Probability of Failure on Demand. A dimensionless probability between 0 and 1. It answers: <em>"by the end of the mission, what\'s the chance this event has happened at least once?"</em> For a basic event with constant rate λ, <code>PFD = 1 − e<sup>−λ·t</sup></code>. When λ·t is small, <code>PFD ≈ λ·t</code>. So a 200 FIT event over 10 000 h gives PFD ≈ 2×10<sup>−3</sup>. It\'s mission-time-dependent — change the mission and PFD changes.</p>' +
                '<p><strong>PFH</strong> — Probability of dangerous Failure per Hour. Unit: /h. The intrinsic hourly failure rate. For a basic event in FIT mode, <code>PFH = λ × 10<sup>−9</sup></code> — i.e. it\'s just FIT in different units. This is what IEC 61508 Table 3 (SIL bridge) and ISO 26262 PMHF target use. It doesn\'t depend on mission time.</p>' +
                '<p><strong>FIT</strong> — Failures In Time. Same thing as PFH but multiplied by 10<sup>9</sup>. So 1 FIT = 10<sup>−9</sup> /h = 1 PFH × 10<sup>9</sup>. Engineers in automotive / IC industries usually think in FIT because the numbers are friendlier (10 FIT vs 1.0e-8 /h).</p>' +
                '<p><strong>The relationship:</strong> FIT and PFH are the same quantity in different units; PFD is the integrated probability over the mission. They\'re not three independent numbers — they\'re two independent numbers (the rate, and the mission-time-integrated value).</p>'
        },
        probMode: {
            title: 'Probability input modes',
            body:
                '<p><strong>Direct value</strong> — type a number, then pick its unit (PFD, PFH, or FIT). Use when you already have a published probability or rate and want to enter it as-is.</p>' +
                '<p><strong>Failure rate (FIT)</strong> — enter λ in FIT (1 FIT = 1 failure per 10⁹ hours). The tool converts to a probability over the mission time: <code>P = 1 − e<sup>−λ·t</sup></code>. Use when the data sheet or FMEDA gives you a rate.</p>' +
                '<p><strong>Rate + diagnostic coverage</strong> — enter the dangerous failure rate λ<sub>D</sub> in FIT plus the coverage fraction (0–1). The tool keeps the <em>undetected</em> portion: <code>λ<sub>DU</sub> = λ<sub>D</sub> × (1 − DC)</code>. Use when you credit a diagnostic mechanism (E2E, BIST, plausibility check) and want only the residual dangerous undetected rate to feed the gate.</p>'
        },
        units: {
            title: 'PFD / PFH / FIT',
            body:
                '<p><strong>PFD</strong> — Probability of Failure on Demand. Dimensionless, between 0 and 1. Used for low-demand safety functions (IEC 61508 low-demand mode): "what\'s the chance the function fails when called?"</p>' +
                '<p><strong>PFH</strong> — Probability of dangerous Failure per Hour. Unit: h⁻¹. Used for high-demand or continuous operation (IEC 61508 high-demand mode, ISO 26262 PMHF). The SIL/ASIL bridges in this tool use PFH.</p>' +
                '<p><strong>FIT</strong> — Failures In Time. 1 FIT = 1 failure per 10⁹ hours. A convenient unit for hardware reliability; numerically λ in FIT × 10⁻⁹ = λ in h⁻¹.</p>'
        },
        coverage: {
            title: 'Diagnostic coverage (DC)',
            body:
                '<p><strong>Diagnostic coverage</strong> (DC) is the fraction of <em>dangerous</em> failures of a sub-element detected by an associated diagnostic mechanism — per <em>IEC 61508-4 §3.8.7</em> and <em>ISO 26262-1:2018</em>. The DC denominator is the dangerous failure rate λ<sub>D</sub>, <em>not</em> the total failure rate.</p>' +
                '<p>The undetected dangerous (residual) rate that propagates into the fault tree is:</p>' +
                '<p style="text-align:center"><code>λ<sub>DU</sub> = λ<sub>D</sub> × (1 − DC)</code></p>' +
                '<p><strong>Important:</strong> enter the dangerous failure rate, not the device\'s total rate. Datasheets often quote total λ; you must extract the dangerous fraction from the FMEDA before entering it here. A typical electronic component has roughly half its failures classified as dangerous (the rest are safe or no-effect), but the split varies — always source it from the FMEDA, not a rule of thumb.</p>' +
                '<p><strong>Typical DC reference values</strong> (always justify against your own evidence):</p>' +
                '<ul>' +
                '<li><strong>≥ 99 %</strong> — Strong end-to-end protection: AUTOSAR E2E Profile 5/6/7 (CRC + counter + timestamp). ISO 26262-5:2018 Annex D, "high" diagnostic level.</li>' +
                '<li><strong>90 %</strong> — Single CRC, parity + timeout, BIST on memory. "Medium" level in Annex D.</li>' +
                '<li><strong>60 %</strong> — Range / plausibility checks alone. "Low" level in Annex D.</li>' +
                '<li><strong>0 %</strong> — No diagnostic credit (default).</li>' +
                '</ul>' +
                '<p>Use the <em>Evidence / source</em> field on the event to record the basis — without that, the DC value is just an assumption.</p>'
        },
        coverageEvidence: {
            title: 'Coverage evidence — why does this matter?',
            body:
                '<p>Safety claims need traceability. A diagnostic coverage of "99 %" without a source is a guess, not an argument.</p>' +
                '<p><strong>What to record:</strong> the standard or document section, the diagnostic mechanism, and any assumptions about fault model.</p>' +
                '<p><strong>Examples of good entries:</strong></p>' +
                '<ul>' +
                '<li><em>"E2E Profile 5 per AUTOSAR R20-11 §7.1.1 — assumed 99 % per ISO 26262-5:2018 Annex D, Table D.13 row \'CRC32+counter+timeout\', high level."</em></li>' +
                '<li><em>"BIST on flash per supplier safety manual XYZ-SM-v3 §4.2; 90 % claim independently reviewed in DIA report DIA-2024-007."</em></li>' +
                '<li><em>"Sensor range check per requirement REQ-SAF-112; 60 % credit (Annex D row \'comparison with another range\') — to be validated by fault-injection test FIT-014."</em></li>' +
                '</ul>'
        },
        ffi: {
            title: 'Freedom from Interference (FFI) and groups',
            body:
                '<p><strong>Groups</strong> in FAS mark <em>independence boundaries</em>. Two basic events in the same group are assumed to share a common environment — same ECU, same power rail, same clock domain — so their failures are <em>not</em> independent.</p>' +
                '<p>When an <strong>AND</strong> or <strong>k-of-n VOTING</strong> gate combines inputs whose leaves share a group, the math <code>P = ∏ P<sub>i</sub></code> is optimistic: it assumes independence that doesn\'t hold. FAS flags this with an <strong>FFI</strong> warning and a red dashed outline on the gate.</p>' +
                '<p><strong>How to resolve a flagged FFI:</strong></p>' +
                '<ul>' +
                '<li>Add a diagnostic to one branch so the residual failures <em>are</em> independent.</li>' +
                '<li>Move one branch to a separate physical resource and reflect that with separate groups.</li>' +
                '<li>Document an FFI argument in the group\'s <em>Description</em> field — required for ISO 26262 Part 9 §6 evidence.</li>' +
                '</ul>'
        },
        eventsKinds: {
            title: 'Events',
            body:
                '<p>FAS works with three kinds of events, matching the standard FTA convention (IEC 61025, NUREG-0492 Fault Tree Handbook):</p>' +
                '<p><strong>Basic event</strong> (ellipse) — A leaf failure mechanism that you enter directly with a probability, rate, or rate + coverage. Examples: a sensor short circuit, a CRC check failure, a memory bit flip. Basic events have no inputs — they\'re where the fault tree "bottoms out".</p>' +
                '<p><strong>Intermediate event</strong> (round box) — A derived failure. Its probability is computed by the gate feeding it. Use intermediate events to give names to meaningful subsystem-level failure modes — <em>"unhandled invalid sensor data"</em>, <em>"loss of redundant power"</em> — so the tree reads as a story, not just gates and leaves.</p>' +
                '<p><strong>Top event</strong> (dark square) — The undesired system-level outcome the entire tree is built to quantify. Only one per project. The SIL/ASIL verdict, the safety target, and the Met / Missed check all hang off the top event.</p>' +
                '<p>Practical convention: pick the top event first (the thing you\'re trying to prevent), then work down to the basic events through intermediate stages — that\'s the deductive direction FTA was designed for.</p>'
        },
        etaMode: {
            title: 'ETA mode — multiple final events',
            body:
                '<p><strong>ETA mode</strong> works like FTA — you place basic events, combine them through gates into intermediate events, and feed those onward — with one difference: it can have <strong>more than one final (top) event</strong>.</p>' +
                '<p>Each final is computed independently from its own sub-tree, and the Analysis panel shows a result card per final.</p>' +
                '<p>FTA and ETA are kept in fully separate models within the same file. Switching the toggle never moves data between them.</p>'
        },
        fmedaArch: {
            title: 'FMEDA — architecture elements & levels',
            body:
                '<p><strong>Architecture elements</strong> are the building blocks of the FMEDA. Each sits in one of three swimlanes by level: <strong>top</strong> (the system), <strong>mid</strong> (boards, controllers), and <strong>low</strong> (supporting sub-elements).</p>' +
                '<p>An element contains <em>functions</em>, and each function contains its <em>failure modes</em> — the box-in-box containment of the FMEDA. Inside a single level, elements are assumed to have freedom from interference; connections run across levels through the architecture net.</p>'
        },
        fmedaFunction: {
            title: 'FMEDA — functions',
            body:
                '<p>A <strong>function</strong> is what an element does (e.g. "deliver torque", "provide 12 V"). It lives inside one architecture element and holds the failure modes that can defeat it.</p>' +
                '<p>Functions connect to other functions through the <em>function net</em> — typically a lower-level function supporting a higher-level one.</p>'
        },
        fmedaFailureMode: {
            title: 'FMEDA — failure modes',
            body:
                '<p>A <strong>failure mode</strong> is a leaf failure inside a function. It carries the same inputs as an FTA basic event — failure rate, or rate plus diagnostic coverage, with an evidence note — so the diagnostic-coverage question (e.g. register readback present vs absent) is captured per mode.</p>' +
                '<p>Each failure mode belongs to <strong>one</strong> function. If the same physical fault affects two functions, do not duplicate it — keep it in its own function and draw a <em>failure-net</em> link to the affected failures in the other functions. That link is exactly what surfaces the common-cause finding.</p>'
        },
        fmedaResidual: {
            title: 'FMEDA — residual rate & hardware metrics',
            body:
                '<p><strong>Recalculate</strong> computes each failure mode\'s residual dangerous-undetected rate (FIT), rolls it up per function and element, and derives the hardware metrics below.</p>' +
                '<p><strong>Residual (per failure mode).</strong> Diagnostic coverage drives the number directly, whether or not a mitigation requirement is written:</p>' +
                '<p style="text-align:center"><code>λ<sub>DU</sub> = λ<sub>D</sub> × (1 − DC<sub>1</sub>)</code></p>' +
                '<p><strong>Leaf failures</strong> (low-level, no incoming cause arrows) use their own entered rate. <strong>Derived failures</strong> (top/mid, with incoming failure-net arrows) ignore any typed rate and inherit from their causes; where several causes converge a visible <strong>AND/OR gate</strong> sets how they combine (OR sums the rates; AND takes the joint). Mitigating only at a mid level will not clear the top until the lower path is handled.</p>' +
                '<hr>' +
                '<p><strong>The two diagnostic coverages</strong></p>' +
                '<ul>' +
                '<li><strong>DC<sub>1</sub></strong> — primary coverage. Fraction of the dangerous rate the safety mechanism detects. Drives the residual and SFF.</li>' +
                '<li><strong>DC<sub>2</sub></strong> — latent-fault coverage. Of the faults DC<sub>1</sub> catches, the fraction whose <em>latency</em> is itself revealed (a second mechanism, a test, an operator check). Drives the latent-fault figures (λ<sub>MPF,latent</sub> / LFM). Leave 0 if there is no latent-fault check.</li>' +
                '</ul>' +
                '<p><strong>IEC 61508 split</strong> (all in FIT)</p>' +
                '<ul>' +
                '<li><strong>λ<sub>Total, Safety</sub></strong> — the sum of all failure rates considered. Here it is the sum of the <em>dangerous</em> rates only (see the note on safe failures below).</li>' +
                '<li><strong>λ<sub>SD</sub> / λ<sub>SU</sub></strong> — safe detected / safe undetected. <strong>Always 0</strong> in this tool today — no safe-failure portion is modelled.</li>' +
                '<li><strong>λ<sub>DD</sub></strong> — dangerous detected = <code>λ<sub>D</sub> × DC<sub>1</sub></code>.</li>' +
                '<li><strong>λ<sub>DU</sub></strong> — dangerous undetected = <code>λ<sub>D</sub> × (1 − DC<sub>1</sub>)</code>, i.e. the residual.</li>' +
                '<li><strong>SFF</strong> — Safe Failure Fraction = <code>(Σλ<sub>S</sub> + Σλ<sub>DD</sub>) / Σλ<sub>Total</sub></code>. With λ<sub>S</sub> = 0 this reduces to <code>Σλ<sub>DD</sub> / Σλ<sub>D</sub></code> — the detected-dangerous fraction.</li>' +
                '</ul>' +
                '<p><strong>ISO 26262 terminology mapping</strong></p>' +
                '<ul>' +
                '<li><strong>λ<sub>SPF</sub></strong> — single-point fault: a dangerous failure with <em>no</em> safety mechanism (DC<sub>1</sub> = 0). The whole rate escapes.</li>' +
                '<li><strong>λ<sub>RF</sub></strong> — residual fault: the part of a <em>covered</em> failure the mechanism still misses, <code>λ<sub>D</sub> × (1 − DC<sub>1</sub>)</code> when DC<sub>1</sub> &gt; 0. (λ<sub>SPF</sub> + λ<sub>RF</sub> = λ<sub>DU</sub>.)</li>' +
                '<li><strong>λ<sub>MPF,dp</sub></strong> — multiple-point fault, detected by DC<sub>1</sub> (<code>λ<sub>D</sub> × DC<sub>1</sub></code>). Only a hazard if a second, independent fault also occurs.</li>' +
                '<li><strong>λ<sub>MPF,latent</sub></strong> — the portion of λ<sub>MPF,dp</sub> whose latency DC<sub>2</sub> does <em>not</em> reveal: <code>λ<sub>D</sub> × DC<sub>1</sub> × (1 − DC<sub>2</sub>)</code>.</li>' +
                '<li><strong>SPFM</strong> — Single-Point Fault Metric = <code>1 − Σ(λ<sub>SPF</sub> + λ<sub>RF</sub>) / Σλ</code>.</li>' +
                '<li><strong>LFM</strong> — Latent-Fault Metric = <code>1 − Σλ<sub>MPF,latent</sub> / Σ(λ − λ<sub>SPF</sub> − λ<sub>RF</sub>)</code>.</li>' +
                '</ul>' +
                '<hr>' +
                '<p><strong>About safe failures (read this).</strong> This tool currently models every entered rate as <em>dangerous</em> — there is no safe-failure portion (λ<sub>S</sub> = 0). Two consequences follow, and both are <strong>conservative</strong>:</p>' +
                '<ul>' +
                '<li><strong>λ<sub>Total, Safety</sub> is the sum of dangerous rates only.</strong> A full FMEDA that also captured the safe failures would report a larger total. Because λ<sub>SD</sub> and λ<sub>SU</sub> are forced to 0, they contribute nothing to the total here.</li>' +
                '<li><strong>SFF is lower than it would otherwise be.</strong> Safe failures normally count toward the "safe" numerator of SFF; omitting them shrinks both the numerator and the denominator in a way that lowers SFF. So the SFF shown is a floor — the real figure, with safe failures credited, is at least this high.</li>' +
                '</ul>' +
                '<p>The metrics are computed over the leaf failure modes; derived (top/mid) modes are roll-ups of those leaves and are not summed again. Treat every figure as the <em>achieved</em> metric, to be checked against your HARA / safety-goal target.</p>' +
                '<hr>' +
                '<p><strong>How to read the SFF level.</strong> SFF is the fraction of failures that are either safe or detected — so the higher it is, the smaller the slice that can fail dangerously without being noticed. In IEC 61508-2 it is an <em>architectural-constraint</em> input (Route 1<sub>H</sub>): together with the hardware fault tolerance (HFT, i.e. how much redundancy the element has) it caps the maximum SIL the element may claim. The bands are <strong>&lt; 60 %</strong>, <strong>60–90 %</strong>, <strong>90–99 %</strong> and <strong>≥ 99 %</strong>.</p>' +
                '<p>Concretely, for a single-channel complex (Type B) element with no redundancy (HFT = 0): an SFF of <strong>20 %</strong> sits below the 60 % floor — the element cannot claim a SIL on its own; you would add diagnostics or a redundant channel. An SFF of <strong>70 %</strong> clears the floor (60–90 % band) and the element can support up to <strong>SIL 1</strong> single-channel — and a step higher with one degree of redundancy. So moving 20 % → 70 % is the difference between "not creditable alone" and "good for SIL 1": higher SFF buys SIL headroom or lets you reach the same SIL with less redundancy. SFF is a constraint, not a substitute for meeting the PFH/PMHF target.</p>'
        },
        fmedaNets: {
            title: 'FMEDA — the three nets',
            body:
                '<p>Three independent nets connect like-to-like, shown one at a time so the view never becomes a spider web:</p>' +
                '<p><strong>Architecture net</strong> — element ↔ element. <strong>Function net</strong> — function ↔ function. <strong>Failure net</strong> — failure ↔ failure.</p>' +
                '<p>The payoff is in the failure net: when one lower-level failure connects to failures in <em>two different functions</em>, that is a <strong>common-cause finding</strong> — a single failure defeating things assumed independent. These are listed in the right pane.</p>'
        },
        linking: {
            title: 'Linking events (signals)',
            body:
                '<p>A <strong>link</strong> is a signal that feeds one event\'s probability up to its parent. There are two ways to feed a derived (intermediate or top) event:</p>' +
                '<p><strong>Direct link</strong> — connect <em>one</em> child event straight to the parent. The parent simply inherits the child\'s probability (a pass-through): <code>P_parent = P_child</code>. Use this when a single sub-failure <em>is</em> the parent failure and there is nothing to combine — e.g. a top event that is just a named view of one intermediate event. This is what lets you compute a top event from a single intermediate without an artificial gate.</p>' +
                '<p><strong>Gate</strong> — when <em>two or more</em> children feed the parent, you must use a gate (AND / OR / VOTING / INHIBIT). The gate is what tells the analyzer <em>how</em> to combine the several inputs into one probability; a plain link has no combining rule, so it is only valid for a single child.</p>' +
                '<p><strong>One feeder per event.</strong> An intermediate or top event can be fed by exactly one source — either one direct link or one gate, never both. To go from a direct link to multiple inputs, remove the link and add a gate (or vice-versa).</p>' +
                '<p><strong>Direction.</strong> Links flow <em>upward</em>: a basic or intermediate event is the <em>from</em> (child); an intermediate or top event is the <em>to</em> (parent). A top event can never be a child, and a basic event can never be a parent.</p>'
        },
        gateAlgebra: {
            title: 'Gates and their algebra',
            body:
                '<p>Gates combine input failure probabilities into the output probability of the event they feed. All formulas assume the inputs are independent — if they aren\'t (shared ECU, shared power), FAS raises an FFI warning on the gate.</p>' +
                '<p><strong>AND</strong> — Output fails only when <em>every</em> input fails:</p>' +
                '<p><code>P_out = P₁ × P₂ × … × P<sub>n</sub></code></p>' +
                '<p>Multiplication drives probability <em>down</em>. Use AND when both branches must fail to defeat a redundant design — a 1-out-of-2 voter, a comm channel ANDed with its E2E protection, etc.</p>' +
                '<p><strong>OR</strong> — Output fails when <em>at least one</em> input fails:</p>' +
                '<p><code>P_out = 1 − (1 − P₁)(1 − P₂) … (1 − P<sub>n</sub>)</code></p>' +
                '<p>For small probabilities this approximates P₁ + P₂ + … (rare-event approximation), but the exact form above always holds for independent events. Use OR when any path failure is enough to cause the outcome — single points of failure, alternative cut sets.</p>' +
                '<p><strong>VOTING (k-of-n)</strong> — Output fails when at least <em>k</em> of <em>n</em> inputs fail. For identical inputs at probability P this is the binomial sum:</p>' +
                '<p><code>P_out = Σ<sub>i≥k</sub> C(n,i) · P<sup>i</sup> · (1 − P)<sup>n−i</sup></code></p>' +
                '<p>FAS evaluates the general case by enumerating subsets, so inputs needn\'t share the same probability. Use voting for majority-fail or m-out-of-n redundancy.</p>' +
                '<p><strong>INHIBIT</strong> — Single input plus a conditioning probability <code>P_cond</code>. Output fails when the input fails <em>and</em> the condition holds:</p>' +
                '<p><code>P_out = P_in × P_cond</code></p>' +
                '<p>Functionally equivalent to a 2-input AND, but the conditioning side is a fixed probability rather than a sub-tree. Common uses: "given a fault occurs, the fault propagates to a dangerous state with probability P_cond", or "the hazardous mode is reachable in P_cond fraction of operations".</p>' +
                '<p><em>Common pitfall:</em> if the same basic event appears under more than one gate, the multiplications double-count and the result is optimistic. FAS flags this with a "Repeated event" warning.</p>' +
                '<p><em>Why FTA looks "inverted" vs ETA:</em> in event tree analysis you multiply along each path (each branch picks one outcome) and sum across paths. In FTA the AND and OR combine probabilities of failures — different question, different algebra. Both techniques are correct for their own job.</p>'
        },
        structure: {
            title: 'Structure: groups & scenarios',
            body:
                '<p>Two non-gate, non-event constructs help organise larger trees.</p>' +
                '<p><strong>Group</strong> — An independence boundary. Events placed in the same group are assumed to share a common environment (same ECU, same power rail, same clock), so their failures are <em>not</em> independent. When an AND or k-of-n VOTING gate combines inputs whose leaves share a group, FAS raises an <strong>FFI</strong> warning and outlines the gate in red.</p>' +
                '<p>The group\'s <em>Description</em> field is the right place to document the FFI argument that justifies accepting a flagged combination — for example, citing the section of the safety case that argues for sufficient independence despite shared hardware. This is the evidence ISO 26262 Part 9 §6 expects when FFI is claimed.</p>' +
                '<p><strong>Scenario</strong> — A list of forced-probability overrides used for what-if analysis. Pick a basic event and set its probability to 1 ("always fails"), 0 ("perfectly reliable"), or anything in between. Activating a scenario in the right panel replaces those events\' computed values during recalculation, leaving the rest of the tree untouched.</p>' +
                '<p>Useful for cut-set exploration, what-if scenarios during design reviews, and sensitivity probing. Events whose values are being overridden show a small diamond (◆) on their canvas labels so it\'s never invisible that a scenario is in play.</p>'
        },
        target: {
            title: 'Safety target',
            body:
                '<p>The <strong>target</strong> is the maximum acceptable PFH for the top event — derived from the system\'s required SIL (IEC 61508) or ASIL (ISO 26262).</p>' +
                '<p>FAS compares the computed PFH against this target on every Recalculate and shows whether the target is met (✓) or missed (✗).</p>' +
                '<p><strong>PFH bands used:</strong></p>' +
                '<ul>' +
                '<li>SIL 4 / ASIL D — PFH &lt; 10⁻⁸ /h</li>' +
                '<li>SIL 3 / ASIL C — PFH &lt; 10⁻⁷ /h</li>' +
                '<li>SIL 2 / ASIL B — PFH &lt; 10⁻⁶ /h</li>' +
                '<li>SIL 1 / ASIL A — PFH &lt; 10⁻⁵ /h</li>' +
                '</ul>' +
                '<p>ASIL B/C share PFH = 10⁻⁷ in ISO 26262-5:2018 informative tables. The distinction between B and C is carried by the hardware metrics (SPFM, LFM, PMHF) not by PFH alone — FAS uses the more lenient bound for B.</p>'
        },
        viewMode: {
            title: 'View modes',
            body:
                '<p><strong>Technical</strong> — engineering view. Probabilities in scientific notation (1.23 × 10⁻⁵), per-hour rates, SIL/ASIL codes. Use when working inside the safety team.</p>' +
                '<p><strong>Simplified</strong> — stakeholder view. Probabilities as percentages over the mission time, SIL/ASIL replaced by plain-language integrity labels. Use when showing the diagram to project management, customers, or non-safety reviewers.</p>' +
                '<p>Both views are recomputed from the same underlying numbers — switching modes never changes the analysis, only how it\'s displayed.</p>'
        }
    }
};
