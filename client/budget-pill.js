// Browser half of dsh-bedrock-metering: a budget pill in the chat composer
// (`conversation.input.right`). Hand-written in the dsh client module format
// (`window.__ModuleLoader__.load({ id, factory })`, React supplied by the shell)
// so the package needs no bundler. The host's /bedrock-metering/status route
// supplies the text (dollars spent in this conversation by default), colour band
// and bar fraction; this file only renders and polls. The slot is session-scoped,
// so the renderer passes the conversation's `sessionId` as a standard prop.
window.__ModuleLoader__.load({
  id: 'dsh-bedrock-metering',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const { createElement: h, useEffect, useState } = React;

    const STATUS_URL = 'bedrock-metering/status';
    const POLL_MS = 10_000;
    const COLORS = { ok: null, warn: '#d97706', critical: '#dc2626', stopped: '#dc2626', overridden: '#d97706' };

    /**
     * Pill element for one status body (pure; exported for tests).
     * @param status - body of the status route.
     * @returns the React element.
     */
    function pillElement(status) {
      const color = COLORS[status.level] ?? null;
      const width = `${Math.round(Math.min(1, Math.max(0, status.bar)) * 100)}%`;
      return h('span', {
        role: 'status',
        title: status.tooltip,
        'aria-label': status.tooltip.split('\n')[0],
        'data-level': status.level,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999,
          fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap', cursor: 'default', fontVariantNumeric: 'tabular-nums',
          color: color ?? 'inherit', opacity: color === null ? 0.7 : 1,
          border: `1px solid ${color ?? 'rgba(127, 127, 127, 0.35)'}`,
        },
      },
      h('span', null, status.label),
      h('span', {
        'aria-hidden': true,
        style: { position: 'relative', width: 36, height: 4, borderRadius: 2, overflow: 'hidden', background: 'rgba(127, 127, 127, 0.25)' },
      }, h('span', {
        style: { position: 'absolute', left: 0, top: 0, bottom: 0, width, borderRadius: 2, background: color ?? 'currentColor' },
      })));
    }

    /** Composer slot entry: polls the status route and renders nothing until it answers. */
    function BudgetPill(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : undefined;
      const [status, setStatus] = useState(undefined);
      useEffect(() => {
        let controller;
        let stopped = false;
        const url = sessionId === undefined ? STATUS_URL : `${STATUS_URL}?session=${encodeURIComponent(sessionId)}`;
        const refresh = () => {
          controller?.abort();
          controller = new AbortController();
          fetch(url, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : undefined))
            .then((body) => {
              if (!stopped) setStatus(body?.v === 1 ? body : undefined);
            })
            .catch(() => {});
        };
        refresh();
        const timer = setInterval(refresh, POLL_MS);
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => {
          stopped = true;
          clearInterval(timer);
          window.removeEventListener('focus', onFocus);
          controller?.abort();
        };
      }, [sessionId]);
      return status === undefined ? null : pillElement(status);
    }

    /** Client services this plugin needs. */
    const inject = ['slots'];

    /**
     * Register the pill into the composer slot once the conversation UI declares it.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'bedrock-metering-budget',
        order: -10,
      }, BudgetPill));
    }

    module.exports.apply = apply;
    module.exports.inject = inject;
    module.exports.pillElement = pillElement;
    module.exports.BudgetPill = BudgetPill;
    return module.exports;
  },
});
