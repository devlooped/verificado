"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { canViewAdmin, isAdmin } from "@/lib/case-access.ts";
import { ClaimsTable, extractClaimRows } from "./claims-table.tsx";

export { extractClaimRows, formatClaimValue } from "./claims-table.tsx";

const SHIELD_CLASS = "grid size-8 shrink-0 place-items-center rounded-full border transition ";
export const ADMIN_NOTIFICATIONS_CHANGED_EVENT = "admin-notifications-changed";

function ShieldIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function UserClaimsPopover({
  claims,
  open,
  onToggle,
  unread = false,
}: {
  claims: Record<string, unknown>;
  open: boolean;
  onToggle: () => void;
  unread?: boolean;
}) {
  const panelId = useId();
  const rows = extractClaimRows(claims);
  if (rows.length === 0) return null;

  // Admins and contributors (read-only) go straight to the admin page, which shows the same claims and the logout link.
  if (canViewAdmin(claims)) {
    return (
      <Link
        href="/admin"
        aria-label={unread ? "Administración: hay notificaciones nuevas" : "Administración"}
        title={unread ? "Administración: hay notificaciones nuevas" : "Administración"}
        className={SHIELD_CLASS + "relative border-rule text-celeste-deep hover:bg-paper-deep"}
      >
        <ShieldIcon />
        {unread && <span aria-hidden className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-seal ring-2 ring-paper" />}
      </Link>
    );
  }

  return (
    <div className="relative normal-case tracking-normal">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Ver atributos de la sesión"
        title="Atributos del token de sesión"
        className={
          SHIELD_CLASS +
          (open ? "border-celeste-deep bg-celeste/15 text-celeste-deep" : "border-rule text-celeste-deep hover:bg-paper-deep")
        }
      >
        <ShieldIcon />
      </button>
      {open && (
        <div
          id={panelId}
          role="region"
          aria-label="Atributos del token"
          className="absolute right-0 z-50 mt-2 w-[min(28rem,calc(100vw-2.5rem))] rounded-sm border border-ink/80 bg-paper p-4 text-ink shadow-[6px_6px_0_0_var(--color-ink)]"
        >
          <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
            <span className="font-display text-xl leading-none">Sesión activa</span>
            <a href="/auth/logout" className="text-xs text-ink-soft underline hover:text-celeste-deep">
              Cerrar sesión
            </a>
          </div>
          <div className="mt-3 max-h-80 overflow-auto">
            <ClaimsTable rows={rows} />
          </div>
        </div>
      )}
    </div>
  );
}

export function UserClaimsBadge() {
  const { user } = useUser();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const viewer = canViewAdmin(user);
  const admin = isAdmin(user);

  useEffect(() => {
    if (!viewer) return;
    // Only an admin runs the checks (POST); a contributor only reads.
    const check = admin ? "POST" : "GET";
    let active = true;
    async function refresh(method: "GET" | "POST") {
      try {
        const response = await fetch("/api/admin/notifications", { method, cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { unread: boolean; changed: boolean };
        if (!active) return;
        setUnread(data.unread);
        if (data.changed && pathname === "/admin") router.refresh();
      } catch { /* The next poll retries; a network failure must not hide the badge. */ }
    }
    void refresh(check);
    const poll = window.setInterval(() => { if (!document.hidden) void refresh("GET"); }, 30_000);
    const health = window.setInterval(() => { if (!document.hidden) void refresh(check); }, 5 * 60_000);
    const focus = () => { if (!document.hidden) void refresh("GET"); };
    document.addEventListener("visibilitychange", focus);
    window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED_EVENT, focus);
    return () => { active = false; window.clearInterval(poll); window.clearInterval(health); document.removeEventListener("visibilitychange", focus); window.removeEventListener(ADMIN_NOTIFICATIONS_CHANGED_EVENT, focus); };
  }, [viewer, admin, pathname, router]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div ref={containerRef}>
      <UserClaimsPopover claims={user} open={open} onToggle={() => setOpen((prev) => !prev)} unread={unread} />
    </div>
  );
}
