/**
 * Manager-name trimming, shared by providers whose manager field can carry a
 * real full name (today: Yahoo's nickname, e.g. "Matt Ruske").
 *
 * The digest and agent only ever need a first name (docs/ingestion-checklist.md
 * says the same for the manual path), and full names shouldn't leave the data
 * layer — so trim at the boundary, same rule as every other tool field.
 *
 *   "Matt Ruske"   → "Matt"
 *   "kevin C"      → "kevin C"   (a single trailing initial survives: two Kyles)
 *   "___"          → null        (Yahoo's hidden-name placeholders)
 *   "--hidden--"   → null
 */
/**
 * Handles the first-token rule gets wrong. Keyed by the exact Yahoo nickname;
 * the value is what the digest should call them. Add a line when a manager
 * picks a nickname like "Extreme Dan" (first token "Extreme" is not a name).
 */
const OVERRIDES: Record<string, string> = {
  "Extreme Dan": "Dan",
};

export function firstName(nickname: string | null | undefined): string | null {
  if (!nickname) return null;
  const trimmed = nickname.trim();
  if (trimmed in OVERRIDES) return OVERRIDES[trimmed];
  if (/^[\s\-_.]*(hidden)?[\s\-_.]*$/i.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  const [first, second] = tokens;
  const initial = second && /^\p{L}\.?$/u.test(second) ? ` ${second}` : "";
  return first + initial;
}
