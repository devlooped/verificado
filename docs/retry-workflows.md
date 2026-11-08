# Retry de workflows nuevos: base verificada, rutas bloqueadas

Estado: **implementación parcial del paso 1 y probe local del mecanismo del paso
5**. No existe todavía un productor de casos con este contrato, almacenamiento
transaccional de intentos, workflow Quick/Expert nuevo ni acción de reanudación.
No se completó el plan; ningún caso, incluido `AT-185-GA`, es reintentable.

## Contrato separado, exclusivamente desde creación

[`retry-contract.ts`](../src/domain/retry-contract.ts) define `same-run-retry/1`.
No es pipeline 6, una generación de continuación ni un importador histórico.
Los perfiles de diseño son **Quick con pipeline 5** y **Expert nativo con pipeline
5** en un workflow nuevo, todavía no implementado. Ambos siguen bloqueados.
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
de un panel** ni autenticidad del registro de creación. La futura transacción de
creación debe registrar ese contrato junto con el caso; no puede existir una API
para adjuntarlo después. El preflight exige prueba de creación atómica y de
arranque conciliado, no sólo un documento con hashes recalculados. Hoy no hay
esa transacción ni lectores de esas pruebas: no se inscriben casos nuevos o viejos.

`RetryFence` separa run, intento y época del mismo run. `retryCommandSchema`
sólo admite clave de solicitud, versión y estado esperado; rechaza contenido
privado, tokens y campos extra. `retryCommandMatches` es validación de payload,
**no autorización, deduplicación durable ni CAS**. El futuro consumidor debe
validar identidad, admin y solicitud bajo lock; el token nunca autoriza.

## Matriz inicial de unidades y subefectos

Esta matriz revisa las ramas nuevas propuestas contra `court-session.ts`,
`quick.ts`, `procedure.ts`, `settled-play.ts`, colección/sources, portada y archivo.
Reutiliza el inventario anterior como índice, no como prueba de cobertura. Las
claves son **plantillas**, no checkpoints implementados. No hay unidad habilitada.
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

La futura pausa seguirá `pausing` → hook registrado en journal → `paused`,
conciliando la ventana DB/hook. Un caso pausado mantiene run SDK `running`.
Un run `completed`, `failed` o `cancelled` es terminal; hook ausente, journal
perdido o deployment inaccesible bloquean sin reset, Re-run ni `start`.
La acción y el consumidor requieren autorización por admin/caso y deduplicación
durable propia. Respuesta perdida de `resumeHook` no se anuncia como éxito.

## Probe reproducible del SDK y World local

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
5. Pruebas reales de transacciones/CAS/rollback/PhaseSession en PostgreSQL
   efímero, almacenamiento de objetos aislado, concurrencia y fallos por frontera.

No se ejecutó el fixture PostgreSQL anterior como sustituto: verifica operaciones
generacionales, no intentos del mismo run, y no verifica las operaciones nuevas
de PhaseSession requeridas. [`generational-postgres.md`](generational-postgres.md)
documenta el aislamiento que debe reutilizar la futura fixture sin conectar a
la base existente ni cargar `.env`. No hay nuevas operaciones SQL en esta entrega.

El despliegue y las verificaciones remotas requieren autorización separada según
el plan. Rollback conserva expediente/journal/objetos y bloquea nuevas
reanudaciones; no vuelve a reset. En esta entrega no hay rutas que deshabilitar:
todo permanece cerrado y el código histórico no se modifica.

## Verificación de esta entrega

- Pasaron los tests dirigidos del contrato y probe instalado (11),
  `npm run typecheck` y `npm run build`, incluida verificación de traces.
- El primer `npm test`, concurrente con el build, falló sólo en
  `src/lib/dependency-overrides.test.ts:14` (FileList no incluyó `package.json`).
  El test aislado y una nueva corrida completa posterior pasaron (682/682).
  No se cambió ese test; se propuso una tarea de investigación, sin afirmar
  una causa no demostrada.
- PostgreSQL, objetos remotos, proveedores y control plane de producción
  **no verificados** por esta entrega. No se cerró ninguno de los criterios
  de aceptación end-to-end del plan ni se habilitó una ruta.
