/**
 * fmt.js
 * Functional Analysis Studio [FAS] — Shared formatting and id helpers.
 *
 * Tiny utility module so every other module can pull the same
 * escaping / id-generation / number-formatting routine without
 * duplicating it.
 */

const fmt = (() => {

    /* HTML-escape for safe injection into innerHTML. */
    function escHtml(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* Per-prefix incrementing counter. IDs read as "e_1", "g_2",
       "grp_3", "scn_4" — short and predictable. Counters live for the
       page session and are rehydrated past existing IDs on JSON load
       (see fas.js Project.fromJSON → fmt.bumpUid). */
    const _counters = Object.create(null);

    function uid(prefix) {
        const p = prefix || 'id';
        _counters[p] = (_counters[p] || 0) + 1;
        return p + '_' + _counters[p];
    }

    function bumpUid(prefix, n) {
        const p = prefix || 'id';
        if (!_counters[p] || _counters[p] < n) _counters[p] = n;
    }

    function resetUid() {
        Object.keys(_counters).forEach(k => delete _counters[k]);
    }

    function clamp(n, lo, hi, fallback) {
        const x = parseFloat(n);
        if (isNaN(x)) return fallback;
        return Math.max(lo, Math.min(hi, x));
    }

    function posInt(v, fallback) {
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) return fallback;
        return n;
    }

    function posNum(v, fallback) {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) return fallback;
        return n;
    }

    /* Strip trailing zeros from a numeric string in either fixed or
       scientific notation. Examples:
            "0.100"     → "0.1"
            "0.1000"    → "0.1"
            "1.00e-3"   → "1e-3"
            "2.50e-1"   → "2.5e-1"
            "1.230e-5"  → "1.23e-5"
            "100.0"     → "100"
       Leaves the exponent untouched, removes any orphan trailing dot. */
    function _trimZeros(s) {
        return String(s)
            .replace(/(\.\d*?)0+(e[+-]?\d+)$/, '$1$2')   // scientific mantissa
            .replace(/(\.\d*?)0+$/,            '$1')     // fixed
            .replace(/\.(e[+-]?\d+)$/,         '$1')     // orphan dot before exp
            .replace(/\.$/,                    '');      // orphan trailing dot
    }

    /* Probability formatter — picks engineering notation under 0.01
       and fixed notation above. 3 significant figures with trailing
       zeros stripped: "1.23e-5", "0.034", "1e-3", "—".

       Uses toExponential rather than manual exponent extraction so
       boundary cases like 0.00009999 → "1e-4" (not "10e-5") normalise
       cleanly. */
    function probStr(p) {
        if (p == null || isNaN(p)) return '—';
        if (p === 0) return '0';
        // Mid-range stays as a plain decimal; small values render as
        // friendly × 10ⁿ (display only — the stored value is unchanged).
        return p >= 0.01 ? _trimZeros(p.toFixed(3))
                         : _expFriendly(p.toExponential(2));
    }

    /* Failure rate in FIT (per 10⁹ h). Fixed notation for 1 ≤ λ < 10000,
       scientific outside. Trailing zeros stripped. */
    function fitStr(rate) {
        if (rate == null || isNaN(rate)) return '—';
        if (rate === 0) return '0 FIT';
        if (rate >= 1 && rate < 1e4) {
            return _trimZeros(rate.toFixed(1)) + ' FIT';
        }
        return _expFriendly(rate.toExponential(2)) + ' FIT';
    }

    /* Per-hour failure rate. */
    function perHourStr(rate) {
        if (rate == null || isNaN(rate)) return '—';
        if (rate === 0) return '0 /h';
        return probStr(rate) + ' /h';
    }

    /* Dual-notation per-hour rate for the Simplified view: shows both the
       scientific form AND the explicit ×10⁻ⁿ /h form so a non-specialist can
       read it, e.g. "2 × 10⁻⁷ /h". (Single source: _expFriendly already
       renders Unicode superscripts; we just append the unit.) */
    function pfhDualStr(pfh) {
        if (pfh == null || isNaN(pfh)) return '—';
        if (pfh === 0) return '0 /h';
        return _expFriendly(pfh.toExponential(2)) + ' /h';
    }

    /* SIL / ASIL band lookup from a PFH (per-hour) value. Single source of
       truth, aligned with CONFIG.silBands / asilBands (same bounds the FTA
       analyzer uses). Returns the band code, e.g. 'SIL 2' / 'ASIL B'. */
    function silForPfh(pfh) {
        if (pfh == null || isNaN(pfh)) return '—';
        for (const b of CONFIG.silBands)  { if (pfh < b.max) return b.sil; }
        return 'No SIL';
    }
    function asilForPfh(pfh) {
        if (pfh == null || isNaN(pfh)) return '—';
        for (const b of CONFIG.asilBands) { if (pfh < b.max) return b.asil; }
        return 'QM';
    }

    /* Highest ASIL whose ISO 26262-5 hardware targets are ALL met by the
       achieved metrics: PMHF < target (/h) AND SPFM ≥ target AND LFM ≥ target.
       ASIL B/C/D are metric-gated. ISO 26262-5 sets NO quantitative SPFM/LFM
       target for ASIL A or QM, so once the metrics fall short of ASIL B we
       classify QM vs ASIL A from the achieved RATE (PMHF) — the data we already
       have — via the asilBands ladder, capped at ASIL A since the metrics do
       not support ASIL B or above. Returns an ASIL string, 'QM', or '—' when
       the metrics are unavailable. SPFM/LFM are ignored when null (not
       computed). ASIL A from rate is informative (no metric target) and the UI
       marks it '*' — the final ASIL A vs QM call belongs to the HARA. */
    function asilFromMetrics(pmhfPerH, spfm, lfm) {
        if (pmhfPerH == null || isNaN(pmhfPerH)) return '—';
        for (const t of CONFIG.iso26262Targets) {
            const pmhfOk = pmhfPerH < t.pmhf;
            const spfmOk = (spfm == null) || (spfm >= t.spfm);
            const lfmOk  = (lfm  == null) || (lfm  >= t.lfm);
            if (pmhfOk && spfmOk && lfmOk) return t.asil;   // B/C/D, metric-gated
        }
        return (asilForPfh(pmhfPerH) === 'QM') ? 'QM' : 'ASIL A';
    }

    /* The ISO 26262 target row for one ASIL (or null). */
    function iso26262TargetFor(asil) {
        return CONFIG.iso26262Targets.find(t => t.asil === asil) || null;
    }

    /* IEC 61508-2 Route 1ₕ architectural-constraint cap. Given an element
       type ('A' | 'B'), its SFF (fraction) and its hardware fault tolerance
       (HFT, 0..2), returns the maximum SIL the architecture permits as a
       string: 'SIL 1'..'SIL 4', or 'not allowed' when even HFT 0 forbids a
       claim (Type B, SFF < 60 %). Returns '—' when SFF is unavailable. */
    function route1hMaxSil(type, sff, hft) {
        if (sff == null || isNaN(sff)) return '—';
        const tbl = CONFIG.route1h[(type === 'A') ? 'A' : 'B'];
        const h   = Math.max(0, Math.min(2, parseInt(hft, 10) || 0));
        let row = 0;
        for (let i = 0; i < CONFIG.route1h.sffBands.length; i++) {
            if (sff < CONFIG.route1h.sffBands[i].max) { row = i; break; }
            row = i;
        }
        const cap = tbl[row][h];
        return cap === 0 ? 'not allowed' : 'SIL ' + cap;
    }

    /* The SFF-band label for display ('< 60 %' … '≥ 99 %'), or '—'. */
    function sffBandLabel(sff) {
        if (sff == null || isNaN(sff)) return '—';
        const b = CONFIG.route1h.sffBands.find(b => sff < b.max);
        return b ? b.label : CONFIG.route1h.sffBands[CONFIG.route1h.sffBands.length - 1].label;
    }

    /* Numeric rank of a SIL string for comparison. 'not allowed' / 'No SIL'
       rank 0; 'SIL n' ranks n; anything else (—) ranks -1 (unknown). */
    function silRank(s) {
        if (s == null) return -1;
        if (s === 'not allowed' || s === 'No SIL') return 0;
        const m = /SIL\s*(\d)/.exec(s);
        return m ? parseInt(m[1], 10) : -1;
    }

    /* The more limiting (lower) of two SIL strings, ignoring unknowns ('—').
       Used to combine the PFH-band SIL with the Route 1ₕ architectural cap:
       the claimable SIL is the lower of the two. */
    function silMin(a, b) {
        const ra = silRank(a), rb = silRank(b);
        if (ra < 0) return b;
        if (rb < 0) return a;
        return ra <= rb ? a : b;
    }

    /* Achieved integrity band from an AGGREGATED FMEDA metrics object — the
       integrity an element (or the whole item) earns from its random-hardware
       metrics, per the active standard. This is the standard-correct basis: it
       is computed over ALL of the unit's failure modes, NOT inferred from a
       single "best" function.
         ISO 26262: the highest ASIL whose PMHF, SPFM and LFM are ALL met
           (asilFromMetrics) for B/C/D; below that, QM or ASIL A from the rate.
         IEC 61508: the claimable SIL = the lower of the PFH-band SIL (from the
           residual dangerous-undetected rate λ_DU) and the Route 1ₕ
           architectural cap (silMin).
       Pure: a read of the metrics object only, no model state. `m` is a
       metrics row from Project.fmedaMetrics() (an element or the `total`). */
    function achievedBand(m, iso) {
        if (!m) return iso ? '—' : 'No SIL';
        if (iso) {
            return asilFromMetrics((m.lambdaSPF + m.lambdaRF) * 1e-9, m.spfm, m.lfm);
        }
        const bandSil = silForPfh(m.lambdaDU * 1e-9);
        return (m.route1hSil == null) ? bandSil : silMin(bandSil, m.route1hSil);
    }

    /* Stored fraction → percent string for an EDITABLE input field.
       Unlike pctStr (which rounds for read-only display), this must
       round-trip cleanly: 0.10 → "10", 0.001 → "0.1", 1 → "100", and
       it must not introduce float dust like "10.000000000000002". We
       multiply by 100 and parse-back through Number to drop trailing
       float noise, capping at a sane number of decimals. Empty / NaN
       returns "" so a blank field stays blank rather than showing 0. */
    function pctInputVal(fraction) {
        if (fraction == null || fraction === '' || isNaN(fraction)) return '';
        const pct = +fraction * 100;
        if (pct === 0) return '0';
        // Up to 9 significant decimals, then strip trailing zeros. 9 is
        // enough to represent a 1e-9-scale PFD as a percent exactly.
        return _trimZeros(Number(pct.toFixed(9)).toString());
    }

    /* Simplified-view formatter: percentage with trailing zeros stripped
       so "0.200 %" reads as "0.2%". No space before the % sign. */
    function pctStr(p) {
        if (p == null || isNaN(p)) return '—';
        if (p === 0) return '0%';
        const pct = p * 100;
        let s;
        if      (pct >= 10)   s = pct.toFixed(1);
        else if (pct >= 0.1)  s = pct.toFixed(3);
        else if (pct >= 1e-4) s = pct.toPrecision(2);
        else                  s = pct.toExponential(1);
        return _trimZeros(s) + '%';
    }

    /* Integer with dot-thousand separator: 10000 → "10.000".
       Matches the European convention used in the simplified view. */
    function intDot(n) {
        if (n == null || isNaN(n)) return '—';
        return Math.round(+n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    }

    /* "<p as %> in <t> h" — simplified probability with the mission
       horizon made explicit so non-technical readers can't misread it
       as per-hour. Uses dot-thousand notation for the hours. */
    function inHoursStr(p, hours) {
        return pctStr(p) + ' in ' + intDot(hours || 0) + ' h';
    }

    /* Friendly scientific notation with real Unicode superscripts:
       "1 × 10⁻¹⁰", "2.5 × 10⁻³", "3.4 × 10²". Mantissa to 3 sig figs,
       trailing zeros stripped; exponent 0 collapses to just the mantissa.
       Used by ETA (the FTA technical view keeps its existing e-notation).
       Derives mantissa/exponent from toExponential to dodge log10 float
       wobble at powers-of-ten boundaries. */
    const _SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³',
                   '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
    function _supExp(n) {
        return String(n).split('').map(c => _SUP[c] || c).join('');
    }
    /* Convert a JS exponential string ("1.23e-5", "1.00e+2") to friendly
       superscript form ("1.23 × 10⁻⁵", "1 × 10²"). Mantissa trailing
       zeros stripped; exponent 0 collapses to the bare mantissa. This is
       the single place exponent rendering lives — shared by sciStr (ETA)
       and the FTA formatters (probStr/fitStr) so the whole tool reads the
       same way. Display only; never affects computed values. */
    function _expFriendly(s) {
        const ei = s.indexOf('e');
        if (ei < 0) return _trimZeros(s);
        const mant = _trimZeros(s.slice(0, ei));
        const exp  = parseInt(s.slice(ei + 1), 10);
        if (exp === 0) return mant;
        return mant + ' × 10' + _supExp(exp);
    }
    function sciStr(x) {
        if (x == null || isNaN(x)) return '—';
        if (x === 0) return '0';
        const sign = x < 0 ? '−' : '';
        return sign + _expFriendly(Math.abs(x).toExponential(2));
    }

    /* Plain-language "1 in N" frequency/probability gloss:
       "≈ 1 in 100 hours", "≈ 1 in 1.000 demands", "≈ 2 per year".
       Generic helper — caller supplies the singular/plural unit words. */
    function oneInN(value, singular, plural) {
        if (value == null || isNaN(value) || value <= 0) return '—';
        if (value >= 1) {
            const n = value < 10 ? _trimZeros(value.toFixed(2))
                                 : intDot(Math.round(value));
            return '≈ ' + n + ' per ' + (singular || 'unit');
        }
        const N = Math.round(1 / value);
        return '≈ 1 in ' + intDot(N) + ' ' + (plural || 'units');
    }

    return {
        escHtml, uid, bumpUid, resetUid,
        clamp, posInt, posNum,
        probStr, fitStr, perHourStr,
        pctStr, pctInputVal, intDot, inHoursStr,
        sciStr, oneInN,
        pfhDualStr, silForPfh, asilForPfh, asilFromMetrics, iso26262TargetFor,
        route1hMaxSil, sffBandLabel, silRank, silMin, achievedBand
    };
})();
