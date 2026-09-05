/**
 * The languages a video can be dubbed into, and which vendor can do each.
 *
 * Two vendors, two ideas of a language. ElevenLabs takes an ISO 639-1 code
 * and covers ~30 languages with no regional accent choice; HeyGen takes a
 * display name ("English (Nigeria)", "Swahili (Kenya)") and covers 175+
 * including the African ones sellers here ask for first. The catalogue
 * below is what the studio offers; the runner turns a code into the
 * vendors that can serve it (see `dubVendorsFor`), and the router keeps
 * only those.
 *
 * What is NOT here, and why: Yoruba, Igbo, Hausa and Pidgin. Neither vendor
 * dubs into them yet (September 2026). The studio says so rather than
 * offering a language that would fail at the vendor after the seller has
 * uploaded a two-minute video.
 */

export interface DubLanguage {
  /** What the row stores. ISO 639-1, with a region suffix where the accent matters. */
  code: string;
  name: string;
  /** Where the catalogue groups it. */
  region: 'Africa' | 'Europe' | 'Asia' | 'Americas' | 'Middle East';
  /** ElevenLabs Dubbing target_lang, when it can do this one. */
  elevenlabs?: string;
  /** HeyGen video-translation language name, when it can do this one. */
  heygen?: string;
}

export const DUB_LANGUAGES: readonly DubLanguage[] = [
  // ---- Africa: HeyGen only for the regional Englishes and the local languages.
  { code: 'en-NG', name: 'English (Nigeria)', region: 'Africa', heygen: 'English (Nigeria)' },
  { code: 'en-KE', name: 'English (Kenya)', region: 'Africa', heygen: 'English (Kenya)' },
  { code: 'en-ZA', name: 'English (South Africa)', region: 'Africa', heygen: 'English (South Africa)' },
  { code: 'en-TZ', name: 'English (Tanzania)', region: 'Africa', heygen: 'English (Tanzania)' },
  { code: 'sw', name: 'Swahili', region: 'Africa', heygen: 'Swahili (Kenya)' },
  { code: 'sw-TZ', name: 'Swahili (Tanzania)', region: 'Africa', heygen: 'Swahili (Tanzania)' },
  { code: 'zu', name: 'Zulu', region: 'Africa', heygen: 'Zulu (South Africa)' },
  { code: 'af', name: 'Afrikaans', region: 'Africa', heygen: 'Afrikaans (South Africa)' },
  { code: 'am', name: 'Amharic', region: 'Africa', heygen: 'Amharic (Ethiopia)' },
  { code: 'so', name: 'Somali', region: 'Africa', heygen: 'Somali (Somalia)' },
  { code: 'ar-EG', name: 'Arabic (Egypt)', region: 'Africa', heygen: 'Arabic (Egypt)' },
  { code: 'ar-MA', name: 'Arabic (Morocco)', region: 'Africa', heygen: 'Arabic (Morocco)' },
  { code: 'fr-africa', name: 'French (for West and Central Africa)', region: 'Africa', elevenlabs: 'fr', heygen: 'French' },
  { code: 'pt-africa', name: 'Portuguese (for Angola and Mozambique)', region: 'Africa', elevenlabs: 'pt', heygen: 'Portuguese (Portugal)' },
  { code: 'mg', name: 'Malagasy', region: 'Africa', heygen: 'Malagasy (Madagascar)' },
  // ---- Europe
  { code: 'en', name: 'English', region: 'Europe', elevenlabs: 'en', heygen: 'English' },
  { code: 'en-GB', name: 'English (UK)', region: 'Europe', elevenlabs: 'en', heygen: 'English (UK)' },
  { code: 'en-US', name: 'English (US)', region: 'Americas', elevenlabs: 'en', heygen: 'English (United States)' },
  { code: 'fr', name: 'French', region: 'Europe', elevenlabs: 'fr', heygen: 'French (France)' },
  { code: 'de', name: 'German', region: 'Europe', elevenlabs: 'de', heygen: 'German (Germany)' },
  { code: 'es', name: 'Spanish (Spain)', region: 'Europe', elevenlabs: 'es', heygen: 'Spanish (Spain)' },
  { code: 'it', name: 'Italian', region: 'Europe', elevenlabs: 'it', heygen: 'Italian (Italy)' },
  { code: 'pt-PT', name: 'Portuguese (Portugal)', region: 'Europe', elevenlabs: 'pt', heygen: 'Portuguese (Portugal)' },
  { code: 'nl', name: 'Dutch', region: 'Europe', elevenlabs: 'nl', heygen: 'Dutch (Netherlands)' },
  { code: 'pl', name: 'Polish', region: 'Europe', elevenlabs: 'pl', heygen: 'Polish (Poland)' },
  { code: 'sv', name: 'Swedish', region: 'Europe', elevenlabs: 'sv', heygen: 'Swedish (Sweden)' },
  { code: 'da', name: 'Danish', region: 'Europe', elevenlabs: 'da', heygen: 'Danish (Denmark)' },
  { code: 'fi', name: 'Finnish', region: 'Europe', elevenlabs: 'fi', heygen: 'Finnish (Finland)' },
  { code: 'no', name: 'Norwegian', region: 'Europe', elevenlabs: 'no', heygen: 'Norwegian Bokmål (Norway)' },
  { code: 'cs', name: 'Czech', region: 'Europe', elevenlabs: 'cs', heygen: 'Czech (Czechia)' },
  { code: 'el', name: 'Greek', region: 'Europe', elevenlabs: 'el', heygen: 'Greek (Greece)' },
  { code: 'hu', name: 'Hungarian', region: 'Europe', elevenlabs: 'hu', heygen: 'Hungarian (Hungary)' },
  { code: 'ro', name: 'Romanian', region: 'Europe', elevenlabs: 'ro', heygen: 'Romanian (Romania)' },
  { code: 'bg', name: 'Bulgarian', region: 'Europe', elevenlabs: 'bg', heygen: 'Bulgarian (Bulgaria)' },
  { code: 'hr', name: 'Croatian', region: 'Europe', elevenlabs: 'hr', heygen: 'Croatian (Croatia)' },
  { code: 'sk', name: 'Slovak', region: 'Europe', elevenlabs: 'sk', heygen: 'Slovak (Slovakia)' },
  { code: 'uk', name: 'Ukrainian', region: 'Europe', elevenlabs: 'uk', heygen: 'Ukrainian (Ukraine)' },
  { code: 'ru', name: 'Russian', region: 'Europe', elevenlabs: 'ru', heygen: 'Russian (Russia)' },
  { code: 'tr', name: 'Turkish', region: 'Europe', elevenlabs: 'tr', heygen: 'Turkish (Türkiye)' },
  // ---- Americas
  { code: 'es-MX', name: 'Spanish (Mexico)', region: 'Americas', elevenlabs: 'es', heygen: 'Spanish (Mexico)' },
  { code: 'es-419', name: 'Spanish (Latin America)', region: 'Americas', elevenlabs: 'es', heygen: 'Spanish (Latin America)' },
  { code: 'pt-BR', name: 'Portuguese (Brazil)', region: 'Americas', elevenlabs: 'pt', heygen: 'Portuguese (Brazil)' },
  { code: 'fr-CA', name: 'French (Canada)', region: 'Americas', elevenlabs: 'fr', heygen: 'French (Canada)' },
  { code: 'ht', name: 'Haitian Creole', region: 'Americas', heygen: 'Haitian Creole (Haiti)' },
  // ---- Middle East
  { code: 'ar', name: 'Arabic', region: 'Middle East', elevenlabs: 'ar', heygen: 'Arabic' },
  { code: 'ar-SA', name: 'Arabic (Saudi Arabia)', region: 'Middle East', elevenlabs: 'ar', heygen: 'Arabic (Saudi Arabia)' },
  { code: 'ar-AE', name: 'Arabic (UAE)', region: 'Middle East', elevenlabs: 'ar', heygen: 'Arabic (United Arab Emirates)' },
  { code: 'he', name: 'Hebrew', region: 'Middle East', heygen: 'Hebrew (Israel)' },
  { code: 'fa', name: 'Persian', region: 'Middle East', heygen: 'Persian (Iran)' },
  // ---- Asia
  { code: 'hi', name: 'Hindi', region: 'Asia', elevenlabs: 'hi', heygen: 'Hindi (India)' },
  { code: 'en-IN', name: 'English (India)', region: 'Asia', elevenlabs: 'en', heygen: 'English (India)' },
  { code: 'ta', name: 'Tamil', region: 'Asia', elevenlabs: 'ta', heygen: 'Tamil (India)' },
  { code: 'te', name: 'Telugu', region: 'Asia', heygen: 'Telugu (India)' },
  { code: 'bn', name: 'Bengali', region: 'Asia', heygen: 'Bengali (India)' },
  { code: 'ur', name: 'Urdu', region: 'Asia', heygen: 'Urdu (Pakistan)' },
  { code: 'zh', name: 'Chinese (Mandarin, Simplified)', region: 'Asia', elevenlabs: 'zh', heygen: 'Chinese (Mandarin, Simplified)' },
  { code: 'zh-HK', name: 'Chinese (Cantonese, Traditional)', region: 'Asia', heygen: 'Chinese (Cantonese, Traditional)' },
  { code: 'ja', name: 'Japanese', region: 'Asia', elevenlabs: 'ja', heygen: 'Japanese (Japan)' },
  { code: 'ko', name: 'Korean', region: 'Asia', elevenlabs: 'ko', heygen: 'Korean (Korea)' },
  { code: 'id', name: 'Indonesian', region: 'Asia', elevenlabs: 'id', heygen: 'Indonesian (Indonesia)' },
  { code: 'ms', name: 'Malay', region: 'Asia', elevenlabs: 'ms', heygen: 'Malay (Malaysia)' },
  { code: 'fil', name: 'Filipino', region: 'Asia', elevenlabs: 'fil', heygen: 'Filipino (Philippines)' },
  { code: 'vi', name: 'Vietnamese', region: 'Asia', elevenlabs: 'vi', heygen: 'Vietnamese (Vietnam)' },
  { code: 'th', name: 'Thai', region: 'Asia', heygen: 'Thai (Thailand)' },
];

