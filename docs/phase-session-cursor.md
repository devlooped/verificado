# Cursores de fase: avance offline acotado

Este bloque del paso 3 añade `verifyPhaseSessionCursor`, un cotejo **offline** de
los cursores de conversación Expert 2–5. Usa el contrato real de
`PhaseSession.begin`, no un restaurador ni un checkpoint `ready`. Su preflight
siempre queda `blocked`; no cambia ninguna ruta, publicación, workflow o replay.

## Qué falta en Expert y Quick

| Contrato actual | Avance existente | Bloqueo pendiente |
| --- | --- | --- |
| Expert 1 | Orquestador y resultados legacy | Sin PhaseSession; resultados/artefactos y replay no importables por este cotejo. |
| Expert 2–5 | PhaseSession por fase/asiento/canal, CAS y exportación offline | Cursor de contexto no equivale a cursor de procedimiento ni resultados de una ronda publicada. |
| Expert instrucción/cotejo/revisión | Turnos, propuestas y progreso local | Conteos no reconstruyen FetchedUrl; fuentes/errores/artefactos requieren resultados completos y procedencia. |
| Expert debate/objeciones/votos/desempates/resumen | TurnSpec y eventos históricos | Faltan dependencias, prefijos completos, resultados por unidad y publicación atómica; no repetir ni inferir turnos. |
| Quick 5 textual sin claims | Ocho resultados cotejables offline y consenso puro sobre prefijo exacto 9/sufijo 11 para el flujo anterior sin resumen | Sin recuperación de asientos parciales, intentos/retries, identificación o desempates. El flujo nuevo con resumen requiere un paso adicional y no está cubierto por ese consenso puro. |
| Quick 1–4, claims, imágenes/enlaces | Orquestador legacy | Sin adaptador probado; Quick no usa PhaseSession. |
| Portada, archivo, traducción/cierre de evidencia | Efectos separados posteriores o dentro de la fase | Cierre de sesión no prueba que estos efectos terminaron; fencing, procedencia y retención sin demostrar. |

`holdSession` y `holdQuickSession` siguen iniciando `log` vacío y numerando desde
1. Expert espera todos los asientos antes de propagar un fallo; no publica la
ronda si uno rechaza. Quick usa `Promise.all`, y tampoco conserva un ledger
recuperable de resultados individuales. No se cambia ese orden para runs viejos.

## Contrato nuevo y comprobaciones

La envoltura `phase_session_cursor_offline_export` v1 contiene una exportación
PhaseSession existente y un record Expert contiguo. La expectativa independiente
aporta modo Expert, expectativa de sesión, hashes del record y de toda la
evidencia, y un ledger completo/ordenado de cada begin: ID, `specJson`, intento
0/1, longitud del prefijo y hash del task exacto. Estos son **pins/claims del
exportador**, no autenticación de un journal o generación.

- Reutiliza el cotejo de origen/generación/revisión/configuración/budgets de
  `verifyPhaseSessionExport`. Rechaza pipelines 1/6 y Quick.
- Exige stamps `seq=1..N`, opening único/modelo coincidente y turnos con offsets
  únicos. Campos nuevos en envolturas/specs, JSON con pérdida de datos, hooks o
  tamaño excesivo bloquean; los payloads de eventos siguen siendo opacos.
  Caps offline: profundidad 32, 100.000 nodos, 8.000.000 caracteres JSON,
  hasta 10.000 eventos y 1.000 entradas de begin; no son límites del proveedor.
- Coteja el ID real de `settled-play`: SHA-256 de
  `JSON.stringify([spec, attempt, ...seqs])`, **no** el hash canónico. Conserva el
  orden original del spec como string; no adivina otro ID ni reordena el task.
- El subconjunto exige records completamente numerados. Un retry legacy que
  recibe eventos provisionales sin seq (ID calculado con ceros) queda fuera;
  no se asignan secuencias para hacerlo pasar ni se migra su replay.
- Cada mensaje user del begin debe contener exactamente el task pinneado y los
  eventos nuevos del prefijo, usando `modelFacingEvents`: elimina sólo originales
  y traducciones audit-only. No reescribe los mensajes ni el record original.
- Para debate exige un único `instruction_closed` anterior al begin y respeta
  su cutoff. El cursor avanza al máximo seq observado, no al número de eventos
  visibles. Prefijos que retroceden, gaps o cursor adelantado/atrasado bloquean.
- La decisión conserva el wrapper exacto task/preparation; no reconstruye el
  draft, índices de crítica, prompts o corpus. Reordenar claves de objetos JSONB
  no altera la comparación estructural del mensaje, ni sus bytes persistidos.
  El texto JSON del begin/wrapper debe conservar la serialización compacta real;
  claves duplicadas que el parser ocultaría se rechazan, incluso con pins nuevos.

El reporte devuelve offsets/seqs/hashes y diagnóstico de turnos existentes.
`nextRecordSeq` es **sólo** la posición estructural de append del record ofrecido,
no el siguiente turno ejecutable. No devuelve body, resultado restaurable,
checkpoint, presupuesto renovado ni decisiones de reutilización. Incluso
`verified-offline` mantiene todos los bloqueos de la exportación anterior.

## Pruebas y límites

```powershell
node --import tsx --test src/court/phase-session-cursor.test.ts
```

Pruebas locales usan `holdSession` y `PhaseSession.begin/finish` reales con CAS
**en memoria**, y barreras/fallos sintéticos. El cotejo se ejecuta con DB, fetch,
reloj y begin/open instrumentados para fallar. Incluye delta entre turnos,
cutoff de debate, stamps/IDs/ledger corruptos, JSONB, privacidad y marcadores
interrumpidos/expirados. No es evidencia PostgreSQL, SDK, journal ni proveedores.
El guard de imports permite composición sólo entre los dos archivos offline
exactos y comprueba que ningún archivo runtime importe ninguno de ellos.
El guard real de publicación rechaza antes de DB un reporte envuelto por un
caller como checkpoint ready: esta unidad no tiene validador productivo.
No se ejecuta ni modifica el fixture PostgreSQL bajo revisión paralela.

Los payloads de eventos siguen siendo JSON opaco: no se demuestra la semántica
del procedimiento, tool-call pairing, resultados completos ni dependencias.
Tampoco procedencia/commit real del record, tiempo de finalización, cobertura de
operaciones, draft auténtico, inactividad histórica, retención o fencing runtime.
No se eliminan blockers por el mero cotejo de bytes/seqs. Rondas parciales y
resultados de otro run no se adoptan; preparación, ejecución, publicación/ready,
recovery y las diez rutas siguen bloqueadas. **El paso 3 no queda completo.**
