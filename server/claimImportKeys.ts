/**
 * server/claimImportKeys.ts — P4-P24
 *
 * Builds the ImportDocument (shared/claimImport.ts) returned by
 * POST /api/claims/upload-extract, and assigns each group and line its
 * stable source identity ONCE, at extraction time. The client sends these
 * keys back unchanged on every commit and retry, so a partial retry keeps
 * the identity each line was first given.
 *
 * Group keys are a short hash (no patient name or member id in the key).
 * Line keys are, in order of preference:
 *   - "p<page>r<row>" when every line in the group has a distinct printed
 *     page + Box 24 row (scanned CMS1500 read page by page), or
 *   - a content key (date, CPT, modifiers, units[, billed, paid]) plus an
 *     occurrence counter, so identical repeated lines stay distinct and the
 *     key does not depend on the order an extractor happened to return
 *     lines in.
 */
import { createHash } from "node:crypto";
import {
  CLAIM_IMPORT_KEY_RE,
  formatModifiers,
  normalizeModifierSet,
  type Cms1500ImportLine,
  type EobImportLine,
  type ImportGroup,
  type UnresolvedClaimTotal,
} from "@shared/claimImport";

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function sanitizeKeyPart(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "x";
  return String(value).replace(/[^A-Za-z0-9.,-]/g, "").slice(0, 24) || "x";
}

export function groupKeyFor(identity: string): string {
  return "g" + createHash("sha256").update(identity.trim().toUpperCase()).digest("hex").slice(0, 12);
}

function finalizeKey(groupKey: string, lineId: string): string {
  const key = `${groupKey}:${lineId}`.slice(0, 160);
  if (!CLAIM_IMPORT_KEY_RE.test(key)) throw new Error(`Generated source line key is invalid: ${key}`);
  return key;
}

/** Assigns sourceLineKey on each line (mutates and returns the same array). */
export function assignCms1500LineKeys<L extends Omit<Cms1500ImportLine, "sourceLineKey"> & { sourceLineKey?: string }>(
  groupKey: string,
  lines: L[]
): Array<L & { sourceLineKey: string }> {
  const positional = lines.every(l => l.page != null && l.slot != null)
    && new Set(lines.map(l => `${l.page}:${l.slot}`)).size === lines.length;
  const seen = new Map<string, number>();
  for (const line of lines) {
    let id: string;
    if (positional) {
      id = `p${line.page}r${line.slot}`;
    } else {
      const content = [line.dateOfService, line.cptCodes, normalizeModifierSet(line.modifier), line.unitsBilled].map(sanitizeKeyPart).join("_");
      const n = seen.get(content) ?? 0;
      seen.set(content, n + 1);
      id = `${content}_${n}`;
    }
    line.sourceLineKey = finalizeKey(groupKey, id);
  }
  return lines as Array<L & { sourceLineKey: string }>;
}

export function assignEobLineKeys<L extends Omit<EobImportLine, "sourceLineKey"> & { sourceLineKey?: string }>(
  groupKey: string,
  lines: L[]
): Array<L & { sourceLineKey: string }> {
  const seen = new Map<string, number>();
  for (const line of lines) {
    const content = [
      line.dateOfService, line.cptCodes, normalizeModifierSet(line.modifier), line.unitsBilled,
      line.chargeAmount, line.insuranceReimbursement,
    ].map(sanitizeKeyPart).join("_");
    const n = seen.get(content) ?? 0;
    seen.set(content, n + 1);
    line.sourceLineKey = finalizeKey(groupKey, `${content}_${n}`);
  }
  return lines as Array<L & { sourceLineKey: string }>;
}

// ─── Adapters from the existing extractor output ─────────────────────────────

type AnyLine = Record<string, any>;
type AnyGroup = { patientName?: string | null; claims: AnyLine[] };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** MM/DD/YYYY or YYYY-MM-DD → YYYY-MM-DD; anything else → null (never guessed). */
export function toIsoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/** Group identity: the extracted name when it is unique in the document, so
 *  an extractor returning groups in a different order keeps each group's key;
 *  name + position only when the same name appears twice. */
function groupIdentities(kind: string, groups: AnyGroup[]): string[] {
  const names = groups.map(g => (g.patientName ?? "unknown").trim().toUpperCase());
  return names.map((n, i) => (names.indexOf(n) === names.lastIndexOf(n) ? `${kind}:${n}` : `${kind}:${n}:${i}`));
}

