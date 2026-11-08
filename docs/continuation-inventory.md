# Continuación segura: contratos e inventario del paso 1

Estado de esta entrega: **diseño e inspección local, no habilitación de continuación**.
Actualización del paso 2: ver [base transaccional y límites](#paso-2-base-transaccional-desactivada).
Bloque parcial del paso 4: ver [retención conservadora](#paso-4-bloque-parcial-de-retencion-conservadora).
Las tablas de contratos/control actual siguientes conservan la evidencia de la
inspección del paso 1; no deben confundirse con el estado de implementación del
paso 2. El snapshot sintáctico sí se actualiza con el runtime del árbol compartido.
Fecha: 2026-11-07. Base: archivos actuales del árbol compartido, incluidos los
cambios previos de Quick y el fix de `collection/sources/court-session`. No se
consultaron journal, proveedores, Blob ni producción. No hay prueba de que
`AT-185-GA` sea recuperable, ni se asume su pipeline a partir de un log.

## Artefactos y lectura correcta

- [`continuation-unit-matrix.json`](continuation-unit-matrix.json): 46 plantillas
  de unidades con rutas, entradas/clave sugerida, resultados exigidos,
  dependencias, efectos, símbolos de evidencia y huecos. Los nombres son de
  diseño; **no** son claves ya implementadas ni un nuevo formato histórico.
- [`continuation-effect-sites.json`](continuation-effect-sites.json): snapshot
  reproducible de 122 sitios sintácticos de efectos, pasos workflow y `TurnSpec`
  en la base acotada de pasos 2–3; no es una prueba exhaustiva de efectos alcanzables.
- [`../scripts/continuation-inventory.ts`](../scripts/continuation-inventory.ts):
  inspector de sólo lectura usando el parser que ya incluye Next. Sólo lee
  fuentes bajo `src/` y `sandbox/harness/`; no importa la aplicación, carga
  `.env`, instala paquetes, evalúa SQL ni realiza llamadas de red.
- [`../src/continuation-inventory.test.ts`](../src/continuation-inventory.test.ts):
  cobertura del diseño, drift del inventario, prueba del inspector y
  reproducciones locales de pérdida de información/publicación.

El snapshot inventaría **candidatos sintácticos**, no demuestra un call graph,
compatibilidad, aislamiento ni ausencia de efectos. `write-candidate` requiere
revisión humana: puede ser una interfaz de artefactos o un stream. SQL dinámico
no literal, alias de funciones, reintentos dentro de SDK, comandos dentro de
VM y efectos internos del proveedor no quedan exhaustivamente resueltos por el
parser. La tabla de escritores y la de efectos complementan ese límite.
Los números de línea de abajo son localizadores al inspeccionar, no fingerprints.
El test compara nombres/sitios y cantidades, no hashes de archivos privados ni
texto de expedientes. Un cambio en efectos debe revisarse antes de actualizar
el snapshot; actualizarlo no autoriza ninguna ruta.

## Matriz de compatibilidad observada

| Ruta | Contrato observado en el árbol | Evidencia requerida para un importador | Continuación |
| --- | --- | --- | --- |
| Expert 1 | `collect` → idioma → `prepareEvidence/runEvidenceStep` + `playTurn/runSeat`; árbol legacy mutable; moderador unifica; sin `settleShared` | Resultados exactos de cada preparación/asiento/intento, journal, transcript, promociones y traducciones. No inferir resultados completos de eventos o índices | **Bloqueada** |
| Expert 2 | `collectShared`; preparación/decisión por `PhaseSession`; fuentes originales; moderador unifica; traducción y corpus congelado schema 2 | `PhaseState`/`PhaseTurn`, request/result de llamadas, aliases, operaciones, CanonicalSource schema 3, documentos/bloques y manifest completo | **Bloqueada** |
| Expert 3 | Research nativo; decisión razonada y typed; host obtiene URLs y coteja. `collectProposedEvidence` omite callback de progreso y conserva firmas/secuencia | `FetchedUrl[]` de cada paso exacto o reconstrucción determinista íntegra probada; no cambiar secuencia de pasos históricos | **Bloqueada** |
| Expert 4 | Como 3, con inicio de colección y batch_completed con conteos; sin batch_started/URLs en progreso | Mismos requisitos; conteos no prueban qué URL dio qué sourceId/error | **Bloqueada** |
| Expert 5 | Como 4, con batch_started URLs y batch_completed `{url, failed}` | Mismos requisitos; URL/failed no prueban sourceId, error exacto, bloques ni integridad | **Bloqueada** |
| Quick 1 | Dispatcher Quick sin instrucción/sandbox; archivo usa rama legacy si pipeline persistido es 1 | No seleccionado por rollout actual; fixtures históricas explícitas y contrato de ZIP probado, nunca tratarlo como Quick 2 por suposición | **Bloqueada** |
| Quick 2 | Identificación opcional; respuesta por asiento, votos por claim y contenido, desempates; archivo shared sin corpus | Resultados/request por asiento/claim/intento, imagen original, fechas, modelos/tools/prompts, errores/retry, prefijo y archivo | **Bloqueada** |
| Quick 3–4 | Dispatcher tiene rama Quick genérica; no seleccionados por rollout actual | Alcanzabilidad histórica y fixtures concretas de cada versión antes de importar | **Bloqueadas** |
| Quick 5 | Dispatcher Quick y archivo shared; seleccionable mediante `latest`/rollout nativo, no usa research Expert | Pruebas de Quick propias, incluidas ambas variantes de identifyClaims y todos sus efectos finales | **Bloqueada** |

Evidencia: [`court-session.ts`](../src/workflows/court-session.ts#L329),
[`rollout.ts`](../src/instruction/rollout.ts#L13),
[`proposed-urls.ts`](../src/instruction/proposed-urls.ts#L36),
[`archive.ts`](../src/evidence/archive.ts#L124).
Las diez combinaciones se enumeran para **bloquear explícitamente** las no
demostradas; eso no afirma que existan casos históricos de cada combinación.
Ningún adaptador está probado en esta etapa. Los tests existentes de replay
intra-run, CAS o fuentes no prueban continuación con run/deployment nuevos.

### Reglas de unidades para las siguientes etapas

1. Conservar submission, pipeline, modelos completos (effort/providerOptions),
   idioma, fecha de trabajo, prompts, herramientas/esquemas, resultados, IDs,
   secuencias y fechas originales. Hash de entrada significa representación
   canónica de **todos** esos insumos, no sólo URL/asiento/número de intento.
2. Claves de unidad lógica separadas de generación y run de ejecución. Cada
   importación debe conservar sourceRun/sourceDeployment y formato probado.
   Igualdad de entrada, formato y resultado no sustituye fencing del escritor.
3. Resultado del asiento separado de publicación de ronda. `P#`/`O#` se asignan
   en `procedure.absorb`, en orden de asientos; el mapping y los eventos, cursor,
   `seq` y decisiones deben publicarse en la misma transacción. IDs de statements,
   objeciones, fuentes y claims forman parte de las entradas de turnos posteriores.
4. No considerar `complete` de PhaseTurn equivalente a `done`, ni `timedOut`,
   draft vacío, ausencia de output, paso con error o resultado `partial` como éxito.
   Preservar presupuesto, deadlines, mensajes y tool-call outcomes; no reconstruir
   una conversación a partir de su prosa pública ni renovar su presupuesto.
5. Son plantillas de dependencias, no un DAG de nombres únicos: `court.publish`
   ocurre por ronda; objection/reply/ruling se instancian por IDs; Quick vota por
   claim y contenido. Intake puede desestimar. Una unidad opcional necesita
   resultado `skipped` con motivo probado (sin claims, sin fuentes, imagen propia,
   simulación, storage no configurado), no ausencia indistinguible de fallo.
6. `session_closed` no termina efectos: portada, traducción de prompts, archivo,
   revocación, limpieza y `finishCase` son unidades posteriores. Failure/stop/admin
   cleanup son ramas propias; no heredan las dependencias de cierre exitoso.
7. Por cada efecto externo, separar intención/start/publicación por subllamada.
   Portada: elección → descarga → aprobación **o** generación → publicación.
   Traducción: generación → verificación(s) → artefacto → checkpoint. Archivo:
   cache → case.jsonl/case.json → ZIP → referencia. No agrupar cobros múltiples
   como un solo `ready` que oculte una respuesta perdida.
8. Sin checkpoint completo o prueba de inactividad anterior: conservar y bloquear.
   El deployment nuevo no vuelve seguros escritores viejos sin fencing. Un lease
   vencido, cancelación del workflow o sandbox detenido no prueba ausencia de
   comandos separados ni de llamadas al proveedor todavía activas.

## Escritores durables y entradas fuera del workflow

| Familia | Escritores / entradas concretas | Control actual y requisito pendiente |
| --- | --- | --- |
| Inicialización y migración automática | `store.db` CREATE/ALTER y migración de eventos `openai` → `chatgpt`; `createCase/createNewCase` insertan cases e images | Cualquier primera conexión puede ejecutar DDL/migración. No usar acceso a store como preflight puramente lector sin revisar este efecto. Es infraestructura, no checkpoint |
| Arranque y cancelación | `startCaseWorkflow`, `stopCaseWorkflow`; `startCourtSession`, `cancelCaseRun`; acción crear, API rerun/stop; Reintentar bloqueado sin efectos | Row lock y runId actual; start/cancel externo dentro de transacción. Sin token/generación/registro CAS inicial; respuesta perdida deja ventana incierta |
| Apertura/configuración/cierre | `openSession`, `saveCaseLanguage`, `saveCaseModels`, `finishCase`, `failResolvedCase` | Estado/stop guard/revision parcial; modelos legacy se recargan. UPDATE por caseId sin ownership de generación/run; `finishCase` puede generar notificación |
| Eventos | `recordEvents` vía `saveEvents` y scripts administrativos | `(case_id,seq) DO NOTHING`; no compara contenido en colisión ni publica PhaseSession/cursor/resultado atómicamente. Legacy `openSession` DELETE events |
| Portada | `saveCover` vía `illustrateCase`; `scripts/generate-covers.ts` usa la misma operación | UPSERT por caseId reemplaza bytes/sourceUrl/generated/saved_at. Sin generation/run ni hash de resultado asociado a intención |
| Operaciones y aliases | `changeOperation`, `sourceOperationRepository.claim/get/publish/fail/defer/recover/alias/resolve`; SourceService y proxy | Owner/lease por operación y alias URL por case; expiración a uncertain ya existe. No generación/inputHash general ni autorización auditada de admin al recover; no adoptar automáticamente |
| Conversaciones | `savePhaseCheckpoint`, `PhaseSession.open/save/begin/append/finish` | CAS por caseId/sessionKey; igualdad system/tools/model; no generación/run/format explícitos ni transacción con eventos/resultados |
| Auditoría/actividad/uso | `saveCaseAuditRecord`, `recordCaseToolActivity`, `recordModelUsage`; settled-play/quick-play/proxy/source tools/file-proposals | Auditoría compara body en colisión; actividad DO NOTHING. Uso puede escribirse antes de checkpoint del efecto. Ownership/fencing y decisiones de continuación no existen |
| Traducción de prompts | `promptTranslations.save` desde `cachePromptTranslations`, archivo y download del ZIP | Cache global por versión/texto/idioma; modelo no forma parte de su clave. Tratar como contrato global separado, validar compatibilidad antes de reutilizar y registrar ownership del efecto del caso; no reinterpretar como checkpoint generacional |
| Grants del broker | `saveSandboxBinding`, `consumeSandboxBinding`, `revokeSandboxBindings`; preparación y `settleShared/revokeShared` | Binding exige case/sessionId activo, revocación irreversible, TTL y decremento transaccional. No generation/run; validación precede request, no cerca de su publicación externa |
| Objetos | `writeEvidenceTree`, `writeCaseTranscript`, `writeEvidenceArchive`, `caseArtifactStore.write`, `copyCaseBlobs`, `deleteEvidenceBlobs/deleteCaseBlobs` | `withCaseWriteLock` sólo existencia/KEY SHARE; árbol legacy/ZIP/transcript overwritable. Artefactos nuevos inmutables con hash pero prefijo compartido por case, no generación. Original.bin, hashes y referencias necesitan aislamiento y publicación bajo fence |
| Reset/borrado/rename | `restartCase/requeueCase`, `deleteCase`, `renameCase`; `withSandboxCleanup`; actions/API/scripts | Reset/borrado bloqueados antes de callbacks/Blob/DB bajo lock; no-op no autoriza pérdida de referencias. Rename mueve filas bajo fence, no libera recursos. No usarlos como fallback |
| Notificaciones y observabilidad | `markAdminNotificationsRead`, `deleteAdminNotification`, `recordSnapshotHealth`, `saveModelSettings`; telemetría/OTel | Efectos globales administrativos separados; settings futuros no deben cambiar snapshot del caso. Sweep se dispara desde GET de notificaciones administrativas |

Referencias centrales: [`store.ts`](../src/store.ts#L206),
[`recordEvents`](../src/store.ts#L488),
[`sourceOperationRepository`](../src/store.ts#L628),
[`bindings`](../src/store.ts#L743),
[`blob.ts`](../src/evidence/blob.ts#L140).
Todos los sitios SQL concretos, incluidas variantes concatenadas y DDL, están
enumerados en el snapshot. Los métodos del repositorio son wrappers del sink
`changeOperation`, no filas SQL separadas.

## Llamadas externas y efectos no transaccionales

| Efecto | Call sites / wrappers | Qué debe registrarse o revisarse |
| --- | --- | --- |
| Modelos legacy | `seat.runSeat`, `court.researchTools`, `language.resolveCaseLanguage`, `evidence.describe`, `translate` | Modelo/prompt/tool contracts, imagen/contexto, llamadas anidadas web/X. Hay `maxRetries:2` en research legacy, y translator/language sin maxRetries explícito; no asumir cero retry por SDK |
| Preparación shared/nativa | `Sandbox.create/get(resume)/writeFiles/runCommand(detached)/getCommand/readFileToBuffer/stop`, `sandbox/harness/instruction-agent.ts` | VM name, commandId, requestHash y archivo resultado; stop crea snapshot con keepLast/deleteEvicted. Harness puede lanzar llamadas independientes del workflow; código se envía desde deployment sólo al crear VM, no al reanudar |
| Broker/gateway | `proxy.forwardGatewayGeneration`, `generation`, `createTurnProxy`, `executeSourceTool`; `SandboxBinding` | OIDC/identidad/phase/session, callId+requestHash, owner de operación, request/result artifacts + resultHash; nueva validación de generación al inicio y al publicar. `hostStage` ya bloquea uncertain, pero permisos viejos no quedan resueltos por eso |
| Decisión shared | `settled-play.advanceSharedTurn` → `hostStage` → `generateText` | maxRetries=0, inFlightStep, mensajes y tool outcomes existen; request+result/artefacto/operation/audit/phase/eventos se publican en pasos separados |
| Quick | `quick-play.generation` → claims/answer/vote/tiebreak; nativeTools del proveedor; imagen de store | maxRetries=0, request/result y audit existen, pero no intención durable antes de llamar. Relee resultPath sin comprobar igualdad del request/model actual; error de generación se guarda como fallo retryable por orquestación, no uncertain |
| Adquisición/lectura | `downloadUrl` usa impit/fetch, redirects, validación de URL/DNS; `downloadWithBrowserbase` crea sesión y libera con update; `sourceDownloader` tiene fallback X vía IA | URL normalizada y final, estado/error completo, lease/owner, bytes/hash; Browserbase maxRetries=1 y fallback de sesión con/sin proxy; una descarga puede tener varios efectos facturables |
| Extracción/OCR | `extractHtml/extractPdf/defaultRecognize`, `spawn` (tesseract y procesos), temporales | Comandos/archivos locales no son fuente nueva ni paid IA por sí mismos; se registran versiones, bloques, límites y resultado. No reejecutarlos para reconstruir datos supuestamente históricos |
| Traducción/validación | `SourceService.normalize/translated`, translator + verifyLanguage, normalización de drafts/review/comments, promptTranslator | Una operación puede englobar traducción y varias verificaciones; se necesitan suboperaciones completas. Algunas fallas de prosa conservan idioma original: importar ese resultado exacto, no volver a traducir silenciosamente |
| Portada | `chooseWithGrok`/búsquedas → downloadImage → approveCover o generateWithGrok → saveCover | maxRetries=2 en chooser/review/image; fallas del chooser/review disparan fallback; illustrate traga error. Ni wrapper exitoso ni ausencia de cover demuestra ausencia de cobro |
| Archivo/publicación | `archiveEvidence`, `cachePromptTranslations`, ZIP local, `putObject`/R2 firmado por fetch, copy/delete | ZIP determinista no implica inputs completos. promptTranslator maxRetries=2 y cache.save posterior; pérdida de respuesta de cache/Blob/ZIP se concilia con hashes/etag, sin llamada nueva |
| Sandbox legacy | `runEvidenceStep` crea VM single-use, permite Gateway y red, comandos del harness, promoción de archivos y stop | Sin binding shared; random runId, status partial posible. Harness/transcript y journal son evidencia exigida; no aplicar fencing de broker shared por analogía |
| Limpieza/retención | `disposeSandboxes`, `deleteCaseSandboxes`, `sweepCaseSandboxes`, `withSandboxCleanup`, provider snapshotExpiration | Borran por case/tag/name con deleteOrphanSnapshots=true; no miran referencias requeridas/generación/comandos. Protección necesaria también en stop/keepLast deleteEvicted/expiración del proveedor, no sólo en sweep |
| Workflow y logs | start/cancel, setAttributes, case telemetry, exporters OTel | Separar journal/control plane y logs de checkpoint; retries del workflow/proveedor requieren inspección del deployment elegido. Logs no demuestran ready ni inactividad |

Entradas adicionales fuera de `courtSession`:

- [`actions.ts`](../src/app/actions.ts#L84): Reintentar comprueba sesión/rol Admin y devuelve un bloqueo incondicional; no consulta ni modifica el expediente, no llama reset, limpieza, auditoría ni start. La vista muestra un botón desactivado sin formulario, el motivo y la imposibilidad actual de estimar costo/reutilización. No hay preflight implementado.
- Las APIs administrativas DELETE y `/api/cases/[id]/rerun`, con permisos/origen propios, responden 409 `sandbox_cleanup_blocked` si la limpieza no está probada. No borran Blob/DB ni inician workflow; no se ofrecen como fallback de Reintentar.
- APIs admin rerun/stop/delete y GET notificaciones;
  [`notifications/route.ts`](../src/app/api/admin/notifications/route.ts#L27)
  llama `sweepCaseSandboxes`.
- [`c/[id]/file/route.ts`](../src/app/c/[id]/file/route.ts#L9): download del ZIP
  llama `getOrCreateEvidenceArchive`; ausencia de ZIP puede escribir artefactos,
  traducir prompts y generar cobros sin atravesar unidades del workflow.
- Scripts de mantenimiento `generate-covers`, `regenerate-case-ids`,
  `migrate-blob-to-r2`, `evidence-snapshot`, `evidence-blob-smoke`, `seed-fixture`,
  `test-local-*`, `eval-*`, `test-court/test-gateway` y e2e tienen capacidad de
  llamar modelos/Blob/DB/sandbox. **No ejecutados aquí**. Deben quedar fuera de
  la autorización automática de continuación y revisarse antes de usarlos.

## Huecos comprobados y prueba faltante

| ID | Evidencia local del hueco | Consecuencia / demostración pendiente |
| --- | --- | --- |
| G01 — fencing/publicación | UPDATE por caseId en store; CAS de phase por sessionKey/revision; withCaseWriteLock sólo KEY SHARE; prefijos `cases/<id>` | Ninguna generación/run protege todas las escrituras o referencias. Probar transacciones PostgreSQL aisladas, carreras contra writers/admin/broker/cleanup y rollback antes de habilitar |
| G02 — prefijo/colisiones | `procedure.ts:23`, `quick.ts:144` inicializan log=[]; store.ts:498 DO NOTHING por seq; openSession legacy DELETE | Test G02 demuestra que segunda invocación Quick vuelve a seq=1 y pide respuestas otra vez. Falta cursor explícito, validación de prefijo y colisión por contenido; no es test de PostgreSQL |
| G03 — compatibilidad | phase-session.ts:84 exige system/tools/model, pero sin generation/format/input contract; Quick generation usa root por seat/claim/step/attempt; configuredModels sólo shared reutiliza stored.models | Igualdad de nombre/modelId no basta; ninguna fixture histórica/adaptador probado. Preservar fecha/model options/prompt/tools. Tests actuales de fase prueban algunas igualdades y deadlines intra-run, no importación cross-run |
| G04 — resultados parciales/publicación | procedure.ts:75 espera allSettled y sólo absorbe si nadie rechaza; Quick.ts:206 usa Promise.all; outputs/artifact/phase/audit/commit separados | Test Expert: 3 asientos terminan sin eventos de ronda publicados. Test Quick: rechazo ocurre mientras otros continúan; sus outputs no se publican. Conservar outputs por asiento y bloquear actividad anterior, no replay nuevo a ciegas |
| G05 — FetchedUrl / fuentes | domain/court.ts:163 sólo conteos/URL+failed; collection.ts:15 exige sourceId/error; proposed-urls.ts:45 pierde ambos | Fixture sintética 33 URLs/4 errores produce eventos idénticos con IDs/errores distintos (v4/v5). No usar conteos como checkpoint. Fix previo collectionSources de una lectura verificada por intento se conserva; errores/blocks/journal reales aún faltan |
| G06 — efecto incierto / retries | Quick llama antes de artifacts.write, errores se almacenan como resultado; cover múltiples fallbacks/retries; cachePromptTranslations llama translate antes de save; translator sin maxRetries explícito | Pérdida entre efecto y publicación no permite asegurar ausencia de cobro. Registrar intención y suboperaciones, inyectar fallos antes/durante/después y conciliar únicamente con evidencia durable/proveedor; no reintentar por ausencia de bytes |
| G07 — actividad vieja / start | startCaseWorkflow llama start antes de guardar runId; cancelCaseRun verifica cancelled solamente; operaciones lease→uncertain | Test de repo memory demuestra uncertain sin takeover. No prueba que un run/comando viejo esté inactivo; start de respuesta perdida y broker en curso necesitan reconciliación/CAS y tests PostgreSQL/local providers |
| G08 — snapshots/limpieza | preparation.ts:40 keepLast=1/deleteEvicted/24h; :223 deleteOrphanSnapshots; :284 sweep failed/resolved; court-session catch dispone sandboxes | Snapshots requeridos pueden desaparecer al fallar, al detener/resumir o por caducidad del proveedor. Falta retención por referencias/generación y revisión de operaciones activas; ninguna promesa de recuperar lo ya eliminado |
| G09 — efectos post-cierre/archivo | court-session.ts:384 portada/cache/archive/revoke/dispose/close; Quick :354 portada/archive/close; archive.ts:161 case.jsonl/case.json inmutables por case; file route reconstruye ZIP | Rerun del archive con auditoría anexada puede colisionar con artefactos inmutables existentes; ZIP legacy mutable. Diseñar snapshots de exportación generacionales y fence también la ruta de download; no declarar cierre sólo con session_closed |
| G10 — recuperación real sin verificar | Plan aprobado documenta journal sin credenciales y logs 33/4; inspección de esta entrega exclusivamente local | No se verificaron pipeline/modelos/actividad/journal/aliases/errores/blobs reales de AT-185-GA. Se requiere preflight autorizado separado de sólo lectura, sin imprimir datos sensibles; si falta cualquier prueba, bloquear |

Los huecos son del alcance solicitado, **no** follow-ups ni fixes implementados
en esta etapa. El código viejo del deployment puede carecer de todos estos
controles: un futuro fence nuevo no hace seguro continuar casos antiguos.

## Paso 2: base transaccional desactivada

Se agregó almacenamiento, **no** una ruta ejecutable de continuación:

- `cases.continuation_generation` (legacy = 0) y tablas aditivas
  `case_continuation_generations`, `case_continuation_checkpoints` y
  `case_continuation_audit`. No se reescriben ni se importan resultados históricos.
- Los writers actualizados de estado, eventos, modelos, idioma, portada, phase
  CAS, auditoría/actividad, operaciones/aliases y grants comprueban la generación
  y run bajo el mismo `FOR UPDATE` de la fila del caso que protege su publicación.
  El orden de locks es caso → filas subordinadas. Inicialización/migración legacy
  también excluye generaciones reservadas. Esto **no** cubre código histórico
  desplegado que ignore las columnas/guardas nuevas.
- `reserveContinuationGeneration` y `startCourtContinuation` fallan antes de
  acceder a DB/Workflow: no existe un switch de entorno para habilitarlos ni
  fallback al reset. `recordBlockedContinuationReservation` es una primitiva
  interna de diagnóstico administrativo: sólo admite un caso fallido con
  revision/run originales iguales, reserva **una generación bloqueada** y anexa
  auditoría en la misma transacción. No afirma inactividad/compatibilidad y no
  tiene una transición pública a `reserved`. No está conectada a UI/API.
- Un caso reservado rechaza writers legacy del código actualizado y evita
  start/stop/reset/delete/rename administrativos que interfieran. La reserva
  diagnóstica no se libera automáticamente, ni permite reservar generación 2.
  Liberación/otra generación requieren revisión/preflight aún no implementados.
- `continuationStartRepository` registra intención antes de `start`, sólo gana
  una claim `reserved` → `starting`, y no recupera `starting/uncertain` por tiempo.
  `registerContinuationRun` es el CAS de generación+token+run del primer paso:
  **sólo registra un candidato**, aun cuando llegue tarde a `uncertain`; no
  modifica el run del caso ni concede permiso de escritura. `observe` guarda
  durablemente la respuesta (o su pérdida). Sólo `reconcile`, bajo el mismo lock,
  compara ambas evidencias y publica `running` + `reconciled_run_id` + run del caso
  + auditoría atómicamente. Todo writer exige ese run reconciliado. Una respuesta
  sola, un registro sin observación, fallo de almacenamiento o conflicto de IDs
  bloquean; no relanzan ni marcan el caso fallido. Una respuesta perdida puede
  conciliarse exclusivamente con el único registro CAS del token reservado.
  El protocolo usa un callback inyectado: no está conectado a un
  workflow real, ni se han probado retries internos del SDK/control plane.
- `registerContinuationCaseRun` es un **paso nuevo separado**. No se insertó en
  `courtSession` ni cambió su secuencia/firmas de invocación legacy. `openCase`
  sigue sin abrir generaciones nuevas: esa ruta permanece bloqueada. Tampoco
  se garantiza resolver la ventana de respuesta perdida del arranque legacy de
  casos nuevos (`startCaseWorkflow`); no se reemplazó su protocolo histórico.
  `saveContinuationEvents` y `closeContinuationCase` también son pasos separados:
  verifican el run ejecutando contra el owner suministrado antes de acceder a DB,
  además del fence transaccional. `saveContinuationEvents` **no puede publicar**:
  `recordEvents(..., writer)` rechaza incluso batches vacíos; sin writer, la
  reserva lo cerca. `savePhaseCheckpoint(..., writer)` también rechaza avances
  independientes. Las firmas legacy conservan su comportamiento en generación 0.
- `publishContinuationCheckpoint` sólo almacena `uncertain` **sin eventos/fase**.
  Para publicar eventos requiere un resultado `ready` con validador semántico y
  CAS de fase, en la misma transacción que checkpoint y auditoría. Rechaza gaps/
  colisiones y acepta
  la repetición idéntica mediante hash de toda la publicación, sin retroceder
  una phase avanzada por otra unidad. **Todo `ready` excepto la unidad pura
  `quick.content-consensus` descrita abajo sigue bloqueado**; un hash inline por sí
  solo no prueba completitud semántica de un turno ni compatibilidad histórica.
  Las referencias a artefactos también requieren sus validadores de pasos 3/4.
- La lectura pública de herramientas incluye claves legacy y
  `generation:<n>:tool:...`, conserva el primer `at` y filtra por schema público.
  Proyecta IDs `tool:generation:<n>:...` para no perder invocaciones en la timeline
  por keys React repetidas; no modifica los bodies originales ni expone prompts.
- Phase sessions, operaciones, aliases y auditoría nuevas tienen claves
  `generation:<n>:...`; las filas legacy se conservan. Las operaciones nuevas
  exigen inputHash y registran owner/run e intención durable. Publicar `ready`
  externo y `recover` están bloqueados: faltan validación de resultado/artefactos,
  conciliación de inactividad y autorización específica auditada. Un lease vencido
  se vuelve `uncertain`, nunca una claim nueva.
- Bindings comprueban generación/run bajo lock y la autorización pura también
  compara ambos. El proxy **deniega todos los efectos generacionales** antes de
  parsear una generación/llamar al proveedor: faltan namespaces de artefactos y
  retención. Writers Blob/portada con owner nuevo también se bloquean; los legacy
  quedan cercados al existir reserva. No se modificaron cleanup/snapshots ni se
  incorporaron generaciones a `SourceService`/PhaseSession/orquestadores todavía.
- La auditoría de control separada no publica texto privado en logs. Los settings,
  cache global de prompts y notificaciones administrativas no son checkpoints
  generacionales; falta conectar los efectos de traducción/export al owner del
  caso y publicar exports nuevos inmutables. El archive/download legacy puede
  iniciar trabajo antes de encontrar un fence: no habilitar reservas operativas
  mientras no se cierre esa ruta en las etapas siguientes.

Pruebas nuevas:

```powershell
node --import tsx --test src/lib/continuation-start.test.ts src/instruction/authorization.test.ts
node --import tsx scripts/test-local-continuation.ts
```

El script PostgreSQL carga la configuración efectiva y exige exactamente la
fixture loopback/user/database documentada **antes** de llamar store. Sólo crea
casos `fixture-continuation-<uuid>` y borra sus propias filas. No imprime la URL
ni llama Blob/IA/Sandbox/Workflow. Para probar maquinaria que la aplicación no
puede habilitar, siembra explícitamente estados `reserved/in_session` sintéticos
por SQL **local**. Eso no es una prueba de elegibilidad histórica ni de una
continuación real. Verifica carrera de dos reservas, lock con writer en vuelo,
CAS de phase, preservación de datos, fences de writers/reset/stop/broker, token
de arranque, respuesta perdida sin otro start, colisiones/gaps y rollback de
checkpoint+eventos+phase+auditoría. Las pruebas unitarias simulan cuatro start
concurrentes, registro durable, respuesta perdida y runIds en conflicto.

G01/G07 tienen base local parcialmente demostrada; G02/G03/G04/G05/G06/G08/G09/G10
siguen bloqueando toda continuación. Los tests del paso 1 sobre prefijo/rondas
siguen reproduciendo defectos **aún no corregidos** de los orquestadores (paso 3),
no exigen conservarlos cuando se implementen cursores. El test antiguo de lock
Blob se actualizó a fence exclusivo en vez de exigir `KEY SHARE` defectuoso.
El mayor alcance del lock en writers legacy puede aumentar contención; no se
midió latencia en producción y no se promete compatibilidad de continuación de
ningún pipeline a partir de estos tests.

Baseline anterior a esta revisión (2026-11-07): `npm test` pasó **533/533** tests
(incluidas las nueve pruebas del inventario); la selección de inventario,
arranque, broker y steps pasó **31/31**. Typecheck completo con `--noEmit
--incremental false --pretty false` y `git diff --check` terminaron con código 0
(git sólo avisó sobre la conversión LF/CRLF del árbol compartido). Pasaron las
tres fixtures PostgreSQL locales protegidas: continuación, instrucción y rerun
legacy; todas usan efectos simulados, sin Blob/IA paga/Workflow reales. El primer
intento integral detectó drift por los dos nuevos steps separados; se actualizaron
snapshot y contratos y se repitió la suite íntegra, sin relajar la detección de drift.
No se ejecutó build, despliegue ni preflight de producción. Ese baseline no
demostraba las tres invariantes corregidas aquí y **no completa el paso 2**.

## Bloque acotado 2–3: consenso puro con cursor durable

`src/court/quick-continuation.ts` implementa sólo la derivación **sin efectos** de
un juicio de consenso desde exactamente nueve eventos: apertura, cuatro
respuestas y cuatro votos completos ordenados por asiento. Admite Quick pipeline
5, submission textual sin identificación de claims, modelos/efforts idénticos y
al menos tres votos coincidentes. Publica juicio/cierre deterministas en `seq`
10–11 (timestamp derivado del prefijo validado), checkpoint con hashes de inputs/
resultado y cursor `nextSeq: 12` mediante CAS de fase inicial. Restaurar exige
el sufijo exacto ya durable y checkpoint idéntico; no reconstruye datos faltantes.

Esto **no** habilita Quick 5 como ruta completa ni importa resultados históricos:
la prueba parte de respuestas/votos suministrados como prefijo exacto. No prueba
que un analista terminó su operación externa. Las pruebas usan la orquestación
Quick real con bench local, interrumpen luego de publicar votos y comprueban que
restaurar este cursor no llama nuevamente a los ocho callbacks de respuestas/
votos. PostgreSQL verifica persistencia y restauración, dos publicaciones
concurrentes idénticas, CAS inválido y fallo de auditoría en la última escritura
con rollback total, colisiones y no retroceso del cursor al repetir.

La fixture también prueba ambos órdenes respuesta/CAS, pérdida de respuesta antes
y después del CAS, callbacks concurrentes en vuelo, registro tardío bloqueado,
IDs/token incorrectos, observación fallida y rollback de autorización al fallar
la auditoría de reconciliación. Incluso con el run correcto sembrado en el caso,
el writer sigue rechazado hasta la reconciliación. Cancelación/cambio de generación
cercan writers tardíos, **sin** interpretarse como prueba de inactividad histórica.
La actividad se verifica con PostgreSQL real para dos generaciones y legacy,
aislamiento por caso, orden estable, idempotencia, schema y IDs públicos distintos.

Pendiente antes de completar los pasos 2–3: integración del SDK/control plane y
workflow de continuación; pruebas de inactividad histórica; recuperación por
asiento/ronda parcial; cursores de Expert y otras unidades Quick, identificación y
desempates; PhaseSession generacional con contratos/presupuestos; broker, Blob,
cover, export y retención. Todas las diez rutas públicas siguen **bloqueadas**.
No se editaron el plan, `quick.ts`, `procedure.ts`, `phase-session.ts` ni la
secuencia legacy de `courtSession` para este bloque; no hay commits/despliegue.

Verificación fresca de este bloque (2026-11-07): `npm test` pasó **540/540**,
sin fallos ni skips. La selección de inventario/arranque/consenso/broker/steps/
actividad pasó **39/39** (incluye las nueve pruebas del inventario). Typecheck
completo `--noEmit --incremental false --pretty false`: código 0. Las tres
fixtures PostgreSQL protegidas (continuación, instrucción y rerun legacy)
terminaron con código 0, sin Blob/IA paga/Workflow reales. `git diff --check`: 0,
sólo avisos LF/CRLF. No se corrió build ni se accedió a producción.

## Paso 4: bloque parcial de retencion conservadora

- `deleteCaseSandboxes` rechaza sin DB, listado, resume ni borrado;
  `sweepCaseSandboxes` avisa el bloqueo y devuelve `[]` sin enumerar recursos.
  Incluye casos fallidos, resueltos, ausentes, renombrados y tags ambiguos: ni
  lease, cancelación, estado terminal ni fencing nuevo prueban liberación de
  todas las referencias e inactividad histórica. `disposeSandboxes` mantiene
  nombre y posición de step; registra `case.sandboxes.cleanup_blocked` sin
  ocultar el error principal del caso.
- Los snapshots **futuros** de preparación usan `snapshotExpiration: 0` y
  `keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: false }`. La VM
  existente se obtiene sin resume y se actualiza antes de métodos que pueden
  reanudarla; se confirma la política antes del stop explícito. Error de
  actualización/cuota bloquea y no dispara una VM sustituta. No se altera la
  expiración ya asignada a snapshots históricos ni se recuperan los eliminados.
- Checkpoints legacy sólo se escriben con caso ejecutando, CAS y lock del caso;
  un `sandboxId` o ID de sesión ya establecido no se reemplaza ni se borra. El
  guard de identidad también se aplica al SQL de publicación atómica. Bindings
  no se reasignan a otro caso/sesión/generación ni se desrevocan; la revocación
  generacional no toca grants de otra generación. Los escritores históricos
  desplegados antes de estos controles siguen sin prueba de inactividad.
- Reset/borrado administrativo **también falla cerrado**, antes de borrar
  Blob/DB o iniciar otra ejecución. `assertSandboxCleanupSafe` es un guard puro
  incondicional (sin bypass de configuración), compartido por store y cleanup.
  El store lo ejecuta bajo el lock del caso antes de callbacks o enumerar steps
  del run detenido; un callback vacío/directo no autoriza borrar referencias.
  `withSandboxCleanup` valida antes de cualquier efecto del lote/aliases y
  propaga el bloqueo. Los dos handlers admin devuelven HTTP 409 y
  `sandbox_cleanup_blocked`, sin afirmar borrado parcial ni éxito. Se conservan
  los resultados missing/active y missing-image cuando corresponden.
  Esto sustituye la excepción DB/Blob de la revisión anterior: no permite
  crear huérfanos nuevos por esas operaciones, pero no recupera referencias
  ya perdidas ni demuestra un protocolo completo de GC.

### Replay legacy: alcance comprobado y bloqueo intencional

- `PhaseSession` durable en generación 0 y caso `in_session` reabre el mismo
  ID/VM/prefijo/turno, sin renovar reloj ni pasos. CAS concurrente permite sólo
  un escritor y no admite reemplazar/eliminar un ID/VM establecido.
- Reabrir y consultar un turno **completo** es read-only y funciona también en
  casos queued/failed/resolved. Save (incluso idéntico), turno nuevo o replay
  incompleto que necesita escribir en esos estados se bloquean; no se adelanta
  la revisión ni se recrea conversación/VM para ocultarlo.
- Binding activo, no revocado y con case/sessionKey/phaseSessionId/owner iguales
  admite replay/renovación dentro del mismo caso ejecutando. Binding revocado
  o histórico sin sessionKey/phaseSessionId se bloquea sin completar identidad
  por suposición. No se desrevoca ni reasigna VM/sesión/generación.
- Son límites intencionales de seguridad, no garantía de replay integral del
  motor Workflow ni de deployments históricos. `settled-play` puede publicar
  prompts/drafts antes de devolver un turno completo; el replay de PhaseSession
  no prueba cero efectos de ese orquestador ni valida artefactos anteriores.
  No se aflojaron guards, no se habilitó continuación y no se llamó al motor real.

Pruebas nuevas: `src/instruction/sandbox-retention.test.ts`,
`src/store-sandbox-retention.test.ts`, y fixture
`scripts/test-local-sandbox-retention.ts` (loopback/DB/usuario explícitos antes
de importar store, identidad DB comprobada, fetch/SDK bloqueados). Cubren
retención futura modelada, errores de cuota/snapshot faltante, cero efectos de
cleanup concurrente, writer tardío contra transición terminal, identidad, CAS
y rollback en PostgreSQL local. No son garantía del control plane real.

Límites: retención sin vencimiento aumenta almacenamiento; no se implementó
monitoreo de cuotas ni estimador de costos. Timeouts automáticos del proveedor,
snapshots históricos, VMs legacy single-use y builders de snapshot siguen sin
recuperación/retención generacional demostrada. Las diez rutas continúan
deshabilitadas y los pasos 2–4 siguen parciales. La metodología pública y su
tarea del paso 7 quedan sin iniciar; el plan no se modifica en este bloque.

Verificación del bloque anterior (antes de corregir el callback/admin): mocks dirigidos **57/57**; inventario/bloqueo
de Reintentar **23/23**; suite local completa **556/556**, sin fallos ni skips.
Las fixtures PostgreSQL de retención y continuación terminaron con código 0;
typecheck sin emisión/cache incremental y `git diff --check`, código 0. No
build, smoke remoto, pagos ni producción. Estos resultados no prueban
recuperación histórica ni habilitan continuación.

Verificación de la corrección callback/admin: suite completa **561/561**,
selección cleanup/store/ambos handlers/workflow **70/70**, y selección de
inventario/Reintentar/workflow **27/27**, todas sin fallos ni skips. Typecheck
sin emisión/cache incremental y `git diff --check`, código 0. Las fixtures
PostgreSQL protegidas de retención/replay y de carreras DELETE/POST pasaron;
la de replay se repitió con casos incompletos y checkpoints ausentes en estados
queued/failed/resolved, sin avanzar ni recrear estado durable. No se ejecutó
el motor Workflow ni Sandbox/Blob/proveedores reales.

## Verificación segura y límites

Bloque local del paso 5: [contratos y límites del preflight histórico de fuentes](historical-source-preflight.md).
Valida exports locales acotados de Expert 3–5, sin IO ni integración con
rutas. El preflight sigue bloqueado por inactividad histórica no probada; el
adaptador offline no autoriza continuación ni recuperación de `AT-185-GA`.

Prueba de diseño local, sin DB ni proveedores:

```powershell
node --import tsx --test src/continuation-inventory.test.ts
```

Pruebas locales ya existentes útiles para delimitar lo que sí existe:

```powershell
node --import tsx --test src/court/phase-session.test.ts src/instruction/collection.test.ts src/instruction/sources.test.ts src/instruction/proposed-urls.test.ts
```

Esas pruebas usan fixtures/memory/inyección de dependencias, no journal o
servicios reales. La fixture 33/4 de esta entrega es **sintética** y prueba pérdida
de información, no un importador de `AT-185-GA` ni sus bloques. El test existente
de colección comprueba una sola lectura del expediente por intento y valida
artefactos; debe preservarse durante los siguientes pasos.

Para inspeccionar drift sin ejecutar la aplicación:

```powershell
node --import tsx scripts/continuation-inventory.ts
```

También se ejecutó typecheck completo sin emitir ni modificar el cache incremental:
`node_modules/.bin/tsc --noEmit --incremental false --pretty false`.
La entrega inicial del paso 1 no cambió runtime ni verificó deployment. El paso 2
sí agrega runtime desactivado y pruebas PostgreSQL protegidas descritas arriba;
no valida continuación real ni inactividad de escritores históricos. No
ejecutar el script de PostgreSQL apuntando a variables heredadas de producción;
usar las guardas documentadas en `shared-instruction.md` y credenciales locales
aisladas. El build y la validación de deployment no forman parte de esta entrega.
