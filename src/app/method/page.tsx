import type { Metadata } from "next";
import Link from "next/link";
import { VERDICT_LABEL } from "@/domain/case.ts";
import { COUNSEL, COUNSEL_NAMES, MODEL_NAME, VERDICTS, type Verdict } from "@/domain/court.ts";
import { GavelIcon, ModelMark, VERDICT_TEXT, VerdictGlyph } from "@/components/marks.tsx";
import { REQUEST_PANEL_ID } from "@/lib/request-panel.ts";
import { ProcessDiagram, QuickProcessDiagram } from "./process-diagram.tsx";

export const metadata: Metadata = {
  title: "Método · Che bot, es cierto?",
  description: "Cómo el panel de inteligencias artificiales realiza chequeos rápidos y expertos.",
};

const STEPS = [
  { n: "I", title: "Instrucción", body: "El moderador fija las afirmaciones. " + COUNSEL_NAMES + " buscan pruebas a favor y en contra. El moderador unifica las fuentes y conserva los aportes de cada analista." },
  { n: "II", title: "Crítica de fuentes", body: "Cada analista revisa la confiabilidad de las fuentes. Tres de los cuatro votos anulan una fuente; todos los votos y sus motivos quedan registrados." },
  { n: "III", title: "Debate", body: "Con las fuentes admitidas conocidas por todos, cada analista expone, responde y puede objetar a sus colegas. El moderador resuelve las objeciones." },
  { n: "IV", title: "Resultado", body: "Votan verdadero, falso, insostenible o engañoso. Si tres coinciden, hay mayoría. Si no, desempata el moderador con la evidencia del registro." },
];

const VERDICT_MEANING: Record<Verdict, string> = {
  verdadero: "La evidencia respalda el contenido o la afirmación.",
  falso: "La evidencia contradice el contenido o la afirmación.",
  no_verificable: "La evidencia no alcanza para sostenerla ni para refutarla.",
  enganoso: "Presenta datos parciales o fuera de contexto que inducen a una conclusión equivocada.",
};

