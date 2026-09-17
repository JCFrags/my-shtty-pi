import { matchesKey, Text } from "@earendil-works/pi-tui";
/** Read-only reports stay in the menu and never enter model context. */
export async function showChronoReport(ctx, title, content) {
    if (ctx.mode !== "tui") {
        ctx.ui.notify(content, "info");
        return;
    }
    await ctx.ui.custom((tui, theme, _keys, done) => {
        const body = new Text(content, 1, 0);
        let offset = 0;
        let pageSize = 10;
        let lineCount = 0;
        return {
            render(width) {
                const lines = body.render(width);
                lineCount = lines.length;
                pageSize = Math.max(1, tui.terminal.rows - 8);
                offset = Math.max(0, Math.min(offset, lineCount - pageSize));
                return [
                    ...new Text(theme.fg("accent", theme.bold(title)), 1, 0).render(width),
                    ...lines.slice(offset, offset + pageSize),
                    ...new Text(theme.fg("dim", "Up/Down or PgUp/PgDn: scroll. Enter/Esc: back."), 1, 0).render(width),
                ];
            },
            invalidate() { body.invalidate(); },
            handleInput(data) {
                if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
                    done();
                    return;
                }
                if (matchesKey(data, "up"))
                    offset--;
                if (matchesKey(data, "down"))
                    offset++;
                if (matchesKey(data, "pageUp"))
                    offset -= pageSize;
                if (matchesKey(data, "pageDown"))
                    offset += pageSize;
                if (matchesKey(data, "home"))
                    offset = 0;
                if (matchesKey(data, "end"))
                    offset = lineCount;
                tui.requestRender();
            },
        };
    });
}
//# sourceMappingURL=chrono-ui.js.map