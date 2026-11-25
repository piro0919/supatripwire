import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
import { Inter, Noto_Sans_JP } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { routing } from "@/i18n/routing";
import { languageAlternates, localePath, ogAlternateLocales, ogLocale } from "@/i18n/urls";
import "./globals.css";

// zizmor.sh sets everything in Inter. Japanese falls back to Noto Sans JP, which Google
// splits into 100+ unicode-range files; preloading them all costs about 1.5 MB, so the
// browser fetches only the ranges the page uses.
const inter = Inter({ display: "swap", subsets: ["latin"], variable: "--font-inter" });

const japanese = Noto_Sans_JP({
  display: "swap",
  preload: false,
  variable: "--font-noto-jp",
  weight: ["400", "500", "600", "700"],
});

type LayoutProps = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: Omit<LayoutProps, "children">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });

  return {
    description: t("description"),
    alternates: {
      canonical: localePath(locale),
      languages: languageAlternates(),
    },
    metadataBase: new URL("https://supatripwire.kkweb.io"),
    openGraph: {
      locale: ogLocale(locale),
      alternateLocale: ogAlternateLocales(locale),
      description: t("description"),
      url: localePath(locale),
      title: t("title"),
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      description: t("description"),
      title: t("title"),
    },
    title: t("title"),
  };
}

export default async function Layout({ children, params }: LayoutProps) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <html className={`${inter.variable} ${japanese.variable}`} lang={locale}>
      <body className="flex min-h-screen flex-col antialiased">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
        <Analytics />
      </body>
    </html>
  );
}
