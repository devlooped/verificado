# Operaciones externas generacionales: intención durable y ejecución bloqueada

Este bloque endurece el repositorio existente; **no habilita continuación ni
ejecuta efectos externos**. No completa los pasos 2 y 4 del plan. Los diez caminos
Expert/Quick × pipelines 1–5, las publicaciones productivas de artefactos y los
guards de autorización, arranque y cleanup siguen bloqueados.

## Contrato integrado

`sourceOperationRepositoryFor(writer)` en `src/store.ts` captura una copia
inmutable de generación/run. La señal explícita `OperationRepository.writer` sólo
sirve para bloquear el uso de servicios legacy; no acredita autorización ni
procedencia. Cada acceso nuevo a operaciones o alias valida el caso y su run
reconciliado bajo el bloqueo del caso, antes de acceder a filas subordinadas.

`claim(caseId, key, stage, leaseMs, inputHash?, input?)` conserva sus argumentos
legacy y agrega una entrada opcional. Con writer generacional exige:

- Entrada JSON finita, sin pérdidas ni getters/proxies, canonicalizada y copiada
  antes del primer `await`; hash exacto calculado con `continuationHash(input)`.
- `body.inputJson` con la entrada canónica **completa**, además de `inputHash`,
  clave, etapa y writer. No acepta filas históricas que sólo tengan el hash.
- Inserción de intención, adquisición de owner y auditoría en **una transacción**.
  Se devuelve el owner sólo después del COMMIT. No se ejecuta I/O externo allí.
- Coincidencia de writer/clave y de entrada/etapa al reclamar. Las lecturas y
  mutaciones también rechazan cuerpos incoherentes o intenciones incompletas.
- Ausencia de una operación predecesora con la misma clave lógica en otro
  namespace, incluido legacy. Se bloquea incluso si dice `ready`: no hay un
  importador/reconciliador productivo que verifique su resultado y artefactos.

### Inventario de predecesores: criterios de rechazo

Antes de insertar, `changeOperation` lee **todas** las filas del caso con
`SELECT case_id, operation_key, body ... WHERE case_id = $1 FOR UPDATE`, después
del bloqueo del caso y dentro de la misma transacción. No filtra por ninguna
clave, no usa `LIKE`, sufijos, wildcards ni `LIMIT`. La consulta anterior podía
ocultar `generation:1:call` cuando su `body.key` faltaba o estaba alterado; una
prueba negativa reproduce el claim indebido antes de la corrección.

Cada fila, incluida la de la clave física reclamada, debe cumplir:

- `case_id` coincide; clave física y lógica son strings no blancos. El cuerpo es
  JSON finito sin accesores; etapa no blanca, `at` parseable, `recoveries` array
  y estado reconocido (`pending`, `running`, `failed`, `uncertain` o `ready`).
- `pending` no tiene owner, expiry ni resultado. Los otros estados tienen owner
  no blanco y expiry parseable. Un `ready` legacy debe contener resultado, pero
  su presencia **no acredita integridad, completitud ni procedencia**.
- Con writer: generación entera positiva segura, no futura, run no blanco; si
  es la generación actual, run igual al writer vigente. La columna es exactamente
  `generation:${body.writer.generation}:${body.key}` y la intención completa
  conserva canonicalización/hash exactos. Los estados generacionales `ready`
  siguen rechazados incluso en filas aparentemente independientes.
- Sin writer: columna exactamente igual a `body.key`, sin `inputJson` y **sin
  prefijo `generation:`**. Ese prefijo está reservado sólo para clasificar el
  camino nuevo: una fila legacy que lo use puede colisionar con una fila
  generacional mutilada. No se adivina ni se reinterpreta su identidad. `writer`
  nulo, parcial o inválido también bloquea. No cambia cómo legacy ejecuta/reproduce.

Tras validar **todo** el inventario, únicamente son independientes del claim las
filas de otra clave física cuya clave lógica exacta difiere de la solicitada.
La fila física actual debe además pertenecer al writer actual; su ownership
continúa sin takeover. Cualquier otra fila con la misma clave lógica bloquea,
sin importar estado, expiración, run o generación. Cualquier fila ambigua o
incoherente bloquea **todos los claims generacionales del caso**, no sólo el que
parece relacionarse con ella. Se hace rollback sin insertar, reparar, borrar,
adoptar ni reescribir la fila dudosa. Otros casos no entran en este inventario.

Las comparaciones son literales, sin normalizar Unicode ni interpretar `%`, `_`,
backslashes, comillas, saltos de línea o `generation:` dentro de la clave lógica.
La reconstrucción desde un writer válido admite prefijos anidados sin ambigüedad;
no se elimina ningún prefijo para inferir una clave. No se amplían los caracteres
que PostgreSQL puede almacenar (por ejemplo, NUL sigue fuera del contrato text).

La independencia demostrada es **sólo la del contrato de identidad persistida**.
No prueba autenticidad de datos totalmente falsificados de manera coherente,
que claves distintas no describan el mismo efecto real, inactividad histórica
ni facturación única. La exclusión concurrente requiere que todos los writers
respeten el bloqueo previo del caso; no protege writes SQL fuera del contrato.
Los mocks serializan `BEGIN` para modelarlo: no demuestran locks, snapshots ni
aislamiento PostgreSQL. La ejecución externa y la publicación siguen bloqueadas.

El repositorio fija los bytes suministrados, **no prueba que el caller haya
incluido todos los parámetros efectivos** (prompt/modelo/configuración, budgets,
deployment, herramientas, etc.). No existe un dispatcher generacional permitido
que consuma esa entrada y pruebe ownership justo antes del efecto. Un claim no es
permiso para llamar a un proveedor ni una garantía de facturación exactamente una
vez. No se añadieron tablas, migraciones ni transportes productivos.

