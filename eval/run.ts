/** Golden harness: run the frozen 336-case eval against the worker in-process.
 *
 * Exit codes: 0 pass; 2 below --min-hits; 3 regressions vs --compare;
 * 4 golden mismatch. The report is always written before a nonzero exit.
 *
 * Usage: bun eval/run.ts [--goldens DIR] [--min-hits N] [--compare R.json]
 *   [--out R.json] [--limit N] [--max-tokens N] [--chunks a,b,c]
 *   [--tools-file F.json] [--pinned-tools P.json] [--layers N]
 *
 * --pinned-tools sets the worker's PINNED_TOOLS env from a file, proving
 * the collapse path (e.g. --tools-file with reordered keys plus --pinned-tools
 * with the golden file must still hit every case).
 */
import worker from "../src/index";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { compareReports } from "./compare";
import { summarizeFailures } from "./failures";
import { callsMatch, routingMatch, summarize } from "./scoring";

const DEFAULT_CHUNKS = "needle3-20l-handoff.cact.aa,needle3-20l-handoff.cact.ab,needle3-20l-handoff.cact.ac";
const CASE_TIMEOUT_S = 120;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function loadGoldens(dir: string): { rows: any[]; tools: any[]; meta: Map<string, any>; manifest: any } {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
  for (const file of manifest.files as string[]) {
    const data = fs.readFileSync(path.join(dir, file));
    const key = file.replace(/\.(jsonl|json)$/, "") + "_sha256";
    const want = manifest[key];
    if (!want) throw new Error(`manifest has no sha for ${file}`);
    if (sha256Hex(data) !== want) {
      throw new Error(`golden ${file} sha mismatch: edited without re-cutting the manifest`);
    }
  }
  const rows = fs.readFileSync(path.join(dir, "eval.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  if (rows.length !== manifest.count) {
    throw new Error(`golden count ${rows.length} != manifest ${manifest.count}`);
  }
  const tools = JSON.parse(fs.readFileSync(path.join(dir, "tools.json"), "utf-8"));
  const meta = new Map<string, any>();
  for (const line of fs.readFileSync(path.join(dir, "seeds_eval.jsonl"), "utf-8").trim().split("\n")) {
    const seed = JSON.parse(line);
    meta.set(seed.query, seed);
  }
  return { rows, tools, meta, manifest };
}

function harnessEnv(weightsDir: string, chunks: string, layers: string): any {
  return {
    NEEDLE_LAYERS: layers,
    WEIGHTS_CHUNKS: chunks.split(",").map((c) => "/" + c).join(","),
    ASSETS: {
      fetch: async (req: Request) => {
        const basename = new URL(req.url).pathname.split("/").pop() as string;
        const file = path.join(weightsDir, basename);
        if (!fs.existsSync(file)) return new Response("missing", { status: 404 });
        return new Response(fs.readFileSync(file), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      },
    },
  };
}

function weightsSha(weightsDir: string, chunks: string): string {
  const hash = createHash("sha256");
  for (const c of chunks.split(",")) hash.update(fs.readFileSync(path.join(weightsDir, c)));
  return hash.digest("hex");
}

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dir, "..");
  const goldensDir = path.resolve(root, arg("--goldens", "eval/goldens"));
  const minHits = parseInt(arg("--min-hits", "333"), 10);
  const comparePath = process.argv.includes("--compare")
    ? arg("--compare", "")
    : "";
  const outPath = path.resolve(root, arg("--out", "eval/report.json"));
  const limit = parseInt(arg("--limit", "0"), 10);
  const maxTokens = parseInt(arg("--max-tokens", "128"), 10);
  const weightsDir = path.resolve(root, arg("--weights-dir", "weights"));
  const chunks = arg("--chunks", DEFAULT_CHUNKS);
  const layers = arg("--layers", "20");

  const { rows, tools: goldenTools, meta, manifest } = loadGoldens(goldensDir);
  const env = harnessEnv(weightsDir, chunks, layers);
  const toolsFile = arg("--tools-file", "");
  const tools = toolsFile
    ? JSON.parse(fs.readFileSync(path.resolve(root, toolsFile), "utf-8"))
    : goldenTools;
  if (toolsFile) console.log(`tools override: ${toolsFile} (${JSON.stringify(tools).length} chars)`);
  const pinnedFile = arg("--pinned-tools", "");
  if (pinnedFile) {
    env.PINNED_TOOLS = fs.readFileSync(path.resolve(root, pinnedFile), "utf-8");
    console.log(`pinned tools: ${pinnedFile}`);
  }
  const ctx = {} as any;
  const selected = limit > 0 ? rows.slice(0, limit) : rows;
  console.log(`golden v${manifest.version} (${manifest.eval_sha256.slice(0, 12)}), ${selected.length}/${rows.length} cases, min-hits ${minHits}`);

  const cases: any[] = [];
  for (const [i, row] of selected.entries()) {
    const seed = meta.get(row.query);
    if (!seed) throw new Error(`no lang/category for eval row ${row.id}`);
    const t0 = Date.now();
    let actual: any[] = [];
    let status = 0;
    let error: string | null = null;
    let fastpath = false;
    let completionChars = 0;
    try {
      const res = await worker.fetch(
        new Request("http://localhost:8787/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: row.query }],
            tools,
            max_tokens: maxTokens,
          }),
        }),
        env,
        ctx
      );
      status = res.status;
      fastpath = res.headers.get("X-Needle-Fastpath") === "1";
      const payload: any = await res.json().catch(() => ({}));
      completionChars = payload?.usage_details?.completion_chars ?? 0;
      if (status === 200) {
        const calls = payload?.choices?.[0]?.message?.tool_calls ?? [];
        actual = calls.map((c: any) => ({
          name: c.function?.name,
          arguments: JSON.parse(c.function?.arguments ?? "{}"),
        }));
      } else {
        error = payload?.error ?? `status ${status}`;
      }
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
    const latencyMs = Date.now() - t0;
    const expected = row.answers ?? [];
    cases.push({
      id: row.id,
      lang: seed.lang,
      category: seed.category,
      hit: error === null && callsMatch(expected, actual),
      routingHit: error === null && routingMatch(expected, actual),
      expected,
      actual,
      status,
      error,
      latencyMs,
      timedOut: latencyMs > CASE_TIMEOUT_S * 1000,
      fastpath,
      completionChars,
    });
    if ((i + 1) % 25 === 0 || i + 1 === selected.length) {
      const soFar = cases.filter((c) => c.hit).length;
      console.log(`  ${i + 1}/${selected.length} hits ${soFar}`);
    }
  }

  const summary = summarize(cases);
  const failures = summarizeFailures(cases.filter((c) => !c.hit));
  const report = {
    model: `needle-3-${layers}l`,
    engine: "wasm-simd128",
    weightsSha: weightsSha(weightsDir, chunks),
    goldenSha: manifest.eval_sha256,
    goldenVersion: manifest.version,
    minHits,
    summary,
    failures,
    cases,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  const fastpathHits = cases.filter((c) => c.fastpath).length;
  console.log(`hits ${summary.hits}/${summary.total} (routing ${summary.routingHits}, fastpath ${fastpathHits}), wrote ${outPath}`);
  if (failures.misses > 0) {
    console.log(`failures: ${JSON.stringify(failures.tags)}`);
  }

  if (comparePath) {
    const baseline = JSON.parse(fs.readFileSync(comparePath, "utf-8"));
    let result;
    try {
      result = compareReports(
        { goldenSha: baseline.goldenSha, hits: baseline.summary.hits, total: baseline.summary.total, cases: baseline.cases },
        { goldenSha: report.goldenSha, hits: summary.hits, total: summary.total, cases }
      );
    } catch (err: any) {
      console.error(`compare refused: ${err.message}`);
      return 4;
    }
    console.log(`vs baseline: ${result.fixes.length} fixes, ${result.regressions.length} regressions (delta ${result.hitDelta >= 0 ? "+" : ""}${result.hitDelta})`);
    if (result.regressions.length > 0) {
      console.error(`regressions: ${result.regressions.join(", ")}`);
      return 3;
    }
  }
  if (summary.hits < minHits) {
    console.error(`below threshold: ${summary.hits} < ${minHits}`);
    return 2;
  }
  return 0;
}

process.exit(await main());
