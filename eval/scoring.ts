/** DroidCall-style exact scoring: same name, args, and order.
 * Port of scripts/evaluate.py calls_match/summarize (cactus repo). */

export interface GoldCall {
  name: string;
  arguments: Record<string, any>;
}

function argsEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && (a as any)[k] === (b as any)[k]);
}

export function callsMatch(expected: GoldCall[], actual: GoldCall[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every(
    (exp, i) => exp.name === actual[i]?.name && argsEqual(exp.arguments, actual[i]?.arguments)
  );
}

/** Tool-name-only match (routing diagnostic, not the target). */
export function routingMatch(expected: GoldCall[], actual: GoldCall[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((exp, i) => exp.name === actual[i]?.name);
}

export interface CaseScore {
  id: string;
  lang: string;
  category: string;
  hit: boolean;
  routingHit: boolean;
  expected: GoldCall[];
  actual: GoldCall[];
  latencyMs: number;
  timedOut: boolean;
}

export interface Bucket {
  total: number;
  hits: number;
}

export function summarize(cases: CaseScore[]): {
  total: number;
  hits: number;
  routingHits: number;
  negatives: number;
  negativeHits: number;
  byLanguage: Record<string, Bucket>;
  byCategory: Record<string, Bucket>;
} {
  const byLanguage: Record<string, Bucket> = {};
  const byCategory: Record<string, Bucket> = {};
  let hits = 0;
  let routingHits = 0;
  let negatives = 0;
  let negativeHits = 0;
  for (const c of cases) {
    if (c.hit) hits += 1;
    if (c.routingHit) routingHits += 1;
    if (c.expected.length === 0) {
      negatives += 1;
      if (c.hit) negativeHits += 1;
    }
    for (const [store, key] of [[byLanguage, c.lang], [byCategory, c.category]] as const) {
      store[key] = store[key] ?? { total: 0, hits: 0 };
      store[key].total += 1;
      if (c.hit) store[key].hits += 1;
    }
  }
  return { total: cases.length, hits, routingHits, negatives, negativeHits, byLanguage, byCategory };
}
