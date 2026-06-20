/* fta.js — Fault Tree Analysis (model layer)

   Gates, links, top event, feeder lookups, repeated/common events and the
   FFI shared-group resolver. The FTA *analysis* (cut sets, probability,
   target check) lives in analyzer.js; this file is the FTA-specific part
   of the editable model.

   Part of the Project class, split out for separation of concerns
   (v3.2.1). These methods are attached to Project.prototype, so a
   Project instance uses them exactly as before — e.g. p.topEvent().
   Loaded AFTER fas.js (which defines class Project). */
'use strict';
(function () {
    Object.assign(Project.prototype, {

    topEvent() { return this.events.find(e => e.kind === 'top') || null; },

    /* Gate whose output is this event (drives the event's probability
       in the analyzer). v1 enforces ≤ 1 gate per output event. */
    gateFeeding(eventId) {
        return this.gates.find(g => g.output === eventId) || null;
    },

    /* Direct link whose `to` is this event — the single-child pass-through
       alternative to a gate. ≤ 1 link per `to` event. */
    linkFeeding(eventId) {
        return this.links.find(l => l.to === eventId) || null;
    },

    /* The single source feeding a derived event, whichever kind it is.
       Returns { kind:'gate', gate } | { kind:'link', link } | null.
       Used to enforce "one feeder per event" across both constructs. */
    feederOf(eventId) {
        const g = this.gateFeeding(eventId);
        if (g) return { kind: 'gate', gate: g };
        const l = this.linkFeeding(eventId);
        if (l) return { kind: 'link', link: l };
        return null;
    },

    /* All gates this event feeds into (as one of their inputs). */
    gatesFedBy(eventId) {
        return this.gates.filter(g => g.inputs.includes(eventId));
    },

    /* All direct links this event feeds (as their `from`). */
    linksFedBy(eventId) {
        return this.links.filter(l => l.from === eventId);
    },

    /* ── Gate CRUD ────────────────────────────────────────────────── */

    addGate({ type, inputs = [], output = null,
              k = null, inhibitProb = null, x = 300, y = 300 }) {
        if (!['AND', 'OR', 'VOTING', 'INHIBIT'].includes(type)) return null;
        const g = {
            id:          fmt.uid('g'),
            type,
            inputs:      inputs.slice(),
            output,
            k:           type === 'VOTING'  ? (k || CONFIG.gateDefaults.k)
                                            : null,
            inhibitProb: type === 'INHIBIT' ? (inhibitProb != null ? inhibitProb
                                                                  : CONFIG.gateDefaults.inhibitProb)
                                            : null,
            x, y
        };
        this.gates.push(g);
        return g;
    },

    updateGate(id, patch) {
        const g = this.gateById(id);
        if (!g) return false;
        if (patch.inputs) patch.inputs = patch.inputs.slice();
        Object.assign(g, patch);
        return true;
    },

    deleteGate(id) {
        this.gates = this.gates.filter(g => g.id !== id);
    },

    /* ── Link CRUD ────────────────────────────────────────────────────
       A link is a single-child pass-through feeding `to` from `from`.
       Validation mirrors gate output rules so the two feeder kinds stay
       mutually exclusive and consistent. */

    /* Why a candidate (from → to) link is or isn't allowed. Returns an
       error string, or null if the link is valid. Pure — used by both
       addLink and the dialog so the UI and model never disagree. */
    linkError(from, to, ignoreLinkId) {
        const f = this.eventById(from);
        const t = this.eventById(to);
        if (!f || !t)        return 'Both ends of the link must be existing events.';
        if (from === to)     return 'An event cannot link to itself.';
        if (t.kind === 'basic')
            return 'The parent (to) must be an intermediate or top event.';
        if (f.kind === 'top')
            return 'A top event cannot feed another event — it is the apex.';
        // One feeder per parent: reject if `to` is already fed by a gate
        // or by a different link.
        if (this.gateFeeding(to))
            return 'Event "' + t.name + '" is already fed by a gate. ' +
                   'Remove that gate first, or link a different event.';
        const existingLink = this.linkFeeding(to);
        if (existingLink && existingLink.id !== ignoreLinkId)
            return 'Event "' + t.name + '" is already fed by a direct link. ' +
                   'An event can have only one feeder; use a gate to combine ' +
                   'two or more inputs.';
        return null;
    },

    addLink({ from, to }) {
        if (this.linkError(from, to)) return null;
        const l = { id: fmt.uid('lnk'), from, to };
        this.links.push(l);
        return l;
    },

    updateLink(id, patch) {
        const l = this.linkById(id);
        if (!l) return false;
        const from = patch.from != null ? patch.from : l.from;
        const to   = patch.to   != null ? patch.to   : l.to;
        if (this.linkError(from, to, id)) return false;
        l.from = from;
        l.to   = to;
        return true;
    },

    deleteLink(id) {
        this.links = this.links.filter(l => l.id !== id);
    },

    /* ── Validation helpers ───────────────────────────────────────── */

    /* Returns the set of event ids that two AND/VOTING inputs share
       via the `groupId` membership — used by the FFI checker.
       Returns null for gate types where it doesn't apply. */
    ffiSharedGroups(gateId) {
        const g = this.gateById(gateId);
        if (!g) return null;
        if (g.type !== 'AND' && g.type !== 'VOTING') return null;
        if (g.inputs.length < 2) return null;

        // Walk each input back to all basic events that contribute to
        // it. Any group id that appears in ≥ 2 of those leaf-sets
        // means two branches share an independence boundary.
        const leafGroupsByInput = g.inputs.map(inpId =>
            this._collectLeafGroups(inpId, new Set()));

        const counts = new Map();
        leafGroupsByInput.forEach(set => {
            set.forEach(gid => counts.set(gid, (counts.get(gid) || 0) + 1));
        });
        const shared = [];
        counts.forEach((c, gid) => { if (c >= 2 && gid) shared.push(gid); });
        return shared;
    },

    _collectLeafGroups(eventId, visited) {
        if (visited.has(eventId)) return new Set();    // cycle guard
        visited.add(eventId);
        const ev = this.eventById(eventId);
        if (!ev) return new Set();
        const feeding = this.gateFeeding(eventId);
        if (feeding) {
            const all = new Set();
            feeding.inputs.forEach(i => {
                this._collectLeafGroups(i, visited).forEach(g => all.add(g));
            });
            return all;
        }
        // A direct link forwards its single child's leaf groups unchanged.
        const link = this.linkFeeding(eventId);
        if (link) {
            return this._collectLeafGroups(link.from, visited);
        }
        // Leaf event — return its group if any.
        const s = new Set();
        if (ev.groupId) s.add(ev.groupId);
        return s;
    },

    /* Events that appear as input to more than one feeder (gate input or
       link source). Naive propagation double-counts; the analyzer flags
       these to the user. */
    repeatedEvents() {
        const count = new Map();
        const bump  = id => count.set(id, (count.get(id) || 0) + 1);
        this.gates.forEach(g => g.inputs.forEach(bump));
        this.links.forEach(l => bump(l.from));
        const out = [];
        count.forEach((c, id) => { if (c >= 2) out.push(id); });
        return out;
    },

    /* Events repeated WITHIN the cone of one root (final/top) event — i.e.
       consumed by two or more feeders that are themselves reachable from the
       root. Walks the feeder tree (gate inputs and link sources) from the
       root, counting how many feeders in the cone consume each event. This is
       the per-final independence check ETA needs: an initiating event or
       barrier shared across DIFFERENT finals is fine (each final is computed
       on its own), but a true repeat inside a single final's cone still
       double-counts. FTA's single top makes the whole model one cone, so the
       global repeatedEvents() above already covers it. */
    repeatedEventsFor(rootId) {
        const count   = new Map();
        const visited = new Set();
        const walk = (id) => {
            const g = this.gateFeeding(id);
            if (g) {
                g.inputs.forEach(iid => {
                    count.set(iid, (count.get(iid) || 0) + 1);
                    if (!visited.has(iid)) { visited.add(iid); walk(iid); }
                });
                return;
            }
            const l = this.linkFeeding(id);
            if (l) {
                count.set(l.from, (count.get(l.from) || 0) + 1);
                if (!visited.has(l.from)) { visited.add(l.from); walk(l.from); }
            }
        };
        walk(rootId);
        const out = [];
        count.forEach((c, id) => { if (c >= 2) out.push(id); });
        return out;
    }
    });
})();
