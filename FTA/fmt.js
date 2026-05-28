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
        const s = p >= 0.01 ? p.toFixed(3) : p.toExponential(2);
        return _trimZeros(s);
    }

    /* Failure rate in FIT (per 10⁹ h). Fixed notation for 1 ≤ λ < 10000,
       scientific outside. Trailing zeros stripped. */
    function fitStr(rate) {
        if (rate == null || isNaN(rate)) return '—';
        if (rate === 0) return '0 FIT';
        if (rate >= 1 && rate < 1e4) {
            return _trimZeros(rate.toFixed(1)) + ' FIT';
        }
        return _trimZeros(rate.toExponential(2)) + ' FIT';
    }

    /* Per-hour failure rate. */
    function perHourStr(rate) {
        if (rate == null || isNaN(rate)) return '—';
        if (rate === 0) return '0 /h';
        return probStr(rate) + ' /h';
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

    return {
        escHtml, uid, bumpUid, resetUid,
        clamp, posInt, posNum,
        probStr, fitStr, perHourStr,
        pctStr, intDot, inHoursStr
    };
})();
