/**
 * server/_core/storageProxy.auth.test.ts
 * Regression tests: GET /manus-storage/* must reject unauthenticated
 * requests with 401 before any Forge/storage API call or signed-URL
 * redirect happens.
 */
import express from 'express';
import http, { type Server } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sdk', () => ({
  sdk: { authenticateRequest: vi.fn() },
}));
vi.mock('./env', () => ({
  ENV: {
    forgeApiUrl: 'https://forge.example.com',
    forgeApiKey: 'test-forge-key',
  },
}));

import { sdk } from './sdk';
import { registerStorageProxy } from './storageProxy';

const authenticateRequest = vi.mocked(sdk.authenticateRequest);

// Uses Node's http client (not global fetch) to call the local test server,
// since global fetch is mocked below to intercept the storage proxy's own
// outbound call to the Forge API.
function requestLocal(baseUrl: string, path: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: () => Promise<string>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${path}`, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: async () => Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
  });
}

let server: Server;
let baseUrl: string;
let forgeFetchSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  forgeFetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ url: 'https://forge.example.com/signed/some-key' }),
  } as Response);
  vi.stubGlobal('fetch', forgeFetchSpy);

  const app = express();
  registerStorageProxy(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('GET /manus-storage/* auth boundary', () => {
  it('rejects an unauthenticated request with 401 before touching the storage backend', async () => {
    authenticateRequest.mockRejectedValueOnce(new Error('Invalid session cookie'));

    const res = await requestLocal(baseUrl, '/manus-storage/some-key');

    expect(res.status).toBe(401);
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ error: 'Authentication required' });
    expect(forgeFetchSpy).not.toHaveBeenCalled();
  });

  it('does not leak auth implementation details on failure', async () => {
    authenticateRequest.mockRejectedValueOnce(
      new Error('JWT verification failed: signature mismatch for secret xyz')
    );

    const res = await requestLocal(baseUrl, '/manus-storage/some-key');

    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/jwt/i);
    expect(text).not.toMatch(/signature/i);
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/cookie/i);
    expect(text).not.toMatch(/stack/i);
    expect(JSON.parse(text)).toEqual({ error: 'Authentication required' });
  });

  it('passes an authenticated request through to the existing proxy behavior', async () => {
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

    const res = await requestLocal(baseUrl, '/manus-storage/some-key');

    expect(authenticateRequest).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(307);
    expect(res.headers.location).toBe('https://forge.example.com/signed/some-key');
    expect(forgeFetchSpy).toHaveBeenCalledTimes(1);
  });
});
