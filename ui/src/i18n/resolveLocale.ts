import { i18n } from "./index";

export type AppLocale = "en" | "zh-TW";

const OVERRIDE_KEY = "paperclip.locale.override";
const RESOLVED_KEY = "paperclip.locale.resolved";

// Accounts that should see English by default. Everyone else defaults to
// Traditional Chinese. Add emails here as needed (the user will note them).
const ENGLISH_EMAILS = new Set<string>(["jay20020109@seasonart.org"]);

function isAppLocale(value: unknown): value is AppLocale {
  return value === "en" || value === "zh-TW";
}

export function getOverride(): AppLocale | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_KEY);
    return isAppLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function defaultLocaleForEmail(email?: string | null): AppLocale {
  const normalized = email?.trim().toLowerCase();
  if (normalized && ENGLISH_EMAILS.has(normalized)) return "en";
  return "zh-TW";
}

/** Manual override (from the switcher) wins; otherwise default by account. */
export function resolveLocale(email?: string | null): AppLocale {
  return getOverride() ?? defaultLocaleForEmail(email);
}

export function applyLocale(locale: AppLocale): void {
  if (i18n.language !== locale) {
    void i18n.changeLanguage(locale);
  }
  try {
    localStorage.setItem(RESOLVED_KEY, locale);
  } catch {
    /* ignore */
  }
}

/** User picked a language explicitly from the switcher. */
export function setLocaleOverride(locale: AppLocale): void {
  try {
    localStorage.setItem(OVERRIDE_KEY, locale);
  } catch {
    /* ignore */
  }
  applyLocale(locale);
}
