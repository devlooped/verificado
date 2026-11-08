# Preflight histórico local de fuentes — paso 5 acotado

Este bloque valida **datos ya suministrados en memoria**. No lee un expediente,
archivos, DB, journal remoto ni Blob; no descarga, extrae, traduce, invoca modelos
ni arranca Workflow. No está conectado a ninguna ruta. Expert/Quick × pipelines
1–5 siguen deshabilitados; delete/rerun conservan el bloqueo previo antes de
efectos DB/Blob y callbacks. No cambia la retención parcial ni prueba referencias
históricas completas, snapshots conservados o recuperación de `AT-185-GA`.

## API y resultados

Implementación: [`historical-sources.ts`](../src/instruction/historical-sources.ts).
Contratos exportados: `HistoricalSourceBatchSchema`, `HistoricalSourceBatch`,
`HistoricalSourceExpectationSchema`, `HistoricalSourceExpectation`,
`HistoricalArtifact` y `HistoricalBatchVerification`.

```ts
verifyHistoricalSourceBatch(
  expectation: unknown,
  input: unknown,
  snapshot: readonly HistoricalArtifact[],
): HistoricalBatchVerification

historicalSourcePreflight(
  expectation: unknown,
  input: unknown,
  snapshot: readonly HistoricalArtifact[],
)
```

`HistoricalArtifact = { readonly path: string; readonly bytes: Uint8Array }`.
El llamador suministra una proyección cerrada de los artefactos de este lote,
no el árbol completo del expediente. Cada path aparece exactamente una vez en
el manifiesto y en el snapshot; no se ignoran bytes, operaciones ni alias sobrantes.
El módulo no modifica bytes, registros, leases, alias ni entradas.

`expectation` tiene exactamente `{ origin, inputHash, evidenceHash }`. Los hashes
y la procedencia esperada se deben fijar **independientemente del export que se
coteja**, desde evidencia confiable. El módulo compara esos valores, pero **no
autentica al exportador**, no crea esa evidencia ni demuestra que los registros
fueron realmente producidos por el run declarado. Recalcular ambos lados desde
datos no confiables no prueba procedencia histórica.

`verifyHistoricalSourceBatch` devuelve:

- `{ state: "blocked", code }` ante cualquier incoherencia: sin resultado parcial,
  URLs, texto privado, motivos internos ni detalles Zod.
