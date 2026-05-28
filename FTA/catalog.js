/**
 * catalog.js
 * Functional Analysis Studio [FAS] — Left-pane Catalog.
 *
 * Static list of "add" buttons grouped by category. The actual create
 * flow lives in main.js / dialogs.js — this module just renders the
 * buttons and routes clicks through one callback.
 *
 * Public:
 *   catalog.render(containerId, onPick)
 *     onPick(kind)   kind ∈
 *       'event-basic', 'event-intermediate', 'event-top',
 *       'gate-AND', 'gate-OR', 'gate-VOTING', 'gate-INHIBIT',
 *       'group', 'scenario'
 *   catalog.setEnabled(bool)
 *
 * Depends on: fmt.js
 */

const catalog = (() => {

    const ITEMS = [
        { group: 'Events', help: 'eventsKinds', items: [
            { kind: 'event-basic',
              icon: '◯',  label: 'Basic event',
              hint: 'A leaf failure: probability, rate, or rate+coverage.' },
            { kind: 'event-intermediate',
              icon: '▢',  label: 'Intermediate event',
              hint: 'A failure derived from a gate below it.' },
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
        { group: 'Structure', help: 'structure', items: [
            { kind: 'group',
              icon: '▦',  label: 'Group / boundary',
              hint: 'Independence boundary. Events in the same group flag FFI on AND gates.' },
            { kind: 'scenario',
              icon: '▸',  label: 'Scenario',
              hint: 'Force selected events to a fixed probability for "what-if" analysis.' }
        ]}
    ];

    let enabled = true;

    function render(containerId, onPick) {
        const root = document.getElementById(containerId);
        if (!root) return;
        let html = '';
        ITEMS.forEach(group => {
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
                if (onPick) onPick(btn.getAttribute('data-kind'));
            });
        });
    }

    function setEnabled(on) {
        enabled = !!on;
        document.querySelectorAll('.cat-item').forEach(b => {
            if (enabled) b.classList.remove('disabled');
            else         b.classList.add('disabled');
        });
    }

    return { render, setEnabled };
})();
