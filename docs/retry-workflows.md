# Retry de workflows nuevos: base verificada, rutas bloqueadas

Estado: **implementación parcial y aislada**, con almacenamiento transaccional de
intentos, creación exclusiva, motor/cursores Quick y Expert offline, controlador y observación real
de hooks. No hay entrypoint ni creación/acción/UI productivos conectados. Los
adaptadores reales de efectos y las garantías de retención/deployment no están
acreditados. No se completó el plan; ningún caso, incluido `AT-185-GA`, es
reintentable. Retry y continuación siguen deshabilitados.

## Contrato separado, exclusivamente desde creación

[`retry-contract.ts`](../src/domain/retry-contract.ts) define `same-run-retry/1`.
No es pipeline 6, una generación de continuación ni un importador histórico.
Los perfiles de diseño son **Quick con pipeline 5** y **Expert nativo con pipeline
5** en un workflow nuevo. Los cursores Quick y Expert están implementados sólo para simulación;
ambos perfiles reales siguen bloqueados.
Los pipelines anteriores no se incorporan al contrato; tampoco se convierte un
caso legacy pipeline 5 en elegible. No se modificaron las firmas ni la secuencia
de pasos de `courtSession`, ni los entry points administrativos existentes.

El contrato requiere:

- Identidad de creación (caso, nonce y fecha), clave idempotente del **arranque
  inicial** y snapshot semántico completo: submission, modelos/opciones, textos
  de prompts, herramientas/esquemas, idioma, fecha de trabajo y presupuestos.
  Las imágenes/artefactos necesitan además referencias inmutables verificadas
  por su adaptador; JSON con aspecto de referencia no demuestra sus bytes.
- Hash canónico del snapshot y de creación. Se reutiliza únicamente el
  canonicalizador puro de `continuation.ts`, sin importar históricos, activar
  `CONTINUATION_ENABLED` ni reutilizar la reserva de otro run.
- Binding caso/run/deployment/World separado de creación: sólo puede publicarse
  después de conciliar intención de inicio, registro del primer paso y resultado
  de `start`. La huella de creación excluye ese binding porque crear debe
  preceder al arranque. Una respuesta perdida nunca autoriza otro `start`.
- Política explícita de cero retries automáticos por Workflow, IA, proveedor,
  broker y sandbox. El esquema rechaza valores distintos de cero, pero esto
  **no prueba** que los adaptadores/SDK los respeten: debe comprobarse en cada
  subefecto antes de habilitar el perfil.

El parser valida formato, JSON no perdedor y hashes, **no completitud semántica
de un panel** ni autenticidad del registro de creación. La transacción aislada de
`PgRetryRepository.create` registra contrato/caso/auditoría mediante INSERT
exclusivo, nunca lo adjunta a casos existentes. El preflight exige prueba de
creación atómica y de arranque conciliado, no sólo hashes recalculados. La app
todavía no llama esa transacción: no inscribe casos nuevos ni viejos.

`RetryFence` separa run, intento y época del mismo run. `retryCommandSchema`
sólo admite clave de solicitud, versión y estado esperado; rechaza contenido
privado, tokens y campos extra. `retryCommandMatches` es validación de payload,
**no autorización, deduplicación durable ni CAS**. El consumidor del repositorio
valida identidad, admin registrado y solicitud bajo lock; el token nunca autoriza.
La autorización real por caso requiere el adaptador administrativo, aún no conectado.

## Matriz inicial de unidades y subefectos

Esta matriz revisa las ramas nuevas propuestas contra `court-session.ts`,
`quick.ts`, `procedure.ts`, `settled-play.ts`, colección/sources, portada y archivo.
Reutiliza el inventario anterior como índice, no como prueba de cobertura. Las
claves son **plantillas de cobertura requerida**; el cursor Quick simulado produce
sus propios checkpoints, sin acreditar las rutas reales. No hay unidad habilitada.
`Q` = Quick; `E` = Expert; `Q/E` = ambos perfiles nuevos de pipeline 5.

