import type { Metadata } from "next";
import Link from "next/link";
import { Archivo, IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import { RequestPanel } from "@/components/request-panel.tsx";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { UserClaimsBadge } from "@/components/user-claims-badge.tsx";
import { COUNSEL_NAMES } from "@/domain/court.ts";
import "./globals.css";

const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "Che bot, ...🤌?",
  description: "Un panel de inteligencias artificiales investiga, debate y vota. Sin sesgos humanos.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" data-theme="light" suppressHydrationWarning className={`${instrument.variable} ${archivo.variable} ${plexMono.variable}`}>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{const saved=localStorage.getItem("theme");document.documentElement.dataset.theme=saved==="dark"||saved==="light"?saved:matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}catch{document.documentElement.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}`,
          }}
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <header className="mx-auto max-w-5xl px-5 pt-6">
          <div className="flex items-center justify-between gap-4 text-[11px] uppercase tracking-[0.2em] text-ink-soft">
            <div className="flex items-center gap-2">
              <Link href="/" aria-label="Volver al inicio" title="Volver al inicio" className="grid size-8 shrink-0 place-items-center rounded-full border border-rule text-ink transition hover:bg-paper-deep">
                <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m3 10 9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  <path d="M9 21v-7h6v7" />
                </svg>
              </Link>
              <span className="fi fi-ar"></span>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/method" title="¿Cómo debaten las 4 superinteligencias más potentes?" className="rounded-full border border-rule px-3 py-1.5 leading-none text-ink transition hover:bg-paper-deep">
                Método
              </Link>
              <UserClaimsBadge />
              <RequestPanel />
              <ThemeToggle />
            </div>
          </div>
          <Link href="/" className="mt-2 block text-center">
            <span className="font-display text-6xl leading-none tracking-tight sm:text-7xl">Che bot, ...🤌?</span>
          </Link>
          <p className="mt-1 text-center font-display text-lg italic text-ink-soft">El panel debate. Un moderador desempata. Ningún humano opina.</p>
          <div className="rule-double mt-4" />
        </header>
        <main className="mx-auto max-w-5xl px-5 pb-24">{children}</main>
        <footer className="mx-auto max-w-5xl px-5 pb-10 text-xs text-ink-soft">
          <div className="border-t border-rule pt-4">
            Analistas: {COUNSEL_NAMES}. Cada caso indica qué modelo lo moderó, y cada voto y cada decisión quedan en el registro público del debate.
          </div>
        </footer>
      </body>
    </html>
  );
}
