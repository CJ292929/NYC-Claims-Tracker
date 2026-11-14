/**
 * server/claimUpload.pdfOpen.test.ts — P4-P30
 *
 * POST /api/claims/upload-extract, over real HTTP, for the failure that
 * reported 25/25 PDFs as "This PDF could not be opened":
 *   - a mixed batch sent at once (fillable form, damaged file, scan) gets one
 *     independent answer per file;
 *   - each failure says what actually failed (server reader, password,
 *     damaged file) instead of the blanket message;
 *   - a fillable form keeps patients apart and keeps repeated CPT lines as
 *     separate lines, with no money and no AI;
 *   - a retried file comes back with the same identity and line keys, so the
 *     idempotent save cannot duplicate patients or lines.
 */
import express from "express";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./aiClaimExtractor", () => ({
  extractClaimsWithAI: vi.fn(async () => ({ claims: [], confidence: 1 })),
  detectInsuranceType: vi.fn(),
  KNOWN_INSURER_NAMES: [],
  reconcileClaimStatusWithPaymentEvidence: vi.fn(),
}));
vi.mock("child_process", async orig => ({ ...(await orig<typeof import("child_process")>()), execSync: vi.fn(() => { throw new Error("pdftotext not installed"); }) }));
vi.mock("./cms1500Vision", async orig => ({ ...(await orig<typeof import("./cms1500Vision")>()), extractCms1500PagesWithVision: vi.fn() }));
vi.mock("./pdfjs", async orig => {
  const real = await orig<typeof import("./pdfjs")>();
  return { ...real, openPdf: vi.fn(real.openPdf) };
});

import { sdk } from "./_core/sdk";
import { invokeLLM } from "./_core/llm";
import { extractCms1500PagesWithVision } from "./cms1500Vision";
import { openPdf } from "./pdfjs";
import { registerClaimUploadRoute } from "./claimUpload";
import { formHeader, formRow, syntheticFormPdf } from "./fixtures/cms1500FormPdfSynthetic";
import { syntheticScannedPages } from "./fixtures/cms1500ScannedSynthetic";

const visionMock = vi.mocked(extractCms1500PagesWithVision);
const openMock = vi.mocked(openPdf);

function blankPdf(pages: number): Buffer {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Two patients on two pages; the first has the same CPT twice on one day. */
const formPdf = () => syntheticFormPdf([
  {
    ...formHeader("SYNTH, ALPHA", "A1"),
    ...formRow(1, { date: ["03", "02", "26"], cpt: "97110", mods: ["GP"], units: "1" }),
    ...formRow(2, { date: ["03", "02", "26"], cpt: "97110", mods: ["GP"], units: "1" }),
    ...formRow(3, { date: ["03", "02", "26"], cpt: "97140", mods: ["GP"] }),
  },
  { ...formHeader("SYNTH, BETA", "B1"), ...formRow(1, { date: ["03", "03", "26"], cpt: "97161" }) },
]);

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1, openId: "owner", name: "Owner", email: null, loginMethod: "google", role: "admin",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  } as any);
  const app = express();
  registerClaimUploadRoute(app);
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const a = server.address();
  baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

const post = (bytes: Buffer, name = "upload.pdf") => {
  const f = new FormData();
  f.append("uploadType", "cms1500");
  f.append("file", new Blob([bytes], { type: "application/pdf" }), name);
  return fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: f });
};

describe("mixed CMS1500 batch", () => {
  it("answers each file on its own, with the real reason for the one that fails", async () => {
    visionMock.mockResolvedValue({ pages: syntheticScannedPages(), missingPages: [], method: "rendered_pages" });
    const [form, damaged, scan] = await Promise.all([post(formPdf()), post(Buffer.from("%PDF-1.4 truncated")), post(blankPdf(3))]);

    expect(form.status).toBe(200);
    const doc = (await form.json()).importDocument;
    expect(doc.templateUsed ?? doc.extractionMethod).toMatch(/form fields/);
    expect(doc.groups.map((g: any) => g.lines.length).sort()).toEqual([1, 3]);
    const alpha = doc.groups.find((g: any) => g.lines.length === 3);
    expect(alpha.lines.filter((l: any) => l.cptCodes === "97110")).toHaveLength(2);
    expect(new Set(alpha.lines.map((l: any) => l.sourceLineKey)).size).toBe(3);
    for (const l of doc.groups.flatMap((g: any) => g.lines)) {
      expect(l).not.toHaveProperty("insuranceReimbursement");
      expect(l).not.toHaveProperty("chargeAmount");
    }

    expect(damaged.status).toBe(422);
    const bad = await damaged.json();
    expect(bad.code).toBe("pdf_invalid");
    expect(bad.error).toMatch(/damaged or is not a PDF/);

    expect(scan.status).toBe(200);
    expect((await scan.json()).importDocument.groups[0].lines).toHaveLength(16);

    // The fillable form needed no AI; only the scan went to page vision.
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeLLM)).not.toHaveBeenCalled();
  }, 30000);

  it("returns the same document identity and line keys on retry", async () => {
    const first = (await (await post(formPdf(), "first-name.pdf")).json()).importDocument;
    const retry = (await (await post(formPdf(), "renamed.pdf")).json()).importDocument;
    expect(retry.sha256).toBe(first.sha256);
    const keys = (d: any) => d.groups.flatMap((g: any) => g.lines.map((l: any) => `${g.groupKey}|${l.sourceLineKey}`)).sort();
    expect(keys(retry)).toEqual(keys(first));
  }, 30000);
});

describe("failures are reported as what they are", () => {
  it("a PDF reader that did not start is a 503 server problem, not an unreadable file", async () => {
    openMock.mockResolvedValueOnce({ ok: false, failure: { kind: "reader_unavailable", detail: "ReferenceError: DOMMatrix is not defined" } });
    const res = await post(formPdf());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("pdf_reader_unavailable");
    expect(body.error).toMatch(/server problem, not a problem with the file/);
    expect(body.error).not.toMatch(/could not be opened/);
    expect(visionMock).not.toHaveBeenCalled();
  });

  it("a password-protected PDF says so", async () => {
    openMock.mockResolvedValueOnce({ ok: false, failure: { kind: "password", detail: "PasswordException: No password given" } });
    const res = await post(formPdf());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/password-protected/);
  });
});
