"use client";

import { startTransition, useActionState, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { requestFactCheck, type RequestField, type RequestState } from "@/app/actions.ts";

const KINDS = [
  { id: "text", label: "Texto" },
  { id: "link", label: "Enlace" },
  { id: "image", label: "Imagen" },
] as const;

type Kind = (typeof KINDS)[number]["id"];

const FIELDS: Record<Kind, readonly RequestField[]> = { text: ["text"], link: ["url", "note"], image: ["image", "note"] };

export const TEXT_MIN = 20;
export const TEXT_MAX = 6000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// The same checks as the server, before a large upload is sent for nothing.
export function imageProblem(file: { size: number; type: string } | undefined): string | undefined {
  if (!file || file.size === 0) return "Elegí una imagen.";
  if (!IMAGE_TYPES.includes(file.type)) return "Formatos aceptados: PNG, JPG, WEBP o GIF.";
  if (file.size > MAX_IMAGE_BYTES) return "La imagen no puede superar 4 MB.";
  return undefined;
}

// What the counter under the text says: what is missing, else how much is used.
export function textCount(text: string): { label: string; short: boolean } {
  const length = text.trim().length;
  if (length > 0 && length < TEXT_MIN) {
    const missing = TEXT_MIN - length;
    return { label: "Faltan " + missing + (missing === 1 ? " carácter" : " caracteres"), short: true };
  }
  return { label: length.toLocaleString("es-AR") + " / " + TEXT_MAX.toLocaleString("es-AR"), short: false };
}

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toLocaleString("es-AR", { maximumFractionDigits: 1 }) + " MB";

const field =
  "w-full rounded-sm border border-rule bg-paper/80 px-4 py-3 text-base outline-none transition focus:border-celeste-deep focus:ring-2 focus:ring-celeste/30 aria-invalid:border-falso aria-invalid:ring-2 aria-invalid:ring-falso/20";
const label = "mb-1.5 block text-sm font-medium text-ink";

export function RequestForm() {
  const [kind, setKind] = useState<Kind>("text");
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ name: string; size: number }>();
  const [local, setLocal] = useState<RequestState>();
  const [state, action, pending] = useActionState<RequestState, FormData>(requestFactCheck, {});
  const fileRef = useRef<HTMLInputElement>(null);
  const uid = useId();
  const ids = {
    language: uid + "-language",
    text: uid + "-text",
    url: uid + "-url",
    linkNote: uid + "-link-note",
    image: uid + "-image",
    imageNote: uid + "-image-note",
    error: uid + "-error",
    textHint: uid + "-text-hint",
  };
  const fieldId = (f: RequestField, k: Kind) => (f === "note" ? (k === "link" ? ids.linkNote : ids.imageNote) : ids[f]);

  // A client check wins over the last server answer; an error about a field of another kind is not shown.
  const shown = local ?? state;
  const problem = shown.error && (!shown.field || shown.field === "language" || FIELDS[kind].includes(shown.field)) ? shown : undefined;
  const invalid = (f: RequestField) => problem?.field === f || undefined;
  const describedBy = (f: RequestField, extra?: string) => [extra, problem?.field === f ? ids.error : undefined].filter(Boolean).join(" ") || undefined;

  // Takes the user straight to the input the server rejected.
  useEffect(() => {
    if (state.field) document.getElementById(fieldId(state.field, kind))?.focus();
    // Only a new server answer moves the focus, not a change of kind.
  }, [state]);

  function chooseImage(file: File | undefined) {
    setImage(file ? { name: file.name, size: file.size } : undefined);
    const error = file ? imageProblem(file) : undefined;
    setLocal(error ? { error, field: "image" } : undefined);
  }

  // A pasted or dropped picture goes into the file input, as if it had been chosen.
  function takeImage(file: File) {
    const input = fileRef.current;
    if (!input) return;
    const files = new DataTransfer();
    files.items.add(file);
    input.files = files.files;
    setKind("image");
    chooseImage(file);
  }

  function onPaste(event: ClipboardEvent<HTMLFormElement>) {
    // Text copied from an office app often carries a picture of itself: text wins.
    if (event.clipboardData.getData("text/plain")) return;
    const file = [...event.clipboardData.files].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    takeImage(file);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    event.preventDefault();
    takeImage(file);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // Submitting by hand keeps what was typed when the server answers with an error:
    // a form action would reset the fields.
    event.preventDefault();
    if (kind === "image") {
      const error = imageProblem(fileRef.current?.files?.[0]);
      if (error) {
        setLocal({ error, field: "image" });
        document.getElementById(ids.image)?.focus();
        return;
      }
    }
    setLocal(undefined);
    const data = new FormData(event.currentTarget);
    startTransition(() => action(data));
  }

  function submitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const count = textCount(text);

  return (
    <form
      action={action}
      onSubmit={onSubmit}
      onPaste={onPaste}
      aria-busy={pending}
    >
      <div className="mt-5">
        <label htmlFor={ids.language} className={label}>Idioma del caso</label>
        <select id={ids.language} name="language" defaultValue="auto" aria-invalid={invalid("language")} aria-describedby={describedBy("language")} className={field}>
          <option value="auto">Detectar</option>
          <option value="es">Español</option>
          <option value="en">Inglés</option>
        </select>
        <p className="mt-1 text-xs text-ink-soft">Detectar usa el idioma del material enviado; español se trata como español latinoamericano.</p>
      </div>


      <fieldset className="mt-5">
        <legend className="sr-only">Tipo de material</legend>
        <div className="inline-flex rounded-sm border border-rule bg-paper-deep p-1">
          {KINDS.map((k) => (
            <label key={k.id} className="cursor-pointer">
              <input type="radio" name="kind" value={k.id} checked={kind === k.id} onChange={() => setKind(k.id)} className="peer sr-only" />
              <span className="block rounded-sm px-4 py-1.5 text-sm font-medium text-ink-soft transition hover:text-ink peer-checked:bg-ink peer-checked:text-paper peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-celeste-deep">
                {k.label}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* Every kind stays mounted, so switching back keeps what was typed; the hidden ones are disabled and not sent. */}
      <fieldset hidden={kind !== "text"} disabled={kind !== "text"} className="mt-4">
        <label htmlFor={ids.text} className={label}>Texto a chequear</label>
        <textarea
          id={ids.text}
          data-autofocus
          name="text"
          rows={6}
          required
          minLength={TEXT_MIN}
          maxLength={TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={submitShortcut}
          aria-invalid={invalid("text")}
          aria-describedby={describedBy("text", ids.textHint)}
          placeholder="Pegá acá la noticia, el posteo o la declaración que querés que chequeemos, o la pregunta que querés que el panel responda."
          className={field}
        />
        <div className="mt-1.5 flex justify-between gap-3 text-xs text-ink-soft">
          <span id={ids.textHint}>Mínimo {TEXT_MIN} caracteres. Ctrl + Enter para enviar.</span>
          <span className={"shrink-0 tabular-nums " + (count.short ? "font-medium text-falso" : "")}>{count.label}</span>
        </div>
      </fieldset>

      <fieldset hidden={kind !== "link"} disabled={kind !== "link"} className="mt-4 space-y-4">
        <div>
          <label htmlFor={ids.url} className={label}>Enlace</label>
          <input id={ids.url} data-autofocus name="url" type="url" required inputMode="url" placeholder="https://..." aria-invalid={invalid("url")} aria-describedby={describedBy("url")} className={field} />
        </div>
        <div>
          <label htmlFor={ids.linkNote} className={label}>
            ¿Qué parte te genera dudas? <span className="font-normal text-ink-soft">(opcional)</span>
          </label>
          <input id={ids.linkNote} name="note" maxLength={500} aria-invalid={invalid("note")} aria-describedby={describedBy("note")} className={field} />
        </div>
      </fieldset>

      <fieldset hidden={kind !== "image"} disabled={kind !== "image"} className="mt-4 space-y-4">
        <label
          htmlFor={ids.image}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className={
            "block cursor-pointer rounded-sm border border-dashed bg-paper/50 px-4 py-6 text-center text-sm text-ink-soft hover:border-celeste-deep " +
            (invalid("image") ? "border-falso" : "border-ink-soft/60")
          }
        >
          <span className="block font-medium text-ink">Subí, arrastrá o pegá una captura</span>
          <span className="block">PNG, JPG, WEBP o GIF, hasta 4 MB</span>
          <input
            ref={fileRef}
            id={ids.image}
            data-autofocus
            name="image"
            type="file"
            accept={IMAGE_TYPES.join(",")}
            required
            onChange={(e) => chooseImage(e.target.files?.[0])}
            aria-invalid={invalid("image")}
            aria-describedby={describedBy("image")}
            className="mx-auto mt-3 block text-xs"
          />
          {image && <span className="mt-2 block text-xs text-ink">Elegiste {image.name} ({megabytes(image.size)}).</span>}
        </label>
        <div>
          <label htmlFor={ids.imageNote} className={label}>
            ¿Qué parte te genera dudas? <span className="font-normal text-ink-soft">(opcional)</span>
          </label>
          <input id={ids.imageNote} name="note" maxLength={500} aria-invalid={invalid("note")} aria-describedby={describedBy("note")} className={field} />
        </div>
      </fieldset>

      {problem && (
        <p id={ids.error} role="alert" className="mt-3 text-sm font-medium text-falso">
          {problem.error}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-sm text-xs text-ink-soft">El análisis tarda unos minutos. Vas a poder seguir el estado en la página de tu caso.</p>
        <button
          type="submit"
          disabled={pending}
          className="btn-primary"
        >
          {pending ? "Enviando…" : "Pedir el chequeo"}
        </button>
      </div>
    </form>
  );
}
