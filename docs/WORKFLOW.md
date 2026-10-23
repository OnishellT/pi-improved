# Forma de trabajo

pi-improved existe para una idea: **el modelo barato implementa; el código decide cuándo puede avanzar; el modelo fuerte y la persona entran solo donde aportan.** Este documento describe el flujo completo que se espera en un proyecto, de la primera sesión al deploy, y qué parte de ese flujo cubre hoy el paquete.

Regla transversal: todo lo que hace pi-improved es **agnóstico de lenguaje y framework**. El paquete no trae gates para un stack concreto; los comandos de verificación salen del propio proyecto y se guardan en `.pi/workflow.json`. Lo que el código comprueba por su cuenta lo hace sobre texto plano (nombres, archivos, diffs), nunca parseando un lenguaje.

## El flujo de un vistazo

| # | Etapa | Quién | Con qué | En pi-improved |
|---|-------|-------|---------|----------------|
| 1 | Setup inicial: docs, skills, reglas | Orquestador (modelo `setup`) + persona | `/setup`, skills de setup, agentlint | Cubierto |
| 2 | Planificación | Orquestador (modelo `implement`) + chequeo del modelo `review` | `/task`, `task_plan`, nombres verificados, plan check | Cubierto |
| 3 | Implementación con contexto específico | Modelo `implement` | Plan aprobado, skill tdd, pausas automáticas | Cubierto en la sesión; pendiente como subagente aislado |
| 4 | Verificación real en el entorno esperado | Código (`verify`) | Herramientas del setup: `verify-app` (navegador / CLI / API / TUI) + compilador, linter, tests | Cubierto |
| 5 | agentlint | Código (`verify`) | Reglas de `.agentlint/config.ts` | Cubierto |
| 6 | Corrección de errores | Orquestador; a la tercera, modelo `escalate` | Gate de verify, skill diagnosing-bugs, revisión del diff | Cubierto |
| 7 | Creación de la PR con verificaciones estáticas | Orquestador | Skills y herramientas del setup | Pendiente |
| 8 | Revisión de la PR en CI | CI del proyecto | Linters, tests, agentlint en CI | Fuera del paquete |
| 9 | Deploy | CI/CD del proyecto | Pipeline del proyecto | Fuera del paquete |
| 10 | Verificación manual | Persona | Entorno desplegado | Fuera del paquete |

"Cubierto" significa que el código del paquete lo ejecuta y lo bloquea cuando falla. "Pendiente" es la siguiente pieza a construir. "Fuera del paquete" es trabajo del proyecto y de la persona que pi-improved prepara, pero no ejecuta.

## 1. Setup inicial: el orquestador crea documentos, skills y reglas

Se hace una vez por repositorio, con el modelo más fuerte que haya (`models.setup`). Su salida es el contexto que después consumen los modelos baratos, así que aquí no se ahorra.

Qué pasa en `/setup`:

1. **Escaneo en código, sin modelo.** Stack, gestor de paquetes, CI, docs existentes, comandos de verificación candidatos, conectores (Jira, Linear) por el remote de git y las claves de tickets en los commits.
2. **Entrevista.** El modelo sigue la skill `grilling`: una pregunta cada vez con `ask_user`, opciones con la recomendada primero, nada que el código ya responda. Máximo unas 12 preguntas.
3. **Documentos.** `GLOSSARY.md`, `AGENTS.md` (máximo 150 líneas: propósito, stack, comandos, mapa, convenciones, reglas MUST/NEVER), `docs/adr/` con las decisiones que el código muestra o la persona confirmó, y una skill `.pi/skills/domain-<área>/SKILL.md` por área de negocio.
4. **Skill de verificación de la app.** Siguiendo `pstack-create-verification-skill`, el modelo escribe `.pi/skills/verify-app/SKILL.md` con un script ejecutable cuando la app se puede manejar sin persona: navegador headless para una web, el binario para una CLI, llamadas para una API, el terminal para una TUI. Las evidencias quedan en `.pi/evidence/`. Esta skill es la herramienta con la que la etapa 4 comprueba la funcionalidad de verdad, no solo los tests.
5. **Reglas.** Si la persona acepta, se instala agentlint y se convierten en reglas hasta 3 MUST/NEVER de `AGENTS.md`: las que un patrón detecta pero una persona debe juzgar. Autoridad humana por defecto.
6. **`verify`.** El modelo deja la lista de comandos de verificación del proyecto ordenada de más rápida a más lenta (compilador o typechecker, linter, tests, `verify-app`, agentlint) y llama a `setup_finish`, que comprueba en código que los archivos existen y tienen el formato correcto, corre `verify` y pide una sola aprobación.