/** Vendor rows that dub into a language, in the order the router should try them. */
export const DUB_VENDOR_KEYS = { elevenlabs: 'elevenlabs:dubbing-v1', heygen: 'heygen:translate' } as const;

export function dubLanguage(code: string): DubLanguage | undefined {
  return DUB_LANGUAGES.find((l) => l.code === code);
}

/**
 * Which of the two known vendors can serve a language, and which cannot.
 * Vendors this table does not know (a stub, a future one) are neither — the
 * router leaves them alone.
 */
export function dubVendorsFor(code: string): { can: string[]; cannot: string[] } {
  const l = dubLanguage(code);
  const can: string[] = [];
  const cannot: string[] = [];
  (l?.elevenlabs ? can : cannot).push(DUB_VENDOR_KEYS.elevenlabs);
  (l?.heygen ? can : cannot).push(DUB_VENDOR_KEYS.heygen);
  return { can, cannot };
}

/** Languages the studio can offer given which vendors are configured here. */
export function dubLanguagesAvailable(has: (providerKey: string) => boolean): DubLanguage[] {
  return DUB_LANGUAGES.filter((l) => (l.elevenlabs && has(DUB_VENDOR_KEYS.elevenlabs)) || (l.heygen && has(DUB_VENDOR_KEYS.heygen)));
}

/** Source languages a seller can name instead of letting the vendor listen. Codes are ISO 639-1. */
export const DUB_SOURCE_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'auto', name: 'Detect it' },
  { code: 'en', name: 'English' }, { code: 'fr', name: 'French' }, { code: 'pt', name: 'Portuguese' }, { code: 'es', name: 'Spanish' }, { code: 'ar', name: 'Arabic' },
  { code: 'sw', name: 'Swahili' }, { code: 'de', name: 'German' }, { code: 'hi', name: 'Hindi' }, { code: 'zh', name: 'Chinese' }, { code: 'it', name: 'Italian' },
];