Todas las instancias requieren formato, dependencias exactas, entrada completa
con huella, procedencia caso/run/deployment, resultado íntegro con hash o
referencia verificada, timestamps e IDs originales. Toda omisión requiere un
resultado `skipped` con motivo explícito. La frontera publica checkpoint,
referencias, eventos, cursores y auditoría en una sola transacción bajo fence.

| Unidad / clave estable propuesta | Perfil | Dependencias / resultado requerido | Subefectos que necesitan intención y resultado propios |
| --- | --- | --- | --- |
| `case.create` | Q/E | Submission e imagen; snapshot y contrato de origen atómicos | DB y objeto de imagen original |
| `run.initial-start/<requestKey>` | Q/E | Creación; intención, candidato y observación conciliados | `start` inicial; nunca usar para retry |
| `case.open` | Q/E | Binding conciliado; estado inicial sin DELETE/reset | Estado/evento de apertura bajo fence |
| `case.models` | Q/E | Creación; configuración completa fijada, no settings actuales | Publicación del snapshot, sin recargar modelos al reanudar |
| `case.language` | Q/E | Submission/contexto; decisión y entrada exactas, o idioma explícito | Detección por IA si procede |
| `intake.base` | E | Submission; título, contexto, idioma y colección completos | Descarga de URL, descripción de imagen, detección y adquisición por separado |
| `quick.identify/<attempt>` | Q | Snapshot/idioma; claims, IDs, raw request/result y errores | Generación y búsquedas/herramientas nativas por invocación |
| `quick.answer/<seat>/<claimSet>` | Q | Idioma y claims o omisión de identificación; respuesta completa por asiento | Generación, llamadas de herramientas, artefactos de request/result |
| `quick.vote/<seat>/<claimOrContent>/<attempt>` | Q | Respuesta exacta; voto, fundamento, mensajes y validaciones | Generación/voto y herramientas; conservar cada fallo sin convertir timeout en fallo seguro |
| `quick.tiebreak/<claimOrContent>/<attempt>` | Q | Votos completos y ordenados; desempate o `skipped` por consenso | Generación y sus herramientas |
| `quick.publish/<boundary>` | Q | Resultados completos por asiento; prefijo y sufijo con `seq`/IDs fijos | Publicación DB atómica, nunca repetir respuestas para reconstruir ronda |
| `phase.open/<sessionKey>` | E | Docket, snapshot y turn spec; estado/mensajes iniciales completos | PhaseSession CAS bajo mismo fence |
| `phase.preparation/<sessionKey>/<turn>/<unit>` | E | Presupuesto/deadline conservados; request, commandId y resultado exactos | Sandbox create/resume, grants, upload, comando detached y lectura del resultado |
| `phase.decision/<sessionKey>/<turn>/<unit>` | E | Preparación/mensajes; raw response, tool calls, output y errores | Cada generación del gateway y tool outcome, no un único `ready` global |
| `phase.tool/<sessionKey>/<turn>/<callId>` | E | Identidad/hashes de request; resultado completo o `uncertain` | Broker, red, source tools, traducción/verificación y artefactos por subllamada |
| `court.intake` | E | Contexto/idioma; claims y decisión de admisión o desestimación | Turnos del moderador y todas sus unidades de fase |
| `court.instruction/<seat>` | E | Claims; propuestas/instrucción completas por asiento | Sesión, preparaciones, decisión y herramientas |
| `sources.fetch-batch/<batch>/<url>` | E | Propuestas ordenadas; cada `{url, sourceId, error}` exacto | Adquisición por URL; no sustituir por conteos de progreso |
| `sources.acquire/<url>` | E | URL/request; bytes, URL final, error y procedencia completos | HTTP/redirects, Browserbase con/sin proxy y fallback IA X por separado |
| `sources.extract/<sourceId>` | E | Bytes originales verificados; documentos/bloques, errores y versión de extractor | Procesos locales/OCR, archivos temporales y su resultado |
| `sources.canonical/<sourceId>` | E | Extracción; CanonicalSource, bloques/hashes e índice íntegros | Artefactos inmutables y alias publicado bajo fence |
| `sources.discovery/<sourceId>/<callId>` | E | Request de herramienta exacto; resultados/errores | Red/herramientas de proveedor y sandbox |
| `sources.translate/<sourceId>/<language>/<part>` | E | Fuente original; traducción **o** fallback exacto con motivo | Cada generación y verificación de idioma, separadas |
| `sources.file-proposals/<batch>` | E | Fetch completo; cotejo de citas, IDs, errores y eventos | Referencias/publicación; no redescargar para reconstruir resultados |
| `court.source_review/<sourceOrClaim>/<seat>` | E | Corpus y propuestas; revisión completa | Turnos/unidades/herramientas del revisor |
| `court.statement/<round>/<seat>` | E | Prefijo ordenado; outcome, IDs/mapping y errores por asiento | Preparación, generación, traducción y herramientas por separado |
| `court.objection/<statementId>/<seat>` | E | Statement/prefijo; objeción completa o omisión motivada | Turno, unidades y herramientas |
| `court.reply/<objectionId>/<seat>` | E | Objeción; respuesta exacta | Turno, unidades y herramientas |
| `court.ruling/<objectionId>` | E | Objeción/respuesta; decisión exacta | Moderador, unidades y herramientas |
| `court.summary/<round>` | E | Ronda completa ordenada; resumen exacto | Turno del moderador y unidades |
| `court.closing/<seat>` | E | Rondas/corpus; cierre completo | Turno, unidades y herramientas |
| `court.vote/<claimOrContent>/<seat>` | E | Cierre/prefijo; voto completo | `content_vote`/voto por claim, sus unidades |
| `court.tiebreak/<claimOrContent>` | E | Votos completos; desempate u omisión por consenso | `tiebreak`/`content_tiebreak`, sus unidades |
| `court.publish/<round>/<boundary>` | E | Outcomes completos por asiento, orden fijo; cursor/mapping y eventos | Una transacción; ronda parcial no publica asientos fuera de orden |
| `evidence.settle` | E | Resultados/corpus; manifest congelado y traducciones exactas | Revocación, fuentes y todas las traducciones/verificaciones |
| `cover.choice` → `cover.download` → `cover.approve` | Q/E | Cierre; candidato, bytes y aprobación o fallback explícito | Búsqueda IA, descarga, revisión IA por separado |
| `cover.generate` → `cover.publish` | Q/E | Fallback autorizado o imagen original; bytes/hash/ref | Generación de imagen y publicación; no fallback tras respuesta incierta |
| `archive.prompt-translation/<prompt>/<language>` | E | Snapshot cerrado; texto traducido exacto | Generación, verificaciones y escritura de cache global (contrato separado) |
| `archive.publish/<snapshot>` | Q/E | Todos los resultados/referencias; JSONL, JSON, manifest y ZIP completos | Cache, objetos individuales, ZIP y publicación de referencias bajo fence |
| `sandbox.revoke/<binding>` | E | Estado de operaciones/grants; revocación durable | Broker y grants; no prueba por sí sola de inactividad del proveedor |
| `sandbox.dispose/<sandboxId>` | E | Inactividad y retención probadas; resultado u omisión por evidencia requerida | Stop/snapshot/delete sólo tras verificar referencias, comandos y permisos |
| `case.finish` | Q/E | **También** portada, archivo y cleanup; estado final/razón | DB y notificación separadas; `session_closed` no completa estos efectos |
| `case.block/<reason>` / `case.stop/<request>` | Q/E | Estado SDK y efectos completos; diagnóstico/auditoría | No borrar evidencia, no cancelar y luego repetir una llamada incierta |

