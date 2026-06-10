/**
 * catalog.js
 * Functional Analysis Studio [FAS] — Left-pane Catalog.
 *
 * Static list of "add" buttons grouped by category. The actual create
 * flow lives in main.js / dialogs.js — this module just renders the
 * buttons and routes clicks through one callback.
 *
 * Public:
 *   catalog.render(containerId, onPick, mode)
 *     onPick(kind)   FTA kinds ∈
 *       'event-basic', 'event-intermediate', 'event-top',
 *       'gate-AND', 'gate-OR', 'gate-VOTING', 'gate-INHIBIT',
 *       'link', 'group', 'scenario'
 *     ETA kinds — same as FTA (events incl. multiple finals, gates,
 *       links, groups, scenarios)
 *   catalog.setEnabled(bool)
 *   catalog.setMode('FTA' | 'ETA')   — re-renders with the right catalog
 *
 * Depends on: fmt.js
 */

const catalog = (() => {

    const FTA_ITEMS = [
        { group: 'Events', help: 'eventsKinds', items: [
            { kind: 'event-basic',
              icon: '◯',  label: 'Basic event',
              hint: 'A leaf failure: probability, rate, or rate+coverage.' },
            { kind: 'event-intermediate',
              icon: '▢',  label: 'Intermediate event',
              hint: 'A failure derived from a gate or a single linked child below it.' },
            { kind: 'event-top',
              icon: '■',  label: 'Top event',
              hint: 'The system-level undesired outcome. Only one per project.' }
        ]},
        { group: 'Gates', help: 'gateAlgebra', items: [
            { kind: 'gate-AND',
              icon: '∧',  label: 'AND',
              hint: 'All inputs must fail. P = ∏ Pᵢ.' },
            { kind: 'gate-OR',
              icon: '∨',  label: 'OR',
              hint: 'Any input failing causes the output. P = 1 − ∏(1 − Pᵢ).' },
            { kind: 'gate-VOTING',
              icon: 'k/n', label: 'Voting (k-of-n)',
              hint: 'Output fails when ≥ k of n inputs fail.' },
            { kind: 'gate-INHIBIT',
              icon: '⊐',  label: 'Inhibit',
              hint: 'Output fails only if input fails AND a condition holds.' }
        ]},
        { group: 'Connections', help: 'linking', items: [
            { kind: 'link',
              icon: '→',  label: 'Link (signal)',
              hint: 'Feed one child event straight into a parent (pass-through). ' +
                    'Two or more inputs need a gate instead.' }
        ]},
        { group: 'Structure', help: 'structure', items: [
            { kind: 'group',
              icon: '▦',  label: 'Group / boundary',
              hint: 'Independence boundary. Events in the same group flag FFI on AND gates.' },
            { kind: 'scenario',
              icon: '▸',  label: 'Scenario',
              hint: 'Force selected events to a fixed probability for "what-if" analysis.' }
        ]}
    ];

    const ETA_ITEMS = [
        { group: 'Events', help: 'etaMode', items: [
            { kind: 'event-basic',
              icon: '◯',  label: 'Basic event',
              hint: 'A leaf failure: probability, rate, or rate+coverage.' },
            { kind: 'event-intermediate',
              icon: '▢',  label: 'Intermediate event',
              hint: 'A failure derived from a gate or a single linked child below it.' },
            { kind: 'event-top',
              icon: '■',  label: 'Final event',
              hint: 'An output of the tree. ETA may have several finals, each computed independently.' }
        ]},
        { group: 'Gates', help: 'gateAlgebra', items: [
            { kind: 'gate-AND',
              icon: '∧',  label: 'AND',
              hint: 'All inputs must fail. P = ∏ Pᵢ.' },
            { kind: 'gate-OR',
              icon: '∨',  label: 'OR',
              hint: 'Any input failing causes the output. P = 1 − ∏(1 − Pᵢ).' },
            { kind: 'gate-VOTING',
              icon: 'k/n', label: 'Voting (k-of-n)',
              hint: 'Output fails when ≥ k of n inputs fail.' },
            { kind: 'gate-INHIBIT',
              icon: '⊐',  label: 'Inhibit',
              hint: 'Output fails only if input fails AND a condition holds.' }
        ]},
        { group: 'Connections', help: 'linking', items: [
            { kind: 'link',
              icon: '→',  label: 'Link (signal)',
              hint: 'Feed one child event straight into a parent (pass-through). ' +
                    'Two or more inputs need a gate instead.' }
        ]},
        { group: 'Structure', help: 'structure', items: [
            { kind: 'group',
              icon: '▦',  label: 'Group / boundary',
              hint: 'Independence boundary. Events in the same group flag FFI on AND gates.' },
            { kind: 'scenario',
              icon: '▸',  label: 'Scenario',
              hint: 'Force selected events to a fixed probability for "what-if" analysis.' }
        ]}
    ];

    function _itemsFor(mode) {
        return mode === 'ETA' ? ETA_ITEMS : FTA_ITEMS;
    }

    let enabled = true;
    let _containerId = null;
    let _onPick = null;
    let _mode = 'FTA';

    function render(containerId, onPick, mode) {
        if (containerId) _containerId = containerId;
        if (onPick)      _onPick = onPick;
        if (mode)        _mode = (mode === 'ETA') ? 'ETA' : 'FTA';
        const root = document.getElementById(_containerId);
        if (!root) return;
        let html = '';
        _itemsFor(_mode).forEach(group => {
            // Section title with optional (?) help button. The button uses
            // the same .dlg-help class as everywhere else, so the global
            // delegated click handler in dialogs.js picks it up and opens
            // the help popover anchored to the button.
            const helpBtn = group.help
                ? `<button type="button" class="dlg-help" data-help="${group.help}" title="What is this?">?</button>`
                : '';
            html += `<div class="cat-group">${fmt.escHtml(group.group)}${helpBtn}</div>`;
            group.items.forEach(it => {
                html += `
                    <button class="cat-item" data-kind="${it.kind}" title="${fmt.escHtml(it.hint)}">
                        <span class="cat-icon">${it.icon}</span>
                        <span class="cat-label">${fmt.escHtml(it.label)}</span>
                    </button>`;
            });
        });
        root.innerHTML = html;
        root.querySelectorAll('.cat-item').forEach(btn => {
            btn.addEventListener('click', () => {
                if (!enabled) return;
                if (_onPick) _onPick(btn.getAttribute('data-kind'));
            });
        });
    }

    function setMode(mode) {
        const m = (mode === 'ETA') ? 'ETA' : 'FTA';
        if (m === _mode) return;
        _mode = m;
        render();
    }

    function setEnabled(on) {
        enabled = !!on;
        document.querySelectorAll('.cat-item').forEach(b => {
            if (enabled) b.classList.remove('disabled');
            else         b.classList.add('disabled');
        });
    }

    return { render, setEnabled, setMode };
})();
