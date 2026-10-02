/**
 * Keyword ranking for `cairn catalog --query`. Deterministic and offline:
 * names, descriptions and comments are split into word stems (camelCase,
 * snake_case and kebab-case boundaries included) and every query token
 * scores the best field it hits. Field weights put names first, then
 * descriptions/intents/tags, then comments and other text.
 */

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "then",
  "this",
  "to",
  "with",
]);

/** Field weights: name > description/intent/tags > comments/other text. */
const FIELD_WEIGHTS = {
  name: 3,
  description: 2,
  intent: 2,
  tags: 2,
  inputs: 1.5,
  comment: 1,
  text: 1,
} as const;
export type RankFieldName = keyof typeof FIELD_WEIGHTS;

export interface RankField {
  field: RankFieldName;
  text: string | undefined;
}

export interface RankResult {
  score: number;
  matched: Array<{ token: string; field: string }>;
}

/**
 * Phrasal verbs (stem → particles) written as two words or one: `log in`,
 * `logged in`, `sign_in` and `signIn` all become one token, so "log in"
 * finds `login_as_admin` although `in` is a stopword.
 */
const PHRASAL: Record<string, readonly string[]> = {
  log: ["in", "out", "on", "off"],
  sign: ["in", "out", "up", "on", "off"],
  set: ["up"],
  check: ["in", "out"],
  back: ["up"],
  clean: ["up"],
  tear: ["down"],
};

/** Spellings of the same action, folded to one token. */
const SYNONYMS: Record<string, string> = {
  signin: "login",
  logon: "login",
  signon: "login",
  signout: "logout",
  logoff: "logout",
};

/**
 * Word stems of `text`: split on camelCase/acronym boundaries and anything
 * that is not a letter or digit, lowercased, stopwords and 1-char tokens
 * dropped, light suffix stemming (`fields` → `field`, `saved` → `sav`,
 * `logged` → `log`), phrasal verbs joined (`log in` → `login`) and a few
 * synonyms folded (`sign in` → `login`).
 */
export function tokenize(text: string): string[] {
  const spaced = text
    // A plural acronym (`URLs`) is one word.
    .replace(/([A-Z]{2,})s(?![a-z])/g, "$1S")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const words = spaced
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const raw = words[i]!;
    const stemmed = stem(raw);
    const next = words[i + 1];
    if (next !== undefined && PHRASAL[stemmed]?.includes(next)) {
      out.push(fold(`${stemmed}${next}`));
      i++;
      continue;
    }
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(fold(stemmed));
  }
  return out;
}

function fold(token: string): string {
  return SYNONYMS[token] ?? token;
}

function stem(word: string): string {
  let w = word;
  let stripped = false;
  if (w.length > 5 && w.endsWith("ing")) {
    w = w.slice(0, -3);
    stripped = true;
  } else if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) {
    w = w.slice(0, -2);
    stripped = true;
  } else if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses"))
    w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss"))
    w = w.slice(0, -1);
  // `logged` → `log`, `submitted` → `submit` (but `filled` → `fill`).
  if (stripped && /([b-df-hj-kmnp-rtv-xz])\1$/.test(w)) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** Unique query stems in authored order. */
export function queryTokens(query: string): string[] {
  return [...new Set(tokenize(query))];
}

/**
 * Score one row: every query token takes the best weighted field it hits
 * (an exact stem match counts fully; a prefix match of ≥4 characters
 * counts half), plus a bonus when every token hit. 0 = no match.
 */
export function rank(
  tokens: readonly string[],
  fields: RankField[],
): RankResult {
  if (tokens.length === 0) return { score: 0, matched: [] };
  const fieldTokens = fields
    .filter((f) => f.text !== undefined && f.text.length > 0)
    .map((f) => ({ field: f.field, stems: new Set(tokenize(f.text!)) }));
  let score = 0;
  const matched: RankResult["matched"] = [];
  for (const token of tokens) {
    let best = 0;
    let bestField: string | undefined;
    for (const { field, stems } of fieldTokens) {
      const quality = matchQuality(token, stems);
      const value = quality * FIELD_WEIGHTS[field];
      if (value > best) {
        best = value;
        bestField = field;
      }
    }
    if (bestField !== undefined) {
      score += best;
      matched.push({ token, field: bestField });
    }
  }
  if (matched.length === tokens.length && tokens.length > 1) score += 1;
  return { score: Math.round(score * 100) / 100, matched };
}

function matchQuality(token: string, stems: Set<string>): number {
  if (stems.has(token)) return 1;
  for (const candidate of stems) {
    const [short, long] =
      candidate.length < token.length ? [candidate, token] : [token, candidate];
    if (short.length >= 4 && long.startsWith(short)) return 0.5;
  }
  return 0;
}
