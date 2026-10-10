import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Use existing local dependencies or an explicit module path. No installs or requests.
const root = dirname(fileURLToPath(import.meta.url));
const cliArgs = process.argv.slice(2);
function rendererModule() {
  const index = cliArgs.indexOf('--marked-module');
  if (index >= 0) {
    const value = cliArgs[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Supply a module file after --marked-module');
    return resolve(value);
  }
  try {
    const piEntry = import.meta.resolve('@earendil-works/pi-coding-agent');
    return createRequire(piEntry).resolve('marked');
  } catch {
    try { return createRequire(import.meta.url).resolve('marked'); }
    catch { throw new Error('No local marked renderer found. Use existing checkout dependencies or --marked-module <module-file>. This script installs nothing.'); }
  }
}
function versionOfMarked(modulePath) {
  let directory = dirname(modulePath);
  for (;;) {
    const manifest = resolve(directory, 'package.json');
    if (existsSync(manifest)) {
      const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
      if (metadata.name === 'marked') return metadata.version;
    }
    const parent = dirname(directory);
    if (parent === directory) return 'unknown';
    directory = parent;
  }
}
const rendererPath = rendererModule();
const { Marked, Renderer } = await import(pathToFileURL(rendererPath));
if (typeof Marked !== 'function' || typeof Renderer !== 'function') throw new Error('The selected module must export Marked and Renderer');
const rendererVersion = versionOfMarked(rendererPath);
const sourcePath = resolve(root, 'reference.md');
const outputPath = resolve(root, 'reference.html');
const names = ['intervals', 'restart-packet', 'cuts', 'precompute', 'parallel', 'commit'];
const hash = data => createHash('sha256').update(data).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const decodeText = value => String(value).replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (all, num, name) => {
  if (num) return String.fromCodePoint(num[0].toLowerCase() === 'x' ? parseInt(num.slice(1), 16) : parseInt(num, 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()];
});
const plainInline = (renderer, tokens) => decodeText(renderer.parser.parseInline(tokens, renderer.parser.textRenderer).replace(/<[^>]*>/g, ''));

function inlineSvg(name, occurrence) {
  let body = readFileSync(resolve(root, 'assets', `${name}.svg`), 'utf8').trim();
  if (!body.startsWith('<svg ') || !/role="img"/.test(body) || !/<title\b/.test(body) || !/<desc\b/.test(body)) {
    throw new Error(`Missing accessible SVG structure: ${name}`);
  }
  if (/<(?:script|foreignObject|image)\b|\son\w+\s*=|(?:href|src)="(?!#)/i.test(body)) {
    throw new Error(`Active or external SVG content is not permitted: ${name}`);
  }
  const prefix = `diagram-${occurrence}-${name}-`;
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ids) {
    body = body.replaceAll(`id="${id}"`, `id="${prefix}${id}"`)
      .replaceAll(`url(#${id})`, `url(#${prefix}${id})`)
      .replaceAll(`href="#${id}"`, `href="#${prefix}${id}"`);
  }
  body = body.replace(/aria-(labelledby|describedby)="([^"]+)"/g, (_, attr, value) => `aria-${attr}="${value.split(/\s+/).map(id => prefix + id).join(' ')}"`);
  return body.replace('<svg ', `<svg data-diagram="${name}" `);
}

