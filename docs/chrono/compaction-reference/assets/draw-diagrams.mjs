import { writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// These diagrams describe the approved baseline, not an installed implementation.
const root = fileURLToPath(new URL('.', import.meta.url));
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const text = (x, y, lines, cls = 'd-copy') => `<text x="${x}" y="${y}" class="${cls}">${[].concat(lines).map((s, i) => `<tspan x="${x}" dy="${i ? 26 : 0}">${esc(s)}</tspan>`).join('')}</text>`;
const rect = (x, y, w, h, cls = 'd-box') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" class="${cls}"/>`;
const box = (x, y, w, h, title, detail = [], cls = 'd-box') => rect(x, y, w, h, cls) + text(x + 18, y + 31, title, 'd-label') + (detail.length ? text(x + 18, y + 61, detail) : '');
const arrow = (stem, points, dashed = false) => `<path d="${points}" class="d-line${dashed ? ' d-dash' : ''}" marker-end="url(#${stem}-arrow)"/>`;
const rule = (x1, y1, x2, y2, dashed = false) => `<path d="M${x1} ${y1} H${x2}" class="d-line${dashed ? ' d-dash' : ''}"/>`;
const vertical = (x, y1, y2, dashed = false) => `<path d="M${x} ${y1} V${y2}" class="d-line${dashed ? ' d-dash' : ''}"/>`;
const styles = `
.chrono-diagram { --d-bg: var(--diagram-bg, #f5f3f0); --d-box: var(--diagram-box, #e9edf0); --d-line: var(--diagram-line, #7c8791); --d-ink: var(--diagram-text, #252f3d); --d-muted: var(--diagram-muted, #555f69); --d-a: var(--diagram-a, #dbe8ef); --d-b: var(--diagram-b, #e7e7d8); --d-c: var(--diagram-c, #edddd5); }
@media (prefers-color-scheme: dark) { .chrono-diagram { --d-bg: var(--diagram-bg, #212730); --d-box: var(--diagram-box, #2b3642); --d-line: var(--diagram-line, #9daab6); --d-ink: var(--diagram-text, #ebe7e4); --d-muted: var(--diagram-muted, #b2bbc4); --d-a: var(--diagram-a, #294553); --d-b: var(--diagram-b, #414536); --d-c: var(--diagram-c, #513b34); } }
.d-bg { fill: var(--d-bg); }
.d-box, .d-a, .d-b, .d-c { fill: var(--d-box); stroke: var(--d-line); stroke-width: 1.5; }
.d-a { fill: var(--d-a); } .d-b { fill: var(--d-b); } .d-c { fill: var(--d-c); }
.d-outline { fill: none; stroke: var(--d-line); stroke-width: 1.5; stroke-dasharray: 6 5; }
.d-line { fill: none; stroke: var(--d-line); stroke-width: 2; }
.d-dash { stroke-dasharray: 6 5; }
.d-arrow { fill: var(--d-line); }
.d-title, .d-label, .d-copy, .d-small, .d-cut { fill: var(--d-ink); font-family: ui-sans-serif, system-ui, sans-serif; }
.d-title { font-size: 25px; font-weight: 600; }
.d-label { font-size: 20px; font-weight: 600; }
.d-copy { font-size: 19px; }
.d-small { font-size: 18px; fill: var(--d-muted); }
.d-cut { font-size: 20px; font-family: ui-monospace, Menlo, Consolas, monospace; }
`;
const svg = (stem, height, title, description, body) => `<svg xmlns="http://www.w3.org/2000/svg" class="chrono-diagram" width="1040" height="${height}" viewBox="0 0 1040 ${height}" role="img" aria-labelledby="${stem}-title ${stem}-desc">
<title id="${stem}-title">${esc(title)}</title>
<desc id="${stem}-desc">${esc('Approved implementation baseline; implementation in progress. ' + description)}</desc>
<style>${styles}</style>
<defs><marker id="${stem}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" class="d-arrow"/></marker></defs>
${rect(0, 0, 1040, height, 'd-bg')}
${text(28, 40, title, 'd-title')}
${text(28, 70, 'Approved baseline. Implementation in progress.', 'd-small')}
${body}
</svg>
`;

const diagrams = new Map();
{
  const s = 'intervals';
  const body = [
    box(28, 104, 248, 90, 'Session 1', ['Originals']),
    arrow(s, 'M276 149 H328'),
    box(328, 104, 176, 90, 'Compaction'),
    arrow(s, 'M504 149 H558'),
    box(558, 104, 454, 90, 'Session 2 originals', ['Current raw interval: [S,E)']),
    box(28, 222, 984, 62, 'No Session 1 / old packet input to Session 2 helpers'),
    text(56, 325, 'Session 2 restart renderings: one partition, no gap or overlap', 'd-small'),
    text(56, 361, 'S', 'd-cut'), text(348, 361, 'H', 'd-cut'), text(744, 361, 'R', 'd-cut'), text(972, 361, 'E', 'd-cut'),
    box(56, 380, 292, 106, 'A: active synopsis', ['[S,H)'], 'd-a'),
    box(348, 380, 396, 106, 'B: compressed history', ['[H,R)'], 'd-b'),
    box(744, 380, 244, 106, 'C: exact tail', ['[R,E)'], 'd-c'),
    box(56, 536, 310, 90, 'ORIGINAL A + B + C', ['Raw [S,E)']),
    arrow(s, 'M366 581 H430', true),
    box(430, 536, 558, 90, 'Independent optional archive', ['Not the three derived restart renderings']),
    text(56, 664, 'Archive work does not block compaction.', 'd-small'),
  ].join('\n');
  diagrams.set(s, svg(s, 694, 'Current-interval source boundaries', 'Session 1 originals lead to compaction, then Session 2 originals S through E. Session 2 helpers receive no Session 1 originals or old restart packet. Session 2 is partitioned into A=[S,H), active synopsis; B=[H,R), compressed history; C=[R,E), exact tail. An independent optional archive takes the original A+B+C, raw [S,E), not the derived synopsis, history, and tail renderings.', body));
}
{
  const s = 'restart-packet';
  const rows = [
    ['01  Normal request context', ['System, tools, and applicable instructions'], 'd-box'],
    ['02  Current-agent task handoff', ['Written by the current conversational agent'], 'd-box'],
    ['03  A: active synopsis', ['[S,H)'], 'd-a'],
    ['04  B: compressed history', ['[H,R)'], 'd-b'],
    ['05  C: small exact tail', ['[R,E)'], 'd-c'],
    ['06  Current-agent continuation message', ['Same current response as the handoff'], 'd-box'],
  ];
  const body = [rect(28, 94, 984, 676, 'd-outline')];
  rows.forEach(([title, detail, cls], i) => {
    const y = 116 + i * 108;
    body.push(box(60, y, 920, 84, title, detail, cls));
    if (i < rows.length - 1) body.push(arrow(s, `M520 ${y + 84} V${y + 108}`));
  });
  body.push(arrow(s, 'M520 740 V802'));
  body.push(box(60, 802, 920, 84, '07  New authorized work', ['The packet does not create permission to continue']));
  diagrams.set(s, svg(s, 914, 'Restart packet and continuation order', 'The proposed request order is normal system, tools, and applicable instructions; current-agent task handoff; A synopsis; B compressed history; C small exact tail; current-agent continuation message; then new authorized work. The main conversational agent writes handoff and continuation in one current response. Derived context does not grant new authority.', body.join('\n')));
}
{
  const s = 'cuts';
  const body = [
    box(28, 110, 470, 180, 'Code chooses cuts', ['Token fit for the full packet', 'Complete tool-call/result units', 'Never split a call from its result']),
    box(548, 110, 464, 180, 'Context Kit hint, current interval', ['Successful milestone completed', 'then next milestone started', 'may suggest H']),
    arrow(s, 'M548 200 H498'),
    box(548, 318, 464, 106, 'Checkpoint: saved position only', ['Weak boundary hint, not completion']),
    text(28, 351, 'Code validates any hint', 'd-small'),
    text(56, 461, 'S', 'd-cut'), text(348, 461, 'H', 'd-cut'), text(744, 461, 'R', 'd-cut'), text(972, 461, 'E', 'd-cut'),
    box(56, 480, 292, 88, 'A: [S,H)', [], 'd-a'),
    box(348, 480, 396, 88, 'B: [H,R)', [], 'd-b'),
    box(744, 480, 244, 88, 'C: [R,E)', [], 'd-c'),
    text(56, 612, 'S ≤ H ≤ R ≤ E. H must be ≤ R. No gap. No overlap.', 'd-cut'),
  ].join('\n');
  diagrams.set(s, svg(s, 646, 'Deterministic cuts with an optional milestone hint', 'Code owns token fit and complete tool-call/result units. A successful current-interval Context Kit milestone-completed/next-milestone-started transition can suggest H. Other typed transitions or weaker position hints can also suggest candidates. A checkpoint is saved position, a weak boundary hint, not completion. Code validates S ≤ H ≤ R ≤ E, with no gap or overlap. The hint never overrides token fit or complete call/result units.', body));
}
{
  const s = 'precompute';
  const body = [
    box(28, 110, 324, 110, 'Pin closed prefix early', ['Exact range [S,H)']),
    arrow(s, 'M352 165 H414'),
    box(414, 110, 598, 110, 'Summarize ORIGINAL A=[S,H)', ['The pinned source range does not grow']),
    arrow(s, 'M190 220 V258'),
    box(28, 258, 984, 88, 'Meanwhile: main work appends after H', ['New original work stays outside the pinned prefix']),
    arrow(s, 'M1012 165 H1024 V360 H713 V372'),
    box(28, 372, 984, 118, 'Final validation', ['Source, branch, projection, model, policy, and cut', 'The candidate must still cover the same original [S,H)']),
    arrow(s, 'M300 490 V534'), arrow(s, 'M747 490 V534'),
    box(28, 534, 464, 88, 'Accept same-range summary', ['Only if the final identity matches']),
    box(548, 534, 464, 88, 'Otherwise replace or degrade', ['Use finite recovery']),
    box(28, 656, 984, 62, 'Never merge old summary + new delta to advance H'),
  ].join('\n');
  diagrams.set(s, svg(s, 748, 'Closed-prefix precompute without summary accumulation', 'Pin a closed original prefix [S,H) early. Summarize original A while main work appends after H. At final assembly, validate source, branch, projection, model, policy, and cut. Accept the same-range summary if it still matches, or replace/degrade. Never merge an old summary and a new delta to advance H.', body));
}
{
  const s = 'parallel';
  const body = [
    text(196, 113, 'Before final E', 'd-label'), text(570, 113, 'After E freeze', 'd-label'),
    vertical(548, 126, 590, true), text(511, 625, 'E freeze', 'd-small'),
    text(28, 180, ['Main', 'work'], 'd-label'),
    box(196, 146, 318, 100, 'Append originals', ['Authorized main work']),
    arrow(s, 'M514 196 H578'),
    box(578, 146, 264, 100, 'Main-agent handoff', ['+ continuation']),
    text(28, 310, ['Optional', 'event lane'], 'd-label'),
    box(196, 276, 318, 100, 'Event reduction', ['Can overlap main work']),
    arrow(s, 'M514 326 H578', true),
    box(578, 276, 264, 100, 'History/tail', ['Assembly']),
    text(28, 440, ['Closed-prefix', 'synopsis'], 'd-label'),
    box(196, 406, 318, 100, 'Original [S,H)', ['Synopsis precompute']),
    arrow(s, 'M514 456 H578'),
    box(578, 406, 264, 100, 'Accept or replace', ['Validated synopsis']),
    arrow(s, 'M842 196 H878 V326 H896'),
    arrow(s, 'M842 326 H896'),
    arrow(s, 'M842 456 H878 V326 H896'),
    box(896, 266, 116, 122, ['Validate', '+ commit']),
    text(196, 555, 'Handoff/continuation and history/tail assembly can overlap.', 'd-small'),
    text(196, 582, 'Final validation joins the required products.', 'd-small'),
    rule(28, 657, 1012, 657, true),
    text(196, 684, 'After final E; independent source flow', 'd-small'),
    text(28, 742, ['Optional', 'archive'], 'd-label'),
    box(196, 704, 318, 104, 'ORIGINAL raw [S,E)', ['Queued after the final E cut']),
    arrow(s, 'M514 756 H578', true),
    box(578, 704, 434, 104, 'Independent archive summary', ['Outside the compaction critical path']),
  ].join('\n');
  diagrams.set(s, svg(s, 844, 'Parallel work lanes and the required final join', 'Main work, optional event reduction, and closed-prefix synopsis precompute can overlap before final E. At E freeze, main-agent handoff plus continuation and history/tail assembly can overlap. Final validation and commit join the required products, using an accepted or replacement synopsis. Optional archive work is queued from original raw [S,E), outside the compaction critical path, and is not a commit input.', body));
}
{
  const s = 'commit';
  const body = [
    box(28, 132, 190, 108, 'Prepared', ['Old context kept']),
    arrow(s, 'M218 186 H282'),
    box(282, 132, 190, 108, 'Validated', ['Identity + fit']),
    arrow(s, 'M472 186 H536'),
    box(536, 132, 190, 108, 'Committed', ['Correlated commit']),
    arrow(s, 'M726 186 H790'),
    box(790, 132, 222, 108, ['Authorized', 'continuation']),
    arrow(s, 'M123 240 V352'), arrow(s, 'M377 240 V352'),
    box(28, 352, 464, 112, 'Stale / canceled / failed', ['Before commit: preserve old context']),
    arrow(s, 'M492 408 H548'),
    box(548, 352, 464, 112, 'Finite degraded recovery', ['No automatic rewind', 'No unbounded retry']),
    box(28, 516, 984, 90, 'Independent optional archive', ['Does not gate any state transition or continuation']),
  ].join('\n');
  diagrams.set(s, svg(s, 636, 'Validated commit with bounded failure recovery', 'The proposed states are prepared, validated, committed, and authorized continuation. Stale, canceled, or failed work before commit preserves old context. Degraded recovery is finite, with no automatic rewind and no unbounded retry. The optional archive does not gate any arrow.', body));
}

for (const [name, body] of diagrams) {
  const path = `${root}${name}.svg`;
  await writeFile(path, body, { mode: 0o644 });
  await chmod(path, 0o644);
  console.log(`${name}.svg ${Buffer.byteLength(body)} bytes`);
}
