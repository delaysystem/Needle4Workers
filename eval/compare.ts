/** Report comparison: fail on any newly-missed case, refuse cross-golden diffs. */

export interface ComparableReport {
  goldenSha: string;
  hits: number;
  total: number;
  cases: { id: string; hit: boolean }[];
}

export interface CompareResult {
  regressions: string[];
  fixes: string[];
  hitDelta: number;
}

/** Throws when the goldens differ: scores across golden versions don't compare. */
export function compareReports(baseline: ComparableReport, candidate: ComparableReport): CompareResult {
  if (baseline.goldenSha !== candidate.goldenSha) {
    throw new Error(
      `golden mismatch: baseline ${baseline.goldenSha} vs candidate ${candidate.goldenSha}`
    );
  }
  const base = new Map(baseline.cases.map((c) => [c.id, c.hit]));
  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const c of candidate.cases) {
    if (!base.has(c.id)) {
      throw new Error(`candidate case ${c.id} missing from baseline`);
    }
    if (base.get(c.id) && !c.hit) regressions.push(c.id);
    if (!base.get(c.id) && c.hit) fixes.push(c.id);
  }
  return { regressions, fixes, hitDelta: candidate.hits - baseline.hits };
}
