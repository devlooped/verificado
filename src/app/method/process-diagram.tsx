import { render } from "pele";

// The source is fixed in the application, not supplied by visitors.
export const PROCESS_DIAGRAM = `flowchart TD
  accTitle: El proceso de una evaluación
  accDescr: Un modelo clasificador decide si el material trae afirmaciones o preguntas y separa cada una. Con preguntas, los cuatro analistas responden en paralelo y, si al menos tres respondieron, cada uno responde cada pregunta Sí, No, Depende, No sé o Dato; tres respuestas iguales dan la del panel y, sin mayoría, desempata el moderador sin investigar. Luego el moderador sintetiza para cada pregunta la opinión mayoritaria o, sin mayoría, las posiciones de los analistas. Con afirmaciones, los cuatro analistas investigan y votan en paralelo cada afirmación y el contenido completo. Para cada resultado, tres votos coincidentes deciden; el moderador resume sus fundamentos sin investigar. Con al menos tres votos sin mayoría, desempata sin investigar. Con menos de tres votos o si falla el desempate no hay resultado; tampoco si falla el resumen de las mayorías.
  A["Se presenta un texto, enlace o imagen"] --> Q{"El clasificador lee el material<br/>y separa hasta cinco ítems:<br/>¿afirmaciones o preguntas?"}
  Q -- Preguntas --> R["Los cuatro analistas investigan en paralelo<br/>y responden cada pregunta"]
  R --> S{"¿Respondieron al menos 3?"}
  S -- No --> T["Sin síntesis"]
  S -- Sí --> Y["Cada analista responde cada pregunta:<br/>Sí, No, Depende, No sé o Dato"]
  Y --> U{"Por cada pregunta:<br/>¿Hay 3 respuestas iguales?"}
  U -- Sí --> V["Respuesta del panel por mayoría"]
  U -- No --> W["El moderador desempata<br/>sin investigar"]
  V --> X["El moderador sintetiza la opinión mayoritaria<br/>o las posiciones de los analistas"]
  W --> X
  Q -- Afirmaciones --> B["Los cuatro analistas investigan en paralelo<br/>con las herramientas de sus proveedores"]
  B --> C["Cada analista responde y vota<br/>cada afirmación y el contenido completo<br/>con fundamentos"]
  C --> D["Se registran las respuestas, las citas<br/>de los proveedores, los votos y las ausencias"]
  D --> E{"Por cada resultado:<br/>¿Hay 3 votos coincidentes?"}
  E -- Sí --> F["Resultado por mayoría"]
  F --> L["El moderador resume los fundamentos<br/>de las mayorías sin investigar"]
  L --> M{"¿Pudo resumir?"}
  M -- Sí --> N["Resumen disponible"]
  M -- No --> H
  E -- No --> G{"¿Hay al menos 3 votos?"}
  G -- No --> H["Sin resultado"]
  G -- Sí --> I["El moderador desempata con el contenido,<br/>las respuestas y los votos, sin investigar"]
  I --> J{"¿Pudo desempatar?"}
  J -- Sí --> K["Resultado con fundamento del moderador"]
  J -- No --> H`;

const diagram = render(PROCESS_DIAGRAM, { idPrefix: "proceso-metodo", responsive: false, links: false, images: false });

export function ProcessDiagram() {
  return (
    <figure className="mt-6">
      <figcaption className="mb-2 text-xs text-ink-soft">
        En pantallas pequeñas, deslizá horizontalmente para recorrer el diagrama completo.
      </figcaption>
      <div
        className="process-diagram overflow-x-auto rounded-sm border border-rule bg-paper/70 p-4 sm:p-6"
        tabIndex={0}
        role="region"
        aria-label="Diagrama de la evaluación; desplazá horizontalmente para verlo completo"
        dangerouslySetInnerHTML={{ __html: diagram.svg }}
      />
    </figure>
  );
}