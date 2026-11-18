/** Ultra-narrow regex fast path for unambiguous bare handoff asks.
 *
 * SAFETY CONTRACT (all three enforced by tests in test/fastpath.test.ts):
 * 1. Every pattern is full-string anchored: politeness wrappers and trailing
 *    punctuation only. Anything longer, hedged, or multi-sentence falls
 *    through to the model.
 * 2. Person-words match standalone only (human, not humanities/humanoid;
 *    person, not personal/personnel) via explicit alternation + end anchor.
 * 3. `matchFastpath` returns true ONLY when the caller declared the
 *    `request_human_handoff` tool AND the matched ask takes no arguments,
 *    so a hit can only ever produce `[handoff({general})]` — the
 *    fail-safe direction for a support router.
 *
 * Golden proof: for every one of the 252 golden cases, a match implies
 * `expected == [handoff({general})]`. If that test ever fails, the
 * patterns got too broad — narrow them, never widen the test.
 *
 * This is layer 2 (bare asks). Layer 1 is the verdict rules engine
 * (src/lib/rules.ts + fastpath.json), consulted first; it handles
 * structural families with full v3 verdicts including abstain.
 */

export const HANDOFF_TOOL = "request_human_handoff";

// Optional politeness wrappers, per language family.
const PLEASE = {
  en: String.raw`(?:please[,\s]+)?`,
  de: String.raw`(?:bitte[,\s]+)?`,
  fr: String.raw`(?:s'il vous plaît[,\s]+)?`,
  es: String.raw`(?:por favor[,\s]+)?`,
  it: String.raw`(?:per favore[,\s]+)?`,
  nl: String.raw`(?:alstublieft[,\s]+)?`,
  pl: String.raw`(?:proszę[,\s]+)?`,
};
// Trailing punctuation/space only — nothing that could change the meaning.
const TAIL = String.raw`[?.!\s]*$`;