Expert nativo no necesita importación ni unificación del moderador legacy. Quick
no usa instrucción, corpus ni sandbox; esas unidades deben quedar fuera de su
DAG, no marcarse implícitamente completas. Las omisiones condicionales dentro
de cada perfil (claims, idioma explícito, consenso, portada propia, sin storage)
sí necesitan registros de omisión; ausencia de configuración de storage no
autoriza descartar evidencia requerida por retry.

### Cursor Expert offline: evidencia, no adaptador productivo

[`expert.ts`](../src/retry/expert.ts) exige habilitación explícita de simulación,
World/deployment de fixture y modelos sintéticos. Separa preparación, generación
y cada resultado de herramienta por asiento/intento; conserva mensajes, draft,
presupuestos, timestamps y eventos originales. Cada frontera está anclada a un
checkpoint y sus dependencias verificadas. Asientos completos no se vuelven a
llamar; dos fallos pre-dispatch requieren dos pausas y solicitudes distintas.
Los timeouts, respuestas perdidas y resultados inválidos bloquean sin publicar
una ronda parcial. El driver espera todos los asientos, incluso si un adaptador
lanza una excepción síncrona, antes de bloquear o cambiar de intento.

La simulación se detiene antes de fuentes y también tras desestimación: **no
termina un caso Expert**. Usa un máximo sintético de dos intentos por turno;
conservar el snapshot de presupuestos no demuestra su enforcement productivo.
Faltan preparación/generación/herramientas reales, procedimiento multi-turno,
fuentes, revisión, debate, objeciones, fallos/votos, traducción, portada, archivo
y cleanup. `nextRetryExpertPlan` bloquea por defecto la ruta real.

