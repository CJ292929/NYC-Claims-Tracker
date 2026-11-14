/**
 * server/pdfjs.ts — P4-P30
 *
 * The one way server code loads pdfjs-dist. In Node, pdfjs loads two things
 * by paths a file tracer cannot see: its canvas polyfill (@napi-rs/canvas,
 * through createRequire) and its worker (import() of a variable). Vercel's
 * tracer therefore packaged only pdf.mjs, and in the deployed function:
 *   - importing pdf.mjs threw "DOMMatrix is not defined" (no polyfill);
 *   - getDocument threw "Setting up fake worker failed" (no worker file).
 * Every caller swallowed that, so every PDF was reported as unopenable.
 * The literal imports below make the tracer package both.
 */
type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

/** The PDF reader itself could not start: a server fault, never the file's. */
export class PdfReaderUnavailableError extends Error {
  constructor(stage: "canvas" | "worker" | "library", cause: unknown) {
    super(`PDF reader unavailable (${stage}): ${errorText(cause)}`);
    this.name = "PdfReaderUnavailableError";
  }
}

let loading: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  if (!loading) {
    loading = load();
    // A failed start is retried on the next request instead of cached.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

async function load(): Promise<Pdfjs> {
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix || !g.ImageData || !g.Path2D) {
    let canvas: Record<string, unknown>;
    try {
      canvas = (await import("@napi-rs/canvas")) as unknown as Record<string, unknown>;
    } catch (err) {
      throw new PdfReaderUnavailableError("canvas", err);
    }
    g.DOMMatrix ??= canvas.DOMMatrix;
    g.ImageData ??= canvas.ImageData;
    g.Path2D ??= canvas.Path2D;
  }
  if (!g.pdfjsWorker) {
    try {
      // pdfjs uses globalThis.pdfjsWorker instead of importing the worker file.
      g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    } catch (err) {
      throw new PdfReaderUnavailableError("worker", err);
    }
  }
  try {
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (err) {
    throw new PdfReaderUnavailableError("library", err);
  }
}

export type PdfOpenFailureKind = "reader_unavailable" | "password" | "invalid" | "unreadable";

export interface PdfOpenFailure {
  kind: PdfOpenFailureKind;
  /** Error name and message only, with file-system paths removed. Never document content. */
  detail: string;
}

export type PdfOpenResult = { ok: true; pageCount: number } | { ok: false; failure: PdfOpenFailure };

/** Opens a PDF once to learn whether it can be read at all, and why not. */
export async function openPdf(buffer: Buffer): Promise<PdfOpenResult> {
  let pdfjs: Pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (err) {
    return { ok: false, failure: { kind: "reader_unavailable", detail: errorText(err) } };
  }
  try {
    const task = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const pageCount = (await task.promise).numPages;
    await task.destroy().catch(() => {});
    return { ok: true, pageCount };
  } catch (err) {
    return { ok: false, failure: classifyPdfError(err) };
  }
}

export function classifyPdfError(err: unknown): PdfOpenFailure {
  const detail = errorText(err);
  const name = err instanceof Error ? err.name : "";
  if (err instanceof PdfReaderUnavailableError || /fake worker|Cannot find module|is not defined|ERR_MODULE_NOT_FOUND/i.test(detail)) {
    return { kind: "reader_unavailable", detail };
  }
  if (name === "PasswordException") return { kind: "password", detail };
  if (name === "InvalidPDFException" || name === "FormatError" || /Invalid PDF structure|No password given|PDF header/i.test(detail)) {
    return { kind: "invalid", detail };
  }
  return { kind: "unreadable", detail };
}

/** HTTP status and user-facing message for a PDF that could not be opened. */
export function pdfOpenFailureResponse(failure: PdfOpenFailure): { status: number; error: string } {
  switch (failure.kind) {
    case "reader_unavailable":
      return { status: 503, error: "The server's PDF reader did not start, so this file was not read. This is a server problem, not a problem with the file. Nothing was saved. Try again later." };
    case "password":
      return { status: 422, error: "This PDF is password-protected. Remove the password, then upload it again. Nothing was saved." };
    case "invalid":
      return { status: 422, error: "This file is damaged or is not a PDF, so it could not be opened. Re-save or re-scan it and try again. Nothing was saved." };
    default:
      return { status: 422, error: `This PDF could not be read (${failure.detail.slice(0, 120)}). Nothing was saved.` };
  }
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return raw
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"'`]*[\\/][^\s"'`]*/g, "<path>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
