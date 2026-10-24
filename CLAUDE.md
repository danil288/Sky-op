# CoopBridge: карта проекта

Этот файл нужен, чтобы не перечитывать весь код. Сначала смотри здесь, потом открывай только нужный файл.
Подробности для пользователя (установка, запуск) в `README.md`; здесь только то, что нужно для работы с кодом.

## Что это

Кооператив для Skyrim (SSE/AE, версия игры у пользователя 1.7.104.0). Три части:

1. **Плагин SKSE** (`plugin/`, C++23, CommonLibSSE-NG) читает данные NPC в игре и меняет их по командам.
2. **Сервер** (`server/`, Node.js 20+, TypeScript, без внешних зависимостей) принимает данные плагина, хранит мир, отдаёт веб-панель и раздаёт данные другим игрокам.
3. **Веб-панель** (`server/ui/index.html`, один файл, чистый JS) список всех NPC, карточка выбранного, редактирование, сеть.

Версии: плагин 0.4.0, протокол плагин↔сервер 4, сервер 0.6.0, протокол комнаты (hub) 2. Меняешь формат сообщений: поднимай номер.

## Потоки данных

```
игра ─ Watcher.cpp ─ Net.cpp ──TCP 127.0.0.1:7777──► bridge.ts ─► World (world.ts: NpcStore на каждого NPC)
                  ◄─ cmd: watch/unwatch/world/set ──┘                │
                                                                     ├─► ui.ts: HTTP :8777 + SSE /events ─► браузер (index.html)
                                                                     └─► hub.ts: TCP :7788 ──► чужие viewer.ts ─► remote.ts ─► их панель
```

- Плагин шлёт `state` (только изменившиеся разделы одного актёра) и `gone`. Сервер копит это в `NpcStore`, считает журнал изменений и рассылает панелям (`ui.broadcast`) и игрокам (`hub.broadcast`) одним вызовом `emitEvent` в `index.ts`.
- Роли: **off** (один компьютер), **host** (админ раздаёт комнату), **viewer** (игрок видит мир админа: `isViewer()` в `index.ts`).
  В режиме viewer своя игра не читается (плагину отправляются `world 0` и `unwatch`, при выходе из комнаты возвращаются), выбор NPC, слежение и управление комнатой блокируются.
  Единственное, что игрок может: **правка NPC админа** (`setFieldAsViewer` → `HubClient.command` → комната → `hub.on("command")` у админа → тот же `setField`, что и у админа, с именем автора → ответ `result`). Это разрешает или запрещает админ (`allowEdit`, `netPermissions`, права приходят игроку сообщением `permissions`).
- Игрок сейчас **ничего не меняет в своей игре**: изменения админа видны только в его панели. Это следующий этап («зеркало»).

## Порты и переменные

| Что | Порт | Переменные |
|---|---|---|
| плагин ↔ сервер | 7777 (127.0.0.1) | `BRIDGE_PORT`, `BRIDGE_HOST` |
| веб-панель | 8777 (127.0.0.1) | `BRIDGE_UI_PORT`, `BRIDGE_UI=0`, `BRIDGE_UI_OPEN=0` |
| комната админа (hub) | 7788 (задаётся в панели) | |
| прочее | | `BRIDGE_TRACK_ALL=0`, `BRIDGE_CONSOLE_PANEL=1`; у имитатора `MOCK_HIT_MS`, `MOCK_CHURN_MS` |

## Файлы

### Плагин (`plugin/src/`)

| Файл | Роль | Зависит от Skyrim |
|---|---|---|
| `main.cpp` | точка входа SKSE: конфиг, сетевой клиент, `Watcher::Configure/Start` | да |
| `Watcher.cpp/.h` | список загруженных актёров (`EnumerateActors`), построение разделов (`BuildXxx`), опрос (`Poll`, `PollEntry`), обработчик ударов (`HitSink`), приём команд (`Execute`) | да |
| `Editor.cpp/.h` | применение команды `set` (`EditVital`, `EditAttribute`, `EditPosition`, `Action`, `EditFaction`, `EditInventory`), проверка значений | да |
| `Registry.h` | реестр актёров и планировщик `VisitDue` (очередь с бюджетом времени) | нет |
| `State.h` | `Tracker`: оставляет только изменившиеся разделы и собирает `state` | нет |
| `Json.h` | писатель вложенного JSON (`Writer`) | нет |
| `Protocol.h/.cpp` | разбор команд (`ParseCommand`), `MakeHello`, `MakeResult`, `ParseFormId`, `EscapeJson` | нет |
| `Config.h` | разбор `CoopBridge.ini` (`[Server]`, `[World]`) | нет |
| `Net.cpp/.h` | TCP-клиент в отдельном потоке, переподключение, очередь отправки (Winsock) | нет |
| `Text.cpp/.h` | перевод строк игры в UTF-8 (см. «Известные проблемы») | нет |