const PATTERNS: RegExp[] = [
  // ---- English ----
  new RegExp(`^${PLEASE.en}can i (?:please\\s+)?(?:talk|speak)(?:\\s+to|\\s+with)\\s+(?:support(?: staff)?|someone|(?:a|an)(?:\\s+(?:real|actual|live))?\\s+(?:human being|human|person|agent|representative|operator))${TAIL}`, "iu"),
  new RegExp(`^how do i reach a real person${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.en}(?:get|give) me (?:a|an)(?:\\s+(?:real|actual|live))?\\s+(?:human being|human|person|agent|representative|operator)${TAIL}`, "iu"),
  new RegExp(`^(?:kindly[,\\s]+)?${PLEASE.en}connect me with (?:a|an)\\s+(?:(?:live|real|actual)\\s+)?(?:representative|agent|operator|human)${TAIL}`, "iu"),
  new RegExp(`^i would like to (?:talk|speak) (?:to|with) (?:a |an )?(?:human being|human|person|agent|representative|operator)${TAIL}`, "iu"),
  new RegExp(`^transfer (?:this chat|me) to (?:a |an )?(?:human being|human|person|agent|representative|operator|support)${TAIL}`, "iu"),
  new RegExp(`^i insist on (?:speaking|talking) to (?:a )?(?:human being|human|person|agent|representative)${TAIL}`, "iu"),
  new RegExp(`^(?:can|could) you transfer me${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.en}put me through to (?:customer service(?: staff)?|support|an agent)${TAIL}`, "iu"),
  new RegExp(`^i (?:want|need) to talk to a human${TAIL}`, "iu"),
  new RegExp(`^i need a real person${TAIL}`, "iu"),
  new RegExp(`^is there a real person i can (?:speak|talk) with${TAIL}`, "iu"),
  // ---- German ----
  new RegExp(`^${PLEASE.de}kann ich mit (?:dem support|einem (?:menschen|mitarbeiter)|einer echten person) sprechen${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.de}geben sie mir (?:einen mitarbeiter|eine echte person)${TAIL}`, "iu"),
  new RegExp(`^verbinden sie mich (?:bitte )?mit (?:einem mitarbeiter|einem menschen|einem echten ansprechpartner)${TAIL}`, "iu"),
  new RegExp(`^ich (?:möchte|will)(?: gerne)? mit (?:einem menschen|einer echten person) sprechen${TAIL}`, "iu"),
  new RegExp(`^stellen sie mich (?:bitte )?(?:zum kundenservice|zu einem mitarbeiter) durch${TAIL}`, "iu"),
  new RegExp(`^gibt es eine echte person, mit der ich sprechen kann${TAIL}`, "iu"),
  new RegExp(`^leiten sie diesen chat an einen mitarbeiter weiter${TAIL}`, "iu"),
  new RegExp(`^ich bestehe darauf, mit einer person zu sprechen${TAIL}`, "iu"),
  new RegExp(`^können sie mich weiterleiten${TAIL}`, "iu"),
  // ---- French ----
  new RegExp(`^${PLEASE.fr}puis-je parler (?:à (?:un humain|une vraie personne|un agent)|au support)${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.fr}mettez-moi en relation avec (?:un conseiller|un représentant en chair et en os)${TAIL}`, "iu"),
  new RegExp(`^y a-t-il une vraie personne à qui je (?:puisse|peux) parler${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.fr}passez-moi (?:un agent|une personne)${TAIL}`, "iu"),
  new RegExp(`^je voudrais parler avec un être humain${TAIL}`, "iu"),
  new RegExp(`^transférez-moi au personnel du service client${TAIL}`, "iu"),
  new RegExp(`^transférez cette conversation à un agent${TAIL}`, "iu"),
  new RegExp(`^j'insiste pour parler à une personne${TAIL}`, "iu"),
  new RegExp(`^vous pouvez me transférer${TAIL}`, "iu"),
  // ---- Spanish ----
  new RegExp(`^${PLEASE.es}¿?(?:puedo|podría) hablar con (?:un humano|una persona real|un agente|soporte)[?.!\\s¿]*$`, "iu"),
  new RegExp(`^${PLEASE.es}páseme con (?:una persona|un agente)${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.es}comuníqueme con (?:un representante|el personal de atención al cliente)${TAIL}`, "iu"),
  new RegExp(`^¿?hay una persona real con la que pueda hablar[?.!\\s]*$`, "iu"),
  new RegExp(`^${PLEASE.es}quisiera hablar con un ser humano${TAIL}`, "iu"),
  new RegExp(`^transfiera este chat a un agente${TAIL}`, "iu"),
  new RegExp(`^insisto en hablar con una persona${TAIL}`, "iu"),
  new RegExp(`^póngame en contacto con un representante en vivo${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.es}¿?pueden transferirme[?.!\\s¿]*$`, "iu"),
  // ---- Italian ----
  new RegExp(`^${PLEASE.it}posso parlare con (?:un umano|una persona vera|una persona reale|un operatore|il supporto)${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.it}mi colleghi con un rappresentante(?: in carne e ossa)?${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.it}vorrei parlare con un essere umano${TAIL}`, "iu"),
  new RegExp(`^mi metta in contatto con il personale del servizio clienti${TAIL}`, "iu"),
  new RegExp(`^trasferisca questa chat a un operatore${TAIL}`, "iu"),
  new RegExp(`^insisto per parlare con una persona${TAIL}`, "iu"),
  new RegExp(`^potete trasferirmi${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.it}mi (?:dia|passi) una persona${TAIL}`, "iu"),
  new RegExp(`^c'è una persona vera con cui posso parlare${TAIL}`, "iu"),
  // ---- Dutch ----
  new RegExp(`^${PLEASE.nl}kan ik met (?:de support|een mens|een echt persoon|een medewerker) spreken${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.nl}verbind me door met (?:een medewerker|de klantenservice)${TAIL}`, "iu"),
  new RegExp(`^ik zou graag met een (?:mens|medewerker|persoon) spreken${TAIL}`, "iu"),
  new RegExp(`^zet dit gesprek door naar een medewerker${TAIL}`, "iu"),
  new RegExp(`^ik sta erop met een persoon te spreken${TAIL}`, "iu"),
  new RegExp(`^breng me in contact met een levende vertegenwoordiger${TAIL}`, "iu"),
  new RegExp(`^kunt u me doorverbinden${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.nl}geef me een (?:medewerker|persoon)${TAIL}`, "iu"),
  new RegExp(`^is er een echt persoon met wie ik kan spreken${TAIL}`, "iu"),
  // ---- Polish ----
  new RegExp(`^${PLEASE.pl}czy mogę porozmawiać z (?:człowiekiem|prawdziwą osobą|konsultantem|obsługą|żywą osobą)${TAIL}`, "iu"),
  new RegExp(`^${PLEASE.pl}połącz mnie z konsultantem${TAIL}`, "iu"),
  new RegExp(`^proszę o (?:człowieka|konsultanta)${TAIL}`, "iu"),
  new RegExp(`^czy jest jakaś prawdziwa osoba, z którą mogę porozmawiać${TAIL}`, "iu"),
  new RegExp(`^chciałbym porozmawiać z człowiekiem${TAIL}`, "iu"),
  new RegExp(`^proszę połączyć mnie z obsługą klienta${TAIL}`, "iu"),
  new RegExp(`^czy jest tu prawdziwa osoba, z którą mogę porozmawiać${TAIL}`, "iu"),
  new RegExp(`^przekażcie tę rozmowę konsultantowi${TAIL}`, "iu"),
  new RegExp(`^nalegam na rozmowę z człowiekiem${TAIL}`, "iu"),
  new RegExp(`^połączcie mnie z żywym przedstawicielem${TAIL}`, "iu"),
  new RegExp(`^możecie mnie przełączyć${TAIL}`, "iu"),
];

/** True only for an unambiguous bare handoff ask AND a declared handoff tool. */
export function matchFastpath(query: string, tools: any[]): boolean {
  const declared = (tools ?? []).some((t) => {
    const fn = t?.function ?? t;
    return fn && fn.name === HANDOFF_TOOL;
  });
  if (!declared) return false;
  const text = query.trim().replace(/\s+/g, " ");
  if (text.length === 0) return false;
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