| Situación generacional | Comportamiento |
| --- | --- |
| `pending` íntegro, sin owner anterior ni predecesor | Un claim adquiere owner durable. |
| `running` con owner válido | Otro claim devuelve `owned: false`, sin takeover. |
| Lease vencido | Lectura/claim pasa a `uncertain`; conserva owner, no reejecuta. |
| Fallo reportado, incluso `uncertain: false` | Conservadoramente `uncertain`; no se ha probado ausencia del efecto. |
| Respuesta de COMMIT perdida | Puede quedar `running` durable; el reintento no adquiere otro owner. |
| `failed`/`uncertain` | No retry automático, ni recuperación administrativa implementada. |
| `publish`, `defer`, `recover` nuevos | Bloqueo antes de DB. No liberar owner por inferir que una etapa llamada `canonical` sea pura. |
| Fila que dice `ready` | Lectura/reuso bloqueado; no se repara ni se adopta silenciosamente. |

`publishGenerationArtifactReference` continúa rechazando **incondicionalmente
antes de DB**, también para receipts localmente auténticos. Nombres, hashes,
readback y WeakSet no prueban procedencia autenticada ni retención. Expiración y
cancelación tampoco demuestran inactividad del escritor histórico.

## Preparación, broker y retries investigados

Los tests nuevos reproducen estos límites con los callers reales y mocks:

1. `advancePreparation` escribe tarea y lanza un comando detached **antes** de
   guardar `preparationCommand`. Si se pierde la respuesta del launch, el comando
   puede haber ejecutado aunque no exista handle durable. El siguiente intento
   legacy puede lanzar otra vez el mismo call ID.
2. `restart()` por fallo de `getCommand` o `wait` borra el handle, conserva call ID
   y tool choice, y permite relanzamiento. Eso no demuestra ausencia del comando
   anterior. La espera/cancelación tampoco reconcilia su resultado.
3. En `src/instruction/proxy.ts`, `generation()` calcula el hash del request pero
   lo compara **después** de `reader.hostStage()`. Su intención legacy durable no
   tiene entrada/hash de request antes de `deps.generate`. Deduplica la generación
   completada y rechaza otro prompt al reutilizar el resultado; no deduplica el
   launch, mkdir, task writes, compute ni todo efecto posterior a la generación.
4. El harness instalado usa `generateText({ maxRetries: 0, stopWhen:
   stepCountIs(1) })`. Los tests envían exactamente una petición ante HTTP 503 o
   respuesta perdida. Esto no desactiva retries de otros SDK ni reconcilia cargos.
5. En `@vercel/sandbox` instalado, `BaseClient` usa `withRetry`, con dos retries
   por defecto para errores de red, 429 y 5xx. El POST detached de `/cmd` no aporta
   una clave durable de idempotencia en el código cliente inspeccionado. El test
   del wrapper reproduce tres intentos de POST cuya respuesta se perdió.
   `Sandbox.withResume` además puede reanudar y repetir una operación ante estados
   stopped/stopping/snapshotting; `getCommand` tiene su propio retry de lectura.
   No se verificó qué garantías ofrece el servidor/control plane real.
6. `src/evidence/broker.ts` construye documentos de tarea y políticas de red; no
   implementa un registro durable de intención/deduplicación. La ruta legacy de
   evidencia permite el gateway directo; la de instrucción lo reenvía al proxy
   autorizado. Ninguna política de red demuestra idempotencia del proveedor.

Cambiar esos órdenes y retries en el camino histórico podría alterar firmas o
replay. Se mantienen sin cambios: el servicio rechaza explícitamente un repo
generacional en el constructor, antes de leer/escribir artefactos; preparación
rechaza `deps.writer` antes de acceder al turno, guardar, detener o reanudar un VM.
El guard generacional del proxy de turnos (`src/instruction/proxy.ts`) ya existente
permanece intacto y anterior al parseo y dispatch. No se infiere scope de nombres
de objetos/sesiones.

## Verificación y límites

Pruebas reproducibles, únicamente con mocks:

```sh
node --import tsx --test src/store-generational-operations.test.ts src/instruction/generational-effects.test.ts
npm run typecheck
```

Se ejercitan las funciones productivas del store interceptando todos los Pool y
fetch; el doble SQL serializa BEGIN para modelar el bloqueo del caso y conserva
COMMIT aun si se pierde su respuesta. Cubre claims concurrentes, colisiones,
rollback de intención/auditoría, writers stale, owner erróneo, respuestas parciales
o perdidas, expiry y predecesores. **No acredita la semántica de aislamiento y
locks de PostgreSQL real.** No se ejecutó PostgreSQL local: no se estableció aquí
una instancia aislada explícitamente segura y no se utilizaron las conexiones de
la app. Tampoco se probaron DB remota, proveedor, Blob/R2, Sandbox real, workflow
ni despliegue.

El inventario estático registra el sitio SQL nuevo de
`sourceOperationRepositoryFor.get`: lectura con lock y actualización de expiry a
`uncertain`; y el lock adicional del escaneo completo de `changeOperation`. Esos
ajustes no conceden compatibilidad ni permiso de ejecución.

La regresión legacy comprueba claves sin namespace, claim sin entrada, publicación
y reuso de `ready`, `defer`, fallo conocido y recovery existentes. Los tests del
broker/preparación preservan y evidencian el límite histórico; no lo declaran
seguro. No hay restauración de turnos, renovación de budgets, reparación,
importación de filas o GC de huérfanos. Todo uso productivo nuevo sigue pendiente
de garantías completas y autorización separada.
