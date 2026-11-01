/**
 * server/fixtures/cms1500FormPdfSynthetic.ts — P4-P28
 *
 * A real PDF shaped like a fillable CMS-1500: each page's text layer holds only
 * printed form labels, and every value sits in an AcroForm text field with the
 * NUCC field names. All values are invented.
 */
export type SyntheticFormPage = Record<string, string>;

const LABELS = "HEALTH INSURANCE CLAIM FORM APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE CARRIER PICA PATIENTS NAME DATE OF SERVICE";

function esc(s: string) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function syntheticFormPdf(pages: SyntheticFormPage[]): Buffer {
  const objs: string[] = [];
  const add = (body: string) => { objs.push(body); return objs.length; };
  // Reserve 1 catalog, 2 pages, 3 font.
  add(""); add(""); add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const pageIds: number[] = [];
  const fieldIds: number[] = [];
  for (const page of pages) {
    const stream = `BT /F1 10 Tf 40 760 Td (${LABELS}) Tj ET`;
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots: number[] = [];
    let y = 700;
    for (const [name, value] of Object.entries(page)) {
      const id = add(`<< /Type /Annot /Subtype /Widget /FT /Tx /T (${esc(name)}) /V (${esc(value)}) /Rect [40 ${y} 240 ${y + 10}] /F 4 >>`);
      annots.push(id);
      fieldIds.push(id);
      y -= 6;
    }
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R /Annots [${annots.map(a => `${a} 0 R`).join(" ")}] >>`));
  }
  objs[0] = `<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [${fieldIds.map(a => `${a} 0 R`).join(" ")}] /NeedAppearances true >> >>`;
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** One filled Box 24 row. */
export function formRow(n: number, r: { date: [string, string, string]; pos?: string; cpt: string; mods?: string[]; pointer?: string; charge?: string; units?: string }): SyntheticFormPage {
  const [mm, dd, yy] = r.date;
  return {
    [`sv${n}_mm_from`]: mm, [`sv${n}_dd_from`]: dd, [`sv${n}_yy_from`]: yy,
    [`sv${n}_mm_end`]: mm, [`sv${n}_dd_end`]: dd, [`sv${n}_yy_end`]: yy,
    [`place${n}`]: r.pos ?? "12",
    [`cpt${n}`]: r.cpt,
    ...(r.mods?.[0] ? { [`mod${n}`]: r.mods[0] } : {}),
    ...(r.mods?.[1] ? { [`mod${n}a`]: r.mods[1] } : {}),
    [`diag${n}`]: r.pointer ?? "A",
    [`ch${n}`]: r.charge ?? "175.00",
    [`day${n}`]: r.units ?? "1",
  };
}

export function formHeader(name: string, account: string, extra: SyntheticFormPage = {}): SyntheticFormPage {
  return {
    pt_name: name, birth_mm: "03", birth_dd: "14", birth_yy: "1950",
    insurance_id: "SYN123456", pt_account: account, ins_policy: "SYNGRP",
    physician_date: "03/01/2026", diagnosis1: "M54.50", diagnosis2: "M25.561",
    ...extra,
  };
}
