import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { routing } from "@/i18n/routing";

export const alt = "supatripwire";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* Rendered at build time. Left dynamic, assets/ would not ship with the function and the
   route would fail in production. */
export function generateStaticParams(): { locale: string }[] {
  return routing.locales.map((locale) => ({ locale }));
}

/* Shown at about 176px in the kk-web list and 500px in an X card, where only the name and
   one line survive. Same colors as the page: white, slate text, the muted slate of its body text. */
const BG = "#ffffff";
const INK = "#334155";
const MUTED = "#64748b";

export default async function OgImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<ImageResponse> {
  const { locale } = await params;
  const isJa = locale === "ja";
  /* Faces cut down to the characters drawn here. If the copy changes, cut them again as
     assets/README.md describes. */
  const [inter, noto] = await Promise.all([
    readFile(join(process.cwd(), "assets/Inter-Bold-subset.woff")),
    readFile(join(process.cwd(), "assets/NotoSansJP-Bold-subset.woff")),
  ]);

  return new ImageResponse(
    <div
      style={{
        alignItems: "center",
        background: BG,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "center",
        width: "100%",
      }}
    >
      <div style={{ color: INK, fontSize: 120, fontWeight: 700 }}>supatripwire</div>
      <div style={{ color: MUTED, display: "flex", fontSize: 44, fontWeight: 700, marginTop: 16 }}>
        {isJa
          ? "Supabase のテナントを越えた読み取りを検知"
          : "Cross-Tenant Read Detection for Supabase"}
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
