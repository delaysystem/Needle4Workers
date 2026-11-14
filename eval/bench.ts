/** Throughput benchmark: concurrency sweep against the in-process worker.
 *
 * Measures achieved req/s plus p50/p95 at each concurrency level with real
 * weights and the real mutex. Environment is recorded because in-process
 * bun numbers are not edge-isolate numbers.
 *
 * Usage: bun eval/bench.ts [--requests N] [--concurrency 1,4,8] [--out FILE]
 */
import worker from "../src/index";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { percentile } from "../src/lib/metrics";

const QUERY = "I paid for premium support. Every reply still comes from a bot. Get me staff.";
const DEFAULT_CHUNKS = "needle3-20l-handoff.cact.aa,needle3-20l-handoff.cact.ab,needle3-20l-handoff.cact.ac";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function harnessEnv(weightsDir: string, chunks: string): any {
  return {
    NEEDLE_LAYERS: "20",
    WEIGHTS_CHUNKS: chunks.split(",").map((c) => "/" + c).join(","),
    ASSETS: {
      fetch: async (req: Request) => {
        const basename = new URL(req.url).pathname.split("/").pop() as string;
        return new Response(fs.readFileSync(path.join(weightsDir, basename)));
      },
    },
  };
}

async function one(env: any, tools: any[], maxTokens: number): Promise<{
  ms: number; status: number; decodeTps: number; outChars: number; inChars: number;
}> {
  const t0 = Date.now();
  const res = await worker.fetch(
    new Request("http://localhost:8787/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: QUERY }],
        tools,
        max_tokens: maxTokens,
      }),
    }),
    env,
    {} as any
  );
  const payload: any = await res.json().catch(() => ({}));
  const details = payload?.usage_details ?? {};
  return {
    ms: Date.now() - t0,
    status: res.status,
    decodeTps: details.decode_tps ?? 0,
    outChars: details.completion_chars ?? 0,
    inChars: QUERY.length,
  };
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dir, "..");
  const requests = parseInt(arg("--requests", "32"), 10);
  const levels = arg("--concurrency", "1,4,8").split(",").map((s) => parseInt(s, 10));
  const outPath = path.resolve(root, arg("--out", "eval/bench.json"));
  const weightsDir = path.resolve(root, arg("--weights-dir", "weights"));
  const chunks = arg("--chunks", DEFAULT_CHUNKS);
  const maxTokens = parseInt(arg("--max-tokens", "128"), 10);
  const tools = JSON.parse(fs.readFileSync(path.join(root, "eval/goldens/tools.json"), "utf-8"));
  const env = harnessEnv(weightsDir, chunks);

  console.log(`warmup (1 request, discarded)`);
  await one(env, tools, maxTokens);

  const rows: any[] = [];
  for (const level of levels) {
    const latencies: number[] = [];
    let errors = 0;
    let tpsSum = 0;
    let tpsN = 0;
    let outChars = 0;
    const started = Date.now();
    let next = 0;
    const runners = Array.from({ length: level }, async () => {
      while (next < requests) {
        next++;
        const r = await one(env, tools, maxTokens);
        latencies.push(r.ms);
        if (r.status !== 200) {
          errors += 1;
        } else {
          tpsSum += r.decodeTps;
          tpsN += 1;
          outChars += r.outChars;
        }
      }
    });
    await Promise.all(runners);
    const wallS = (Date.now() - started) / 1000;
    const sorted = [...latencies].sort((a, b) => a - b);
    const row = {
      concurrency: level,
      requests,
      errors,
      wall_s: Math.round(wallS * 10) / 10,
      rps: Math.round((requests / wallS) * 100) / 100,
      p50_ms: percentile(sorted, 0.5),
      p95_ms: percentile(sorted, 0.95),
      max_ms: sorted[sorted.length - 1],
      avg_decode_tps: tpsN > 0 ? Math.round((tpsSum / tpsN) * 10) / 10 : 0,
      avg_out_chars: tpsN > 0 ? Math.round(outChars / tpsN) : 0,
      avg_est_tokens: tpsN > 0 ? Math.ceil((outChars / tpsN + QUERY.length) / 4) : 0,
    };
    rows.push(row);
    console.log(
      `c=${level}: ${row.rps} rps, p50 ${row.p50_ms}ms, p95 ${row.p95_ms}ms, ` +
      `decode ${row.avg_decode_tps} tok/s, ~${row.avg_est_tokens} tok/req, errors ${errors}`
    );
  }

  const report = {
    query_chars: QUERY.length,
    max_tokens: maxTokens,
    environment: {
      runtime: `bun ${Bun.version}`,
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.cpus().length,
      note: "in-process numbers, not edge-isolate numbers",
    },
    levels: rows,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${outPath}`);
}

await main();
