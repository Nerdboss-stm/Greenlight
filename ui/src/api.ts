/**
 * GreenLight — the one and only API client.
 *
 * Every screen imports from here. There are NO fetch() calls anywhere else in
 * the app. All shapes come from ./types (mirror of api/models.py). All errors
 * surface as ApiClientError with a stable `type`. See docs/CONTRACT.md.
 */

import { useCallback, useRef, useState } from "react";
import type {
  AuthorRequest,
  BasketRequest,
  BasketResponse,
  CaseRequest,
  Determination,
  EvalResult,
  EvalRunRequest,
  GoldCase,
  PatientContext,
  Policy,
  RetrievePolicyRequest,
  SummarizeRequest,
  TraceEvent,
} from "./types";

const BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8000";

/** Thrown by every client call. `type` is the server's error envelope type,
 *  or a client-side code (network_error / parse_error). */
export class ApiClientError extends Error {
  type: string;
  status?: number;
  constructor(type: string, message: string, status?: number) {
    super(message);
    this.name = "ApiClientError";
    this.type = type;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (e) {
    throw new ApiClientError("network_error", `Could not reach the server: ${String(e)}`);
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiClientError("parse_error", "Malformed JSON in response");
    }
  }

  if (!res.ok) {
    const env = (body as { error?: { type?: string; message?: string } } | null)?.error;
    throw new ApiClientError(
      env?.type ?? "http_error",
      env?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(payload) });
}

// --- One function per endpoint ----------------------------------------------

export function summarize(patientFile: SummarizeRequest["patient_file"]): Promise<PatientContext> {
  return post<PatientContext>("/summarize", { patient_file: patientFile } satisfies SummarizeRequest);
}

export function getPolicies(): Promise<Policy[]> {
  return request<Policy[]>("/policies");
}

export function retrievePolicy(procedure: string): Promise<Policy> {
  return post<Policy>("/policies/retrieve", { procedure } satisfies RetrievePolicyRequest);
}

export function runCase(req: CaseRequest): Promise<Determination> {
  return post<Determination>("/case", { ...req, stream: false });
}

export function authorGold(procedure: string, targets: number): Promise<GoldCase[]> {
  return post<GoldCase[]>(
    `/policies/${encodeURIComponent(procedure)}/author`,
    { targets } satisfies AuthorRequest,
  );
}

export function submitBasket(req: BasketRequest): Promise<BasketResponse> {
  return post<BasketResponse>("/basket", req);
}

export function runEval(req: EvalRunRequest): Promise<EvalResult> {
  return post<EvalResult>("/evals/run", req);
}

/**
 * Stream a case as it adjudicates, invoking `onEvent` for each TraceEvent.
 * Resolves with the full Determination (carried by the final `done` event).
 *
 * Robustness contract: ANY stream failure — network, non-OK status, missing
 * body, malformed SSE, or a stream that ends without a `done` event —
 * transparently falls back to runCase(), replaying the returned trace[] through
 * `onEvent` so the UI still animates. Callers get the same Determination and
 * never learn which path ran.
 */
export async function streamCase(
  req: CaseRequest,
  onEvent: (event: TraceEvent) => void,
): Promise<Determination> {
  try {
    const res = await fetch(`${BASE}/case`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ ...req, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`stream unavailable (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: Determination | null = null;

    const flush = (frame: string) => {
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      const event = JSON.parse(data) as TraceEvent;
      onEvent(event);
      if (event.type === "done") {
        final = event.payload as unknown as Determination;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        flush(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
    if (buffer.trim()) flush(buffer);

    if (!final) throw new Error("stream ended without a done event");
    return final;
  } catch {
    // Transparent fallback — same Determination, and we replay its trace so the
    // UI receives the identical event sequence it would have streamed.
    const determination = await runCase(req);
    for (const event of determination.trace) onEvent(event);
    return determination;
  }
}

// --- Loading pattern ---------------------------------------------------------

export interface AsyncState<T> {
  data: T | null;
  error: ApiClientError | null;
  loading: boolean;
}

/**
 * Consistent async/loading/error wrapper for any client call.
 *
 *   const oxygen = useAsync(runCase);
 *   oxygen.run({ patient_file, procedure: "240.2" });
 *   // oxygen.loading / oxygen.error / oxygen.data
 */
export function useAsync<Args extends unknown[], T>(fn: (...args: Args) => Promise<T>) {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: false });
  const callId = useRef(0);

  const run = useCallback(
    async (...args: Args): Promise<T | null> => {
      const id = ++callId.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const data = await fn(...args);
        if (id === callId.current) setState({ data, error: null, loading: false });
        return data;
      } catch (e) {
        const error =
          e instanceof ApiClientError ? e : new ApiClientError("unknown", String(e));
        if (id === callId.current) setState((s) => ({ ...s, error, loading: false }));
        return null;
      }
    },
    [fn],
  );

  const reset = useCallback(() => setState({ data: null, error: null, loading: false }), []);

  return { ...state, run, reset };
}
