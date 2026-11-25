import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { CHECK_COMMAND, CHECK_REPORT } from "./terminal-output";

export const alt = "supatripwire";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* Rendered at build time. Left dynamic, assets/ would not ship with the function and the
   route would fail in production. */
export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

/* The card shows real output, the same report the page's terminals print: the command,
   how many reads were scanned, and how many crossed tenants. */
function reportLine(prefix: string): string {
  const line = CHECK_REPORT.find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) {
    throw new Error(`No "${prefix}" line in CHECK_REPORT; update the Open Graph card.`);
  }
  return line;
}
const SCANNED = reportLine("Signed-in reads scanned");
const CROSSED = reportLine("Data crossed tenants");

/* Pieces the line may wrap between. The renderer would otherwise break Japanese anywhere,
   leaving the last particle and verb alone on a line. Hiragana and spaces join the piece before them, which
   keeps particles and okurigana with their word. */
function wrapPieces(text: string, locale: string): string[] {
  const pieces: string[] = [];
  for (const { segment } of new Intl.Segmenter(locale, { granularity: "word" }).segment(text)) {
    const last = pieces.length - 1;
    if (last >= 0 && /^[\p{Script=Hiragana}\s]+$/u.test(segment)) {
      pieces[last] += segment;
    } else {
      pieces.push(segment);
    }
  }
  return pieces;
}

/* The page's terminal colors. */
const TERMINAL = "#282c34";
const TERMINAL_INK = "#ffffff";
const TERMINAL_MUTED = "#a4a8b0";
const CROSSED_TONE = "#f87171";

export default async function OgImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ImageResponse> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "hero" });
  /* Faces cut down to the characters drawn here: the name, hero.title, the domain and the
     terminal lines. If any of them changes, cut them again as assets/README.md describes. */
  const [inter, noto] = await Promise.all([
    readFile(join(process.cwd(), "assets/Inter-Bold-subset.woff")),
    readFile(join(process.cwd(), "assets/NotoSansJP-Bold-subset.woff")),
  ]);

  /* Same layout as the other package cards on kkweb.io: name, one line and the domain on
     the left, what the package does on the right. */
  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: "#0b0b0f",
        color: "#ffffff",
        display: "flex",
        height: "100%",
        padding: "0 80px",
        width: "100%",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          width: 560,
        }}
      >
        <div style={{ display: "flex", fontSize: 54, letterSpacing: -1 }}>supatripwire</div>
        <div
          style={{
            color: "#a1a1aa",
            display: "flex",
            flexWrap: "wrap",
            fontSize: 30,
            lineHeight: 1.4,
            marginTop: 28,
          }}
        >
          {wrapPieces(t("title"), locale).map((piece, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed text; pieces can repeat
            <span key={index} style={{ whiteSpace: "pre" }}>
              {piece}
            </span>
          ))}
        </div>
        <div style={{ color: "#71717a", display: "flex", fontSize: 26, marginTop: 48 }}>
          kkweb.io
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, justifyContent: "flex-end" }}>
        <div
          style={{
            background: TERMINAL,
            borderRadius: 16,
            color: TERMINAL_INK,
            display: "flex",
            flexDirection: "column",
            fontSize: 19,
            gap: 12,
            padding: "26px 28px",
          }}
        >
          <div style={{ display: "flex", whiteSpace: "pre" }}>
            <span style={{ color: TERMINAL_MUTED }}>$ </span>
            {CHECK_COMMAND}
          </div>
          <div style={{ display: "flex" }}>{SCANNED}</div>
          <div style={{ color: CROSSED_TONE, display: "flex" }}>{CROSSED}</div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { data: inter, name: "Inter", style: "normal", weight: 700 },
        { data: noto, name: "Noto Sans JP", style: "normal", weight: 700 },
      ],
    },
  );
}
