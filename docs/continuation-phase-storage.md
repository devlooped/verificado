# PhaseSession: retención durable bloqueada y fencing

Este bloque implementa SQL real, no sólo otro diagnóstico: tabla aditiva
`case_continuation_phase_states`, `retainContinuationPhaseSnapshot` y
`loadContinuationPhaseSnapshot`. No se ejecutó una migración externa ni el fixture
PostgreSQL bajo revisión; la tabla se crea por el bootstrap existente de `db()`.

El estado almacenado **siempre es blocked**. Las funciones no implementan
PhaseRepository y devuelven `snapshot`, no `body` restaurable por PhaseSession.
`savePhaseCheckpoint(..., writer)` conserva el bloqueo antes de DB. No se conectan
workflows/rutas ni se ejecutan providers, preparación, turnos o publicación ready.

## Persistencia y fencing

- Identidad explícita: caso/generación/run/deployment/pipeline 2–5 y clave
  fase/asiento/canal. Cuerpo completo y hash canónico, revisión CAS y FK a la
  generación; tabla separada de los namespaces legacy y del consenso Quick.
- Escritor obligatorio y capturado antes de await. Case lock primero y control
  de generación activa/run reconciliado/status/cancelación, luego fila de fase.
  Lecturas también verifican fencing; nunca usan fallback legacy.
- El prefijo se lee de `events` dentro de la misma transacción y se coteja completo
  (seq, hashes y mensajes del begin), no por conteos de fuentes. Cursor/delta y
  cutoff de debate deben corresponder al record comprometido.
- CAS, snapshot y auditoría se escriben atómicamente. Una repetición byte-equivalente
  de la revisión esperada tras respuesta de COMMIT perdida devuelve la revisión
  durable, sin nueva auditoría ni nueva sesión. Colisiones o corrupción bloquean.
  Lecturas y retries también cotejan la auditoría durable; no se reparan registros
  faltantes/corruptos. Las columnas de eventos no se normalizan sobre un body
  contradictorio para hacerlo pasar.
- Historial de mensajes/resultados/events append-only; configuración, bindings,
  identidad y deadlines de turnos existentes inmutables. No se renuevan budgets,
  eliminan turnos, alteran turnos completos ni abandonan turnos incompletos.
  Un turno nuevo debe tener un begin anexado después del historial anterior;
  no puede reutilizar mensajes viejos como marco de otro presupuesto.
  Marcadores de efectos pendientes no se limpian por flags o expiración.
- Los audit records contienen hashes/identidades/revisión, no prompts privados.

`loadPhaseCheckpoint` legacy sigue siendo lectura sin mutación, incluso tras
fallo del caso. Su rama generacional ahora usa case lock/fencing. Una clave
`generation:` sin escritor o anidada se rechaza; las claves de PhaseSession
legacy reales no cambian. Sus firmas, pasos, reloj y orden de replay no se editan.

## Verificación y límites

```powershell
node --import tsx --test src/store-continuation-phase.test.ts
```

Los tests llaman al store real con un **doble SQL transaccional** y PhaseSession
en memoria. Cubren CAS/carreras, generación/cancelación delante de un escritor
en espera, rollback/audit collision, respuesta COMMIT perdida, corrupción,
ausencia de writer, replay legacy, budgets y marcadores pendientes. **No son
evidencia de locks PostgreSQL** ni efectos/SDK/control plane reales.

Retener un cuerpo de sesión no autentica su origen, resultado, draft, operaciones,
turnos completados ni tiempo de finalización. Los payloads AI/eventos siguen
siendo opacos; no se verifica semántica de procedimiento, pairing de tools,
artefactos, retención externa o inactividad histórica. Un cierre/flag/hash no
autoriza ejecutar otra llamada. El protocolo exige escritores que respeten el
case lock; no protege contra SQL ajeno a ese contrato.

No se importa una sesión legacy a una nueva ejecución ni se restaura PhaseSession
desde este almacenamiento. Quick no usa PhaseSession. El wiring requiere pruebas
de precondiciones y publicación atómica de efectos/resultados aún ausentes;
continuación, ready/publicación y diez rutas siguen deshabilitadas. Pasos 2/3 y
el plan permanecen incompletos; no se editaron plan/notas ni scratchpad del padre.
