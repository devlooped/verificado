import type { Metadata } from "next";
import Link from "next/link";
import { VERDICT_LABEL } from "@/domain/case.ts";
import { COUNSEL, COUNSEL_NAMES, MODEL_NAME, VERDICTS, type Verdict } from "@/domain/court.ts";
import { GavelIcon, ModelMark, VERDICT_TEXT, VerdictGlyph } from "@/components/marks.tsx";
import { REQUEST_PANEL_ID } from "@/lib/request-panel.ts";
import { ProcessDiagram } from "./process-diagram.tsx";

export const metadata: Metadata = {
  title: "Método · Che bot, ...🤌?",
  description: "Cómo el panel de inteligencias artificiales chequea afirmaciones y responde preguntas.",
};

const STEPS = [
  { n: "I", title: "Clasificación", body: "Un modelo clasificador lee el material, distingue si trae afirmaciones para chequear o preguntas para responder y separa cada una, hasta cinco, sin investigarlas ni responderlas." },
  { n: "II", title: "Respuestas", body: COUNSEL_NAMES + " investigan en paralelo, cada uno con las herramientas de búsqueda de su proveedor, y responden con sus palabras, sin debatir entre sí." },
  { n: "III", title: "Afirmaciones", body: "Cada analista vota cada afirmación y el contenido completo: verdadero, falso, insostenible o engañoso. Si tres coinciden, hay mayoría. Si no, desempata el moderador." },
  { n: "IV", title: "Preguntas", body: "No se califican. Para cada pregunta, el moderador sintetiza la opinión mayoritaria de los analistas o, si no hay mayoría, sus distintas posiciones." },
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
          Un clasificador, cuatro analistas, un moderador, cero opiniones humanas.
        </p>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Presentá un texto, un enlace o una imagen. Si trae afirmaciones, el panel las chequea y las vota; si trae preguntas, las responde y el moderador sintetiza sus respuestas. Nadie edita, nadie opina, todo queda en el registro público.
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
        <h2 className="font-display text-3xl">Las etapas del chequeo</h2>
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
            Si hay al menos tres votos pero no hay mayoría, el moderador desempata con el contenido, las respuestas y los votos. Su decisión lleva el sello de desempate; podés ver qué modelo moderó y leer los fundamentos.
          </span>
        </p>
        <p className="mt-4 text-sm text-ink-soft">Estos resultados son solo para afirmaciones: las preguntas no reciben ninguno.</p>
      </section>

      <section id="afirmaciones-y-preguntas" className="mt-12 scroll-mt-6">
        <h2 className="font-display text-3xl">Afirmaciones y preguntas</h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          Antes de que los analistas empiecen, un modelo clasificador lee el material y separa cada afirmación o cada pregunta, hasta cinco. Si trae <strong className="text-ink">afirmaciones</strong>, como una noticia, un posteo o una declaración, o si pide verificar una (“¿es cierto que…?”), cada analista, en paralelo, busca con las herramientas de su proveedor y responde con sus palabras sobre esas afirmaciones y el conjunto, y luego vota cada afirmación y el contenido completo por separado. Para cada resultado, tres votos coincidentes deciden y el moderador resume brevemente los fundamentos de las mayorías, sin investigar ni cambiar la calificación; si hay al menos tres votos sin mayoría, desempata con el contenido, las respuestas y los votos. Con menos de tres votos no hay resultado. Si el material solo trae opiniones, se vota solo el contenido completo. No hay crítica de fuentes ni debate, y las páginas que cita cada respuesta son las de su proveedor, no fuentes revisadas por el panel.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-soft">
          Si el material le hace al panel una o varias <strong className="text-ink">preguntas</strong>, cada analista las responde una por una con su propia búsqueda, y para cada pregunta el moderador redacta una síntesis de las respuestas, sin investigar ni agregar datos propios: si al menos tres analistas coinciden, sintetiza esa opinión mayoritaria; si no, sintetiza las distintas posiciones y quién sostiene cada una. Las preguntas no se votan ni se califican, ni una por una ni en conjunto. Con menos de tres respuestas no hay síntesis.
        </p>
      </section>

      <section id="proceso" className="mt-14 scroll-mt-6">
        <div className="rule-double pt-5">
          <h2 className="font-display text-3xl">El proceso, paso a paso</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Desde el material que recibimos hasta el resultado o la síntesis final.
          </p>
        </div>
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
