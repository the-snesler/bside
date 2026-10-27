/**
 * Builds a small, valid PDF: one page per entry, each line drawn in
 * Helvetica, with a correct cross-reference table, so pdf.js reads it as a
 * real file. Text must be plain ASCII, and fit on the page: pdf.js skips
 * glyphs outside it (a smaller `fontSize` fits more).
 */
export function makePdf(pages: string[][], options: { title?: string; fontSize?: number } = {}): Uint8Array {
  const size = options.fontSize ?? 12;
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((lines, index) => {
    const escape = (line: string) => line.replace(/[\\()]/g, (char) => `\\${char}`);
    const stream = `BT /F1 ${size} Tf 10 780 Td ${size * 1.2} TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`;
    objects[pageIds[index]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`;
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  const infoId = objects.length;
  if (options.title) objects[infoId] = `<< /Title (${options.title}) >>`;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R${options.title ? ` /Info ${infoId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
