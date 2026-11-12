"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { BetaNotice } from "@/components/beta-notice.tsx";
import { RequestForm } from "@/components/request-form.tsx";
import { canRequestCase } from "@/lib/case-access.ts";
import { REQUEST_PANEL_ID } from "@/lib/request-panel.ts";

const round = "grid size-8 shrink-0 place-items-center rounded-full border transition";

export function RequestPanel() {
  const { user, isLoading } = useUser();
  const pathname = usePathname();
  const panelRef = useRef<HTMLDivElement>(null);

  // A navigation, such as the redirect to a new case, closes the panel.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel?.matches(":popover-open")) panel.hidePopover();
  }, [pathname]);

  // Opening the panel puts the cursor in the field of the chosen kind.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function onToggle(event: Event) {
      if ((event as ToggleEvent).newState !== "open") return;
      panel?.querySelector<HTMLElement>("[data-autofocus]:not(:disabled)")?.focus();
    }
    panel.addEventListener("toggle", onToggle);
    return () => panel.removeEventListener("toggle", onToggle);
  }, []);

  return (
    <>
      <button
        type="button"
        popoverTarget={REQUEST_PANEL_ID}
        aria-label="Pedir un chequeo"
        title="Pedir un chequeo"
        className={round + " border-celeste-deep bg-celeste-deep text-paper hover:border-ink hover:bg-ink hover:text-paper"}
      >
        <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div
        ref={panelRef}
        id={REQUEST_PANEL_ID}
        popover="auto"
        role="dialog"
        aria-labelledby={REQUEST_PANEL_ID + "-title"}
        className="request-panel reveal fixed bottom-auto left-auto top-16 right-[max(1.25rem,calc((100vw-64rem)/2+1.25rem))] m-0 max-h-[calc(100dvh-5rem)] w-[min(34rem,calc(100vw-2.5rem))] overflow-y-auto rounded-sm border border-ink/80 bg-paper p-5 text-base normal-case tracking-normal text-ink shadow-[6px_6px_0_0_var(--color-ink)] backdrop:bg-black/15 sm:p-7"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id={REQUEST_PANEL_ID + "-title"} className="font-display text-3xl leading-none">Pedí un chequeo</h2>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-[11px] uppercase tracking-widest text-ink-soft sm:inline">Formulario Nº 1</span>
            <button
              type="button"
              popoverTarget={REQUEST_PANEL_ID}
              popoverTargetAction="hide"
              aria-label="Cerrar"
              title="Cerrar"
              className={round + " border-rule text-ink hover:bg-paper-deep"}
            >
              <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </div>
        {isLoading ? (
          <p className="mt-5 text-sm text-ink-soft">Cargando…</p>
        ) : canRequestCase(user) ? (
          // A new page starts a new form: after a request is sent, the next one starts empty.
          <RequestForm key={pathname} />
        ) : (
          <BetaNotice signedIn={!!user?.sub} />
        )}
      </div>
    </>
  );
}
