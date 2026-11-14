/**
 * server/pdfjs.test.ts — P4-P30
 *
 * The deployed function failed every PDF because pdfjs's canvas polyfill and
 * worker were not packaged (they are loaded by paths a file tracer cannot
 * follow), and every caller reported that as "This PDF could not be opened".
 * These tests pin the loader's traceable imports and the failure
 * classification that replaced the blanket message.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyPdfError, loadPdfjs, openPdf, pdfOpenFailureResponse, PdfReaderUnavailableError } from "./pdfjs";
import { formHeader, formRow, syntheticFormPdf } from "./fixtures/cms1500FormPdfSynthetic";

describe("loadPdfjs", () => {
  it("loads pdfjs with its worker and canvas polyfill registered globally", async () => {
    const pdfjs = await loadPdfjs();
    expect(typeof pdfjs.getDocument).toBe("function");
    const g = globalThis as Record<string, any>;
    expect(g.pdfjsWorker?.WorkerMessageHandler).toBeTruthy();
    expect(typeof g.DOMMatrix).toBe("function");
  });

  it("names the worker and canvas with literal imports, so the deploy tracer packages them", () => {
    const src = readFileSync(path.join(__dirname, "pdfjs.ts"), "utf8");
    expect(src).toContain('import("@napi-rs/canvas")');
    expect(src).toContain('import("pdfjs-dist/legacy/build/pdf.worker.mjs")');
  });

  it("is the only server module that imports pdfjs-dist directly", () => {
    const offenders = readdirSync(__dirname)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "pdfjs.ts")
      .filter(f => /import\(\s*["']pdfjs-dist/.test(readFileSync(path.join(__dirname, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("openPdf", () => {
  it("opens a fillable CMS1500 and reports its page count", async () => {
    const pdf = syntheticFormPdf([
      { ...formHeader("SYNTH, ALPHA", "A1"), ...formRow(1, { date: ["03", "02", "26"], cpt: "97110" }) },
      { ...formHeader("SYNTH, BETA", "B1"), ...formRow(1, { date: ["03", "03", "26"], cpt: "97140" }) },
    ]);
    expect(await openPdf(pdf)).toEqual({ ok: true, pageCount: 2 });
  });

  it("calls a non-PDF or damaged file invalid, not a server fault", async () => {
    for (const bytes of [Buffer.from("not a pdf at all"), Buffer.from("%PDF-1.4 truncated")]) {
      const r = await openPdf(bytes);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe("invalid");
    }
  });
});

describe("classifyPdfError", () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it("separates a reader that did not start from a bad file", () => {
    expect(classifyPdfError(new PdfReaderUnavailableError("canvas", new Error("x"))).kind).toBe("reader_unavailable");
    expect(classifyPdfError(new Error('Setting up fake worker failed: "Cannot find module \'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs\'"')).kind).toBe("reader_unavailable");
    expect(classifyPdfError(new ReferenceError("DOMMatrix is not defined")).kind).toBe("reader_unavailable");
    expect(classifyPdfError(named("PasswordException", "No password given")).kind).toBe("password");
    expect(classifyPdfError(named("InvalidPDFException", "Invalid PDF structure.")).kind).toBe("invalid");
    expect(classifyPdfError(named("UnknownErrorException", "something else")).kind).toBe("unreadable");
  });

  it("strips file-system paths from the logged detail", () => {
    const { detail } = classifyPdfError(new Error("Cannot find module '/var/task/node_modules/x/pdf.worker.mjs'"));
    expect(detail).not.toContain("/var/task");
    expect(detail).toContain("<path>");
  });

  it("gives each failure its own status and message", () => {
    const r = (kind: any) => pdfOpenFailureResponse({ kind, detail: "d" });
    expect(r("reader_unavailable").status).toBe(503);
    expect(r("reader_unavailable").error).toMatch(/server problem, not a problem with the file/);
    expect(r("password").error).toMatch(/password-protected/);
    expect(r("invalid").error).toMatch(/damaged or is not a PDF/);
    expect(r("unreadable").error).toMatch(/could not be read \(d\)/);
  });
});