[`expert-phase.ts`](../src/retry/expert-phase.ts) es un adaptador separado de
checkpoints nuevos con CAS y cadena de hashes, probado en memoria y PostgreSQL
efímero. Conserva
resultados, prefijos de mensajes/eventos y la identidad de `activeTurn` al leer.
No habilita el runtime legacy `PhaseSession` ni demuestra sus subefectos reales.
La fachada nueva `RetryExpertSession.open` enlaza esa entrada al snapshot de
creación y entrega el prompt original al repositorio al restaurar. `begin`
registra antes una unidad con task, record completo y presupuesto; rechaza
cambios incluso al reutilizar turnos completos, sin renovar su deadline. La
fachada sólo maneja checkpoints: no ejecuta la orquestación Expert legacy.

### Integración nueva de procedimiento y despacho Expert

`expert-procedure.ts` implementa un cursor separado de `runProcedure`: intake,
instrucción, fuentes/revisión/settle, aperturas y réplicas con objeciones,
respuestas y resoluciones, cierres/votos/desempates, resumen y post-proceso.
Cada avance requiere un marcador durable anclado a sus dependencias; una
ronda conserva resultados por asiento y publica eventos en orden, bajo fence.

`expert-turn.ts` fija el submission, task/record, prompts iniciales y de sistema,
modelos/opciones, herramientas y presupuesto de creación. Conserva ambas
conversaciones entre turnos. Descompone cada turno en pin → generación → cada
normalización de prosa → cada herramienta → completion; conserva también
la salida typed original y las propuestas/votos descartados con sus motivos.
No traduce la cita textual de una propuesta de instrucción.

`executeRetryExpertUnit` coteja la unidad con el plan vigente, registra el
claim transaccional antes de resolver modelo o despachar herramienta y publica
su resultado por propietario/época. No tiene gateway ni herramientas legacy
por defecto. La generación usa el SDK instalado, `maxRetries=0` y un solo
step, con declaraciones de herramientas **sin** callbacks de ejecución. El
presupuesto original no se renueva. Una respuesta perdida de COMMIT reutiliza
sólo el resultado durable exacto; una excepción de proveedor queda incierta.

`expert-tool.ts` aplica exclusivamente acciones locales del tribunal al
submission fijado, sin lector/traductor/red/sandbox/archivo. Exige corpus
settled coincidente para debate. Una decisión completa, incluido `pass` sin
evento, no se reabre por otra llamada de la misma generación. Normalización y
herramientas externas necesitan adaptadores explícitos de deployment: no se
permiten despachadores opacos de un turno, ronda o colección enteros.

