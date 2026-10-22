/**
 * client/src/lib/csvImport.ts
 *
 * Parsing/validation helpers for the bulk patient CSV upload (see
 * handleBulkUpload in Dashboard.tsx). Split out so the row-level parsing
 * logic — quoted-cell handling, header fallbacks, missing-session
 * tolerance — can be unit tested without mounting the dashboard.
 */
import Papa from 'papaparse';

export interface ParsedCsvRow {
  name: string;
  insurance: string;
  authorized: number;
  authDate: string | null;
  dateOfService: string | null;
  sessionNumber: number;
  remaining: number;
  newAuth: string;
  dateAshSubmitted: string | null;
}

export interface CsvRowResult {
  row: ParsedCsvRow | null;
  skipReason?: string;
}

/** Trim + case-fold a patient name so "John Doe" and "john doe " compare equal. */
export function normalizePatientName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** First non-empty, trimmed value found under any of the given header names. */
function getField(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

/** Parse the raw CSV text (already read from the uploaded File) into header-keyed rows. */
export function parseCsvText(text: string): Papa.ParseResult<Record<string, string>> {
  return Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
}

/**
 * Validate + normalize a single CSV row. Never throws — returns a skip
 * reason instead so the caller can report it and keep processing the rest
 * of the file. Missing/zero "Authorized Sessions" is NOT a skip condition:
 * the patient profile is still created (with 0 sessions) so staff can log
 * or edit sessions later.
 */
export function parseCsvRow(row: Record<string, string>, rowIndex: number): CsvRowResult {
  const name = getField(row, 'Patient Name', 'Name', 'Patient');
  if (!name) {
    return { row: null, skipReason: `Row ${rowIndex}: Missing patient name` };
  }

  const authorizedRaw = getField(row, 'Authorized Sessions', 'Total Authorized');
  const authorized = authorizedRaw ? parseInt(authorizedRaw, 10) : 0;

  const sessionNumberRaw = getField(row, 'Session Number');
  const sessionNumber = sessionNumberRaw ? parseInt(sessionNumberRaw, 10) : 1;

  const remainingRaw = getField(row, 'Sessions Remaining');
  const remaining = remainingRaw ? parseInt(remainingRaw, 10) : (Number.isNaN(authorized) ? 0 : authorized);

  return {
    row: {
      name,
      // Blank stays blank — never substitute a hard-coded insurer, which may
      // have been permanently deleted from the catalog (P4-P21).
      insurance: getField(row, 'Insurance', 'Insurance Company') || '',
      authorized: Number.isNaN(authorized) ? 0 : authorized,
      authDate: getField(row, 'Authorization Date') || null,
      dateOfService: getField(row, 'Date of Service') || null,
      sessionNumber: Number.isNaN(sessionNumber) ? 1 : sessionNumber,
      remaining: Number.isNaN(remaining) ? 0 : remaining,
      newAuth: getField(row, 'New Authorization?') || 'NO',
      // Accept both the legacy "ASH" header and the newer "Authorization" header.
      dateAshSubmitted: getField(row, 'Date ASH Submitted', 'Date Authorization Submitted') || null,
    },
  };
}

export interface CsvImportSummary {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  skipReasons: string[];
}

export function emptyCsvImportSummary(): CsvImportSummary {
  return { createdCount: 0, updatedCount: 0, skippedCount: 0, skipReasons: [] };
}