- `{ state: "verified-offline", continuationEnabled: false, origin, inputHash,
  evidenceHash, resultHash, fetched, failures, artifacts, basis }` si el cotejo
  local es completo. `fetched` conserva orden e identidad exactos del input,
  y cumple `FetchedUrl[]`: cada elemento es **o** `{ url, sourceId } **o**
  `{ url, error }`, nunca ambos. `failures` conserva `{ url, error, operation,
  reason, at }`; `reason` es el error durable exacto, diferente del código público.
  `artifacts` contiene los paths/hashes cotejados, no los cuerpos.
  `basis` es `journal-and-operations` u `operations-only`.

El **preflight siempre** devuelve `{ state: "blocked", continuationEnabled: false,
blockers, sourceBatch }`. `blockers` incluye `historical_inactivity_unproved` y
`continuation_disabled`; agrega el código de integridad cuando el cotejo falla.
`sourceBatch` es el resultado anterior, útil únicamente para revisión privada
local: si fue verificado incluye URLs/identificadores/motivos privados; **no debe
volcarse en logs ni publicarse como respuesta administrativa**. No hay lector de
control plane, verificador de inactividad ni capacidad de importación/ejecución.
Estado failed, cancelación, lease vencido, fencing, ausencia de bindings/tags o
un booleano del llamador no satisfacen esa prueba.

## Export local v1 y alcance concreto

Estos son **formatos locales nuevos**, no formatos nativos del journal del SDK
Workflow ni un parser de su almacenamiento. No hay hooks para fabricar el export
desde infraestructura. Todos los objetos del contrato son estrictos y se rechazan
valores no JSON finitos/campos que se perderían en serialización.

| Campo | Contrato |
| --- | --- |
| `format`, `caseStatus` | `historical-source-batch/v1`, `failed` |
| `origin` | `{ caseId, check: "expert", pipeline: 3 \| 4 \| 5, runId, deploymentId, language, models }`; IDs no vacíos, hasta 256 caracteres; idioma hasta 32 |
| `models` | Mapa de rol a `{ id, effort: string \| null }`; exige `judge` y `counsel.grok/gemini/claude/chatgpt`; igualdad exacta entre procedencias |
| `urls`, `inputHash` | 1–1000 URLs http/https ya normalizadas, sin credenciales/fragmentos/duplicados; hash de `{ origin, urls }`, con orden significativo |
| `operations` | `{ format: "source-operations/v1", origin, records: [{ body, hash }] }`; máximo 4096, claves únicas |
| `body` | `{ key, stage: "acquisition" \| "extraction" \| "canonical", status, at, owner?, expiresAt?, result?, error?, recoveries: [] }` |
| `aliases` | `{ format: "source-aliases/v1", origin, records: [{ url, sourceId }] }`; máximo 4096, exactamente un alias directo por URL |
| `artifacts` | Hasta 4096 `{ path, hash }`; máximo 8 MiB por artefacto suministrado |
| `journal` | `null` explícito **o** `{ format: "fetchProposals-results/v1", origin, batches }`; ausente/malformado no equivale a `null` |
| Cada batch | `{ step: "fetchProposals", stepId, ordinal, completedAt, urls, inputHash, result, resultHash }`; ordinal consecutivo desde 1, IDs únicos, orden exacto, 1–4 URLs/resultados |

Timestamps: ISO datetime. Hashes: SHA-256 hexadecimal minúsculo de 64 caracteres.
Los hashes JSON usan `continuationHash` (claves ordenadas recursivamente); los
hashes de archivos usan **bytes**, no texto normalizado. `evidenceHash` cubre el
export completo, incluido el manifiesto, operaciones, alias y journal.
`resultHash` cubre el array exacto `fetched`.

Se cotejan los contratos de `fetchProposals` y `SourceService` existentes:

El alcance es **Expert 3/4/5**: Quick no recorre esta colección de fuentes.
`check` ausente o Quick no se convierte implícitamente a Expert; queda bloqueado.

1. Lotes consecutivos de `COLLECTION_BATCH = 4`. El hash de argumentos es el
   de `{ caseId, language, urls, simulated: false }` para pipeline 3. Para 4/5
   agrega `{ batch: ordinal, batches: ceil(total/4) }`. No se deducen resultados
   desde eventos de progreso o conteos: se coteja cada URL/resultado/hash.
2. `sourceId = "src_" + sha256(url).slice(0, 24)`. Solo adquisiciones directas,
   `url === finalUrl`, con alias exacto; redirects, alias compartidos y colisiones
   se bloquean, no se reconstruyen por suposición.
3. Operación `acquisition:<sourceId>` ready: se cotejan metadata, path y hash de
   `instruction/sources/<sourceId>/original.bin`. Extracción ready con clave
   `extraction:<sha256(JSON.stringify([rawHash, "markdown-blocks-v1", contexto]))>`;
   contexto es `finalUrl` para html/htm y la extensión para otros formatos.
   Su archivo es `instruction/operations/<sha256(clave)>/extracted.md`.
4. Canonical ready con clave
   `canonical:<sha256(JSON.stringify([sourceId, extracted.hash, extracted.title, "original"]))>`.
   Se cotejan referencia/hash de `source.json` schemaVersion 3, adquisición,
   extracción y documento completos, además de la copia canónica `extracted.md`.
   UTF-8 estricto, JSON exacto de `JSON.stringify` sin claves duplicadas y bloques
   con IDs/páginas/offsets/longitudes UTF-16 que reproducen el Markdown completo.
5. La única falla soportada es adquisición `failed` con motivo durable no vacío
   (hasta 4096 caracteres), sin resultado ni artefactos del source. El resultado
   exacto del contrato actual es `{ url, error: "source_failed" }`; no se reemplaza
   por el motivo del proveedor. Fallas de extracción/canonical, estados pending,
   running o uncertain, recoveries no vacíos y campos generacionales/inputHash
   de otras revisiones quedan bloqueados en este adaptador v1 acotado.

Si hay journal, **cada** resultado/orden/error debe coincidir con la cadena de
operaciones y artefactos. Un journal corrupto/discrepante no se descarta para
caer a operations-only. `journal: null` permite únicamente una **proyección
determinista** del resultado del contrato actual desde operaciones completas y
artefactos cotejados, con hashes esperados independientes: no prueba que el step
de Workflow terminó ni que publicó ese resultado. Conteos `33/4` solos bloquean.

Códigos de bloqueo: `invalid_export`, `provenance_mismatch`, `input_mismatch`,
`evidence_mismatch`, `duplicate_or_collision`, `artifact_integrity`,
`operation_integrity`, `operation_unresolved`, `unsupported_source`,
`journal_integrity`. No hay excepción de reparación ni ejecución al bloquear.

## Verificación y límites

Fixture **sintética** de 33 URLs, nueve lotes y cuatro fallas de adquisición,
para pipelines 3/4/5, con/sin journal; no es un export de `AT-185-GA`.
Pruebas de journal ausente/corrupto/discrepante, orden, duplicados/colisiones,
alias/operaciones/bytes sobrantes, hashes esperados independientes, motivos
alterados, originales/extracciones/canonical JSON ausentes o cambiados, offsets,
claves JSON duplicadas, procedencia, estados inciertos y evidencia de inactividad
insuficiente. Mocks que fallan ante fetch/DB/Sandbox/Blob/repositorio/reloj prueban
cero llamadas tanto con entradas válidas como bloqueadas; se compara el input
antes/después. Inventario sintáctico e imports runtime limitados a crypto/Zod y
helpers puros impiden dependencias de modelos, infraestructura o ejecución.

```powershell
node --import tsx --test src/instruction/historical-sources.test.ts
node_modules/.bin/tsc --noEmit --incremental false --pretty false
```

Verificación nueva de este bloque: **9/9** pruebas del módulo, incluidas en una
selección de fuentes/inventario/cleanup/store/ambos endpoints/workflow de
**101/101**; suite local completa **570/570**, sin fallos ni skips. Typecheck sin
emisión/cache incremental, inventario sin drift y `git diff --check` pasaron.
Chequeo adicional de whitespace de los cuatro archivos de esta entrega: cero
problemas. Es evidencia nueva, distinta de las 561 pruebas previas del fix de
limpieza; no se repitieron fixtures PostgreSQL ni se usó infraestructura real.

No se hicieron lecturas reales históricas, verificaciones SDK/control plane,
build, instalaciones, pruebas remotas, despliegues ni commits. Este bloque no
completa el paso 5 ni los pasos previos parciales; cualquier integración posterior
necesita evidencia histórica autoritativa, inactividad, retención/referencias
completas y autorización separada. El plan permanece sin editar y la tarea de
metodología pública del paso 7 sigue sin iniciar.
