/**
 * Spoken words as a transcript writes them, in either script, and the phrase a transcript ends with.
 * The worker's spoken commands and the jev loop's release words match through the same rules.
 */

/** Cyrillic letters as Latin sounds, so a word matches in either script (`Енді` and `Andy`, `зулу` and `zulu`). */
const CYRILLIC_LATIN: Record<string, string> = Object.fromEntries(
  'а:a б:b в:v г:h ґ:g д:d е:e є:ye ё:yo ж:zh з:z и:y і:i ї:yi й:y к:k л:l м:m н:n о:o п:p р:r с:s т:t у:u ф:f х:h ц:ts ч:ch ш:sh щ:shch ь: ъ: ы:y э:e ю:yu я:ya'
    .split(' ')
    .map((pair) => pair.split(':')),
);

/** A spoken word, normalised: lower case, Latin letters without accents, `kh` as `h`. */
export function spokenWord(raw: string): string {
  const lower = raw.normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of lower) out += CYRILLIC_LATIN[ch] ?? ch;
  return out.normalize('NFD').replace(/\p{M}/gu, '').replace(/kh/g, 'h');
}

/** The words of a transcript with where each sits in it, and whether it was written in Cyrillic; punctuation is not a word. */
export function spokenWords(text: string): Array<{ word: string; start: number; end: number; cyrillic: boolean }> {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: spokenWord(m[0]),
    start: m.index,
    end: m.index + m[0].length,
    cyrillic: /\p{Script=Cyrillic}/u.test(m[0]),
  }));
}

/**
 * A phrase said at the end of an utterance (`say`, any script). `ownSentence`: it counts only as its
 * own sentence, the whole utterance or after punctuation; a capital letter alone is no boundary.
 */
export interface EndPhrase {
  say: string;
  ownSentence?: true;
}

export interface SpokenPhrase<T extends EndPhrase> {
  phrase: T;
  words: string[];
}

/** The phrases as their spoken words, longest first: the order phraseEnd tries them in. */
export function endPhrases<T extends EndPhrase>(phrases: readonly T[]): Array<SpokenPhrase<T>> {
  return phrases
    .map((phrase) => ({ phrase, words: spokenWords(phrase.say).map((w) => w.word) }))
    .sort((a, b) => b.words.length - a.words.length);
}

/**
 * The phrase a transcript ends with and where it starts (`at`), or null; `missed` when it is an
 * `ownSentence` phrase inside a sentence (`send me a copy`).
 */
export function phraseEnd<T extends EndPhrase>(
  text: string,
  phrases: ReadonlyArray<SpokenPhrase<T>>,
): (SpokenPhrase<T> & { at: number; missed?: true }) | null {
  const words = spokenWords(text);
  for (const said of phrases) {
    if (words.length < said.words.length) continue;
    const tail = words.slice(words.length - said.words.length);
    if (!tail.every((w, i) => w.word === said.words[i])) continue;
    const at = tail[0].start;
    if (said.phrase.ownSentence && !/(^|[.!?,;:–—-])\s*$/u.test(text.slice(0, at)))
      return { ...said, at, missed: true };
    return { ...said, at };
  }
  return null;
}
