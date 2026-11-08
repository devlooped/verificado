# PhaseSession: cotejo offline, no recuperación

`verifyPhaseSessionExport` valida un **formato de exportación offline nuevo**,
no un checkpoint ejecutable ni el journal de Workflow. No llama PhaseSession,
DB, artefactos, Sandbox, modelos ni reloj. Devuelve diagnóstico sin `body`,
resultado restaurable, referencia o estado `ready`. Su preflight siempre queda
`blocked`, `continuationEnabled:false`; no existe publicación ni wiring runtime.

## Contratos investigados

- `phase-session.ts` persiste una conversación por fase/asiento/canal. `open`
  exige modelo efectivo (incluyendo opciones/cache), sistema y tools iguales;
  no reescribe el prefijo. `begin` reutiliza el turno y su deadline, y conserva
  cursores. El repositorio usa revisión CAS; no guarda origen/generación/formato.
- `settled-play.ts` usa PhaseSession en Expert pipelines 2–5, preparación y
  decisión. Quick y pipeline 1 no tienen este contrato. El ID del turno depende
  de spec, intento y secuencias. La decisión marca `inFlightStep` antes de
  `hostStage`; artefactos, auditoría, acciones y mensajes no son una publicación
  atómica. `answer` tipada es un resultado pendiente de aplicar, no turno final.
- `preparation.ts` persiste tool choice y después el ID/path del comando remoto.
  Una interrupción entre lanzamiento y save puede dejar resultado desconocido;
  quitar `activeTurn` no finaliza el turno. El binding/journal/VM son contratos
  externos que este cotejo no consulta. Un timeout nativo puede guardar draft
  vacío y `done/complete:true`: esos flags no prueban una respuesta recuperable.
- `store.ts` mantiene el namespace legacy y lectura `generation:<g>:<key>`;
  guardar PhaseSession con writer generacional sigue fallando antes de DB con
  `Continuation phase requires atomic checkpoint publication`.

## Alcance verificable

La envoltura `phase_session_offline_export`, versión 1, exige case, pipeline
2–5, generación fuente explícita (0 legacy), run/deployment, session ID, clave
lógica y clave física, revisión CAS y cuerpo JSON. **Estos metadatos son claims
del exportador**, no datos inferidos del cuerpo legacy. La expectativa aporta
por separado origen, revisión, hash canónico de toda la exportación, configuración
efectiva y hash del primer mensaje. Los pins deben obtenerse independientemente;
un hash recalculado por el exportador no autentica un origen.

No se convierte generación 0 en una nueva ni se elige el pipeline actual.
Configuración, identidad/namespace, prefijo y revisión distintos bloquean.
Tools se compara como string exacto; el orden de claves JSON del modelo no cambia
su igualdad. El cuerpo no se normaliza ni se guarda. Campos futuros/desconocidos
se rechazan, en lugar de adaptar por suposición.
También se rechaza cualquier pérdida de datos al parsear el schema (incluidas
claves de diccionarios omitidas por el parser), y resultados sin campo `output`.

Se comprueban offset de cada turno sobre un mensaje user, identidad, copia exacta
del active turn (puede faltar en un turno interrumpido), forma de mensajes y
resultados JSON, IDs/paths de marcadores y pending typed answer. Las partes de
mensajes y eventos son JSON opaco: **no** se valida aquí su semántica AI SDK,
la regla de cierre de evidencia, tool-call pairing ni secuencias comprometidas.

Límites actuales, sin renovarlos:

- Contexto: `JSON.stringify(messages).length <= 2_000_000`, unidades UTF-16;
  no es un límite de bytes ni tokens del proveedor.
- Preparación: hasta 8 pasos y deadline original de 300 s. Decisión: 20 pasos,
  300 s, o 600 s para decisión tipada de instrucción/crítica en pipelines 3–5.
  Budgets personalizados permitidos por la API legacy quedan fuera de este
  subconjunto offline: no se modifica esa API para rechazarlos.
- El instante de observación es explícito y no habilita ejecución. Se reporta
  vencimiento y pasos registrados; no se calcula presupuesto pagado recuperable.
  Una sesión finalizada puede inspeccionarse después del deadline: falta
  `finishedAt`, por lo que no se prueba que terminara a tiempo.
- Recursos del validador offline: profundidad 32, 100.000 nodos/array y 8.000.000
  caracteres JSON (keys/strings). Son caps locales adicionales, no límites del
  runtime. Se rechazan getters/proxies/toJSON ejecutable, JSON disperso/oculto,
  ciclos y valores no JSON antes de schemas/hashes, sin ejecutar esos accesos.

`locally-finalized` solo describe flags con datos locales presentes. `unresolved`,
`exhausted`, `interrupted` y `result-unproved` no son estados de una operación
durable ni autorizan reintentar. Todos conservan blockers: origen autenticado,
prefijo de eventos, semántica de mensajes, cobertura de operaciones, finalización
temporal y recuperación runtime sin probar. No se recuperan turnos ni presupuestos,
ni se demuestra retención, inactividad histórica o recuperación de AT-185-GA.

## Evidencia local y separación de contratos

El test del caller real usa `advanceSharedTurn`, AI SDK con modelo mock,
SourceService y repositorios/artefactos en memoria: interrumpe auditoría después
de la generación durable y antes de append. El estado contiene acciones locales
y `inFlightStep`, pero perdió `activeTurn` y no avanzó pasos/mensajes; el cotejo
lo mantiene `unresolved` sin ejecutar otra generación ni alterar la fila.
DB/fetch/download quedan instrumentados para fallar y registran cero llamadas.
Los tests legacy siguen comprobando replay dentro de **su** journal; eso no
demuestra que una exportación aislada pueda reemplazarlo.

Puntos de revisión: [PhaseSession](../src/court/phase-session.ts#L74),
[caller/orden de efectos](../src/court/settled-play.ts#L143),
[comando de preparación](../src/instruction/preparation.ts#L140),
[CAS y bloqueo generacional](../src/store.ts#L920).
