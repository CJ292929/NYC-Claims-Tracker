/**
 * server/claimUpload.pdfFirst.test.ts — P4-P27
 *
 * POST /api/claims/upload-extract for the PDF-first bulk uploads, over real
 * HTTP with real (synthetic, generated) PDFs:
 *   - a PDF mixing text pages and scanned (no text layer) pages is never
 *     sent through a text-only parser that would drop the scanned pages:
 *     CMS1500 goes to page vision for every page, EOB to AI document vision;
 *   - every fallback extraction method is flagged (extractionFallback) and
 *     the primary methods are not;
 *   - the legacy extractor's text cut-off is reported, never silent;
 *   - a multi-patient EOB comes back as one group per patient.
 *
 * The AI provider is mocked (extractCms1500PagesWithVision,
 * extractClaimsWithAI, invokeLLM): these tests prove routing and reporting,
 * not real OCR quality. No real patient data.
 */
import express from "express";
import type { Server } from "http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./_core/sdk", () => ({ sdk: { authenticateRequest: vi.fn() } }));
vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));
vi.mock("./aiClaimExtractor", () => ({
  extractClaimsWithAI: vi.fn(),
  detectInsuranceType: vi.fn(),
  KNOWN_INSURER_NAMES: [],
  reconcileClaimStatusWithPaymentEvidence: vi.fn(),
}));
vi.mock("./insuranceTemplates", () => ({ tryTemplateExtraction: vi.fn(), parseCMS1500: vi.fn(), PatientBoundaryError: class extends Error {} }));
vi.mock("child_process", async orig => ({ ...(await orig<typeof import("child_process")>()), execSync: vi.fn() }));
vi.mock("./cms1500Vision", async orig => ({ ...(await orig<typeof import("./cms1500Vision")>()), extractCms1500PagesWithVision: vi.fn() }));

import { execSync } from "child_process";
import { sdk } from "./_core/sdk";
import { invokeLLM } from "./_core/llm";
import { extractClaimsWithAI } from "./aiClaimExtractor";
import { parseCMS1500, tryTemplateExtraction } from "./insuranceTemplates";
import { extractCms1500PagesWithVision } from "./cms1500Vision";
import { registerClaimUploadRoute } from "./claimUpload";
import { syntheticScannedPages } from "./fixtures/cms1500ScannedSynthetic";

const execSyncMock = vi.mocked(execSync);
const parseMock = vi.mocked(parseCMS1500);
const templateMock = vi.mocked(tryTemplateExtraction);
const aiMock = vi.mocked(extractClaimsWithAI);
const llmMock = vi.mocked(invokeLLM);
const visionMock = vi.mocked(extractCms1500PagesWithVision);

/**
 * A real PDF: each entry is one page — a string becomes that page's text
 * layer, null an image-only (scanned) page with no text.
 */
