import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Sanitize display copies only. Never change the saved arguments or result.
function safeText(value) {
  return stripTerminalSequences(String(value ?? ""))
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function singleLine(value) {
  return safeText(value).replace(/\s+/g, " ").trim();
}

function component(render) {
  return { render, invalidate() {} };
}

/** Pure human presentation hooks. Projections must only read their inputs. */
export function createToolPresentation(spec) {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const title = singleLine(spec.call(args, context));
      return component((width) => width < 1 ? [] : [theme.fg("toolTitle", theme.bold(truncateToWidth(title, width)))]);
    },
    renderResult(result, options, theme, context) {
      const view = spec.result(result, options, context);
      return component((width) => {
        if (width < 1 || (view.quiet && !options.expanded)) return [];
        const budget = options.expanded ? 9 : 5;
        const labels = [];
        const notices = [];
        const excerpts = [];
        let omitted = Boolean(view.omitted);
        const addLabel = (target, text, color) => {
          const line = singleLine(text);
          if (!line) return;
          omitted ||= visibleWidth(line) > width;
          target.push({ text: truncateToWidth(line, width), color });
        };
        addLabel(labels, view.summary, view.tone ?? "muted");
        for (const notice of view.notices ?? []) addLabel(notices, notice, "warning");
        for (const line of view.lines ?? []) {
          for (const wrapped of wrapTextWithAnsi(safeText(line), width)) {
            // Also bound indivisible wide characters at very small terminal widths.
            omitted ||= visibleWidth(wrapped) > width;
            excerpts.push({ text: truncateToWidth(wrapped, width), color: "toolOutput" });
          }
        }
        const total = labels.length + notices.length + excerpts.length;
        const needsCue = options.expanded || omitted || total > budget;
        const available = budget - (needsCue ? 1 : 0);
        const noticeSpace = available - labels.length;
        const rows = [...labels];
        if (notices.length > noticeSpace) {
          const shown = Math.max(0, noticeSpace - 1);
          rows.push(...notices.slice(0, shown));
          rows.push({ text: truncateToWidth(`… ${notices.length - shown} more notices`, width), color: "warning" });
        } else {
          rows.push(...notices, ...excerpts.slice(0, noticeSpace - notices.length));
        }
        omitted ||= total > available;
        const rendered = rows.map((row) => theme.fg(row.color, row.text));
        if (needsCue) {
          const cue = `${omitted ? "… " : ""}raw: /export NEW.jsonl`;
          rendered.push(theme.fg("dim", truncateToWidth(cue, width)));
        }
        return rendered;
      });
    },
  };
}
