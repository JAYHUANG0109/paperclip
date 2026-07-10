import type { Resource } from "i18next";

import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

// Only the locales the app can actually select (AppLocale = "en" | "zh-TW";
// see resolveLocale.ts and the language switcher). The repo ships ~40 language
// files (~328 KB each) that no UI path can ever reach — globbing them all in
// `eager` mode bundled ~13 MB of unreachable JSON straight into the entry chunk,
// which dominated first-load time. Restricting the glob to the two real locales
// keeps the simple synchronous init while cutting the entry by ~12 MB. Add a
// pattern here (and to AppLocale) if a new language is genuinely wired up.
const localeModules = import.meta.glob(["./locales/en.json", "./locales/zh-TW.json"], {
  eager: true,
  import: "default",
}) as Record<string, unknown>;

export const localeMessages = Object.fromEntries(
  Object.entries(localeModules).map(([path, messages]) => {
    const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
    if (!locale) {
      throw new Error(`Invalid locale file path: ${path}`);
    }
    return [locale, messages];
  }),
);

if (!(DEFAULT_LOCALE in localeMessages)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

for (const [locale, messages] of Object.entries(localeMessages)) {
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // In development, fail loudly so locale drift (e.g. a key added to one
    // language but not English) is caught immediately. In production, NEVER
    // crash the whole app over a missing translation — log it and continue;
    // i18next falls back to the default locale / key. A blank site for every
    // user is far worse than one untranslated string.
    if (import.meta.env.DEV) {
      throw new Error(`Invalid ${locale} locale messages: ${message}`);
    }
    console.error(`[i18n] Invalid ${locale} locale messages (continuing with fallbacks): ${message}`);
  }
}

export const supportedLocales = Object.keys(localeMessages);

export const i18nextResources: Resource = Object.fromEntries(
  Object.entries(localeMessages).map(([locale, messages]) => [locale, { translation: messages }]),
) as Resource;

export type SupportedLocale = keyof typeof localeMessages;