export function renderReference(markdown, sourceHash = hash(markdown)) {
  const headings = [];
  const usedIds = new Set(['top', 'main-content', 'reference-prose']);
  const imageCounts = Object.fromEntries(names.map(name => [name, 0]));
  let figureCount = 0;
  let tableCount = 0;
  let section = 'Reference';
  const marked = new Marked({ gfm: true, breaks: false, async: false });
  const counts = { headings: 0, tables: 0, codeBlocks: 0, images: 0 };
  marked.walkTokens(marked.lexer(markdown), token => {
    if (token.type === 'heading') counts.headings++;
    if (token.type === 'table') counts.tables++;
    if (token.type === 'code') counts.codeBlocks++;
    if (token.type === 'image') counts.images++;
  });
  function imageName(href) {
    const match = /^assets\/([a-z-]+)\.svg$/.exec(href);
    if (!match || !names.includes(match[1])) throw new Error(`Unexpected image reference: ${href}`);
    return match[1];
  }
  marked.use({
    renderer: {
      heading(token) {
        const title = plainInline(this, token.tokens);
        const base = title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[\s_]+/g, '-') || 'section';
        let id = base;
        let suffix = 2;
        while (usedIds.has(id)) id = `${base}-${suffix++}`;
        usedIds.add(id);
        headings.push({ depth: token.depth, title, id });
        if (token.depth <= 3) section = title;
        return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      image(token) {
        const name = imageName(token.href);
        figureCount++;
        imageCounts[name]++;
        return inlineSvg(name, figureCount);
      },
      paragraph(token) {
        const meaningful = token.tokens.filter(item => item.type !== 'text' || item.text.trim() !== '');
        if (meaningful.length === 1 && meaningful[0].type === 'image') {
          const image = meaningful[0];
          const caption = plainInline(this, image.tokens || [{ type: 'text', raw: image.text, text: image.text }]);
          const svg = this.image(image);
          const number = figureCount;
          return `<figure class="figure" id="figure-${number}">\n<div class="figure-canvas" tabindex="0" role="group" aria-label="${escapeHtml(`Diagram ${number}: ${caption}`)}">${svg}</div>\n<figcaption>${escapeHtml(caption)}</figcaption>\n</figure>\n`;
        }
        return Renderer.prototype.paragraph.call(this, token);
      },
      table(token) {
        tableCount++;
        const label = `Table ${tableCount}: ${section}`;
        const captionId = `table-${tableCount}-caption`;
        const table = Renderer.prototype.table.call(this, token).replace('<table>', `<table>\n<caption id="${captionId}" class="sr-only">${escapeHtml(label)}</caption>`);
        return `<div class="table-scroll" tabindex="0" role="region" aria-labelledby="${captionId}">${table}</div>\n`;
      },
      tablecell(token) {
        const tag = token.header ? 'th' : 'td';
        const scope = token.header ? ' scope="col"' : '';
        const alignment = token.align ? ` style="text-align:${token.align}"` : '';
        return `<${tag}${scope}${alignment}>${this.parser.parseInline(token.tokens)}</${tag}>\n`;
      },
    },
  });
  const body = marked.parse(markdown);
  if (headings.length !== counts.headings || tableCount !== counts.tables || figureCount !== counts.images) {
    throw new Error('Renderer/token parity check failed');
  }
  for (const name of names) if (imageCounts[name] !== 1) throw new Error(`Expected one embed of required diagram: ${name}`);
  const toc = headings.filter(heading => heading.depth > 1).map(({ depth, title, id }) => `<li><a href="#${escapeHtml(id)}" style="--level:${depth - 2}">${escapeHtml(title)}</a></li>`).join('\n');
  const css = readFileSync(resolve(root, 'reference.css'), 'utf8');
  if (/<\/style/i.test(css) || /@import|url\(/i.test(css)) throw new Error('The reference CSS must be inline and dependency-free');
  const title = headings.find(heading => heading.depth === 1)?.title || 'Chrono compaction reference';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none'; connect-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'">
<meta name="description" content="Approved Chrono compaction implementation baseline. Implementation is in progress. Maintained repository reference, not official upstream Pi documentation.">
<title>${escapeHtml(title)} · Approved implementation baseline</title>
<style>${css}</style>
</head>
<body id="top">
<a class="skip-link" href="#main-content">Skip to reference</a>
<header class="site-header"><div class="header-inner"><a class="document-label" href="#top">Chrono / Compaction reference</a><span class="draft-chip">Approved baseline / Implementation in progress</span></div></header>
<div class="layout">
<nav class="section-nav" aria-label="Reference sections"><details open><summary>On this page</summary><ol>${toc}</ol></details></nav>
<main class="reading-column" id="main-content" tabindex="-1">
<div class="review-notice"><strong>Approved implementation baseline; implementation in progress.</strong><br>This maintained Chrono reference defines intended behavior. It does not attest a completed or activated runtime and is not official upstream Pi documentation.</div>
<article class="prose" id="reference-prose">${body}</article>
<footer class="document-footer">Canonical content source: <a href="reference.md"><code>reference.md</code></a>.<br>Markdown SHA256: <code>${sourceHash}</code>.<br>Offline presentation. All diagrams and styles are embedded. Reference links open only when selected.</footer>
</main>
</div>
</body>
</html>
`;
  if (/<(?:script|link|iframe|object|embed|img)\b/i.test(html)) throw new Error('External or active HTML resource found');
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const idSet = new Set(htmlIds);
  if (idSet.size !== htmlIds.length) throw new Error('Duplicate HTML/SVG ID');
  for (const [, encoded] of html.matchAll(/href="#([^"]+)"/g)) {
    if (!idSet.has(decodeURIComponent(decodeText(encoded)))) throw new Error(`Unresolved local anchor: ${encoded}`);
  }
  for (const [, value] of html.matchAll(/aria-(?:labelledby|describedby)="([^"]+)"/g)) {
    for (const id of value.split(/\s+/)) if (!idSet.has(id)) throw new Error(`Unresolved accessible label: ${id}`);
  }
  const sourceMainSections = headings.filter(heading => heading.depth === 2).length;
  const wordCount = markdown.trim().split(/\s+/u).length;
  return {
    html,
    body,
    baseline: new Marked({ gfm: true, breaks: false, async: false }).parse(markdown),
    stats: { ...counts, mainSections: sourceMainSections, wordCount, imageCounts, headingIds: headings.map(heading => heading.id), renderer: `marked ${rendererVersion}`, markdownSha256: sourceHash, htmlSha256: hash(html), htmlBytes: Buffer.byteLength(html) },
  };
}

function expectedHash(args) {
  const index = args.indexOf('--source-sha256');
  if (index < 0 || !/^[a-f\d]{64}$/.test(args[index + 1] || '')) throw new Error('Supply --source-sha256 with the reviewed Markdown hash');
  return args[index + 1];
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) {
    const sample = '# Renderer check\n\n## Coverage\n\nA paragraph with **bold** and `code`.\n\n| Left | Right |\n| :--- | ---: |\n| one | two |\n\n```text\n<exact> & source\n```\n\n' + names.map(name => `![${name}](assets/${name}.svg)`).join('\n\n') + '\n\n## Coverage\n\n[First section](#coverage).\n';
    const rendered = renderReference(sample);
    if (rendered.stats.headingIds.join(',') !== 'renderer-check,coverage,coverage-2') throw new Error('Heading stability check failed');
    if (rendered.stats.codeBlocks !== 1 || rendered.stats.tables !== 1 || rendered.stats.images !== 6) throw new Error('Fixture count mismatch');
    console.log(JSON.stringify({ selfCheck: 'passed', ...rendered.stats }, null, 2));
  } else {
    const bytes = readFileSync(sourcePath);
    const sourceHash = hash(bytes);
    if (sourceHash !== expectedHash(args)) throw new Error('Markdown differs from the supplied source hash');
    const result = renderReference(bytes.toString('utf8'), sourceHash);
    if (!readFileSync(sourcePath).equals(bytes)) throw new Error('Markdown changed during rendering');
    if (args.includes('--parity-json')) {
      console.log(JSON.stringify({ baseline: result.baseline, article: result.body, stats: result.stats }));
    } else {
      const temporary = resolve(root, `.${basename(outputPath)}.${process.pid}.tmp`);
      writeFileSync(temporary, result.html, { mode: 0o644 });
      renameSync(temporary, outputPath);
      chmodSync(outputPath, 0o644);
      console.log(JSON.stringify({ output: basename(outputPath), ...result.stats }, null, 2));
    }
  }
}
