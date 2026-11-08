# PostgreSQL real: fixture generacional efímera y dedicada

```powershell
node --import tsx scripts/test-local-generational-operations.ts --run --context desktop-linux --image postgres:17-alpine
```

Requiere Node/dependencias ya instalados, Docker local Linux accesible y la imagen
PostgreSQL ya presente y de confianza; el ID fija el contenido local pero no autentica
su procedencia. **No instala, construye ni hace pull**. Sin `--run`, sin
contexto explícito o con un endpoint remoto, bloquea antes de crear recursos.
El tag debe ser `postgres:<tag>` y se fija al ID completo de la imagen instalada.
No admite URL, puerto, usuario o base externos por CLI. Un worker directo sin
el canal IPC del runner también se bloquea.

## Por qué no se ejecuta el fixture compartido anterior

`scripts/test-local-continuation.ts` carga `@next/env` y utiliza la base fija de
`src/lib/local-database.ts` (`grokeado_local_fixture`, puerto 5432). Eso no acredita
dedicación a esta ejecución. Además sus claims generacionales hash-only son
anteriores al contrato de entrada completa. No se ejecuta ni se modifica aquí.
La evidencia previa de operaciones/predecesores usa mocks y no demuestra locks
PostgreSQL; esta prueba nueva es una verificación separada, no su reinterpretación.

## Protección y ownership

- Comprueba un endpoint Docker local named pipe/socket y servidor Linux. Lee sólo
  metadata; nunca conecta al PostgreSQL existente ni lee `.env*`.
- Crea una red bridge privada **dedicada**, NAT IPv4, sin IPv6 y con ICC desactivado,
  y un contenedor con UUID/label de ejecución usando el ID de imagen local.
  Verifica que no haya otros contenedores en esa red y que la dirección del nuevo
  sea RFC1918. Publica únicamente `127.0.0.1:<puerto dinámico>:5432`.
- Rootfs readonly, sin privilegios, sin binds/volúmenes; datos, socket y temporales
  sólo en tmpfs. No reutiliza nombres, datos, usuarios ni credenciales existentes.
- Usuario/base/password temporales se generan en memoria. El password se entrega
  al CLI Docker por entorno del subproceso, no argv/archivo/log. Un child con
  entorno mínimo recibe la configuración por IPC; sólo allí se define su propio
  `DATABASE_URL`, antes del primer import del store. El proceso padre conserva
  sus variables. No se usan fallbacks de la app ni `@next/env`.
- Revalida ID/label/imagen, estado/fecha, mounts, network y bindings antes de
  conectar; coteja base/usuario/dirección/puerto del servidor y exige cero tablas
  públicas. Crea un marker de ejecución y lo verifica al terminar.
- El intervalo de inicio se mide con `SystemTime` del mismo daemon Docker antes
  de crear y después de inspeccionar, sin mezclar el reloj del host y la VM.
  Timestamps inválidos, stale, futuros o un reloj que retrocedió bloquean.
  ID/UUID/label/imagen y todos los controles de aislamiento siguen siendo obligatorios.
- Todas las conexiones PostgreSQL son reales. En el worker, el guard de
  `Socket.connect` deja pasar sólo el loopback/puerto creado y el guard de
  `fetch` rechaza llamadas. El contador cubre sólo esos dos puntos: no monitorea
  UDP, procesos hijos, mecanismos nativos ni conexiones del contenedor. No hay
  mocks de Pool, SQL, COMMIT, locks ni respuestas del store.
- No se muestran Config.Env, URLs, passwords, usuarios temporales ni errores
  arbitrarios. Fallos reportan únicamente fase/SQLSTATE; stderr del worker no se
  reenvía. Sin secretos de proveedores ni llamadas a servicios reales.

## Qué se verifica

1. Un trigger **sólo de fixture** bloquea el INSERT del store con un advisory
   lock. `pg_blocking_pids` demuestra que espera al backend de control. Otra
   conexión hace `FOR UPDATE NOWAIT` sobre el caso y recibe SQLSTATE `55P03`:
   el store real ya mantiene su case lock. Antes del COMMIT no se ven intención,
   owner ni auditoría. Ocho claims simultáneos dan un owner y una auditoría,
   manteniendo los bytes canónicos aunque el caller mutase su objeto.
2. Triggers de fallo en UPDATE de ownership y en INSERT de auditoría producen
   rollback completo de intención/owner/audit. Se vuelve a reclamar tras quitar
   el fallo, únicamente en este caso sintético sin efectos.
3. Una colisión real de `ON CONFLICT` en auditoría revierte el paso a uncertain
   y conserva el owner/filas anteriores.
4. Expiry y respuesta perdida pasan a uncertain; ocho reintentos no hacen
   takeover. `ready`, defer y recovery siguen rechazados.
5. Predecesores con claves/writers mutilados, columnas incompatibles, estado o
   hash inválido, namespaces no canónicos y legacy reservado bloquean incluso
   claims aparentemente distintos. Incluye carreras y claves anidadas, `%`, `_`,
   comillas, backslashes, saltos de línea y Unicode. Las filas bloqueadas y su
   auditoría no se reparan ni se adoptan.
