/** Isolate-local request metrics: counters, latency quantiles, log lines.
 *
 * Workers isolates are independent, so these counters cover one isolate
 * since it started (documented limit, not a global dashboard). The eval
 * harness computes offline aggregates separately.
 */

export interface RequestOutcome {
  status: number;
  latencyMs: number;
  retried?: boolean;
  replayed?: boolean;
  saturated?: boolean;
  /** Engine-reported decode throughput, when the request ran inference. */
  decodeTps?: number;
  /** Exact I/O sizes; token counts are estimated from these (chars/4). */
  promptChars?: number;
  outputChars?: number;
}

/** Industry-rough token estimate, always labeled as such at use sites. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export const LATENCY_RING = 512;

export class Metrics {
  readonly startedAt = new Date().toISOString();
  private startMs = Date.now();
  requests = 0;
  ok = 0;
  clientError = 0;
  serverError = 0;
  badGateway = 0;
  retried = 0;
  replayed = 0;
  saturated = 0;
  inferenceRuns = 0;
  decodeTpsSum = 0;
  promptCharsTotal = 0;
  outputCharsTotal = 0;
  estTokensTotal = 0;
  private latencies: number[] = [];

  record(outcome: RequestOutcome): void {
    this.requests += 1;
    if (outcome.status >= 200 && outcome.status < 300) this.ok += 1;
    else if (outcome.status === 429) this.saturated += 1;
    else if (outcome.status === 502) this.badGateway += 1;
    else if (outcome.status >= 400 && outcome.status < 500) this.clientError += 1;
    else this.serverError += 1;
    if (outcome.retried) this.retried += 1;
    if (outcome.replayed) this.replayed += 1;
    if (outcome.decodeTps !== undefined) {
      this.inferenceRuns += 1;
      this.decodeTpsSum += outcome.decodeTps;
    }
    const promptChars = outcome.promptChars ?? 0;
    const outputChars = outcome.outputChars ?? 0;
    this.promptCharsTotal += promptChars;
    this.outputCharsTotal += outputChars;
    this.estTokensTotal += estimateTokens(promptChars + outputChars);
    this.latencies.push(outcome.latencyMs);
    if (this.latencies.length > LATENCY_RING) this.latencies.shift();
  }

  snapshot(): Record<string, unknown> {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      started_at: this.startedAt,
      uptime_s: Math.floor((Date.now() - this.startMs) / 1000),
      scope: "isolate",
      requests: this.requests,
      ok: this.ok,
      client_error: this.clientError,
      server_error: this.serverError,
      bad_gateway: this.badGateway,
      retried: this.retried,
      replayed: this.replayed,
      saturated: this.saturated,
      latency_ms: {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      },
      compute: {
        inference_runs: this.inferenceRuns,
        avg_decode_tps: this.inferenceRuns > 0
          ? Math.round((this.decodeTpsSum / this.inferenceRuns) * 10) / 10
          : 0,
        prompt_chars_total: this.promptCharsTotal,
        output_chars_total: this.outputCharsTotal,
        est_tokens_total: this.estTokensTotal,
        est_tokens_note: "chars/4 estimates; exact token counts are not exposed by the engine",
      },
    };
  }
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/** One structured log line per request (picked up by Workers Logs). */
export function logRequest(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ type: "needle.request", ...fields }));
}