Разделы `state` и функции, которые их строят в `Watcher.cpp`: `presence` (`BuildPresence`), `identity`, `vitals`, `attributes`, `position`, `location`,
`state`, `combat`, `package`, `follower`, `factions`, `effects`, `inventory`, `lastHit` (`BuildLastHit`). Быстрые: `BuildFast`
(vitals, position, state, combat, package); медленные: `BuildSlow` (identity, attributes, location, follower, factions, effects, inventory).

### Сервер (`server/src/`)

| Файл | Роль |
|---|---|
| `index.ts` | запуск, консоль, склейка всего: `watchFromText`, `unwatch`, `worldSwitch`, `setField`, `netStart/netStop`, `emitEvent`, `snapshotEvent`, обработчики событий моста |
| `protocol.ts` | формат сообщений плагина (описан в комментарии в начале), `parseClientMessage`, `parseRef`, типы `CommandBody` |
| `bridge.ts` | TCP-сервер для плагина (одно подключение), `send(команда, таймаут)`, события `hello/state/gone/result/disconnected` |
| `world.ts` | `World`: `Map<refID, NpcStore>`, выбранный NPC, `gone`, `reset`, `snapshotData` |
| `npc.ts` | `NpcStore` (разделы, журнал, `applyDetailed`, `render` для консольной панели), `diffSection` (текст журнала по каждому разделу), словари переводов |
| `edit.ts` | `validateSet`: список допустимых полей и диапазонов |
| `text.ts` | `repairMojibake/repairDeep`: исправление дважды перекодированного текста |
| `ui.ts` | HTTP: страница, `/events` (SSE), `/api/*`, ключ, проверка Host/Origin |
| `hub.ts` | комната админа: пароль (HMAC), блокировка перебора, рассылка, пинг, команды игроков (`onCommand`: ограничение частоты, форма, права), `reply`, `setPermissions` |
| `viewer.ts` | подключение игрока к комнате, переподключение, `command()` (отправка правки админу и ожидание ответа), `canEdit` |
| `remote.ts` | `RemoteWorld`: копия мира админа для новых вкладок браузера |
| `net-config.ts` | `parseNetStart`, `listInterfaces` |

`server/tools/mock-plugin.mjs`: имитатор плагина (7 NPC, `world`, `watch`, `set`, `gone`). `server/test/smoke.mjs`: все тесты сервера (один файл).

### Веб-панель (`server/ui/index.html`)

Модель: `A` (Map refID → данные NPC), `S` (выбранный NPC: `bindSelected`), `net`, `tracking`. События: `onEvent` (snapshot/state/gone/log/world/status/net).
Карточки рисуют функции `renderVitals/Position/Ai/Attrs/Factions/Effects/LastHit/Inventory/Log`; какие разделы какую карточку обновляют, задаёт `DEPENDS`.
Редактируемые поля это `input[data-field="группа.часть"]`; запись идёт через `setField` → `/api/set`. Список NPC: `summary`, `renderList`. Сеть: `renderNet`, `applyModeUi`.
Заготовка `{{TOKEN}}` в `<meta>` заменяется сервером на ключ при каждой выдаче страницы.

## Протоколы (кратко, полностью см. `protocol.ts` и `hub.ts`)

**Сервер → плагин** (строка JSON): `watch{ref}`, `unwatch`, `world{value:0|1}`, `set{ref,field,arg?,value?}`.
**Плагин → сервер**: `hello`, `result{id,status,message}` (статусы `watching`, `unwatched`, `tracking`, `untracked`, `applied`, `error`),
`state{ref,seq,sections}`, `gone{ref}`.
**Поля `set`** (источник правды `Editor.h` и `edit.ts`): `vitals.<health|magicka|stamina>.<current|max|base|modPermanent|modTemporary|damage>`,
`attributes.<…>`, `position.<x|y|z|angleZ>`, `action.<kill|resurrect|drawWeapon|sheatheWeapon|stopCombat|startCombat>`,
`faction.<add|rank|remove>`, `inventory.<add|remove|equip|unequip>`. Имя, FormID, baseID, уровень, раса, флаги неубиваемости **не редактируются** (требование пользователя).
**События для панели и игроков**: `snapshot`, `state`, `gone`, `log`, `world`, `status`; только для панели `net`.
**HTTP**: `GET /`, `GET /events`, `GET /api/interfaces`; `POST /api/{watch,unwatch,world,set,net/start,net/stop,net/permissions}` (нужны `Content-Type: application/json` и заголовок `X-CoopBridge-Token`).

## Как проверять

```
cd server && npm install && npm test     # 60 проверок; npm test сам запускает tsc
bash plugin/tests/run.sh                 # 137 проверок (протокол 91, состояние 16, планировщик 30), нужен g++
```

Игровая часть плагина (`Watcher.cpp`, `Editor.cpp`, `main.cpp`) на Linux **не собирается**: её собирает только пользователь на Windows. Всё остальное в плагине тестируется.
Для проверки вызовов библиотеки: `git clone --depth 1 --branch v12.1.0 https://github.com/alandtse/CommonLibSSE-NG.git` и `grep` по `include/RE`.
Сквозные проверки делались так: запустить `dist/index.js` и `tools/mock-plugin.mjs` с разными портами, ходить по HTTP, а страницу гонять в jsdom (ставить `jsdom` вне проекта).

