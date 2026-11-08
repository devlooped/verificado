import { render } from "pele";

// The source is fixed in the application, not supplied by visitors.
export const PROCESS_DIAGRAM = `flowchart TD
  accTitle: El proceso de un chequeo experto
  accDescr: Desde el material enviado hasta el cierre del debate, pasando por instrucción, crítica de fuentes, exposiciones, objeciones, votos y resultado.
  A["Se presenta un texto, enlace o imagen"] --> B["Se abre el debate: moderador y cuatro analistas"]
  B --> C{"¿Hay afirmaciones<br/>fácticas verificables?"}
  C -- No --> D["El moderador descarta el caso<br/>y explica el motivo"]
  D --> Z["Termina el debate"]
  C -- Sí --> E["El moderador fija<br/>entre 1 y 5 afirmaciones"]

  subgraph INSTRUCCION["1. Instrucción"]
    E --> F["Los cuatro analistas investigan en paralelo<br/>a favor y en contra de cada afirmación"]
    F --> G["Registran sus aportes y documentan<br/>las búsquedas, incluso sin resultados"]
    G --> H["El moderador unifica los aportes por URL<br/>y conserva sus autores y fragmentos"]
  end

  subgraph FUENTES["2. Crítica de fuentes"]
    H --> I{"¿Hay fuentes?"}
    I -- No --> M["Expediente común sin fuentes"]
    I -- Sí --> J["Cada analista vota vetar o no vetar<br/>cada fuente y da sus motivos"]
    J --> K{"Para cada fuente:<br/>¿hay al menos 3 vetos?"}
    K -- Sí --> L["Fuente anulada"]
    K -- No --> N["Fuente admitida"]
    L --> O["Se cierra la instrucción"]
    N --> O
    M --> O
  end

  subgraph DEBATE["3. Debate"]
    O --> P["Primero, exposiciones iniciales de los cuatro;<br/>luego, réplicas de los cuatro"]
    P --> INTERVENCION["Un analista toma la palabra"]
    INTERVENCION --> Q["Los otros tres pueden formular objeciones"]
    Q --> R{"¿Hay objeciones?"}
    R -- No --> U{"¿Quedan intervenciones<br/>en esta etapa o la siguiente?"}
    R -- Sí --> S["Por cada objeción, el autor puede responder<br/>y el moderador la resuelve"]
    S --> T{"¿Se acepta la objeción?"}
    T -- Sí --> V["Se anula la intervención objetada"]
    T -- No --> W["La intervención se mantiene"]
    V --> U
    W --> U
    U -- Sí --> INTERVENCION
    U -- No --> X["Cada analista presenta su conclusión<br/>y vota cada afirmación con fundamentos"]
  end

  subgraph RESULTADO["4. Resultado"]
    X --> Y{"Para cada afirmación:<br/>¿hay 3 votos coincidentes?"}
    Y -- Sí --> AA["Resultado por mayoría"]
    Y -- No --> AB["El moderador desempata<br/>y fundamenta su decisión"]
    AA --> AC["El moderador resume argumentos,<br/>acuerdos y desacuerdos"]
    AB --> AC
    AC --> Z
  end`;

export const QUICK_PROCESS_DIAGRAM = `flowchart TD
  accTitle: El proceso de un chequeo rápido
  accDescr: Opcionalmente el moderador identifica afirmaciones independientes antes de la investigación. Los cuatro analistas investigan y votan el contenido completo y, si se eligió, cada afirmación en paralelo. Para cada resultado, tres votos coincidentes deciden; el moderador resume sus fundamentos sin investigar. Con al menos tres votos sin mayoría, desempata sin investigar. Con menos de tres votos o si falla el desempate no hay resultado; tampoco si falla el resumen de las mayorías.
  A["Se presenta un texto, enlace o imagen"] --> O{"¿Identificar afirmaciones independientes?"}
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
const quickDiagram = render(QUICK_PROCESS_DIAGRAM, { idPrefix: "proceso-rapido", responsive: false, links: false, images: false });

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
        aria-label="Diagrama del chequeo experto; desplazá horizontalmente para verlo completo"
        dangerouslySetInnerHTML={{ __html: diagram.svg }}
      />
    </figure>
  );
}

export function QuickProcessDiagram() {
  return (
    <figure className="mt-6">
      <figcaption className="mb-2 text-xs text-ink-soft">
        En pantallas pequeñas, deslizá horizontalmente para recorrer el diagrama completo.
      </figcaption>
      <div
        className="process-diagram overflow-x-auto rounded-sm border border-rule bg-paper/70 p-4 sm:p-6"
        tabIndex={0}
        role="region"
        aria-label="Diagrama del chequeo rápido; desplazá horizontalmente para verlo completo"
        dangerouslySetInnerHTML={{ __html: quickDiagram.svg }}
      />
    </figure>
  );
}
