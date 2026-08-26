# 0002 — Адаптація панелі під Pi та oh-my-pi (dual-platform)

## Контекст

Плагін зараз — OpenCode-only (`@opencode-ai/plugin` `PluginModule{ id, server }`, події `message.*`/`todo.updated`/`session.*`). Pi (`@earendil-works/pi-coding-agent` `ExtensionAPI`) має іншу модель: `export default function(pi){ pi.on(...); pi.registerTool(); pi.registerCommand() }`, події `turn_*`/`message_*`/`tool_call`/`tool_result`/`agent_*`, відсутні `todo.updated`/`subtask` як core-примітиви.

`oh-my-pi` (`oh-my-pi@0.2.0`, `pi.extensions: ["./dist/extension.js"]`) — enhancement-фреймворк над Pi: додає оркестрацію через два інструменти-делегатори `oh_my_pi_delegate_task(category, task)` і `oh_my_pi_subagent(agent, task)` + категорії (`quick/deep/ultrabrain/...`). З т.з. flow-панелі це аналог `task` в OpenCode — точка розгалуження в sub-agent.

Вимога: один репозиторій/кодбаза працює на **OpenCode і на Pi з/без oh-my-pi**.

## Рішення

**Shared core + два тонкі адаптери.** 60% коду portable і залишається shared:

* `src/flow/types.ts` — домен (StepType/State, FlowTree, UnitOfWork) — без змін.
* `src/flow/render.ts` — рендер text/html — без змін.
* `src/server/panel-server.ts` — `http`+SSE (`/, /data, /events`) — без змін.

Платформо-специфічне ізолюється в адаптерах:

```
src/
  flow/            # shared core (types, render, panel-server)
  adapters/
    opencode/      # OpenCode: reducer.ts, session-tracker.ts, binding.ts
    pi/            # Pi: pi-reducer.ts, pi-session.ts, extension.ts
  server.ts        # re-export OpenCode адаптера (зворотна сумісність)
  extension.ts     # re-export Pi адаптера (entry для Pi)
```

**OpenCode-адаптер** — існуюча логіка без змін: `FlowStore` на `Event{ message.updated, message.part.updated(delta), todo.updated, session.idle, session.created }`, `SessionTracker` на `parentID`.

**Pi-адаптер** — нова реалізація `PiFlowStore`:

* `before_agent_start` → `UserRequest` + відкриття `UnitOfWork`
* `turn_start` → `ModelCall`/`ModelReply` (running)
* `message_update` (assistant streaming) → доповнення `ModelReply.content/reasoning`
* `tool_call` → `ToolCall` (pending→running); `tool_result`/`tool_execution_end` → `ToolResult`/`completed|failed`
* `oh_my_pi_delegate_task` / `oh_my_pi_subagent` → `ToolCall{subtask:true}` (аналог `tool==="task"` в OpenCode), з `SessionTracker`-подібною склейкою якщо oh-my-pi форкає сесію (`session_start{reason:"fork"}` + `previousSessionFile`)
* `turn_end` → `completed` для ModelCall/Reply
* `agent_end` / `agent_settled` → закриття Unit + `Answer` вузол
* `todo.updated` відсутній у Pi → `Plan` лишається порожнім (можливе майбутнє: слухати кастомний `oh_my_pi` todo-tool або файл `.oh-my-pi/boulder-state` — не в scope MVP)

**Дистрибуція:**

* OpenCode: `opencode.json` → `plugin: ["file:///…/dist/server.js"]`, `exports["./server"]` (esbuild bundle).
* Pi / oh-my-pi: `pi install` з npm або `.pi/extensions/flow-panel/index.ts` (jiti, без бандлу) або `package.json: { pi:{ extensions:["./dist/extension.js"] } }`. Оскільки oh-my-pi вже займає `pi.extensions`, flow-панель ставиться **поряд** — Pi завантажує всі `pi.extensions` з усіх встановлених пакетів, конфлікту немає.

## Альтернативи

* Форк репозиторію під Pi — відхилено: дублювання 60% коду, розбіжність.
* Уніфікований `Event` union з `if (platform)` — відхилено: тече абстракція, типи SDK несумісні (`@opencode-ai/sdk` vs `@earendil-works/pi-coding-agent`).

## Наслідки

* Один `npm run build` збирає **два бандли**: `dist/server.js` (OpenCode) і `dist/extension.js` (Pi).
* Тести дублюються: `src/adapters/opencode/*.test.ts` і `src/adapters/pi/*.test.ts` на спільних фікстурах.
* oh-my-pi сумісність — без додаткових залежностей: достатньо матчити імена інструментів `oh_my_pi_delegate_task`/`oh_my_pi_subagent` як subtask.
