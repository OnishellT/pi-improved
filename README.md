# pi-improved

Setup automático de proyectos para Pi, pensado para que modelos baratos trabajen con buen contexto.

## Instalación

```sh
pi install git:github.com/OnishellT/pi-improved
```

No hace falta nada más: el CLI de [pi-subagent](https://github.com/badlogic/pi-subagent) y agentlint vienen incluidos (si ya hay un `subagent` en el PATH, se usa ese). Requiere Node >= 22.18.

Luego, en tu proyecto:

1. `/setup`: prepara el proyecto (Pi también te lo ofrece al abrir uno sin setup).
2. `/models`: elige el modelo de cada fase.
3. `/task <descripción o PAY-142>`: trabaja una tarea.
4. `/doctor`: revisa Node, subagent, agentlint, git y que los modelos de `.pi/workflow.json` estén disponibles (si falta alguno, `/login <provider>`).

Para probar sin instalar: `pi -e ~/projects/pi-improved` (corre antes `npm install`).

## Qué hace `/setup`

1. **Escanea el repo (código, sin modelo):** stack, gestor de paquetes, CI, docs y comandos de verificación. Detecta conectores por el remote de git, las claves de tickets en los commits y las URLs en las docs.
2. **Pregunta lo mínimo:** idioma y qué conectores activar (una confirmación por conector, en solo lectura).
3. **Le da al modelo un solo prompt corto** para explorar el código y preguntarte con `ask_user` (opciones para elegir). Con eso escribe `AGENTS.md`, `.pi/skills/domain-*/SKILL.md` y `docs/adr/`.
4. **agentlint (opcional, proyectos de Node):** si aceptas, el modelo instala [agentlint](https://github.com/aurelienbobenrieth/agentlint) y convierte en reglas las MUST/NEVER de `AGENTS.md` que tú elijas (hasta 3 para empezar). Se adoptan de forma gradual y nunca se aceptan hallazgos en bloque. Después, `agentlint check --all` corre como un paso más de `verify`.
5. **`setup_finish` revisa el resultado en código:** que existan los archivos y que el formato sea correcto. Después corre `verify` y te pide aprobar una sola vez.

Si el modelo se detiene antes de tiempo, un hook lo empuja a seguir (como máximo 2 veces por mensaje). Si `verify` falla 3 veces, decides tú.

## El flujo de cada tarea

1. **`/task <descripción o PAY-142>`**: el agente lee el ticket (si hay Jira o Linear), las skills, las ADRs y las **tareas pasadas parecidas**. Luego propone un plan con `task_plan`.
2. **Decisiones:** si el plan trae una decisión que ninguna doc respalda, el código te la pregunta con opciones y la guarda como ADR en `docs/adr/`. Apruebas el plan una vez.
3. **Pausas automáticas mientras implementa:** archivos fuera del plan, paquetes nuevos (por comando o editando `package.json`, `pyproject.toml`, etc.) y migraciones o esquemas.
4. **Bloqueo con `verify`:** si el agente cambió archivos, no termina hasta que `verify` pase (3 reintentos automáticos y después decides tú). `/verify` lo corre a mano.
5. **Aprender:** al confirmar que la tarea terminó, se guarda una ficha corta en `.pi/memory/tasks.jsonl` (se versiona), que alimenta el paso 1 de tareas futuras.

## Modelos y subagentes

- **`/models`** elige un modelo por fase: `setup` (conviene uno fuerte, se usa una vez), `implement` (el barato del día a día) y `review`. Se guarda en `.pi/workflow.json`.
- **Revisión del diff:** si hay un modelo de `review`, cuando `verify` pasa un hijo de [pi-subagent](https://github.com/badlogic/pi-subagent) con ese modelo y solo lectura revisa el diff contra el plan, las ADRs y `AGENTS.md`. Si pide cambios, vuelven al modelo barato (2 rondas y después decides tú). Si no hay tmux o falla, la revisión se omite y te avisa.
- **Dentro de un hijo** (`PI_SUBAGENT_RUN_DIR`) la extensión no registra nada: nada de ofertas de setup, bloqueos ni preguntas que nadie puede ver.

## Protecciones

- `setup_finish` y `task_plan` solo son visibles en su fase.
- Los comandos de agentlint que abren su interfaz (`review`, `--review`, `--wizard`) se bloquean, porque se quedarían esperando a una persona.
- `agentlint accept` siempre te pide aprobación, aunque la regla permita que decida el agente.

`.pi/task.json` es la tarea activa. Es local, y el setup lo agrega al `.gitignore`.

## Estado

`.pi/workflow.json` (se versiona en git):

```json
{ "version": 1, "setup": "done", "language": "Español", "verify": ["npm run test"], "connectors": [{ "id": "jira", "mcp": { "url": "…" } }] }
```

## Desarrollo

```sh
npm test
```
