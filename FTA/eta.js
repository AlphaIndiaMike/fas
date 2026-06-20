/* eta.js — Event Tree Analysis (model layer)

   Scenario (initiating-event → barrier/outcome) CRUD. The ETA *analysis*
   (outcome probabilities) lives in analyzer.js (analyzeETA); this file is
   the ETA-specific part of the editable model.

   Part of the Project class, split out for separation of concerns
   (v3.2.1). These methods are attached to Project.prototype, so a
   Project instance uses them exactly as before — e.g. p.addScenario().
   Loaded AFTER fas.js (which defines class Project). */
'use strict';
(function () {
    Object.assign(Project.prototype, {

    /* ── Scenario CRUD ────────────────────────────────────────────── */

    addScenario({ name, overrides = [] }) {
        const s = {
            id:        fmt.uid('scn'),
            name:      name || this._uniqueScenarioName(),
            overrides: overrides.map(o => ({ ...o }))
        };
        this.scenarios.push(s);
        return s;
    },

    _uniqueScenarioName() {
        let n = this.scenarios.length + 1;
        let nm;
        do { nm = 'Scenario ' + n; n++; }
        while (this.scenarios.some(s => s.name === nm));
        return nm;
    },

    updateScenario(id, patch) {
        const s = this.scenarioById(id);
        if (!s) return false;
        if (patch.overrides) patch.overrides = patch.overrides.map(o => ({ ...o }));
        Object.assign(s, patch);
        return true;
    },

    deleteScenario(id) {
        this.scenarios = this.scenarios.filter(s => s.id !== id);
    }
    });
})();
