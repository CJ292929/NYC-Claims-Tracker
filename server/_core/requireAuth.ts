import type { NextFunction, Request, Response } from 'express';
import { CLAIMS_ACCESS_DENIED_ERR_MSG } from '@shared/const';
import { sdk } from './sdk';
import { isSuperAdmin } from './superAdmin';

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

/** P4-P23: raw-Express twin of superAdminProcedure (server/_core/trpc.ts) for
 * Claims routes outside tRPC (CMS1500/EOB extraction upload). 401 when there
 * is no valid session, 403 for any authenticated non-Super-Admin — checked
 * BEFORE the request body (the uploaded file) is parsed or processed. A
 * clinic session that must change its password is refused as well, matching
 * normalProtectedProcedure. */
export async function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  let user;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isSuperAdmin(user) || user.clinicUser?.mustChangePassword) {
    res.status(403).json({ error: CLAIMS_ACCESS_DENIED_ERR_MSG });
    return;
  }
  next();
}