Las pruebas conectan el procedimiento al ejecutor y al repositorio durable con
modelos simulados del SDK. Fuentes, settle y post son primitivas **de fixture**,
no adaptadores productivos. Siguen pendientes el linkage de creación/entrypoint
productivo, herramientas nativas de proveedor, adquisición/objetos/archivo y
cleanup completos, validadores confiables de inactividad, retención y World.
Ni esta integración ni la fachada de fase habilitan retry; los flags siguen
en `false`. La verificación global actual de 749 tests cubre esta integración
local; no demuestra los adaptadores ni las garantías productivas pendientes.

## Preflight puro y estados

`retryPreflight` es un reductor de observaciones, no un lector operativo. No
importa el store, carga `.env`, ejecuta DDL, escribe auditoría ni llama al SDK.
Para un no-admin no revela elegibilidad, motivos internos, costos ni identidad.
Para admin distingue contrato ausente/desconocido, creación no acreditada,
arranque no conciliado, caso no pausado, run terminal/inaccesible/distinto,
hook no confirmado/ajeno, deployment ausente, retención/cuota e integridad.
Devuelve siempre `blocked`/`route_disabled`: no hay atajo para habilitarlo.

`pending`, `running`, `ready`, `proven_failed`, `uncertain` y `skipped` son
estados distintos. `running` e `uncertain` bloquean aun con lease vencido.
`proven_failed` requiere prueba de inactividad. `ready`/`skipped` no suman costo
pendiente; costo desconocido, inválido o no finito devuelve `null`, nunca cero.
Un estimado es diagnóstico, no garantía de cobro exactamente una vez.

La pausa aislada sigue `pausing` → hook registrado en journal → `paused`,
conciliando la ventana DB/hook. Un caso pausado mantiene run SDK `running`.
Un run `completed`, `failed` o `cancelled` es terminal; hook ausente, journal
perdido o deployment inaccesible bloquean sin reset, Re-run ni `start`.
La acción y el consumidor requieren autorización por admin/caso y deduplicación
durable propia. Respuesta perdida de `resumeHook` no se anuncia como éxito.

## Probe reproducible del SDK y World local

### Protocolo de aplicación aislado

`src/retry/repository.ts` tiene instalación explícita y `read` sin bootstrap/DDL.
Cada mutación toma primero el lock del caso y publica cuerpo, eventos y auditoría
atómicamente. Conserva resultados completos, errores/pruebas y pausas; verifica
el hash del cuerpo contra la última auditoría. Colisiones bloquean sin repair.

`initial-start.ts` concilia candidato/observación con un claim durable único;
respuesta perdida nunca autoriza otro start. Una solicitud aceptada autoriza
sólo la unidad nombrada por su pausa: otro asiento fallido requiere otra solicitud.
`executeRecordedUnit` registra intención antes del efecto, reutiliza resultados
completos y bloquea estados inciertos. `RetryBeforeEffectFailure` sólo puede
provenir de validación **anterior al despacho** de un adaptador auditado. Las
cadenas de prueba no autentican a un proveedor; faltan validadores confiables.

El motor espera todos los asientos antes de cambiar fence/pausar. Quick usa su
cursor durable y snapshot original, no reinicia la orquestación legacy. El
controlador de inspección no escribe ni expone tokens/inputs/resultados/pruebas;
el de despacho permite un emisor único y nunca redespacha una respuesta ambigua.
La acción/UI productiva todavía no los llama.

`hook-registration.ts` lee run, token y journal correlacionado paginado del World
instalado. Exige un único `hook_created`; rechaza disposal/force claim, terminales,
identidades distintas y paginación incompleta. Revalida run/hook antes de confirmar
`paused`, sin afirmar lock entre World y DB, retención ni disponibilidad del código.
Los writers legacy/start/stop/reset/delete rechazan el marker nuevo bajo lock.

```powershell
node --import tsx scripts/test-local-retry-integration.ts
node --import tsx --test src/local-retry-integration.test.ts
```

