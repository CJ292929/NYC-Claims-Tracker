import type { NextFunction, Request, Response } from 'express';
import { sdk } from './sdk';

// Reuses the same session-cookie verification tRPC's createContext relies on
// (server/_core/context.ts -> sdk.authenticateRequest), so any raw Express
// route enforces the identical session/auth rules as the rest of the app
// instead of a parallel implementation.
export async function requireAuthenticatedUser(req: Request, res: Response, next: NextFunction) {
  try {
    await sdk.authenticateRequest(req);
    next();
  } catch {
    // Never forward the underlying error (JWT/cookie details) to the client.
    res.status(401).json({ error: 'Authentication required' });
  }
}