## Типовые задачи: что править

- **Новый раздел данных NPC**: функция `BuildXxx` и добавление в `BuildFast/BuildSlow` в `Watcher.cpp` → разбор и текст журнала в `diffSection` (`npc.ts`) → карточка и `DEPENDS` в `index.html` → строка в `mock-plugin.mjs` (`sectionsOf`).
- **Новое редактируемое поле**: ветка в `Editor.cpp` → допустимость в `edit.ts` (`validateSet`) → поле или кнопка в `index.html` → ветка в `applySet` в `mock-plugin.mjs` → тест в `smoke.mjs`.
- **Новая команда плагину**: `CommandType` и разбор в `Protocol.h/.cpp` (тест в `protocol_test.cpp`) → `Execute` в `Watcher.cpp` → `CommandBody` и статус в `protocol.ts` → обработка в `index.ts` → `mock-plugin.mjs`, заглушка в `net_harness.cpp`.
- **Новое событие для панели**: `emitEvent` в `index.ts` → `RemoteWorld.apply` в `remote.ts` (иначе игроки его не увидят) → `onEvent` в `index.html`.
- **Нагрузка на игру**: `[World]` в `CoopBridge.ini`, константы в начале `Watcher.cpp`.

## Ловушки (уже наступали)

- В файлах плагина, где подключён `Windows.h` (`Watcher.cpp`, `Editor.cpp`), **нельзя `std::min/std::max`**: макросы ломают вызов. Использовать тернарный оператор или `(std::max)(a, b)`.
- `npm start` запускает `dist/index.js`. После обновления файлов **обязательно `npm run build`**, иначе работает старая сборка. После распаковки архива сначала `npm install` (нужны типы Node).
- Строки игры (имена, предметы) приходят **уже в UTF-8**, а `Text.cpp` перекодирует их из cp1251 ещё раз («Свен» → «РЎРІРµРЅ»). Сервер это чинит (`text.ts`), но правильное исправление ещё не сделано: убрать перекодировку в `Text.cpp` (и тогда удалить `repairDeep` в `npc.ts`).
- В CommonLibSSE-NG v12.1.0 нет `SetPlayerTeammate`: флаг «спутник игрока» не реализован.
- Вызовы библиотеки сверялись с заголовками тега `v12.1.0`; пользователь собирает с ним же (`git clone --branch v12.1.0`, см. README).
- Тестовый сокет без `setNoDelay(true)` даёт задержку ~40 мс (алгоритм Нейгла) и делает тесты нестабильными.
- Заголовки HTTP не принимают кириллицу (Node бросает `ERR_INVALID_CHAR`), в тестах значения ключа латинские.
- Имитатор переподключается раз в 2 с: в сквозных проверках после старта ждать 3–4 с.

## Состояние работ

Готово и проверено на тестах и имитаторе: чтение всех загруженных NPC, редактирование, веб-панель, комната админа, игроки видят мир админа и (с разрешения) правят NPC.
Пользователь проверил 5-ю версию с другом на двух компьютерах: серверы подключились друг к другу в обе стороны, данные админа видны игроку в панели.
**Не проверено в игре никем**: перебор `ProcessLists::ForAllActors`, `Editor.cpp` (особенно `SetPosition`/`SetHeading`, надевание предметов), реальная нагрузка, связь по Radmin VPN.

Не реализовано: эффекты (наложить и снять), флаг «спутник игрока», задачи ИИ («идти в точку», «сесть»), «удерживать значение».
Онлайн, остальные этапы: 2) зеркало состояния на компьютерах игроков (одинаковые сохранения и моды, отключение их ИИ, создание NPC, появившихся во время игры),
3) движение с интерполяцией, 4) обратный канал (урон и действия игроков → админ), 5) двойники игроков. refID зависит от порядка загрузки модов.
Окно ввода IP и порта внутри игры не делали: для него нужна ImGui или SkyUI, пока это окно в браузерной панели.

## Известные недочёты

- В консоли для выбранного NPC печатается каждое изменение здоровья и выносливости (регенерация даёт строку каждые 50 мс). Нужно сворачивать мелкие изменения (порог или не чаще раза в секунду); в веб-журнале то же самое.

## Как работать с пользователем

- Отвечать по-русски. Пользователь не программист: объяснять просто, команды для запуска давать готовыми.
- Если он пишет «беседа», «обсуждение» или «код не пиши», код не писать до явной команды.
- Всегда честно отделять проверенное (тесты, имитатор) от непроверенного (игра): игровую часть я у себя не запускал.
- После изменений: прогнать оба набора тестов, при смене формата поднять номер версии, обновить `README.md` и этот файл, собрать архив без `node_modules`, `dist`, `build-tests`.
- Архив собирать так: удалить `server/dist`, `server/node_modules`, `server/package-lock.json`, `plugin/build-tests` и упаковать папку `coop-bridge`.
