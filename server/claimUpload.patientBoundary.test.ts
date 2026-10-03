/**
 * server/claimUpload.patientBoundary.test.ts
 *
 * P4-P3S: when a template parser (parseMeritainEOBWithGroups) throws
 * PatientBoundaryError because it can't reliably tell two patients'
 * sections apart, POST /api/claims/upload-extract must:
 *   - respond 422 with the exact staff-facing message, not a generic 500
 *   - never fall through to the AI-extraction fallback (extractClaimsWithAI)
 *   - never respond with a 200/claims body of any kind (so no claim data,
 *     real or placeholder, ever reaches the client's import preview or the
 *     bulkImportFromEOB persistence step downstream)
 *
 * tryTemplateExtraction is mocked to throw directly -- this exercises the
 * HTTP-layer contract, not the regex logic itself (covered separately in
 * server/parseMeritainEOBWithGroups.boundaries.test.ts).
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
vi.mock('./insuranceTemplates', async () => {
  const actual = await vi.importActual<typeof import('./insuranceTemplates')>('./insuranceTemplates');
  return {
    PatientBoundaryError: actual.PatientBoundaryError,
    tryTemplateExtraction: vi.fn(),
    parseCMS1500: vi.fn(),
  };
});

import { sdk } from './_core/sdk';
import { tryTemplateExtraction, PatientBoundaryError } from './insuranceTemplates';
import { extractClaimsWithAI } from './aiClaimExtractor';
import { registerClaimUploadRoute } from './claimUpload';

const authenticateRequest = vi.mocked(sdk.authenticateRequest);
const tryTemplateExtractionMock = vi.mocked(tryTemplateExtraction);
const extractClaimsWithAIMock = vi.mocked(extractClaimsWithAI);

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
  authenticateRequest.mockResolvedValue({
    id: 1, openId: 'sample-user', email: 'sample@example.com', name: 'Sample User',
    loginMethod: 'manus', role: 'user', createdAt: new Date(), updatedAt: new Date(),
    lastSignedIn: new Date(),
  } as any);
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

function uploadForm(): FormData {
  const form = new FormData();
  form.append('uploadType', 'reimbursement');
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'test.pdf');
  return form;
}

describe('POST /api/claims/upload-extract — PatientBoundaryError handling', () => {
  it('responds 422 with the explicit review message, never a generic 500 or a 200 claims body', async () => {
    tryTemplateExtractionMock.mockImplementation(() => {
      throw new PatientBoundaryError('Patient boundaries could not be determined (section 0 contains 2 patient headers).');
    });

    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      body: uploadForm(),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Patient boundaries could not be determined. Review the document before importing.');
    // No claims/patientGroups key of any kind leaked through on this path.
    expect(body.claims).toBeUndefined();
    expect(body.patientGroups).toBeUndefined();
  }, 20000);

  it('never falls through to AI extraction on a boundary error', async () => {
    tryTemplateExtractionMock.mockImplementation(() => {
      throw new PatientBoundaryError('Patient boundaries could not be determined.');
    });

    await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      body: uploadForm(),
    });

    expect(extractClaimsWithAIMock).not.toHaveBeenCalled();
  }, 20000);

  it('a normal (non-boundary) template error still surfaces as a 500, not swallowed as 422', async () => {
    tryTemplateExtractionMock.mockImplementation(() => {
      throw new Error('some unrelated parsing crash');
    });

    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      body: uploadForm(),
    });

    expect(res.status).toBe(500);
  }, 20000);
});