Este segundo probe ejecuta el motor/cursor de la aplicación con SDK instalado,
repo de memoria, steps `maxRetries=0` y lectura real de hook/journal. Comprueba dos
pausas/autorizaciones, pérdida de respuestas de start/resume, claim concurrente,
entrega duplicada y preservación de resultados. Una respuesta externa perdida
bloquea. Una barrera de fixture permite escribir el duplicado antes de desechar
el primer hook; no es permiso de redispatch. El bundle usa la fuente local del
motor/helper de nombres de tsx: no prueba el transform de Next ni proveedores,
PostgreSQL o retención. Usa un child limpio/journal temporal propio con guards
de fetch/socket y cleanup, con los mismos límites de aislamiento del probe básico.

### Probe básico del mecanismo

```powershell
node --import tsx scripts/test-local-retry-hooks.ts
node --import tsx --test src/domain/retry-contract.test.ts src/local-retry-hooks.test.ts
```

El runner crea un child con entorno mínimo y `WORKFLOW_TARGET_WORLD=local`,
sin variables de DB/proveedores ni `.env`. Usa un directorio `mkdtemp` propio,
queue in-process y resultados sintéticos; no lee `.workflow-data` del proyecto.
No llama proveedores, DB, Blob, sandbox remoto, HTTP ni producción. El child
rechaza `fetch` y conexiones `Socket.connect`, y exige cero intentos de red.
Esos guards cubren los sinks usados por el probe, no tráfico universal por
procesos hijos/UDP/mecanismos nativos (que el probe no invoca). El child
cierra el World y borra únicamente su directorio en `finally` al terminar la
prueba normalmente. En timeout/terminación abrupta puede quedar ese directorio
temporal: no borra journals ajenos para intentar limpiarlo.

Se comprueba con el SDK **instalado**, no un doble de hook:

- Fallo de step capturado por el workflow con `maxRetries = 0`; el mismo run
  permanece `running`, conserva el resultado completo del primer step y
  ejecuta una sola vez la unidad pendiente tras reanudación.
- `getConflict()` confirma registro antes del step de exposición; ese step
  coteja hook y `hook_created` en journal. Un conflicto bloquea sin force claim.
- Dos invocaciones concurrentes de `resumeHook` con la misma clave propia
  agregan **dos** `hook_received`; el consumidor de fixture usa esa clave y
  autoriza un intento. Esto modela la ambigüedad de una respuesta perdida,
  pero no inyecta una falla de transporte interno del SDK ni implementa
  deduplicación transaccional del emisor/consumidor en PostgreSQL.
- Después de completar, fallar o cancelar, `resumeHook` rechaza; hook no
  encontrado también rechaza. No se reabre ninguno de esos runs.

El bundle mínimo registra los steps usando la tabla del SDK y las bindings del
VM. No prueba el transform de Next ni la completitud/fencing de Quick/Expert.
En conflictos puede recibir `HookConflictError` en vez del `Run` del propietario
porque no se incluye su serializer: ambas respuestas se bloquean. La Set del
consumidor se reproduce desde el journal del run, **no sustituye** la auditoría,
lock, fence y deduplicación propios que requiere el contrato productivo.

### Límite operativo comprobado

La corrida local reporta `deploymentId: dpl_local@5.1.2` (`@workflow/world-local`
5.1.2; Workflow/core 5.2.3). `getDeploymentId` del World local usa la **versión
del paquete**, no la identidad inmutable del código de la aplicación. Sus
capacidades de hooks no prueban conservación/disponibilidad de un deployment
fijado. `StartOptions.experimental_retention` sólo admite `default` o `0`;
`default` delega al World/plan y no acredita un plazo mínimo. **No usar `0`**:
puede purgar datos al terminar. No se consultó el control plane remoto.

Antes de aceptar referencias/habilitar, falta demostrar en un entorno autorizado:

1. Deployment original inmutable y disponible durante toda la pausa; identidad
   y acceso al journal/hook, retención efectiva del World y permisos de lectura.
2. Retención, privacidad, cuotas/espacio y referencias para DB/objetos/sandboxes;
   monitoreo de pérdida de journal, hook, deployment y bytes. Las pruebas del
   World local no acreditan esto ni retención remota.