Resultado: `.pi/workflow.json` con `setup: "done"`, `verify`, `models`, `connectors` y, si aplica, `agentlint`. Se versiona.

## 2. Planificación

`/task <descripción | PAY-142 | ruta/a/spec.md>` arranca una tarea. El orquestador (modelo `implement`) lee el ticket por MCP, los archivos de spec que se nombren, `GLOSSARY.md`, `AGENTS.md`, las skills y ADRs relacionadas, las tareas pasadas parecidas de `.pi/memory/tasks.jsonl`, y el código que va a tocar junto con sus archivos hermanos. No edita nada.

Después llama a `task_plan` con:

- `summary`, `steps`, `files`.
- `decisions`: solo elecciones que ningún documento resuelve, con 2 a 4 opciones. Las que el código no puede resolver se preguntan a la persona y se guardan como ADR.
- `interface`: archivo, exports y firmas que los tests van a importar, citando la fuente (ticket, doc o archivo existente).
- `seams`: puntos de prueba según la skill `tdd`; cada criterio de aceptación del ticket, incluidos los de entrada inválida, debe tener uno.

Dos comprobaciones corren antes de pedir aprobación:

- **Nombres verificados** (`src/contract.ts`). Cada nombre de `interface` debe aparecer literalmente, como palabra, en la fuente que cita; un archivo nuevo debe tener todas las palabras de su nombre en esa fuente. Lo que no aparece cuenta como inventado y se pregunta. Es texto plano: sirve en cualquier lenguaje.
- **Chequeo del plan** (`src/plan-check.ts`). Un hijo de solo lectura con el modelo `review` (o `setup`) lee ticket, interfaz y archivos hermanos y devuelve `VERDICT: OK` o una lista de arreglos: nombres que no siguen la convención de la carpeta, forma de argumentos distinta a la del ticket, helpers existentes que se están duplicando, entradas inválidas sin cubrir. Una vez por tarea. Si pide arreglos, el orquestador corrige el plan y vuelve a llamar a `task_plan`. `"review": { "plan": false }` lo apaga.

La persona aprueba el plan una vez. `.pi/task.json` pasa a `implementing`.

## 3. Implementación con contexto específico

La forma esperada es que **implemente un agente que recibe solo lo que necesita**: el plan aprobado, la interfaz, los seams, las ADRs que tocan y las skills de la fase. Nada de la conversación de planificación, nada de otras tareas. Cuanto menos contexto arrastra el modelo barato, mejor sigue el plan.

Hoy la implementación corre en la misma sesión de pi con el modelo `implement`, con la skill `tdd` inyectada y el plan como contrato. Los subagentes que ya existen son los de solo lectura (chequeo del plan y revisión del diff). Mover la implementación a un subagente con el contexto recortado es el siguiente paso de esta etapa; lo que la rodea (gates, pausas, verificación) ya está hecho y no cambia.

Mientras implementa, el código pausa y pregunta cuando el agente:

- toca archivos fuera de `files` del plan;
- añade dependencias, por comando o editando `package.json`, `pyproject.toml`, `go.mod`, etc.;
- crea migraciones o cambia esquemas.

Si el agente escribe una pregunta en texto plano en vez de usar `ask_user`, un empujón se lo recuerda.

## 4. Verificación real en el entorno esperado

Cuando el agente da la tarea por terminada, el código no le cree. En `agent_before_settle`:

1. **Contrato de interfaz.** Cada export del plan debe aparecer en su archivo. Si falta, vuelve al agente sin gastar tiempo de verify ni dinero de revisión.
2. **`verify`.** Se ejecutan en orden los comandos de `.pi/workflow.json`: primero los rápidos (compilador, typechecker, linter), después los tests, después `verify-app`, que ejercita la funcionalidad en el entorno real con las herramientas que el setup dejó: abrir la pantalla en el navegador headless, correr el comando de la CLI, llamar al endpoint, recorrer la TUI. Las evidencias quedan en `.pi/evidence/`.

El agente no puede cerrar la tarea con `verify` en rojo. Los comandos vienen del proyecto, no del paquete: el mismo flujo sirve para TypeScript, Python, Go o lo que haya.

## 5. agentlint

`agentlint check --all` es un paso más de `verify`. Comprueba las reglas MUST/NEVER que el setup convirtió en código. Si una regla falla:

- el agente tiene un intento para corregir el código;
- si vuelve a fallar, la persona decide: corregir o registrar la excepción. La excepción se aprueba con `agentlint approve` y actor humano, porque pi no tiene TTY y puede estar corriendo dentro de otro agente.

Los comandos de agentlint que abren su interfaz interactiva están bloqueados: se quedarían esperando a alguien.

## 6. Corrección de errores

