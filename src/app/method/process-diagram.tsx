import { render } from "pele";

// The source is fixed in the application, not supplied by visitors.
export const PROCESS_DIAGRAM = `flowchart TD
  accTitle: El proceso de un chequeo
  accDescr: El moderador clasifica el material como afirmaciones o preguntas. Con preguntas, los cuatro analistas responden en paralelo y, si al menos tres respondieron, el moderador sintetiza la opinión mayoritaria o, sin mayoría, las posiciones de los analistas; las preguntas no se califican. Con afirmaciones, opcionalmente el moderador identifica afirmaciones independientes antes de la investigación. Los cuatro analistas investigan y votan el contenido completo y, si se eligió, cada afirmación en paralelo. Para cada resultado, tres votos coincidentes deciden; el moderador resume sus fundamentos sin investigar. Con al menos tres votos sin mayoría, desempata sin investigar. Con menos de tres votos o si falla el desempate no hay resultado; tampoco si falla el resumen de las mayorías.
  A["Se presenta un texto, enlace o imagen"] --> Q{"El moderador clasifica el material:<br/>¿afirmaciones o preguntas?"}
  Q -- Preguntas --> R["Los cuatro analistas investigan en paralelo<br/>y responden las preguntas"]
  R --> S{"¿Respondieron al menos 3?"}
  S -- No --> T["Sin síntesis"]
  S -- Sí --> U{"¿Hay una opinión mayoritaria?"}
  U -- Sí --> V["El moderador sintetiza<br/>la opinión mayoritaria"]
  U -- No --> W["El moderador sintetiza<br/>las posiciones de los analistas"]
  V --> X["Sin calificación de las preguntas"]
  W --> X
  Q -- Afirmaciones --> O{"¿Identificar afirmaciones independientes?"}
  O -- Sí --> P["El moderador lee el material<br/>y separa hasta cinco afirmaciones"]
  O -- No --> B["Los cuatro analistas investigan en paralelo<br/>con las herramientas de sus proveedores"]
  P --> B
  B --> C["Cada analista responde y vota<br/>el contenido completo con fundamentos<br/>y cada afirmación, si se eligió"]
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
        aria-label="Diagrama del chequeo; desplazá horizontalmente para verlo completo"
        dangerouslySetInnerHTML={{ __html: diagram.svg }}
      />
    </figure>
  );
}
