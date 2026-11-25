import { routing } from "./routing";

/**
 * The path a locale is served at.
 * localePrefix is "as-needed", so only the default locale has no prefix.
 * `/en` is not a page but a 307 to `/`, so canonical and hreflang must not point there.
 */
export function localePath(locale: string, path = ""): string {
  const prefix = locale === routing.defaultLocale ? "" : `/${locale}`;

  return `${prefix}${path}` || "/";
}

/** Open Graph wants og:locale as language_TERRITORY; bare "en" or "ja" is outside the spec. */
export function ogLocale(locale: string): string {
  return locale === "ja" ? "ja_JP" : "en_US";
}

/** og:locale:alternate for every locale but this one. */
export function ogAlternateLocales(locale: string): string[] {
  return routing.locales.filter((one) => one !== locale).map(ogLocale);
}

/**
 * The hreflang list. x-default points at the default locale,
 * the page shown to people whose language is not offered.
 */
export function languageAlternates(path = ""): Record<string, string> {
  return {
    ...Object.fromEntries(routing.locales.map((one) => [one, localePath(one, path)])),
    "x-default": localePath(routing.defaultLocale, path),
  };
}
