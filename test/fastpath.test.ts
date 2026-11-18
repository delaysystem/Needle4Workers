import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { HANDOFF_TOOL, matchFastpath } from "../src/lib/fastpath";

const ROOT = path.resolve(import.meta.dir, "..");
const HANDOFF = [{ name: HANDOFF_TOOL }];
const OTHER = [{ name: "get_weather" }];

describe("matchFastpath positives", () => {
  const cases: [string, string][] = [
    ["en", "Can I talk to a human?"],
    ["en", "Please, can I please speak with a real person"],
    ["en", "GET ME A HUMAN"],
    ["en", "Get me an agent."],
    ["en", "Connect me with a representative"],
    ["en", "Put me through to customer service staff"],
    ["en", "I want to talk to a human"],
    ["en", "I need a real person"],
    ["en", "Is there a real person I can speak with?"],
    ["en", "I would like to talk with a human being."],
    ["en", "Transfer this chat to an agent."],
    ["en", "I insist on speaking to a person."],
    ["en", "Kindly connect me with a live representative."],
    ["en", "Can you transfer me???"],
    ["en", "Get me a human being."],
    ["en", "Transfer me to a human being."],
    ["en", "I insist on speaking to a human being."],
    ["de", "Kann ich mit einem Menschen sprechen?"],
    ["de", "Bitte, geben Sie mir eine echte Person."],
    ["de", "Verbinden Sie mich mit einem Mitarbeiter"],
    ["de", "Ich möchte mit einer echten Person sprechen"],
    ["de", "Ich möchte gerne mit einem Menschen sprechen."],
    ["de", "Stellen Sie mich bitte zum Kundenservice durch."],
    ["de", "Gibt es eine echte Person, mit der ich sprechen kann?"],
    ["de", "Leiten Sie diesen Chat an einen Mitarbeiter weiter."],
    ["de", "Ich bestehe darauf, mit einer Person zu sprechen."],
    ["de", "Verbinden Sie mich bitte mit einem echten Ansprechpartner."],
    ["de", "Können Sie mich weiterleiten???"],
    ["fr", "Puis-je parler à un humain ?"],
    ["fr", "Mettez-moi en relation avec un conseiller."],
    ["fr", "Y a-t-il une vraie personne à qui je puisse parler ?"],
    ["fr", "Passez-moi un agent"],
    ["fr", "Je voudrais parler avec un être humain."],
    ["fr", "Transférez-moi au personnel du service client."],
    ["fr", "Transférez cette conversation à un agent."],
    ["fr", "J'insiste pour parler à une personne."],
    ["fr", "Mettez-moi en relation avec un représentant en chair et en os."],
    ["fr", "Vous pouvez me transférer ???"],
    ["es", "¿Puedo hablar con un humano?"],
    ["es", "Páseme con una persona."],
    ["es", "Comuníqueme con un representante"],
    ["es", "¿Hay una persona real con la que pueda hablar?"],
    ["es", "Quisiera hablar con un ser humano."],
    ["es", "Comuníqueme con el personal de atención al cliente."],
    ["es", "Transfiera este chat a un agente."],
    ["es", "Insisto en hablar con una persona."],
    ["es", "Póngame en contacto con un representante en vivo."],
    ["es", "¿Pueden transferirme???"],
    ["it", "Posso parlare con un umano?"],
    ["it", "Mi colleghi con un rappresentante."],
    ["it", "Mi dia una persona"],
    ["it", "C'è una persona vera con cui posso parlare"],
    ["it", "Vorrei parlare con un essere umano."],
    ["it", "Mi metta in contatto con il personale del servizio clienti."],
    ["it", "Trasferisca questa chat a un operatore."],
    ["it", "Insisto per parlare con una persona."],
    ["it", "Mi colleghi con un rappresentante in carne e ossa."],
    ["it", "Potete trasferirmi???"],
    ["nl", "Kan ik met een medewerker spreken?"],
    ["nl", "Verbind me door met een medewerker."],
    ["nl", "Geef me een persoon"],
    ["nl", "Is er een echt persoon met wie ik kan spreken"],
    ["nl", "Ik zou graag met een mens spreken."],
    ["nl", "Verbind me door met de klantenservice."],
    ["nl", "Zet dit gesprek door naar een medewerker."],
    ["nl", "Ik sta erop met een persoon te spreken."],
    ["nl", "Breng me in contact met een levende vertegenwoordiger."],
    ["nl", "Kunt u me doorverbinden???"],
    ["pl", "Czy mogę porozmawiać z człowiekiem?"],
    ["pl", "Połącz mnie z konsultantem."],
    ["pl", "Proszę o człowieka"],
    ["pl", "Czy jest jakaś prawdziwa osoba, z którą mogę porozmawiać"],
    ["pl", "Chciałbym porozmawiać z człowiekiem."],
    ["pl", "Proszę połączyć mnie z obsługą klienta."],
    ["pl", "Czy jest tu prawdziwa osoba, z którą mogę porozmawiać?"],
    ["pl", "Przekażcie tę rozmowę konsultantowi."],
    ["pl", "Nalegam na rozmowę z człowiekiem."],
    ["pl", "Połączcie mnie z żywym przedstawicielem."],
    ["pl", "Możecie mnie przełączyć???"],
  ];
  for (const [lang, query] of cases) {
    test(`${lang}: ${query.slice(0, 48)}`, () => {
      expect(matchFastpath(query, HANDOFF)).toBe(true);
    });
  }
});