export default function MethodPage() {
  return (
    <>
      <header className="reveal pt-10">
        <p className="font-mono text-xs uppercase tracking-widest text-ink-soft">Método</p>
        <h1 className="mt-2 max-w-3xl font-display text-5xl leading-[1.02] sm:text-6xl">
          ¿Es cierto lo que leíste? <em className="text-celeste-deep">Que lo chequeen.</em>
        </h1>
        <p className="mt-4 max-w-3xl font-display text-2xl leading-snug text-ink-soft sm:text-3xl">
          Cuatro analistas, un moderador, cero opiniones humanas.
        </p>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Presentá un texto, un enlace o una imagen. Elegí entre un chequeo rápido, con respuestas y votos independientes, o uno experto, con investigación, crítica de fuentes y debate. Nadie edita, nadie opina, todo queda en el registro público.
        </p>
        <p className="mt-6">
          <button type="button" popoverTarget={REQUEST_PANEL_ID} className="btn-primary">
            Pedir un chequeo
          </button>
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {COUNSEL.map((c) => (
            <span key={c} className="inline-flex items-center gap-2 rounded-full border border-rule bg-paper/70 py-1.5 pl-1.5 pr-3.5 text-sm">
              <span className="grid size-7 place-items-center rounded-full bg-paper-deep">
                <ModelMark model={c} className="size-4" />
              </span>
              {MODEL_NAME[c]}
            </span>
          ))}
        </div>
      </header>

      <section className="mt-14 border-y border-rule py-8">
        <h2 className="font-display text-3xl">Las etapas del chequeo experto</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <div key={s.n} className="reveal" style={{ animationDelay: 60 + i * 60 + "ms" }}>
              <span className="font-display text-3xl italic text-celeste-deep">{s.n}.</span>
              <h3 className="mt-1 font-display text-2xl">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="resultados" className="mt-12 scroll-mt-6">
        <h2 className="font-display text-3xl">Los cuatro resultados posibles</h2>
        <dl className="mt-5 grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {VERDICTS.map((v) => (
            <div key={v} className="flex items-start gap-3">
              <span className={"mt-1 grid size-8 shrink-0 place-items-center rounded-full border border-rule bg-paper/70 " + VERDICT_TEXT[v]}>
                <VerdictGlyph verdict={v} className="size-4" />
              </span>
              <div>
                <dt className={"font-display text-2xl leading-none " + VERDICT_TEXT[v]}>{VERDICT_LABEL[v]}</dt>
                <dd className="mt-1 text-sm text-ink-soft">{VERDICT_MEANING[v]}</dd>
              </div>
            </div>
          ))}
        </dl>
        <p className="mt-8 flex items-start gap-3 text-sm text-ink-soft">
          <GavelIcon className="mt-0.5 size-4 shrink-0 text-seal" />
          <span>
            En el chequeo rápido, si hay al menos tres votos pero no hay mayoría, el moderador desempata con el contenido, las respuestas y los votos. En el experto, desempata las afirmaciones sin mayoría con la evidencia del registro. Su decisión lleva el sello de desempate; podés ver qué modelo moderó y leer los fundamentos.
          </span>
        </p>
        <p className="mt-4 text-sm text-ink-soft">En el chequeo experto, después de decidir las afirmaciones, los analistas evalúan el contenido completo si hay una sola afirmación o forman una narrativa común. Si al menos tres votan sobre el conjunto, tres votos coincidentes dan el resultado; si no coinciden, desempata el moderador. Las afirmaciones independientes pueden no tener un resultado global. Los casos anteriores pueden no incluir esta votación.</p>
      </section>

      <section id="chequeo-rapido" className="mt-12 scroll-mt-6">
        <h2 className="font-display text-3xl">Chequeo rápido y chequeo experto</h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          Al pedir un chequeo elegís el tipo. El <strong className="text-ink">chequeo rápido</strong> (el predeterminado) le pregunta a cada analista, en paralelo, si el contenido es cierto: cada uno busca con las herramientas de su proveedor, responde con sus palabras y vota sobre el contenido completo. Tres votos coincidentes dan el resultado; si hay al menos tres votos sin mayoría, el moderador desempata con el contenido, las respuestas y los votos, sin investigar. Con menos de tres votos no hay resultado y un administrador puede reintentar el caso. No hay crítica de fuentes ni debate, y las páginas que cita cada respuesta son las de su proveedor, no fuentes revisadas por el panel.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          Con el rol <strong className="text-ink">Contrib o Admin</strong> podés activar <strong className="text-ink">Identificar afirmaciones independientes</strong>: el moderador lee el material y separa hasta cinco afirmaciones, como en el experto. Cada analista realiza una sola investigación rápida que cubre esas afirmaciones y el conjunto, y luego vota cada afirmación y el contenido completo por separado, aunque sean independientes entre sí. Cada resultado usa la misma regla de tres votos y desempate. Si no hay afirmaciones factuales, se vota solo el contenido completo. La opción está desactivada por defecto y puede tardar un poco más; no agrega debate ni crítica de fuentes.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          El <strong className="text-ink">chequeo experto</strong> sigue el proceso completo de instrucción, crítica de fuentes, debate y votos por afirmación. Tarda más y deja un registro más detallado.
        </p>
      </section>

      <section id="proceso" className="mt-14 scroll-mt-6">
        <div className="rule-double pt-5">
          <h2 className="font-display text-3xl">Los procesos, paso a paso</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Desde el material que recibimos hasta la decisión final, así funciona cada tipo de chequeo.
          </p>
        </div>
        <h3 className="mt-8 font-display text-2xl">Chequeo rápido</h3>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">Los analistas responden y votan el contenido completo sin debatir entre sí.</p>
        <QuickProcessDiagram />
        <h3 className="mt-10 font-display text-2xl">Chequeo experto</h3>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">El panel investiga, critica las fuentes y debate cada afirmación.</p>
        <ProcessDiagram />
        <p className="mt-10">
          <Link href="/" className="text-celeste-deep underline decoration-celeste/40 underline-offset-4 hover:decoration-celeste-deep">
            ← Volver a los casos
          </Link>
        </p>
      </section>
    </>
  );
}
