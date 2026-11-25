import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { LanguageSwitch } from "./language-switch";
import { Terminal } from "./terminal";
import {
  CHECK_COMMAND,
  DOCTOR_COMMAND,
  DOCTOR_REPORT,
  HERO_REPORT,
  NAMED_TENANT_EXCERPT,
  ROW_CEILING_EXCERPT,
} from "./terminal-output";

const REPO = "https://github.com/piro0919/supatripwire";
const DOCS = `${REPO}#readme`;

type PageProps = {
  params: Promise<{ locale: string }>;
};

/// zizmor's two buttons: a filled one and an outlined one, both lifting 2px on hover.
function Button({
  children,
  href,
  variant,
}: {
  children: ReactNode;
  href: string;
  variant: "primary" | "secondary";
}) {
  const look =
    variant === "primary"
      ? "border-primary bg-primary text-white hover:border-primary-hover hover:bg-primary-hover"
      : "border-accent text-accent hover:bg-accent/10";
  return (
    <a
      className={`inline-block rounded-lg border-2 px-6 py-2.5 font-semibold transition hover:-translate-y-0.5 max-stack:px-5 max-stack:text-button-narrow ${look}`}
      href={href}
    >
      {children}
    </a>
  );
}

/// One feature row: the terminal on one side, the heading and text on the other.
/// Every second row is mirrored, as on zizmor's page.
function Feature({
  children,
  reversed,
  terminal,
  title,
}: {
  children: ReactNode;
  reversed?: boolean;
  terminal: ReactNode;
  title: string;
}) {
  return (
    <div
      className={`mb-16 flex items-center gap-12 last:mb-0 max-stack:flex-col ${reversed ? "flex-row-reverse" : ""}`}
    >
      <div className="min-w-0 flex-1 max-stack:w-full">{terminal}</div>
      <div className="flex flex-1 flex-col gap-4 max-stack:w-full">
        <h2 className="font-bold text-feature text-ink leading-tight">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Body({ children }: { children: ReactNode }) {
  return <p className="text-feature-body text-muted">{children}</p>;
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-code-bg px-1.5 py-0.5 font-mono text-inline-code text-ink">
      {children}
    </code>
  );
}

function TextLink({ children, href }: { children: ReactNode; href: string }) {
  return (
    <a className="text-accent transition hover:text-accent-hover" href={href}>
      {children}
    </a>
  );
}

export default async function Page({ params }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations();

  return (
    <>
      <header className="sticky top-0 z-10 bg-header shadow-header">
        <nav className="mx-auto flex max-w-page items-center justify-between gap-4 px-8 py-6 max-sm:px-5">
          <span className="font-bold text-ink text-logo leading-none max-sm:text-2xl">
            supatripwire
          </span>
          <div className="flex items-center gap-6 whitespace-nowrap font-medium max-sm:gap-4">
            <a className="transition hover:text-accent max-sm:hidden" href={DOCS}>
              {t("nav.docs")}
            </a>
            <a className="transition hover:text-accent" href={REPO}>
              GitHub
            </a>
            <LanguageSwitch />
          </div>
        </nav>
      </header>

      <main className="flex-1">
        <section className="py-20">
          <div className="mx-auto max-w-page px-8">
            <div className="mx-auto flex max-w-hero items-center gap-16 max-stack:flex-col">
              <div className="max-w-hero-text flex-hero-text max-stack:max-w-full max-stack:flex-none">
                <h1
                  className={`mb-6 font-bold leading-hero ${locale === "ja" ? "text-hero-ja" : "text-hero"} max-sm:text-4xl`}
                >
                  {t("hero.title")}
                </h1>
                <p className="mb-8 text-lead">{t("hero.lead")}</p>
                <div className="flex flex-wrap gap-4 max-stack:justify-center">
                  <Button href={`${REPO}#usage`} variant="primary">
                    {t("hero.install")}
                  </Button>
                  <Button href={`${REPO}#setup`} variant="secondary">
                    {t("hero.start")}
                  </Button>
                </div>
              </div>
              <div className="min-w-0 flex-hero-shot p-4 max-stack:order-first max-stack:w-full max-stack:flex-none max-stack:p-0">
                <Terminal command={CHECK_COMMAND} label={t("terminal.check")} lines={HERO_REPORT} />
              </div>
            </div>
          </div>
        </section>

        <section className="bg-band py-20">
          <div className="mx-auto max-w-page px-8">
            <Feature
              terminal={<Terminal label={t("terminal.named")} lines={NAMED_TENANT_EXCERPT} />}
              title={t("features.named.title")}
            >
              <Body>{t("features.named.body")}</Body>
              <Body>
                {t.rich("features.named.more", {
                  link: (chunks) => <TextLink href={`${REPO}#what-it-reports`}>{chunks}</TextLink>,
                })}
              </Body>
            </Feature>
            <Feature
              reversed
              terminal={<Terminal label={t("terminal.ceiling")} lines={ROW_CEILING_EXCERPT} />}
              title={t("features.ceiling.title")}
            >
              <Body>{t("features.ceiling.body")}</Body>
            </Feature>
            <Feature
              terminal={
                <Terminal
                  command={DOCTOR_COMMAND}
                  label={t("terminal.doctor")}
                  lines={DOCTOR_REPORT}
                />
              }
              title={t("features.outside.title")}
            >
              <Body>{t("features.outside.body")}</Body>
              <Body>
                {t.rich("features.outside.doctor", {
                  code: (chunks) => <InlineCode>{chunks}</InlineCode>,
                })}
              </Body>
            </Feature>
          </div>
        </section>
      </main>

      <footer className="bg-footer py-8 text-footer-ink">
        <div className="mx-auto flex max-w-page items-center justify-between px-8 max-stack:flex-col max-stack:gap-4">
          <span>© 2026 piro0919</span>
          <div className="flex gap-6 text-footnote">
            <a className="opacity-80 transition hover:opacity-100" href={DOCS}>
              {t("footer.docs")}
            </a>
            <a className="opacity-80 transition hover:opacity-100" href={REPO}>
              GitHub
            </a>
            <a
              className="opacity-80 transition hover:opacity-100"
              href="https://buymeacoffee.com/piro0919"
            >
              Buy Me a Coffee
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
