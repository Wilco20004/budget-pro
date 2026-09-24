// Order-confirmation emails lay receipts out as HTML tables. mailparser's own
// text version runs table cells together ("Airfryer 6LR 1499.99"), which
// loses the "name ... price" pairing the slip parser relies on. This keeps
// one table row per line with its cells spaced apart.

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…', zwnj: '' };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToLines(html: string): string {
  return decode(
    html
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(td|th)>/gi, '   ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(tr|p|div|li|h[1-6]|table|section|header|footer)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ​‌]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