3. Escrituras/cleanup/download/admin/broker protegidos por run/intento; creación
   y arranque conciliados; checkpoints completos por **cada** unidad de la matriz.
4. Intenciones previas a cada subllamada; evidencia inequívoca para conciliar
   efectos inciertos; nueva llamada sólo con autorización específica auditada
   y prueba de inactividad anterior. Nada de takeover por expiración de lease.
5. Pruebas adicionales de subefectos Expert, almacenamiento de objetos aislado
   y fallos por cada frontera real; el check de fase sólo verifica checkpoints.

El modo `--retry` del fixture PostgreSQL dedicado verifica operaciones nuevas del
mismo run, separado de las pruebas generacionales. Pasó en PostgreSQL 17.11/read
committed: creación/claims concurrentes, lock real, rollback de publicación/audit,
colisiones, respuesta COMMIT perdida, dos pausas Quick y writers tardíos. Un
quinto check verifica checkpoints de fase Expert: cuatro saves concurrentes
(un único CAS), restauración de resultados/mensajes/deadline, reutilización de
turno completo, cambio de intento del mismo run, escritor previo rechazado sin
mutación y pérdida de respuesta tras el COMMIT real del resultado. No verifica
subefectos reales de PhaseSession, objetos ni hooks SDK en esa misma transacción. El doble de
transporte pierde una respuesta después del COMMIT real, sin simular el SQL.
Ver aislamiento y límites en [`generational-postgres.md`](generational-postgres.md).

El despliegue y las verificaciones remotas requieren autorización separada según
el plan. Rollback conserva expediente/journal/objetos y bloquea nuevas
reanudaciones; no vuelve a reset. No hay rutas habilitadas; las firmas/secuencias
históricas permanecen intactas y sus writers ahora rechazan el marker nuevo.

## Verificación de esta entrega

- Pasaron los tests dirigidos del contrato y probe instalado (11),
  `npm run typecheck` y `npm run build`, incluida verificación de traces.
- El primer `npm test`, concurrente con el build, falló sólo en
  `src/lib/dependency-overrides.test.ts:14` (FileList no incluyó `package.json`).
  El test aislado y una nueva corrida completa posterior pasaron (682/682).
  No se cambió ese test; se propuso una tarea de investigación, sin afirmar
  una causa no demostrada.
- La continuación pasó cinco checks PostgreSQL reales dedicados, 48 tests
  dirigidos de protocolo/controlador/observador, cursores e integración SDK.
- La primera corrida global del árbol integrado falló en dos expectativas SQL
  de rutas y el inventario de efectos. Se actualizaron las fixtures para el
  marker de contrato y los cuatro sitios de efectos revisados, sin relajar
  guards ni ejecutar sus efectos. Pasaron 13 tests dirigidos de esas fixtures.
- Antes del nuevo procedimiento/ejecutor Expert, la corrida sustitutiva
  `job-fdd398a7` pasó `npm test` (730/730, sin skips),
  `npm run typecheck` y `npm run build`, secuencialmente y con validación de
  15 server traces. Este resultado corresponde al árbol integrado, no al
  baseline de 682 tests. No prueba entrypoints nuevos aún no implementados
  ni adaptadores productivos.
- La integración Expert pasó 27 tests dirigidos sin skips (`job-ba489190`):
  procedimiento hasta cierre con SDK simulado y acciones locales, inputs
  originales, reutilización tras COMMIT perdido, exclusión concurrente,
  autorización independiente de fallos y bloqueo ante corrupción/ambigüedad.
  La fixture respeta la separación instrucción/debate; fuentes/settle/post
  son simulados.
- La verificación global posterior (`job-7c52d19b`) pasó `npm test`
  (749/749, sin skips ni cancelaciones), typecheck y build secuenciales,
  incluyendo las verificaciones de browser registry e instruction harness
  en 15 server traces. Diff revisado y `git diff --check` limpio.
- Objetos remotos, proveedores y control plane de producción
  **no verificados**. Los criterios funcionales de aceptación end-to-end
  del plan siguen abiertos y no se habilitó una ruta.