El informe de `verify` vuelve al orquestador con instrucciones, y la presión sube con cada fallo:

| Fallo | Qué pasa |
|-------|----------|
| 1.º | "Arréglalo y termina." |
| 2.º | Se inyecta la skill `diagnosing-bugs`: reproducir, aislar, hipótesis, y solo entonces tocar código. |
| 3.º | Se cambia al modelo `escalate` (o `review`, o `setup`) para ese intento. |
| Más | La persona decide: seguir o dejarlo. |

Cuando `verify` pasa y el diff es arriesgado (grande, dependencias nuevas, migraciones, rutas sensibles, decisiones nuevas), un hijo de solo lectura con el modelo `review` revisa el diff contra el plan, las ADRs y `AGENTS.md` siguiendo `pstack-blast-radius`. Una ronda: si pide cambios, el modelo barato los hace y los comprueba `verify`, no otra revisión pagada. Un diff pequeño y sin zonas sensibles no paga revisión.

Al confirmar la persona que la tarea terminó, se guarda una ficha en `.pi/memory/tasks.jsonl`; cada 5 tareas corre una retro con la skill `retro` y se revisa la skill de verificación con `pstack-maintain-verification-skill`.

## 7. Creación de la PR con verificaciones estáticas

Pendiente. Lo esperado: al cerrar la tarea, el orquestador prepara la rama y la PR usando las herramientas que el setup identificó (CLI del hosting, plantilla de PR del repo) y adjunta el resultado de las verificaciones estáticas: comandos de `verify`, hallazgos de agentlint, resumen del plan y de las ADRs nuevas. La PR lleva la evidencia de `verify-app` cuando existe. Nada se pushea sin orden de la persona.

## 8. Revisión de la PR en CI

Fuera del paquete, pero el setup lo prepara: los mismos comandos de `verify` deben correr en el CI del proyecto, agentlint incluido. Lo que pasa en local tiene que pasar en CI con la misma lista; si divergen, el setup o la retro lo corrigen.

## 9. Deploy

Fuera del paquete. Lo hace el pipeline del proyecto cuando la PR se aprueba.

## 10. Verificación manual

Fuera del paquete y a propósito. La última palabra sobre la funcionalidad la tiene una persona en el entorno desplegado. `verify-app` y las evidencias de `.pi/evidence/` existen para que esa comprobación sea corta y dirigida, no para sustituirla.

## Cómo funciona por dentro

**Estado.** `.pi/workflow.json` es el estado del proyecto (versionado): setup, `verify`, `models`, `skills`, `connectors`, `review`, `agentlint`. `.pi/task.json` es la tarea activa (local, en `.gitignore`): `status` (`planning` | `implementing` | `done`), `plan`, `spec`, `planChecks`, `allowedExtra`.

**Modelos por fase.** `/models` fija `setup`, `implement`, `review` y `escalate` como `provider/model`. La fase que falta usa el modelo de la sesión. El modelo fuerte se usa una vez en setup, en el chequeo del plan, en la revisión del diff cuando hay riesgo y en el tercer intento de corrección; el resto es el modelo barato.

**Skills por fase.** Las skills viven en `vendor/skills/` y se inyectan en el prompt de cada fase (`/skills` las cambia): setup = grilling, domain-modeling, technical-writing, create-verification-skill; plan e implementación = tdd; diagnóstico = diagnosing-bugs; revisión = blast-radius; aprendizaje = retro, maintain-verification-skill. El modelo nunca elige una skill.

**Gates.** Todo lo que bloquea se hace en código, en eventos de pi: `agent_before_settle` (contrato, verify, revisión, cierre), `tool_result` (conteo de escrituras, texto de MCP como evidencia del ticket) y `tool_call` (archivos fuera del plan, dependencias, migraciones, comandos interactivos de agentlint). Las herramientas `setup_finish` y `task_plan` solo son visibles en su fase.

**Subagentes.** Los hijos se lanzan con pi-subagent en tmux, en solo lectura (`read,grep,find,ls`), con un brief en archivo y un tiempo máximo. Dentro de un hijo (`PI_SUBAGENT_RUN_DIR`) la extensión no registra nada. Su coste se registra en la telemetría de la tarea.

**Portabilidad.** `pi install git:github.com/OnishellT/pi-improved` basta; pi-subagent y agentlint vienen incluidos. Requisitos del sistema que no se pueden empaquetar: Node >= 22.18, git, tmux. `/doctor` los comprueba.

## Pendiente

1. **Subagente implementador** con contexto recortado (etapa 3).
2. **Creación de la PR** con las verificaciones estáticas adjuntas (etapa 7).
3. **Evaluación con más tareas** y una variante con pista de interfaz para medir la calidad con el flujo completo.
