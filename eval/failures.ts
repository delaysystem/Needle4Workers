/** Failure-mode classification: every miss gets all applicable tags.
 *
 * Buckets mirror the hand-derived round-5 taxonomy: false-positive,
 * false-negative, arity (call-count mismatch), wrong-tool,
 * spurious/missing/wrong reason, missing/extra details, span-pick
 * (details present on both sides but different). A miss can carry
 * several tags (e.g. wrong span plus a spurious reason).
 */

export interface MissCase {
  id: string;
  expected: { name: string; arguments: Record<string, any> }[];
  actual: { name: string; arguments: Record<string, any> }[];
}

export function classifyMiss(miss: MissCase): string[] {
  const tags: string[] = [];
  const exp = miss.expected;
  const act = miss.actual;
  if (exp.length === 0 && act.length > 0) {
    tags.push("false-positive");
    return tags;
  }
  if (exp.length > 0 && act.length === 0) {
    tags.push("false-negative");
    return tags;
  }
  if (exp.length !== act.length) {
    tags.push("arity");
    return tags;
  }
  for (let i = 0; i < exp.length; i++) {
    if (exp[i].name !== act[i].name) {
      tags.push("wrong-tool");
      continue;
    }
    const eArgs = exp[i].arguments ?? {};
    const aArgs = act[i].arguments ?? {};
    if ("reason" in aArgs && !("reason" in eArgs)) tags.push("spurious-reason");
    else if ("reason" in eArgs && !("reason" in aArgs)) tags.push("missing-reason");
    else if ("reason" in eArgs && eArgs.reason !== aArgs.reason) tags.push("wrong-reason");
    const eDet = eArgs.details;
    const aDet = aArgs.details;
    if (aDet !== undefined && eDet === undefined) tags.push("extra-details");
    else if (eDet !== undefined && aDet === undefined) tags.push("missing-details");
    else if (eDet !== undefined && eDet !== aDet) tags.push("span-pick");
  }
  return tags;
}

export interface FailureReport {
  misses: number;
  tags: Record<string, number>;
  cases: Record<string, string[]>;
}

export function summarizeFailures(misses: MissCase[]): FailureReport {
  const tags: Record<string, number> = {};
  const cases: Record<string, string[]> = {};
  for (const miss of misses) {
    const missTags = classifyMiss(miss);
    cases[miss.id] = missTags;
    for (const tag of missTags) tags[tag] = (tags[tag] ?? 0) + 1;
  }
  return { misses: misses.length, tags, cases };
}