describe("matchFastpath negatives", () => {
  const tricky = [
    "", "   ", "human", "Hello?",
    // Substring traps: person/personnel, human/humanities/humanoid.
    "I need personal advice.",
    "Contact HR personnel for benefits.",
    "Get me a humanities textbook.",
    "I want to talk to a humanoid robot.",
    "Parlez à un humanitaire s'il vous plaît.",
    // Continued sentences change the meaning — the model decides these.
    "Can I talk to a human resources representative about my 401k?",
    "Please connect me with an agent Smith costume for Halloween.",
    "Get me a person. Please hurry.",
    "Kann ich mit einem Menschen sprechen, der Deutsch kann?",
    // Multi-sentence sarcasm/context — never a bare ask.
    "Brilliant. A robot. Just what my broken boiler needed. Get me a person.",
    "I paid for premium support. Every reply still comes from a bot. Get me staff.",
    // Known false-positive shapes from the eval misses.
    "My sister works in support, she told me to try here first.",
    "Your support team won an award, congratulations.",
    "What payment methods do you accept?",
    "How do I change my delivery address?",
    "Meine Schwester arbeitet im Support, sie sagte, ich soll es zuerst hier versuchen.",
    "Comment modifier mon adresse de livraison ?",
    // Bare nouns and fragments without an ask.
    "human being", "A real person would know.", "Agents are busy today.",
    // Near-miss shapes of the formal-ask patterns: trailing scope/conditions
    // and non-human targets keep these with the model.
    "I would like to talk with a human resources manager about benefits.",
    "Transfer this chat to an agent Smith costume for Halloween.",
    "I insist on speaking to a person who speaks German.",
    "Kindly connect me with a live representative if one is free, otherwise email me.",
    "Can you transfer me to voicemail???",
    "Stellen Sie mich bitte zum Kundenservice durch, aber erst nach 18 Uhr.",
    "Leiten Sie diesen Chat an einen Mitarbeiter weiter, der sich mit Rechnungen auskennt.",
    "Transférez cette conversation à un agent conversationnel.",
    "J'insiste pour parler à une personne morale.",
    "Insisto en hablar con una persona jurídica.",
    "Insisto per parlare con una persona giuridica.",
    "Ik sta erop met een persoon te spreken die Nederlands spreekt.",
    "Breng me in contact met een levende vertegenwoordiger van de schildpaddenclub.",
    "Połączcie mnie z żywym przedstawicielem handlowym.",
    "Możecie mnie przełączyć na pocztę głosową???",
  ];
  for (const query of tricky) {
    test(`refuses: ${query.slice(0, 52) || "(empty)"}`, () => {
      expect(matchFastpath(query, HANDOFF)).toBe(false);
    });
  }
  test("requires the declared handoff tool", () => {
    expect(matchFastpath("Get me a human.", [])).toBe(false);
    expect(matchFastpath("Get me a human.", OTHER)).toBe(false);
    expect(matchFastpath("Get me a human.", [{ function: { name: HANDOFF_TOOL } }])).toBe(true);
  });
});

describe("golden implication proof", () => {
  test("a match implies the gold is exactly [handoff({general})] — all 252 cases", () => {
    const rows = fs.readFileSync(path.join(ROOT, "eval/goldens/eval.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.length).toBe(252);
    const violations: string[] = [];
    let hits = 0;
    for (const row of rows) {
      if (!matchFastpath(row.query, HANDOFF)) continue;
      hits++;
      const ok =
        Array.isArray(row.answers) && row.answers.length === 1 &&
        row.answers[0].name === HANDOFF_TOOL &&
        JSON.stringify(row.answers[0].arguments ?? {}) === JSON.stringify({ reason: "general" });
      if (!ok) violations.push(`${row.id}: ${JSON.stringify(row.answers)}`);
    }
    expect(violations).toEqual([]);
    console.log(`fastpath fires on ${hits}/252 goldens, 0 implication violations`);
  });
});
