/**
 * server/claimUpload.fieldBoundary.test.ts
 *
 * Regression tests for enforceFieldBoundary() in server/claimUpload.ts: a
 * Reimbursement/EOB upload must keep line-item billing detail (chargeAmount,
 * diagnosisCodes, modifier, unitsBilled) that its own extractor found, while
 * still stripping genuinely CMS-1500-exclusive form fields (placeOfService,
 * claimSubmittedDate, visitNumber).
 *
 * No live LLM/Supabase: extraction is mocked via tryTemplateExtraction /
 * parseCMS1500 so this only exercises the boundary-gate logic itself.
 */
import express from 'express';
import type { Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_core/sdk', () => ({
  sdk: { authenticateRequest: vi.fn() },
}));
vi.mock('./_core/llm', () => ({ invokeLLM: vi.fn() }));
vi.mock('./aiClaimExtractor', () => ({
  extractClaimsWithAI: vi.fn(),
  detectInsuranceType: vi.fn(),
}));
// P4-P30: the route now opens every PDF up front and rejects the fake bytes
// below as damaged. This suite is about field boundaries, not PDF opening
// (claimUpload.pdfOpen.test.ts covers that), so the open is reported as ok.
vi.mock('./pdfjs', async () => {
  const actual = await vi.importActual<typeof import('./pdfjs')>('./pdfjs');
  return { ...actual, openPdf: vi.fn(async () => ({ ok: true as const, pageCount: 1 })) };
});
vi.mock('./insuranceTemplates',() => ({
  tryTemplateExtraction: vi.fn(),
  parseCMS1500: vi.fn(),
}));

import { sdk } from './_core/sdk';
import { tryTemplateExtraction, parseCMS1500 } from './insuranceTemplates';
import { extractClaimsWithAI } from './aiClaimExtractor';
import { registerClaimUploadRoute } from './claimUpload';

const authenticateRequest = vi.mocked(sdk.authenticateRequest);
const tryTemplateExtractionMock = vi.mocked(tryTemplateExtraction);
const parseCMS1500Mock = vi.mocked(parseCMS1500);
const extractClaimsWithAIMock = vi.mocked(extractClaimsWithAI);

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  authenticateRequest.mockResolvedValue({
    id: 1, openId: 'sample-user', email: 'sample@example.com', name: 'Sample User',
    // P4-P25: claim extraction requires Claims access — the owner OAuth admin qualifies.
    loginMethod: 'manus', role: 'admin', createdAt: new Date(), updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as any);
  // Default: no gaps to backfill. Individual tests override this if they need
  // to exercise the AI-backfill path specifically.
  extractClaimsWithAIMock.mockResolvedValue({ claims: [], confidence: 1 } as any);
  const app = express();
  registerClaimUploadRoute(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function uploadForm(uploadType: 'reimbursement' | 'cms1500'): FormData {
  const form = new FormData();
  form.append('uploadType', uploadType);
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'test.pdf');
  return form;
}

describe('POST /api/claims/upload-extract — reimbursement field boundary', () => {
  // Real (unmocked) pdftotext/pdfjs extraction attempts run before the mocked
  // template extraction is reached — each spawns a subprocess against the
  // fake PDF buffer and fails, which is slower than vitest's 5s default.
  it('keeps line-item billing detail but strips CMS-1500-only form fields for a reimbursement upload', async () => {
    tryTemplateExtractionMock.mockReturnValue({
      templateName: 'Synthetic Test Template',
      claims: [
        {
          dateOfService: '2026-01-11',
          cptCodes: '97162',
          // CMS-1500-exclusive — must be stripped on a reimbursement upload
          placeOfService: 'Office',
          claimSubmittedDate: '2026-01-15',
          visitNumber: 3,
          // Line-item billing detail — must survive (this is the fix)
          chargeAmount: 275.0,
          diagnosisCodes: 'M54.50, M25.512, R29.6, R26.89',
          modifier: 'GP',
          unitsBilled: 1,
          // Payment-side fields — already worked, must not regress
          insuranceReimbursement: 137.5,
          patientAmountPaid: 0,
          patientAmountDue: 0,
          oaClaimNumber: '192643',
          checkDate: '2026-03-03',
          checkNumberVirtualCard: 'CHK1',
          claimStatus: 'approved',
          insuranceBilled: null,
          expireBcbsClaimNumber: null,
        },
      ],
    } as any);

    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      body: uploadForm('reimbursement'),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claims).toHaveLength(1);
    const claim = body.claims[0];

    // Fixed: previously these were forced to null by enforceFieldBoundary.
    expect(claim.chargeAmount).toBe(275.0);
    expect(claim.diagnosisCodes).toBe('M54.50, M25.512, R29.6, R26.89');
    expect(claim.modifier).toBe('GP');
    expect(claim.unitsBilled).toBe(1);

    // Preserved (already worked, must not regress).
    expect(claim.insuranceReimbursement).toBe(137.5);
    expect(claim.oaClaimNumber).toBe('192643');
    expect(claim.checkDate).toBe('2026-03-03');

    // Still correctly out of scope for a Reimbursement/EOB upload.
    expect(claim.placeOfService).toBeNull();
    expect(claim.claimSubmittedDate).toBeNull();
    expect(claim.visitNumber).toBeNull();
  }, 20000);
  // The CMS1500 side of the boundary (P4-P24: no money, no visit number,
  // pointer-only diagnoses) is covered in claimUpload.cms1500Import.test.ts.
});
