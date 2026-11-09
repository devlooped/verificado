import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ClaimsTable, extractClaimRows } from "@/components/claims-table.tsx";
import { DeleteNotificationButton } from "@/components/delete-notification-button.tsx";
import { ModelSettingsForm, type ModelRow } from "@/components/model-settings-form.tsx";
import { loadModelSettings, resolveFamilyModels } from "@/court/model-config.ts";
import { MODEL_ROLES, modelEffort } from "@/court/models.ts";
import { auth0 } from "@/lib/auth0.ts";
import { canViewAdmin, isAdmin } from "@/lib/case-access.ts";
import { fetchGatewayModels } from "@/lib/gateway-catalog.ts";
import { latestFamilyModels, modelFamily } from "@/lib/model-families.ts";
import { listAdminNotifications } from "@/store.ts";
import { markNotificationsRead } from "./actions.ts";

export const metadata: Metadata = { title: "Administración · Che bot", robots: { index: false, follow: false } };

function adminLoginPath(before: string | undefined): string {
  const returnTo = before ? `/admin?before=${encodeURIComponent(before)}` : "/admin";
  return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const [session, { before }] = await Promise.all([auth0.getSession(), searchParams]);
  const user = session?.user;
  // Sign in first. Anyone else sees the ordinary 404, so the route stays unadvertised.
  if (!user?.sub) redirect(adminLoginPath(before));
  if (!canViewAdmin(user)) notFound();
  // Contrib sees the page read-only; the actions check isAdmin again.
  const readOnly = !isAdmin(user);
  const [settings, catalog, notificationRows] = await Promise.all([
    loadModelSettings(),
    fetchGatewayModels().catch((err: unknown) => {
      console.warn("Gateway catalog unavailable:", err);
      return undefined;
    }),
    listAdminNotifications(typeof before === "string" ? before : undefined),
  ]);
  const notifications = notificationRows.slice(0, 100);
  const models = resolveFamilyModels(settings);
  const rows: ModelRow[] = MODEL_ROLES.map((role) => ({
    ...role,
    defaultId: modelFamily(role.defaultId),
    modelId: models[role.key].id,
    effort: role.configurableEffort ? modelEffort(models[role.key]) : null,
    overridden: settings.some((setting) => setting.role === role.key),
  }));
  const options = latestFamilyModels(catalog ?? []);

  return (
    <div className="mx-auto max-w-4xl space-y-12 pt-10">
      <section>
        <h1 className="font-display text-4xl leading-none">Administración</h1>
        <p className="mt-2 text-sm text-ink-soft">Sesión y configuración de los modelos que usa cada función.</p>
        {readOnly && <p role="note" className="mt-2 text-sm font-medium text-ink-soft">Solo lectura: tu rol Contrib permite ver esta página, no modificarla.</p>}
      </section>

      <section aria-labelledby="notifications-heading">
        <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
          <h2 id="notifications-heading" className="font-display text-2xl leading-none">Notificaciones</h2>
          {!readOnly && notifications.length > 0 && (
            <form action={markNotificationsRead}>
              <input type="hidden" name="through" value={notifications[0]!.id} />
              <button type="submit" className="cursor-pointer text-sm text-celeste-deep underline">{before ? "Marcar hasta aquí como leídas" : "Marcar todas leídas"}</button>
            </form>
          )}
        </div>
        <p className="mt-2 text-sm text-ink-soft">El estado de lectura es compartido entre administradores.</p>
        {notifications.length === 0 ? <p className="mt-3 text-sm text-ink-soft">No hay notificaciones.</p> : (
          <ol className="mt-3 divide-y divide-rule">
            {notifications.map((notification) => (
              <li key={notification.id} className="flex items-start justify-between gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <strong>{notification.title}</strong>
                    {!notification.read_at && <span className="text-xs font-semibold text-seal">Nueva</span>}
                    <time className="text-xs text-ink-soft" dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString("es-AR", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" })}</time>
                  </div>
                  <p className="mt-1 text-ink-soft">{notification.message}</p>
                  {notification.case_id && <a className="mt-1 inline-block text-celeste-deep underline" href={"/c/" + encodeURIComponent(notification.case_id)}>Caso Nº {notification.case_id}</a>}
                </div>
                {!readOnly && <DeleteNotificationButton id={notification.id} title={notification.title} />}
              </li>
            ))}
          </ol>
        )}
        <div className="mt-3 flex gap-4 text-sm text-celeste-deep">
          {before && <a className="underline" href="/admin#notifications-heading">Más recientes</a>}
          {notificationRows.length > 100 && <a className="underline" href={"/admin?before=" + encodeURIComponent(notifications.at(-1)!.id) + "#notifications-heading"}>Más antiguas</a>}
        </div>
      </section>

      <section aria-labelledby="claims-heading">
        <div className="flex items-baseline justify-between gap-3 border-b border-rule pb-2">
          <h2 id="claims-heading" className="font-display text-2xl leading-none">Sesión activa</h2>
          <a href="/auth/logout" className="text-sm text-ink-soft underline hover:text-celeste-deep">
            Cerrar sesión
          </a>
        </div>
        <div className="mt-3">
          <ClaimsTable rows={extractClaimRows(user)} />
        </div>
      </section>

      <section aria-labelledby="models-heading">
        <h2 id="models-heading" className="border-b border-rule pb-2 font-display text-2xl leading-none">Modelos</h2>
        <p className="mt-2 text-sm text-ink-soft">
          Cada caso usa la última versión disponible de cada familia y conserva esa copia al abrir la sesión; los casos en curso no cambian.
          {!catalog && " El catálogo de models.dev no respondió: solo se valida el formato de los IDs."}
        </p>
        <ModelSettingsForm rows={rows} catalog={options} readOnly={readOnly} />
      </section>
    </div>
  );
}
