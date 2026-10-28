/**
 * Models write TeX as `\(…\)` and `\[…\]`, which Markdown reads as escaped
 * parentheses and brackets. Rewrite them to remark-math's `$$` delimiters
 * (inline `$$…$$`; a `$$` block when `\[` and `\]` stand on their own lines),
 * leaving fenced code blocks and inline code spans alone. Single `$` is not
 * math, so prices stay text. Unmatched delimiters are left as they are.
 */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\(") && !text.includes("\\[")) return text;
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (prose.length) out.push(rewriteProse(prose.join("\n")));
    prose = [];
  };
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = null;
    } else if (marker) {
      flush();
      fence = { char: marker[0]!, length: marker.length };
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

const CODE_SPAN = /(`+)[\s\S]*?(?<!`)\1(?!`)/g;
/** Display math whose delimiters stand on their own lines, keeping the line's indent (lists, quotes). */
const DISPLAY_BLOCK = /^([ \t>]*)\\\[[ \t]*\n([\s\S]+?)\n[ \t>]*\\\][ \t]*$/gm;
const DISPLAY_LINE = /^([ \t>]*)\\\[(.+?)\\\][ \t]*$/gm;
const DISPLAY_INLINE = /(?<!\\)\\\[((?:(?!\n\s*\n)[\s\S])+?)(?<!\\)\\\]/g;
const INLINE = /(?<!\\)\\\(((?:(?!\n\s*\n)[\s\S])+?)(?<!\\)\\\)/g;

function rewriteProse(text: string): string {
  // Code spans are cut out first and put back unchanged.
  const spans: string[] = [];
  const masked = text.replace(CODE_SPAN, (span) => `\u0000${spans.push(span) - 1}\u0000`);
  const inline = (body: string, match: string) => (body.includes("$$") || !body.trim() ? match : `$$${body.trim()}$$`);
  const rewritten = masked
    .replace(DISPLAY_BLOCK, (match, indent: string, body: string) => (body.includes("$$") ? match : `${indent}$$\n${body}\n${indent}$$`))
    .replace(DISPLAY_LINE, (match, indent: string, body: string) => (body.includes("$$") || !body.trim() ? match : `${indent}$$\n${indent}${body.trim()}\n${indent}$$`))
    .replace(DISPLAY_INLINE, (match, body: string) => inline(body, match))
    .replace(INLINE, (match, body: string) => inline(body, match));
  return rewritten.replace(/\u0000(\d+)\u0000/g, (_, index: string) => spans[Number(index)]!);
}