function syntheticPdf(pages: Array<string | null>): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const id = objs.length + 1;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
    const stream = text == null ? "" : `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const TEXT_PAGE = "HEALTH INSURANCE CLAIM FORM SYNTHETIC TEXT LAYER PAGE";

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(sdk.authenticateRequest).mockResolvedValue({
    id: 1, openId: "owner", name: "Owner", email: null, loginMethod: "google", role: "admin",
    createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  } as any);
  // pdftotext is not available (as on Vercel); the pure-JS layout reader is used.
  execSyncMock.mockImplementation(() => { throw new Error("pdftotext not installed"); });
  const app = express();
  registerClaimUploadRoute(app);
  await new Promise<void>(r => { server = app.listen(0, () => r()); });
  const a = server.address();
  baseUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

async function upload(bytes: Buffer, uploadType: "cms1500" | "reimbursement", name = "synthetic.pdf", type = "application/pdf") {
  const f = new FormData();
  f.append("uploadType", uploadType);
  f.append("file", new Blob([bytes], { type }), name);
  const res = await fetch(`${baseUrl}/api/claims/upload-extract`, { method: "POST", body: f });
  return { status: res.status, body: await res.json() };
}

const eobClaim = (patientName: string, cpt: string) => ({
  patientName, dateOfService: "2026-03-02", cptCodes: cpt, modifier: "GP", unitsBilled: 1,
  chargeAmount: 175, insuranceReimbursement: 90, patientAmountDue: 20, patientAmountPaid: null, claimStatus: "approved",
});

describe("CMS1500 PDFs", () => {
  it("a text PDF with a scanned page in the middle is read page by page through vision, not the text template", async () => {
    visionMock.mockResolvedValue({ pages: syntheticScannedPages(), missingPages: [], method: "rendered_pages" });
    const { status, body } = await upload(syntheticPdf([TEXT_PAGE, null, TEXT_PAGE]), "cms1500");
    expect(status).toBe(200);
    expect(parseMock).not.toHaveBeenCalled();
    expect(visionMock).toHaveBeenCalledTimes(1);
    expect(visionMock.mock.calls[0][2]).toBe(3);
    const doc = body.importDocument;
    expect(doc.pageCount).toBe(3);
    expect(doc.warnings[0]).toMatch(/Page\(s\) 2 of 3 are scanned images/);
    expect(doc.extractionFallback).toBeNull();
    expect(doc.groups[0].lines).toHaveLength(16);
  }, 20000);

  it("an all-text PDF keeps the text template and is not flagged as a fallback", async () => {
    parseMock.mockReturnValue([{ patientName: "TESTPATIENT, ALEX", claims: [{ dateOfService: "2026-03-02", cptCodes: "97110", unitsBilled: 1, modifier: "GP", placeOfService: "12", diagnosisCodes: "M54.50", cptLines: [{ cptCodes: "97110", unitsBilled: 1, modifier: "GP", diagnosisCodes: "M54.50" }] } as any] }]);
    const { status, body } = await upload(syntheticPdf([TEXT_PAGE, TEXT_PAGE]), "cms1500");
    expect(status).toBe(200);
    expect(visionMock).not.toHaveBeenCalled();
    expect(body.importDocument.extractionMethod).toBe("CMS1500 template (text layer)");
    expect(body.importDocument.extractionFallback).toBeNull();
  }, 20000);

  it("a fully scanned PDF read via the whole-PDF fallback is flagged", async () => {
    visionMock.mockResolvedValue({ pages: syntheticScannedPages(), missingPages: [], method: "whole_pdf" });
    const { body } = await upload(syntheticPdf([null, null, null]), "cms1500");
    expect(body.importDocument.extractionMethod).toMatch(/whole-PDF fallback/);
    expect(body.importDocument.extractionFallback).toMatch(/fallback/);
  }, 20000);

  it("an unreadable scan is a failure, not an empty success", async () => {
    visionMock.mockResolvedValue({ pages: [], missingPages: [1, 2], method: "rendered_pages" });
    const { status, body } = await upload(syntheticPdf([null, null]), "cms1500");
    expect(status).toBe(422);
    expect(body.importDocument).toBeUndefined();
  }, 20000);
});

describe("EOB PDFs", () => {
  it("a known template is not a fallback", async () => {
    templateMock.mockReturnValue({ templateName: "Synthetic Payer", claims: [eobClaim("TESTPATIENT, ALEX", "97110")], patientGroups: [{ patientName: "TESTPATIENT, ALEX", claims: [eobClaim("TESTPATIENT, ALEX", "97110")] }] } as any);
    const { body } = await upload(syntheticPdf([TEXT_PAGE]), "reimbursement");
    expect(body.importDocument.extractionMethod).toBe("Synthetic Payer");
    expect(body.importDocument.extractionFallback).toBeNull();
  }, 20000);

  it("no template match → AI text reading, flagged, one group per patient", async () => {
    templateMock.mockReturnValue(null as any);
    aiMock.mockResolvedValue({ claims: [eobClaim("TESTPATIENT, ALEX", "97110"), eobClaim("SAMPLE, JORDAN", "97140")], confidence: 0.9 } as any);
    const { body } = await upload(syntheticPdf([TEXT_PAGE, TEXT_PAGE]), "reimbursement");
    expect(aiMock.mock.calls[0][0].kind).toBe("text");
    const doc = body.importDocument;
    expect(doc.extractionFallback).toMatch(/read by AI \(fallback\)/);
    expect(doc.groups.map((g: any) => g.patientName)).toEqual(["TESTPATIENT, ALEX", "SAMPLE, JORDAN"]);
    expect(doc.groups.map((g: any) => g.lines.map((l: any) => l.cptCodes))).toEqual([["97110"], ["97140"]]);
  }, 20000);

  it("a text EOB with a scanned page skips the text template and is read with AI vision on the whole PDF", async () => {
    aiMock.mockResolvedValue({ claims: [eobClaim("TESTPATIENT, ALEX", "97110")], confidence: 0.9 } as any);
    const { body } = await upload(syntheticPdf([TEXT_PAGE, null]), "reimbursement");
    expect(templateMock).not.toHaveBeenCalled();
    expect(aiMock.mock.calls[0][0].kind).toBe("pdf");
    const doc = body.importDocument;
    expect(doc.warnings[0]).toMatch(/Page\(s\) 2 of 2 are scanned images/);
    expect(doc.extractionFallback).toMatch(/AI document vision \(fallback\)/);
  }, 20000);

  it("AI provider down → legacy extractor is flagged and its text cut-off is reported", async () => {
    templateMock.mockReturnValue(null as any);
    aiMock.mockRejectedValue(new Error("provider down"));
    llmMock.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ claims: [{ dateOfService: "2026-03-02", cptCodes: "97110", insuranceReimbursement: 90 }] }) } }] } as any);
    const rows = Array.from({ length: 600 }, (_, i) => `SYNTH-${i},2026-03-02,97110,175.00,90.00`).join("\n");
    const csv = Buffer.from(`Ref,Service Date,Procedure,Billed,Paid\n${rows}\n`);
    const { status, body } = await upload(csv, "reimbursement", "remit.csv", "text/csv");
    expect(status).toBe(200);
    const doc = body.importDocument;
    expect(doc.extractionMethod).toBe("AI Extraction (Legacy)");
    expect(doc.extractionFallback).toMatch(/legacy extractor/);
    expect(doc.warnings.join(" ")).toMatch(/only the first 20,000 of [\d,]+ characters were read/);
    expect(doc.groups[0].patientName).toBeNull();
  }, 20000);
});
