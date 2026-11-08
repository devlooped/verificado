import Link from "next/link";
import type { CaseRecord } from "@/domain/court.ts";
import { isAdmin, type CaseUser } from "@/lib/case-access.ts";

export function Suspended({ c, user }: { c: CaseRecord; user: CaseUser | null | undefined }) {
  const admin = isAdmin(user);
  return (
    <section className="mx-auto max-w-2xl py-16 text-center">
      <h1 className="font-display text-5xl">El análisis se interrumpió</h1>
      <p className="mx-auto mt-4 max-w-md text-ink-soft">El panel no pudo completar el análisis.</p>
      {admin && c.error && <p className="mx-auto mt-3 max-w-md font-mono text-xs text-ink-soft">Detalle: {c.error}</p>}
      {admin ? (
        <div className="mt-6">
          <button type="button" disabled aria-describedby="retry-blocked retry-estimate" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">Reintentar</button>
          <p id="retry-blocked" className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
            Reintentar está bloqueado: la continuación segura está desactivada. No se reinicia ni se borra el expediente, no se limpian sus sandboxes ni se inicia otra ejecución.
          </p>
          <p id="retry-estimate" className="mx-auto mt-3 max-w-md text-sm text-ink-soft">
            No se puede estimar el costo pendiente ni qué resultados podrán reutilizarse.
          </p>
          <p className="mx-auto mt-3 max-w-md text-sm text-ink-soft">
            «Volver a ejecutar» es una operación administrativa distinta: elimina resultados y archivos generados y empieza de cero. No se usa como alternativa de Reintentar.
          </p>
        </div>
      ) : (
        <p className="mx-auto mt-4 max-w-md text-sm text-ink-soft">
          Si necesitás este resultado, escribinos a{" "}
          <a href={"mailto:hola@che.bot?subject=" + encodeURIComponent("Caso " + c.id + " interrumpido")} className="font-medium text-celeste-deep underline">hola@che.bot</a>{" "}
          con el número de caso ({c.id}).
        </p>
      )}
      <p className="mt-6 text-sm">
        <Link href="/" className="text-celeste-deep underline decoration-celeste/40 underline-offset-4 hover:decoration-celeste-deep">← Volver a los casos</Link>
      </p>
    </section>
  );
}
