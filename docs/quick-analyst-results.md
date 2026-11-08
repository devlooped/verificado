# Resultados completos de analistas Quick: cotejo offline

`src/court/quick-analyst-results.ts` agrega un cursor **de evidencia privada**, no un checkpoint ejecutable. Complementa el consenso textual puro existente. No se importa desde el workflow, store, API ni acción administrativa y no habilita ninguna de las diez rutas.

## Contratos comprobados

- `quick-play.ts:generation` primero escribe `request.json` y `result.json`, luego publica auditoría y retorna al step. Un resultado escrito no prueba que terminó la auditoría ni que Workflow publicó el retorno. La reutilización actual lee por ruta, sin verificar allí la configuración de la solicitud.
- `court-session.ts:answerQuick/voteQuick` son steps separados. El voto recibe la respuesta íntegra; sus argumentos no son intercambiables con los de respuesta. El export local representa argumentos con nombres; los opcionales `undefined` ausentes se omiten. **No es el formato del journal SDK** ni un importador autenticado.
- `quick.ts:holdQuickSession` publica primero `session_opened`. Ejecuta los cuatro asientos en paralelo, conserva el orden `COUNSEL` al publicar las cuatro respuestas y después los cuatro votos en una sola llamada a `commit`. El voto público recorta la razón, pero el resultado del step no; el cursor conserva ambos. La secuencia de auditoría es `0` para respuesta y `2` para voto inicial, no la secuencia pública `2..9`.
- La simulación conserva IDs configurados en apertura/solicitud/auditoría, pero la respuesta lleva `court-fixture` y esfuerzo `null`; el esfuerzo de apertura también es `null`. No se convierte simulación en evidencia de un proveedor real.
- **Quick no usa PhaseSession**. `PhaseSession.finish()` fija `complete`, no `done`; `begin()` devuelve un turno completo sin regenerarlo y rechaza otro incompleto. `settled-play.ts:advanceSharedTurn` puede publicar prompts y draft antes de devolver un turno completo. Ni `complete`, ni `done`, ni un lease vencido prueban publicación íntegra, ausencia de operaciones o inactividad histórica. Este bloque no adapta fases Expert ni debilita sus guards de configuración/CAS/presupuesto.

## Alcance exacto del formato local v1

`verifyQuickAnalystResults(expectation, export)` requiere Quick **5**, texto sin identificación de claims, cuatro respuestas y cuatro votos exitosos en el intento **0**, y exactamente el prefijo público completo de nueve eventos. La respuesta almacenada debe terminar con `finishReason: stop`; otros finales, retries, ausencias, claims, links, imágenes, fases Expert y pipelines 1–4 quedan fuera. Un empate completo puede cotejarse, pero el cursor no decide ni ejecuta desempate; el consenso existente conserva su propio bloqueo de empate.

El export incluye origen (caso/run/deployment/idioma/configuración completa de los cinco modelos/simulación), ocho retornos completos del journal, solicitudes/resultados JSON ya parseados, auditorías y eventos. Exige IDs de journal únicos y opacos; no inventa IDs Workflow. Compara las rutas reales, argumentos, prompts, mensajes del voto, herramientas nativas, opciones de proveedor, esquema de salida, resultados, sources, IDs de auditoría, timestamps y ambas secuencias. Preserva el export completo y devuelve `nextSeq: 10`, sin publicar ni reconstruir un evento faltante. No ordena por timestamp: los asientos paralelos pueden terminar en distinto orden.

`expectation` debe fijar **independientemente** origen, `inputHash = continuationHash(origin)` y `evidenceHash = continuationHash(export)`. Calcular los pins del mismo export no aporta confianza; solo permite fixtures sintéticas. Se rechazan discrepancias incluso con un hash recalculado si contradicen el contrato. Antes de schemas/hashes se rechazan arrays dispersos, propiedades extra/no enumerables, accessors, símbolos, ciclos y valores no JSON; límites: profundidad 32, 100.000 nodos y 2.000.000 caracteres de claves/strings. Esto no corrige el canonicalizador compartido.

El formato exige `operationCoverage: unproved` y una lista vacía `unresolvedOperations`: cualquier operación pendiente/incierta conocida bloquea el cotejo. **La lista vacía no prueba cobertura**, conciliación de llamadas ni inactividad. No se admiten assertions de cobertura histórica completa.

## Bloqueos permanentes y pruebas

`quickAnalystPreflight(...)` siempre devuelve `state: blocked` y `continuationEnabled: false`, aun con `analystResults.status: verified-offline`. Los bloqueos incluyen inactividad histórica, cobertura de operaciones, bytes físicos/procedencia autenticada del export y deshabilitación global. Un error agrega un código genérico sin exponer texto privado.

No hay lector remoto/local de artefactos en el adaptador, importer SDK, publicación DB atómica probada para un caso real, generación nueva, provider hook, comando de Sandbox ni recuperación de `AT-185-GA`. Los JSON parseados y sus hashes no prueban los bytes Blob originales ni ausencia de publicaciones/operaciones fuera del export. Sin esas pruebas adicionales no es seguro importar/reutilizar estos datos en un run nuevo. Una ronda parcial se conserva y bloquea: no se repiten asientos ni se completa por conteos.

Las pruebas usan `quickAnswer`/`quickVote` reales con modelo simulado y `MemoryArtifactStore`, auditoría capturada y `holdQuickSession` real detenido después de la ronda íntegra. Los exports de journal son fixtures explícitas, no un run real. Incluyen discrepancias de contratos, publicación parcial, estados inciertos, cambios de modelo/procedencia, colisiones e inputs malformados; el cotejo es determinista, no muta entradas y no hace nuevas llamadas.
