"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

/// The language switch. English is the default, so Japanese readers need a way in.
export function LanguageSwitch() {
  const locale = useLocale();
  const t = useTranslations("language");
  const pathname = usePathname();

  return (
    <div className="flex items-center gap-3 text-sm">
      {(["en", "ja"] as const).map((target) => (
        <Link
          aria-current={locale === target ? "page" : undefined}
          className={locale === target ? "text-ink" : "text-muted transition hover:text-ink"}
          href={pathname}
          key={target}
          locale={target}
        >
          {t(target)}
        </Link>
      ))}
    </div>
  );
}
