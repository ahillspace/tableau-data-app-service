/* Build-time Markdown rendering. No network or runtime rendering dependency. */
const fs = require('node:fs');
const path = require('node:path');
const { Marked } = require(process.env.REVIEW_MARKED || 'marked');
const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
const byPath = new Map(sources.map(s => [s.path, s]));
const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
const textOf = tokens => tokens.map(t => t.tokens ? textOf(t.tokens) : (t.text || '')).join('');
const repo = path.resolve(__dirname, '../..');
// Repository/tool/history references and files that sit beside the documents
// (diagram images and their sources) are visible in GitHub; the offline spec
// resolves current documents internally and labels these non-spec references.
// A Markdown document under docs/ must be listed in specification.json.
const allowedNonSpec = p => {
  const resolved = path.resolve(repo, p);
  return p === 'docs/specification.html' ||
    (resolved.startsWith(repo + path.sep) && fs.existsSync(resolved) && !(p.startsWith('docs/') && p.endsWith('.md')));
};
for (const source of sources) {
  if (!source.path.startsWith('docs/') || source.path.includes('..')) throw new Error('Only current docs sources may be embedded');
  source.headings = [];
  const counts = new Map();
  const md = new Marked({gfm:true, async:false});
  md.use({renderer: {
    heading(token) {
      const title = textOf(token.tokens);
      const base = slug(title);
      const count = counts.get(base) || 0;
      counts.set(base, count + 1);
      const anchor = base + (count ? '-' + count : '');
      const id = 'doc-' + source.id + '-' + anchor;
      source.headings.push({title, anchor, id, depth: token.depth});
      const depth = Math.min(token.depth + 1, 6);
      return `<h${depth} id="${escape(id)}">${this.parser.parseInline(token.tokens)}</h${depth}>\n`;
    },
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      const href = token.href || '';
      if (/^https?:\/\//.test(href)) return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error(`${source.path}: unsupported link protocol ${href}`);
      const [file, fragment=''] = href.split('#');
      const destPath = file ? path.posix.normalize(path.posix.join(path.posix.dirname(source.path), decodeURIComponent(file))) : source.path;
      const dest = byPath.get(destPath);
      if (!dest) {
        if (allowedNonSpec(destPath)) return `<span class="muted" title="Repository file, not part of this view: ${escape(destPath)}">${label}</span>`;
        throw new Error(`${source.path}: required document missing from specification.json: ${destPath}`);
      }
      return `<a href="#documents/${escape(dest.id)}${fragment ? '/' + escape(decodeURIComponent(fragment)) : ''}" data-source="${escape(dest.id)}" data-anchor="${escape(decodeURIComponent(fragment))}">${label}</a>`;
    },
    html(token) { return escape(token.text); },
    table(token) {
      const header = token.header.map(c => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
      const rows = token.rows.map(row => `<tr>${row.map(c => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
      return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
    }
  }});
  source.html = md.parse(source.content);
}
// Resolve every embedded document anchor after all headings are known.
for (const source of sources) {
  for (const match of source.html.matchAll(/data-source="([^"]+)" data-anchor="([^"]*)"/g)) {
    if (!match[2]) continue;
    const dest = sources.find(s => s.id === match[1]);
    if (!dest.headings.some(h => escape(h.anchor) === match[2])) throw new Error(`${source.path}: missing embedded anchor ${dest.path}#${match[2]}`);
  }
}
process.stdout.write(JSON.stringify(sources));
