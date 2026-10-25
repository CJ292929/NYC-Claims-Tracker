/**
 * server/claimUpload.cms1500Import.test.ts — P4-P24
 *
 * POST /api/claims/upload-extract for CMS1500 uploads, over real HTTP:
 *   - text-layer PDFs keep the regex template path and come back as an
 *     importDocument with stable source keys, no money, no visit number;
 *   - an image-only PDF (a real, generated 3-page PDF with no text layer)
 *     goes to the page-aware vision reader with the TRUE page count, and
 *     every page's lines come back assembled;
 *   - a page the reader never returns is reported, and a provider failure
 *     is a controlled error, never an empty success.
 *
 * The AI provider is mocked (extractCms1500PagesWithVision) — validation
 * against the real supplied scan through the configured provider was done
 * separately and is reported in the PR, with no patient data committed.
 */
import express from "express";
import type { Server } from "http";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./aiClaimExtractor", () => ({
  extractClaimsWithAI: vi.fn(async () => ({ claims: [], confidence: 1 })),
  detectInsuranceType: vi.fn(),
  KNOWN_INSURER_NAMES: [],
  reconcileClaimStatusWithPaymentEvidence: vi.fn(),
}));
vi.mock("./insuranceTemplates", () => ({ tryTemplateExtraction: vi.fn(), parseCMS1500: vi.fn(), PatientBoundaryError: class extends Error {} }));
vi.mock("child_process", async orig => ({ ...(await orig<typeof import("child_process")>()), execSync: vi.fn() }));
vi.mock("./cms1500Vision", async orig => ({ ...(await orig<typeof import("./cms1500Vision")>()), extractCms1500PagesWithVision: vi.fn() }));

import { execSync } from "child_process";
import { sdk } from "./_core/sdk";
import { parseCMS1500 } from "./insuranceTemplates";
import { extractCms1500PagesWithVision } from "./cms1500Vision";
import { registerClaimUploadRoute } from "./claimUpload";
import { syntheticScannedPages } from "./fixtures/cms1500ScannedSynthetic";

const execSyncMock = vi.mocked(execSync);
const parseMock = vi.mocked(parseCMS1500);
const visionMock = vi.mocked(extractCms1500PagesWithVision);

/** A real, parseable PDF with `pages` blank pages and no text layer. */
function blankPdf(pages: number): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) objs.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

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

function form(bytes: Buffer, name = "synthetic.pdf"): FormData {
  const f = new FormData();
  f.append("uploadType", "cms1500");
  f.append("file", new Blob([bytes], { type: "application/pdf" }), name);
  return f;
}

describe("text-layer CMS1500", () => {
  it("returns an importDocument with source keys, no money, no visit number", async () => {
    execSyncMock.mockReturnValue(Buffer.from("HEALTH INSURANCE CLAIM FORM ".repeat(5)) as any);
    parseMock.mockReturnValue([{
      patientName: "TESTPATIENT, ALEX",
      claims: [{
        dateOfService: "2026-03-02", placeOfService: "12", visitNumber: null, claimSubmittedDate: "2026-03-16",
        cptCodes: "97110", chargeAmount: 175, insuranceReimbursement: null, patientAmountPaid: null, patientAmountDue: null,
        unitsBilled: 1, modifier: "GP", diagnosisCodes: "M54.50",
        cptLines: [
          { cptCodes: "97110", chargeAmount: 175, insuranceReimbursement: null, patientAmountPaid: null, patientAmountDue: null, unitsBilled: 1, modifier: "GP", diagnosisCodes: "M54.50" },
          { cptCodes: "97110", chargeAmount: 175, insuranceReimbursement: null, patientAmountPaid: null, patientAmountDue: null, unitsBilled: 1, modifier: "GP", diagnosisCodes: null },
        ],
      } as any],
    }]);
    const bytes = Buffer.from("%PDF-1.4 synthetic text-layer stand-in");
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: form(bytes) });
    expect(res.status).toBe(200);
    const body = await res.json();
    const doc = body.importDocument;
    expect(doc).toMatchObject({ kind: "cms1500", sha256: createHash("sha256").update(bytes).digest("hex"), extractionMethod: "CMS1500 template (text layer)" });
    expect(doc.groups).toHaveLength(1);
    const [a, b] = doc.groups[0].lines;
    expect(a.sourceLineKey).not.toBe(b.sourceLineKey);
    for (const l of doc.groups[0].lines) {
      expect(l).not.toHaveProperty("visitNumber");
      expect(l).not.toHaveProperty("insuranceReimbursement");
      expect(l).not.toHaveProperty("chargeAmount");
    }
    expect(doc.groups[0].warnings.join(" ")).toMatch(/1 line\(s\) have no diagnosis codes/);
    expect(visionMock).not.toHaveBeenCalled();
  }, 20000);
});

describe("scanned / image-only CMS1500", () => {
  beforeEach(() => {
    execSyncMock.mockImplementation(() => { throw new Error("pdftotext not installed"); });
  });

  it("reads all three pages through the vision reader and assembles 16 lines", async () => {
    visionMock.mockResolvedValue({ pages: syntheticScannedPages(), missingPages: [], method: "rendered_pages" });
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: form(blankPdf(3)) });
    expect(res.status).toBe(200);
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(visionMock.mock.calls[0][2]).toBe(3);
    expect(parseMock).not.toHaveBeenCalled();
    const doc = (await res.json()).importDocument;
    expect(doc.pageCount).toBe(3);
    expect(doc.extractionMethod).toBe("CMS1500 page vision, each page read twice (3/3 pages read)");
    expect(doc.groups).toHaveLength(1);
    expect(doc.groups[0].pages).toEqual([1, 2, 3]);
    expect(doc.groups[0].lines).toHaveLength(16);
    expect(doc.warnings).toEqual([]);
  }, 20000);

  it("reports a page the reader did not return instead of a clean success", async () => {
    visionMock.mockResolvedValue({ pages: syntheticScannedPages().slice(0, 2), missingPages: [3], method: "rendered_pages" });
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: form(blankPdf(3)) });
    const doc = (await res.json()).importDocument;
    expect(doc.extractionMethod).toBe("CMS1500 page vision, each page read twice (2/3 pages read)");
    expect(doc.warnings[0]).toMatch(/Page\(s\) 3 of 3 could not be read/);
    expect(doc.groups[0].lines).toHaveLength(12);
  }, 20000);

  it("turns a provider failure into a controlled 502 with nothing to save", async () => {
    visionMock.mockRejectedValue(new Error("provider down"));
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: form(blankPdf(3)) });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.importDocument).toBeUndefined();
    expect(body.error).toMatch(/Nothing was saved/);
  }, 20000);

  it("rejects an unreadable PDF before calling the provider", async () => {
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: form(Buffer.from("not a pdf")) });
    expect(res.status).toBe(422);
    expect(visionMock).not.toHaveBeenCalled();
  }, 20000);
});
