"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { CHECK_TYPES, type Submission } from "@/domain/court.ts";
import { auth0 } from "@/lib/auth0.ts";
import { BETA_MESSAGE, canIdentifyClaims, canRequestCase, isAdmin } from "@/lib/case-access.ts";
import { startCourtSession } from "@/lib/case-workflow.ts";
import { deleteCaseBlobs } from "@/evidence/blob.ts";
import { withSandboxCleanup } from "@/instruction/preparation.ts";
import { createNewCase, finishCase, requeueCase } from "@/store.ts";

const IMAGE_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

const note = z.string().trim().max(500).optional().transform((v) => v || undefined);

const RequestForm = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().trim().min(20, "Pegá un texto de al menos 20 caracteres.").max(6000, "El texto es demasiado largo (máximo 6000 caracteres).") }),
  z.object({
    kind: z.literal("link"),
    url: z
      .url({ protocol: /^https?$/, error: "Ingresá un enlace válido (http o https)." })
      .refine((u) => URL.canParse(u) && !PRIVATE_HOST.test(new URL(u).hostname), "Ingresá un enlace público."),
    note,
  }),
  z.object({
    kind: z.literal("image"),
    image: z
      .instanceof(File, { error: "Elegí una imagen." })
      .refine((f) => f.size > 0, "Elegí una imagen.")
      .refine((f) => f.size <= MAX_IMAGE_BYTES, "La imagen no puede superar 4 MB.")
      .refine((f) => f.type in IMAGE_TYPES, "Formatos aceptados: PNG, JPG, WEBP o GIF."),
    note,
  }),
]);

export type RequestField = "text" | "url" | "note" | "image" | "language" | "check" | "identifyClaims";
// The field names the input to fix, so the form can mark and focus it.
export type RequestState = { error?: string; field?: RequestField };

const FIELDS: readonly string[] = ["text", "url", "note", "image"] satisfies RequestField[];

export async function requestFactCheck(_prev: RequestState, formData: FormData): Promise<RequestState> {
  const session = await auth0.getSession();
  const user = session?.user;
  if (!user?.sub || !canRequestCase(user)) return { error: BETA_MESSAGE };
  const language = z.enum(["auto", "es", "en"], { error: "Elegí un idioma válido." }).default("auto").safeParse(formData.get("language") ?? undefined);
  if (!language.success) return { error: language.error.issues[0]?.message, field: "language" };
  const check = z.enum(CHECK_TYPES, { error: "Elegí un tipo de chequeo válido." }).default("quick").safeParse(formData.get("check") ?? undefined);
  if (!check.success) return { error: check.error.issues[0]?.message, field: "check" };
  const identifyClaims = z.literal("on", { error: "Elegí una opción de afirmaciones válida." }).optional().safeParse(formData.get("identifyClaims") ?? undefined);
  if (!identifyClaims.success) return { error: identifyClaims.error.issues[0]?.message, field: "identifyClaims" };
  if (check.data === "quick" && identifyClaims.data === "on" && !canIdentifyClaims(user)) {
    return { error: "Identificar afirmaciones independientes requiere el rol Contrib o Admin.", field: "identifyClaims" };
  }
  const parsed = RequestForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    return { error: issue?.message ?? "Revisá los datos.", field: FIELDS.includes(field) ? (field as RequestField) : undefined };
  }

  let submission: Submission;
  let image: Buffer | undefined;
  const input = parsed.data;
  if (input.kind === "image") {
    image = Buffer.from(await input.image.arrayBuffer());
    submission = { kind: "image", mimeType: input.image.type, note: input.note, language: language.data, check: check.data };
  } else {
    submission = { ...input, language: language.data, check: check.data };
  }
  if (check.data === "quick" && identifyClaims.data === "on") submission.identifyClaims = true;
  const id = await createNewCase(submission, image, user.sub);
  try {
    await startCourtSession(id);
  } catch (err) {
    console.error("could not start court session:", err);
    await finishCase(id, "failed", "No se pudo iniciar la sesión.");
  }
  redirect("/c/" + id);
}

export async function retryCase(id: string): Promise<void> {
  const session = await auth0.getSession();
  if (!isAdmin(session?.user)) throw new Error("No autorizado para reintentar el caso.");

  if (await requeueCase(id, withSandboxCleanup(deleteCaseBlobs))) {
    try {
      await startCourtSession(id, true);
    } catch (err) {
      console.error("could not start court session:", err);
      await finishCase(id, "failed", "No se pudo iniciar la sesión.");
    }
  }
  redirect("/c/" + id);
}