6. Identidades completas y distintas pueden pasar la comprobación acotada; eso
   **no demuestra independencia semántica de efectos ni procedencia**.
7. Escritores viejos esperan un case lock real; tras COMMIT de cambio de
   generación leen el nuevo estado y quedan fenced. Una cancelación local
   adelantada a escritores pendientes también los bloquea sin nuevas filas.

Los estados de generación/run reconciliado se **siembran de forma sintética en
la base recién creada**; ninguna API pública autoriza continuación, arranque,
efecto ni publicación. No hay importación histórica, Blob/R2/Sandbox, proveedor,
workflow, repair o GC real. No se completa el plan ni se habilitan rutas/flags.

## Limpieza y límites

### Modo same-run retry

```powershell
node --import tsx scripts/test-local-generational-operations.ts --run --context desktop-linux --retry
```

Reutiliza exactamente el runner/worker dedicado y sus guards; después del
bootstrap fresco instala explícitamente el schema aditivo de retry. Comprueba:

1. Creación atómica exclusiva y un único owner del arranque inicial concurrente.
2. Lock real `FOR UPDATE NOWAIT`, cuatro claims y reutilización de resultado completo.
3. Rollback de cuerpo/eventos/cursor/auditoría, colisión, corrupción y respuesta
   perdida **después del COMMIT real**. Sólo la pérdida de respuesta se simula
   con un wrapper de Pool; PostgreSQL/SQL/lock/COMMIT no son dobles.
4. Cursor Quick con una ronda parcial, dos autorizaciones separadas, comandos
   duplicados y fence de escritores tardíos, sin repetir llamadas sintéticas.
5. Checkpoints de fase Expert: cuatro saves concurrentes con un solo CAS,
   restauración de resultados/mensajes/deadline e identidad de `activeTurn`,
   reutilización de turno completo, cambio de intento del mismo run y rechazo
   del escritor previo sin mutación. Respuesta perdida después del COMMIT real
   del resultado: restauración por evidencia durable, sin repetir checkpoint.

Pasó en PostgreSQL 17.11, `read committed`, cinco checks, cero intentos externos
y cleanup confirmado. El World/hook es simulado en este modo; el SDK real se
prueba separadamente. No verifica los subefectos reales de PhaseSession,
objetos, servicios remotos ni
una ruta habilitable; tampoco cuenta como prueba de retención o cargos únicos.

El runner usa `finally`: revalida ownership del ID que devolvió cada create,
elimina únicamente su contenedor y comprueba su ausencia; elimina su red sólo
si queda vacía y coincide su label/ID. No usa prune, rm por patrón, volúmenes,
DROP DATABASE ni limpieza de casos ajenos. La salida indica limpieza verificada.
El worker desechable termina tras cerrar su pool de control y todas las promesas;
su salida cierra el pool privado del store, sin añadir hooks al runtime.
En timeout/error se exige su salida antes de liberar el puerto; si no se puede
acreditar, se bloquea cleanup de recursos y se informa, en vez de permitir que
un worker tardío reconecte a un puerto reutilizado por otro servicio.

Si una creación pierde su respuesta antes de devolver un ID, o se termina el
runner abruptamente fuera de `finally`, puede quedar un recurso de ejecución
sin cleanup acreditado. No se adopta ni borra por nombre una creación incierta:
se debe informar y dejar revisión manual, nunca tocar recursos existentes.
En esa ventana la salida dice cleanup incompleto, nunca limpieza verificada.
Un recurso cuya identidad cambie o una red con otros contenedores no se borra.

La evidencia de éxito sólo vale para la versión PostgreSQL y `read committed`
reportados, con escritores que respetan el case lock. No prueba otras versiones,
aislamientos, writes fuera del contrato, SDK/control plane, cargos únicos,
retención ni inactividad histórica. Una corrida fallida no acredita el protocolo.
Los tests de `src/local-generational-fixture.test.ts` son validaciones **offline**
de los guards; no cuentan como pruebas PostgreSQL.

La bridge privada no es un air-gap ni una garantía contra un administrador Docker
hostil; el contenedor puede tener salida a red. Los guards acotados del worker
no son un firewall ni prueban ausencia universal de tráfico externo. El fixture
revisado sólo envía SQL sintético y no invoca SDK/proveedores. El primer
intento con red `internal` fue rechazado por ausencia del binding de puerto en
Docker local, antes del import del store, y sus recursos fueron limpiados. No se
cuenta como evidencia del protocolo ni se relajó la exigencia de binding loopback.
También se corrigió la representación de dirección en el fixture a
`host(inet_server_addr())`: el cast textual de inet puede incluir máscara, y no
es el formato de IP que expone Docker. La dirección exacta sigue cotejándose;
los intentos rechazados antes del store no cuentan como pruebas de sus carreras.
