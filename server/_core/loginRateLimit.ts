/**
 * In-memory brute-force guard for clinic.login.
 *
 * Defense-in-depth only: state lives in the process, so on Vercel's
 * serverless runtime each function instance tracks failures independently
 * (INSTANCE_LOCAL, not DISTRIBUTED). It still meaningfully raises the cost
 * of a naive password-guessing script hitting a single warm instance, and
 * resets automatically, but it does not guarantee a global cap across
 * instances. Robust cross-instance enforcement would need a shared store
 * (e.g. Redis/Upstash), which is out of scope here.
 */
import type { IncomingHttpHeaders } from "http";
export { normalizeUsername } from "./username";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

type AttemptEntry = {
  count: number;
  windowStart: number;
};

const attemptsByKey = new Map<string, AttemptEntry>();

// Opportunistic sweep so the map can't grow unbounded from one-off
// usernames/IPs that never come back to clear their entry.
let writesSinceSweep = 0;
const SWEEP_EVERY_N_WRITES = 200;

function sweepExpired(now: number): void {
  attemptsByKey.forEach((entry, key) => {
    if (now - entry.windowStart > WINDOW_MS) {
      attemptsByKey.delete(key);
    }
  });
}

function keyFor(normalizedUsername: string, ip: string): string {
  return `${normalizedUsername}|${ip}`;
}

/** Best-effort client IP, read directly from headers (no `trust proxy` dependency). */
export function getClientIp(req: {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string | null };
}): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

export function isRateLimited(normalizedUsername: string, ip: string): boolean {
  const entry = attemptsByKey.get(keyFor(normalizedUsername, ip));
  if (!entry) return false;
  if (Date.now() - entry.windowStart > WINDOW_MS) return false;
  return entry.count >= MAX_FAILED_ATTEMPTS;
}

export function recordFailedAttempt(normalizedUsername: string, ip: string): void {
  const now = Date.now();
  const key = keyFor(normalizedUsername, ip);
  const entry = attemptsByKey.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByKey.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }

  writesSinceSweep += 1;
  if (writesSinceSweep >= SWEEP_EVERY_N_WRITES) {
    writesSinceSweep = 0;
    sweepExpired(now);
  }
}

export function clearFailedAttempts(normalizedUsername: string, ip: string): void {
  attemptsByKey.delete(keyFor(normalizedUsername, ip));
}

/** Test-only: reset all in-memory state between test cases. */
export function __resetLoginRateLimitForTests(): void {
  attemptsByKey.clear();
  writesSinceSweep = 0;
}
