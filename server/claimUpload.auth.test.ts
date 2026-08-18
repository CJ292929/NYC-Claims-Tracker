/**
 * server/claimUpload.auth.test.ts
 * Regression tests: POST /api/claims/upload-extract must reject
 * unauthenticated requests before any file parsing, template extraction,
 * or AI/LLM call runs.
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
vi.mock('./insuranceTemplates', () => ({
  tryTemplateExtraction: vi.fn(),
  parseCMS1500: vi.fn(),
}));

import { sdk } from './_core/sdk';
import { invokeLLM } from './_core/llm';
import { extractClaimsWithAI, detectInsuranceType } from './aiClaimExtractor';
import { tryTemplateExtraction, parseCMS1500 } from './insuranceTemplates';
import { registerClaimUploadRoute } from './claimUpload';

const authenticateRequest = vi.mocked(sdk.authenticateRequest);

let server: Server;
let baseUrl: string;

beforeEach(async () => {
  vi.clearAllMocks();
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

describe('POST /api/claims/upload-extract auth boundary', () => {
  it('rejects an unauthenticated request with 401 before touching extraction/AI', async () => {
    authenticateRequest.mockRejectedValueOnce(new Error('Invalid session cookie'));

    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not a real upload'),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Authentication required' });

    expect(invokeLLM).not.toHaveBeenCalled();
    expect(extractClaimsWithAI).not.toHaveBeenCalled();
    expect(detectInsuranceType).not.toHaveBeenCalled();
    expect(tryTemplateExtraction).not.toHaveBeenCalled();
    expect(parseCMS1500).not.toHaveBeenCalled();
  });

  it('does not leak auth implementation details on failure', async () => {
    authenticateRequest.mockRejectedValueOnce(
      new Error('JWT verification failed: signature mismatch for secret xyz')
    );

    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not a real upload'),
    });

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/jwt/i);
    expect(text).not.toMatch(/signature/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/stack/i);
    expect(JSON.parse(text)).toEqual({ error: 'Authentication required' });
  });

  it('passes an authenticated request through the auth boundary', async () => {
    authenticateRequest.mockResolvedValueOnce({
      id: 1,
      openId: 'sample-user',
      email: 'sample@example.com',
      name: 'Sample User',
      loginMethod: 'manus',
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any);

    // No file attached: request should get past the 401 boundary and fail
    // downstream at multer's own validation instead, proving auth ran first
    // and did not block a legitimate authenticated caller.
    const res = await fetch(`${baseUrl}/api/claims/upload-extract`, {
      method: 'POST',
    });

    expect(res.status).not.toBe(401);
    expect(authenticateRequest).toHaveBeenCalledTimes(1);
  });
});