/** Flattens a DateClaimGroup-style claim (cptLines[]) or a flat claim into its service lines. */
function flattenLines(claim: AnyLine): AnyLine[] {
  const lines: AnyLine[] = Array.isArray(claim.cptLines) && claim.cptLines.length > 0 ? claim.cptLines : [claim];
  return lines.map(l => ({ ...claim, ...l, cptLines: undefined }));
}

/** Template / AI CMS1500 output → ImportGroup. visitNumber and every amount are dropped. */
export function cms1500GroupsFromClaims(groups: AnyGroup[]): ImportGroup<Cms1500ImportLine>[] {
  const identities = groupIdentities("cms1500", groups);
  return groups.map((g, gi) => {
    const groupKey = groupKeyFor(identities[gi]);
    const lines = g.claims.flatMap(flattenLines).map(l => {
      // P4-P28: a misread units cell (0, 1.5) becomes a flagged blank for the
      // reviewer, instead of failing validation for the whole file.
      const rawUnits = num(l.unitsBilled);
      const unitsBilled = rawUnits != null && Number.isInteger(rawUnits) && rawUnits >= 1 && rawUnits <= 999 ? rawUnits : null;
      return {
        page: null,
        slot: null,
        dateOfService: toIsoDate(l.dateOfService),
        placeOfService: str(l.placeOfService),
        cptCodes: str(l.cptCodes),
        modifier: str(l.modifier),
        unitsBilled,
        diagnosisPointer: str(l.diagnosisPointer),
        diagnosisCodes: str(l.diagnosisCodes),
        claimSubmittedDate: toIsoDate(l.claimSubmittedDate),
        insuranceBilled: str(l.insuranceBilled),
        lineChargeForValidation: num(l.chargeAmount),
        unreadable: rawUnits != null && unitsBilled == null ? ["unitsBilled"] : ([] as string[]),
        notes: str(l.notes),
      };
    });
    return {
      groupKey,
      patientName: str(g.patientName) && g.patientName !== "UNKNOWN" ? str(g.patientName) : null,
      pages: null,
      claimIdentifier: null,
      lines: assignCms1500LineKeys(groupKey, lines),
      warnings: [],
      unresolvedClaimTotals: [],
    };
  });
}

/** Template / AI EOB output → ImportGroup. Claim-level combined totals stay unresolved. */
export function eobGroupsFromClaims(groups: AnyGroup[]): ImportGroup<EobImportLine>[] {
  const identities = groupIdentities("eob", groups);
  return groups.map((g, gi) => {
    const groupKey = groupKeyFor(identities[gi]);
    const unresolvedClaimTotals: UnresolvedClaimTotal[] = [];
    for (const c of g.claims) {
      if (c.unresolvedClaimTotal) {
        unresolvedClaimTotals.push({
          dateOfService: toIsoDate(c.dateOfService),
          cptCodes: str(c.cptCodes),
          planPaid: Number(c.unresolvedClaimTotal.planPaid),
          patientResponsibility: num(c.unresolvedClaimTotal.patientResponsibility),
          cptCount: Number(c.unresolvedClaimTotal.cptCount),
        });
      }
    }
    const lines = g.claims.flatMap(flattenLines).map(l => ({
      page: null,
      dateOfService: toIsoDate(l.dateOfService),
      cptCodes: str(l.cptCodes),
      modifier: formatModifiers(String(l.modifier ?? "").split(/[\s,]+/)),
      unitsBilled: num(l.unitsBilled),
      chargeAmount: num(l.chargeAmount),
      insuranceReimbursement: num(l.insuranceReimbursement),
      patientAmountDue: num(l.patientAmountDue),
      patientAmountPaid: num(l.patientAmountPaid),
      claimStatus: str(l.claimStatus),
      oaClaimNumber: str(l.oaClaimNumber),
      checkDate: toIsoDate(l.checkDate),
      checkNumberVirtualCard: str(l.checkNumberVirtualCard),
      notes: str(l.notes),
    }));
    return {
      groupKey,
      patientName: str(g.patientName),
      pages: null,
      claimIdentifier: null,
      lines: assignEobLineKeys(groupKey, lines),
      warnings: unresolvedClaimTotals.length > 0
        ? [`${unresolvedClaimTotals.length} claim block(s) report one combined plan payment for several lines. Those amounts are not saved to any line — review them manually.`]
        : [],
      unresolvedClaimTotals,
    };
  });
}
