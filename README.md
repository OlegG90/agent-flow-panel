# Agent Flow Panel

OpenCode plugin that visualizes an agent's work as a live flowchart panel in the browser: step tree on the left, full details of a selected step on the right.

## Встановлення

1. Скопіювати репозиторій і встановити залежності:

   ```sh
   npm install
   ```

2. Зібрати плагін у самодостатній бандл:

   ```sh
   npm run build
   ```

   Результат — `dist/server.js`.

3. Підключити плагін в OpenCode. Локально в проєкті (`opencode.json`):

   ```json
   {
     "plugin": ["./src/server.ts"]
   }
   ```

   Або глобально для всіх проєктів (`~/.config/opencode/opencode.jsonc`), вказавши абсолютний шлях до зібраного бандла:

   ```jsonc
   {
     "plugin": ["file:///C:/шлях/до/проєкту/dist/server.js"]
   }
   ```

4. Перезапустити OpenCode. Плагін надає інструменти `flow_panel` (відкрити панель з нуля), `flow_open` (відкрити панель із збереженням поточного виду) та `flow_tree` (показати дерево кроків текстом).

## Розробка

- `npm test` — тести (Node test runner)
- `npm run typecheck` — перевірка типів
- `npm run lint` — ESLint
- `npm run panel:fixture` — згенерувати статичне превʼю панелі з фікстури у браузері