"use server";

import { revalidatePath } from "next/cache";
import { loadModelSettings, resolveFamilyModels } from "@/court/model-config.ts";
import { auth0 } from "@/lib/auth0.ts";
import { isAdmin } from "@/lib/case-access.ts";
import { fetchGatewayModels } from "@/lib/gateway-catalog.ts";
import { latestFamilyModels } from "@/lib/model-families.ts";
import { parseModelSettings } from "@/lib/model-settings.ts";
import { deleteAdminNotification, markAdminNotificationsRead, saveModelSettings } from "@/store.ts";

export type ModelSettingsState = { saved?: number; error?: string; errors?: Record<string, string> };

export async function markNotificationsRead(formData: FormData): Promise<void> {
  const session = await auth0.getSession();
  if (!isAdmin(session?.user)) throw new Error("No autorizado.");
  const through = formData.get("through");
  if (typeof through !== "string") throw new Error("Notificación inválida");
  await markAdminNotificationsRead(through);
  revalidatePath("/admin");
}

export async function deleteNotification(id: string): Promise<void> {
  const session = await auth0.getSession();
  if (!isAdmin(session?.user)) throw new Error("No autorizado.");
  if (!(await deleteAdminNotification(id))) throw new Error("Notificación no encontrada.");
  revalidatePath("/admin");
}

export async function saveModels(_prev: ModelSettingsState, formData: FormData): Promise<ModelSettingsState> {
  const session = await auth0.getSession();
  const user = session?.user;
  if (!isAdmin(user)) return { error: "No autorizado." };
  const [settings, catalog] = await Promise.all([
    loadModelSettings(),
    // Without the catalog only the ID format is checked.
    fetchGatewayModels().catch((err: unknown) => {
      console.warn("Gateway catalog unavailable:", err);
      return undefined;
    }),
  ]);
  const result = parseModelSettings(formData, resolveFamilyModels(settings), catalog && latestFamilyModels(catalog));
  if (!result.ok) return { errors: result.errors };
  if (result.changes.length) await saveModelSettings(result.changes, user.email ?? user.sub);
  revalidatePath("/admin");
  return { saved: result.changes.length };
}
