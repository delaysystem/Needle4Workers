/** First-match rule engine for pre-model routing (port of Needle4Humans
 * scripts/fastpath.py — same semantics, same spec format).
 *
 * Rule SPECS are data (fastpath.json); this module holds no task literals.
 * First match in file order wins; no match returns null so the caller
 * falls through to the model.
 *
 * UNICODE BRIDGE (the one deliberate difference from a naive port):
 * Python's `\w`/`\b` are Unicode-aware, JavaScript's are ASCII-only.
 * At load, every `\w` becomes the Latin word class below and every `\b`
 * becomes the equivalent explicit boundary, so matching behavior is
 * identical for the 7 supported languages. No `/u` flag: it would
 * reject the patterns' identity escapes. Equivalence is proven, not
 * assumed: test/fastpath-cases.test.ts runs all adversarial cases and
 * the golden static gate asserts every fire matches its gold exactly.
 */

export interface RuleCall {
  name: string;
  arguments: Record<string, any>;
}

export interface Rule {
  id: string;
  pattern: string;
  calls: RuleCall[];
  case?: "sensitive" | "insensitive";
}

interface CompiledRule extends Rule {
  re: RegExp;
}

// Latin letters (covers EN/DE/FR/ES/IT/NL/PL diacritics) + digits + _.
const WORD_CH = "A-Za-z0-9_\\u00C0-\\u024F\\u1E00-\\u1EFF";
const WORD_CLASS = `[${WORD_CH}]`;
// ASCII \b is (?:(?<!\w)(?=\w)|(?<=\w)(?!\w)); this is the same shape
// with the Unicode word class above.
const UB =
  `(?:(?<![${WORD_CH}])(?=[${WORD_CH}])|(?<=[${WORD_CH}])(?![${WORD_CH}]))`;

function toUnicodeRegex(source: string, caseSensitive: boolean): RegExp {
  // Order matters: expand \w first (it introduces no new \b), then \b.
  // Neither appears inside a [...] class in any shipped spec; the
  // loader test asserts the transform only touches bare tokens.
  const expanded = source
    .split("\\w")
    .join(WORD_CLASS)
    .split("\\b")
    .join(UB);
  return new RegExp(expanded, caseSensitive ? "" : "i");
}

export function loadRules(spec: unknown): CompiledRule[] {
  if (typeof spec !== "object" || spec === null || !Array.isArray((spec as any).rules) || (spec as any).rules.length === 0) {
    throw new Error("fastpath spec needs a non-empty 'rules' list");
  }
  const seen = new Set<string>();
  return (spec as any).rules.map((rule: any, index: number) => {
    const where = `rule #${index}`;
    if (typeof rule !== "object" || rule === null) throw new Error(`${where} is not an object`);
    if (typeof rule.id !== "string" || !rule.id) throw new Error(`${where} needs a string 'id'`);
    if (seen.has(rule.id)) throw new Error(`${where} duplicates rule id '${rule.id}'`);
    seen.add(rule.id);
    if (typeof rule.pattern !== "string" || !rule.pattern) {
      throw new Error(`${where} ('${rule.id}') needs a 'pattern' string`);
    }
    if (!Array.isArray(rule.calls)) throw new Error(`${where} ('${rule.id}') needs a 'calls' list`);
    for (const call of rule.calls) {
      if (typeof call !== "object" || call === null || typeof call.name !== "string" ||
          (call.arguments !== undefined && (typeof call.arguments !== "object" || call.arguments === null))) {
        throw new Error(`${where} ('${rule.id}') calls need {name, arguments} objects`);
      }
    }
    let re: RegExp;
    try {
      re = toUnicodeRegex(rule.pattern, rule.case === "sensitive");
    } catch (err: any) {
      throw new Error(`${where} ('${rule.id}') bad regex: ${err?.message ?? err}`);
    }
    return { ...rule, re };
  });
}

export function matchRule(rules: CompiledRule[], query: string): CompiledRule | null {
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    if (rule.re.test(query)) return rule;
  }
  return null;
}

export function applyRules(rules: CompiledRule[], query: string): RuleCall[] | null {
  const rule = matchRule(rules, query);
  if (!rule) return null;
  return rule.calls.map((c) => ({ name: c.name, arguments: { ...(c.arguments ?? {}) } }));
}

export interface RuleCase {
  query: string;
  calls: RuleCall[] | null;
}

function canon(value: any): any {
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value).sort().map((k) => [k, canon(value[k])])
    );
  }
  return value;
}

export function callsEqual(a: RuleCall[] | null, b: RuleCall[] | null): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export function runCases(rules: CompiledRule[], cases: RuleCase[]): string[] {
  const failures: string[] = [];
  cases.forEach((c, index) => {
    const got = applyRules(rules, c.query);
    if (c.calls === null || c.calls === undefined) {
      if (got !== null) failures.push(`case #${index} should fall through but fired: ${JSON.stringify(c.query)}`);
    } else if (!callsEqual(got, c.calls)) {
      failures.push(`case #${index} want ${JSON.stringify(c.calls)} got ${JSON.stringify(got)}: ${JSON.stringify(c.query)}`);
    }
  });
  return failures;
}
