# Artefactos generacionales: staging experimental, publicación bloqueada

**Toda publicación desde `publishGenerationArtifactReference` falla antes de DB.**
No hay flag, hook de fixture, transporte habilitado ni ruta alternativa productiva.
Incluso un recibo auténtico del WeakSet obtenido de un Map, un transporte arbitrario
o un supuesto transporte remoto recibe `generation_artifact_retention_unproved`.
El recibo ni siquiera se inspecciona. Variables de entorno y una futura habilitación
global de continuación no levantan este bloqueo independiente.

No se habilita ninguna continuación ni se promueven checkpoints. Firmas y replay
de `ArtifactStore`, `caseArtifactStore`, evidencia, ZIP y transcript legacy no cambian.

## Lo que sí prueba staging

`stageGenerationArtifact` acepta un transporte **arbitrario** con el contrato
create-only/read. Copia bytes y captura caso/generación/run antes del primer await;
valida ruta, límite de 8 MiB y hash esperado; rechaza memoria compartida. Las claves
deterministas `continuation-artifacts/v1/<caso>/generations/<g>/<ruta>/<sha256>` están
fuera del árbol legacy `cases/`. El nombre no prueba inmutabilidad remota.

Readback coteja longitud, SHA-256 y bytes exactos. Una respuesta perdida o 412 solo
se resuelve con bytes idénticos **bajo el contrato del transporte suministrado**;
ausencia/lectura fallida es `generation_artifact_uncertain`, discrepancia es
`generation_artifact_conflict`. No hay reparación, reintentos automáticos ni GC.

El recibo congelado y su WeakSet prueban únicamente el cotejo local, no procedencia
del transporte, retención física, escritura remota ni autorización. JSON deserializado
pierde ese marcador, pero ni siquiera el marcador auténtico permite publicar.
Staging puede ejecutar el transporte que le suministre un caller; no es una frontera
de autorización. No existe caller runtime que lo integre con publicación.

## Prueba transaccional inequívocamente no productiva

Solo `src/store-generation-artifacts.test.ts` compone el protocolo experimental,
en una VM con un doble DB de memoria. Lee y elimina los tipos de tres funciones **privadas**
actuales del store (`assertCaseWriter`, `withCaseMutation`, `continuationAudit`),
sin exportarlas ni añadir una función de publicación alternativa al runtime.
La VM no recibe Pool, environment, imports, require, fetch ni conexiones reales.
Es aislamiento de prueba, no un sandbox de seguridad para código hostil.

La composición vive dentro del test, no está exportada y no es un seam del store.
Un test comprueba ausencia de sus referencias/imports en los módulos runtime.
Así se sigue modelando lock del caso, generación/run reconciliado, idempotencia,
colisión con rollback, cancelación tardía y COMMIT con respuesta perdida. **Estos
son resultados de un modelo, no publicación real ni nueva evidencia PostgreSQL.**

La API productiva se prueba por separado con recibos de Map auténticos, copiados,
ausentes y proxy hostil, con distintas variables de entorno: cero llamadas DB/fetch.
`node --import tsx scripts/test-local-generation-artifacts.ts` ahora es únicamente
un smoke offline de ese bloqueo. No carga `.env`, conecta PostgreSQL, crea filas
ni conserva el antiguo camino de publicación de fixture.

## Garantías pendientes

R2 firma `If-None-Match:*` para `putObject(overwrite:false)`, pero otros escritores,
`putObject(true)`, `copyObject`, `deleteObjects` o lifecycle podrían mutar/eliminar
objetos. No se prueban IAM, Object Lock, cuotas, retención ni inactividad histórica.
Readback no garantiza conservación entre cotejo/publicación ni atomicidad Blob/DB.
`stageCaseGenerationArtifact` y el preflight generacional siguen bloqueados.

No hay journal durable de uploads, descubrimiento/liberación de huérfanos, garantía
de una sola llamada/cargo remoto, cancelación Workflow comprobada ni lectores
generacionales integrados. No se promete retención infinita ni se borra para resolver
cuotas. Los errores inciertos no autorizan un reintento ni una operación `ready`.
Una implementación futura requiere revisión explícita de procedencia/retención,
autorización y fencing completos; no basta habilitar un flag o presentar un recibo.
