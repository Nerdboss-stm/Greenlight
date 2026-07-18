/**
 * File → /summarize input. Decides the modality from the file and produces the
 * exact `patient_file` object api.ts should send.
 *
 * - `.json` / `.jsonl` → FHIR path (Abridge record or Synthea Bundle).
 * - `.pdf` → fax: text extracted client-side. If the PDF has no selectable text
 *   (a scanned/image fax), fall back to client-side OCR (Tesseract.js).
 * - image files (`.png`, `.jpg`, …) → fax: OCR directly.
 * - other text-like files (`.txt`, `.md`, …) → fax transcript.
 *
 * Heavy deps (pdfjs, tesseract) are dynamically imported only when used.
 */

export type Modality = "fhir" | "fax";

export type StatusFn = (message: string) => void;

export interface IngestResult {
  /** the object to pass to summarize() as patient_file */
  input: Record<string, unknown>;
  modality: Modality;
  /** short human label for the UI chip */
  label: string;
  filename: string;
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

export async function ingestFile(file: File, onStatus?: StatusFn): Promise<IngestResult> {
  const name = file.name.toLowerCase();

  if (IMAGE_RE.test(name) || file.type.startsWith("image/")) {
    onStatus?.("Running OCR on image fax…");
    const transcript = await ocrImage(file);
    if (!transcript.trim()) throw new Error("OCR found no readable text in this image.");
    return fax(transcript, "Fax · image → OCR", file.name);
  }

  if (name.endsWith(".pdf")) {
    const { text, ocr } = await extractPdfText(file, onStatus);
    if (!text.trim()) {
      throw new Error("No readable text found in this PDF, even after OCR.");
    }
    return fax(text, ocr ? "Fax · scanned PDF → OCR" : "Fax · PDF → transcript", file.name);
  }

  const text = await file.text();

  if (name.endsWith(".json") || name.endsWith(".jsonl")) {
    return { input: parseJsonOrJsonl(text), modality: "fhir", label: "FHIR · JSON", filename: file.name };
  }

  if (!text.trim()) throw new Error("The document is empty.");
  return fax(text, "Fax · text → transcript", file.name);
}

function fax(transcript: string, label: string, filename: string): IngestResult {
  return { input: { transcript, modality: "transcript" }, modality: "fax", label, filename };
}

/** Accept a single JSON object, a JSON array (take the first record), or JSONL
 *  (take the first non-empty line). */
export function parseJsonOrJsonl(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    const value = JSON.parse(trimmed);
    if (Array.isArray(value)) {
      if (!value.length) throw new Error("The JSON array is empty.");
      return value[0] as Record<string, unknown>;
    }
    return value as Record<string, unknown>;
  } catch {
    // fall through to JSONL
  }
  const firstLine = trimmed.split("\n").map((l) => l.trim()).find(Boolean);
  if (!firstLine) throw new Error("Not valid JSON or JSONL.");
  return JSON.parse(firstLine) as Record<string, unknown>;
}

// --- PDF: embedded text, then OCR fallback -----------------------------------

/** A PDF text layer shorter than this (whitespace stripped) is treated as
 *  "no selectable text" → OCR. Scanned faxes have ~0. */
const MIN_TEXT_CHARS = 24;

async function extractPdfText(file: File, onStatus?: StatusFn): Promise<{ text: string; ocr: boolean }> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const data = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  const embedded = pages.join("\n").trim();
  if (embedded.replace(/\s/g, "").length >= MIN_TEXT_CHARS) {
    return { text: embedded, ocr: false };
  }

  // No usable text layer — render each page to a canvas and OCR it.
  onStatus?.("No embedded text — scanned fax, running OCR…");
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const out: string[] = [];
    const n = pdf.numPages;
    for (let i = 1; i <= n; i++) {
      onStatus?.(`OCR page ${i} of ${n}…`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not create a canvas for OCR.");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const { data: { text } } = await worker.recognize(canvas);
      out.push(text);
    }
    return { text: out.join("\n").trim(), ocr: true };
  } finally {
    await worker.terminate();
  }
}

async function ocrImage(file: File): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data: { text } } = await worker.recognize(file);
    return text;
  } finally {
    await worker.terminate();
  }
}
