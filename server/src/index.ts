import { spawn } from "node:child_process";
import readline from "node:readline";
import { Bridge } from "./bridge.js";
import { validateSet } from "./edit.js";
import { HubServer, type ViewerCommand, type ViewerInfo } from "./hub.js";
import { listInterfaces, parseNetStart } from "./net-config.js";
import type { LogEntry } from "./npc.js";
import { type GoneMessage, type HelloInfo, type StateMessage, parseRef } from "./protocol.js";
import { RemoteWorld } from "./remote.js";
import { type ActionResult, UiServer } from "./ui.js";
import { HubClient, type HubStatus } from "./viewer.js";
import { World } from "./world.js";

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? 7777);
const UI_PORT = Number(process.env.BRIDGE_UI_PORT ?? 8777);
const UI_ENABLED = process.env.BRIDGE_UI !== "0";
const UI_OPEN = process.env.BRIDGE_UI_OPEN !== "0";
// Включать слежение за всеми загруженными NPC при подключении игры (BRIDGE_TRACK_ALL=0 - не включать).
const TRACK_ALL = process.env.BRIDGE_TRACK_ALL !== "0";
// Старая консольная панель выбранного NPC (перерисовка экрана целиком). По умолчанию выключена: она мигает.
const CONSOLE_PANEL = process.env.BRIDGE_CONSOLE_PANEL === "1";
const RENDER_INTERVAL_MS = 150;

for (const [name, value] of [["BRIDGE_PORT", PORT], ["BRIDGE_UI_PORT", UI_PORT]] as const) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    console.error(`Некорректный ${name}: ${process.env[name]}`);
    process.exit(1);
  }
}

const HELP = `
Основной интерфейс - веб-панель в браузере (адрес написан при запуске сервера).
Здесь то же самое командами (refID берите из панели или из консоли игры: нажмите ~ и кликните по NPC):

  world on|off     следить за всеми загруженными NPC (по умолчанию включается при подключении игры)
  list             показать отслеживаемых NPC
  watch <refID>    выбрать NPC: он читается каждый такт, его журнал печатается здесь; вместо refID можно player
  watch off        снять выбор
  set <поле> [значение] [аргумент]
                   изменить параметр выбранного NPC, например:
                     set vitals.health.current 50
                     set inventory.add 3 0003133C        (количество, затем FormID предмета)
                     set action.kill
                   Полный список полей - в README. Удобнее делать это в веб-панели.

Служебные: help, quit
`;

const isTty = process.stdout.isTTY === true;
const useColor = isTty && process.env.NO_COLOR === undefined;

const bridge = new Bridge({ host: HOST, port: PORT });
const world = new World();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

let pluginInfo: HelloInfo | null = null;
let ui: UiServer | null = null;

// ---------- сеть между игроками ----------
// off    - обычная работа на одном компьютере;
// host   - админ: его данные раздаются подключившимся игрокам (hub);
// viewer - игрок: панель показывает мир админа, свои данные из игры и управление отключены.
type NetMode = "off" | "host" | "viewer";
interface NetStatus {
  mode: NetMode;
  state: string;
  message: string;
  address: string;
  name: string;
  viewers: ViewerInfo[];
  /** Админ: разрешил ли игрокам править NPC. Игрок: разрешил ли это ему админ. */
  canEdit: boolean;
}
let net: NetStatus = { mode: "off", state: "off", message: "", address: "", name: "", viewers: [], canEdit: true };
let hub: HubServer | null = null;
let hubClient: HubClient | null = null;
const remote = new RemoteWorld();
const isViewer = (): boolean => net.mode === "viewer";
const VIEWER_BLOCKED: ActionResult = { ok: false, message: "Игрокам недоступно: выбор NPC, слежение и управление комнатой решает админ" };

// ---------- вывод в консоль ----------

function hms(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function println(text: string): void {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  console.log(text);
  rl.prompt(true);
}

let renderTimer: NodeJS.Timeout | null = null;

function redrawPanel(): void {
  renderTimer = null;
  if (isTty) process.stdout.write("\x1b[H\x1b[2J\x1b[3J");
  const store = world.selectedStore();
  process.stdout.write((store ? store.render({ color: useColor }) : "NPC не выбран. Введите: watch <refID>   (help - справка)") + "\n");
  rl.prompt(true);
}

function schedulePanel(): void {
  if (renderTimer === null) renderTimer = setTimeout(redrawPanel, RENDER_INTERVAL_MS);
}

/** Новые записи журнала актёра: во все вкладки браузера, а для выбранного NPC ещё и в консоль. */
function publishLog(ref: string, entries: readonly LogEntry[]): void {
  if (entries.length === 0) return;
  emitEvent({ type: "log", ref, entries: entries.map((e) => ({ t: e.time.getTime(), text: e.text })) });
  if (ref !== world.selected) return;
  if (CONSOLE_PANEL) {
    schedulePanel();
    return;
  }
  for (const e of entries) println(`${hms(e.time)}  ${e.text}`);
}

/** Публичное состояние сети для панели (без паролей). */
function publicNet(): NetStatus {
  return { ...net, viewers: net.viewers.map((v) => ({ ...v })) };
}

function setNet(patch: Partial<NetStatus>): void {
  net = { ...net, ...patch };
  ui?.broadcast({ type: "net", net: publicNet() });
}

/** Событие мира с этого компьютера: во все вкладки браузера и всем подключённым игрокам. В режиме просмотра свой мир не показывается. */
function emitEvent(event: unknown): void {
  if (isViewer()) return;
  ui?.broadcast(event);
  hub?.broadcast(event);
}

function snapshotEvent(): unknown {
  if (isViewer()) return { ...remote.snapshotEvent(), mode: "viewer", readOnly: true, canEdit: net.canEdit, net: publicNet() };
  return { type: "snapshot", gameConnected: bridge.connected, plugin: pluginInfo, ...world.snapshotData(), mode: net.mode === "host" ? "host" : "local", readOnly: false, canEdit: true, net: publicNet() };
}

// ---------- действия (общие для консоли и веб-панели) ----------

async function watchFromText(text: string): Promise<ActionResult> {
  if (isViewer()) return VIEWER_BLOCKED;
  const ref = parseRef(text);
  if (ref === null) return { ok: false, message: `Неверный refID: «${text.trim()}». Нужны до 8 шестнадцатеричных цифр или слово player.` };

  const r = await bridge.send({ cmd: "watch", ref });
  if (r.status !== "watching") {
    const why = r.status === "timeout" ? "нет ответа от игры" : r.message || "не удалось";
    return { ok: false, message: `${ref}: ${why}` };
  }
  world.selected = ref;
  if (CONSOLE_PANEL) redrawPanel();
  return { ok: true, message: `Выбран NPC ${ref}` };
}

async function unwatch(): Promise<ActionResult> {
  if (isViewer()) return VIEWER_BLOCKED;
  const was = world.selected !== null;
  world.selected = null;
  if (renderTimer !== null) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  await bridge.send({ cmd: "unwatch" });
  return { ok: true, message: was ? "Выбор NPC снят" : "NPC и так не выбран" };
}

async function worldSwitch(on: boolean): Promise<ActionResult> {
  if (isViewer()) return VIEWER_BLOCKED;
  const r = await bridge.send({ cmd: "world", value: on ? 1 : 0 });
  if (r.status !== "tracking" && r.status !== "untracked") {
    return { ok: false, message: r.status === "timeout" ? "Игра не ответила" : r.message || "Не удалось переключить слежение" };
  }
  world.tracking = on;
  emitEvent({ type: "world", tracking: on });
  return { ok: true, message: on ? "Слежение за всеми загруженными NPC включено" : "Слежение за всеми выключено" };
}

/** Изменение параметра NPC. ref - из панели; в консоли берётся выбранный. Проверяется здесь и ещё раз в плагине. */
async function setField(refText: unknown, field: unknown, arg: unknown, value: unknown, author?: string): Promise<ActionResult> {
  if (isViewer()) return setFieldAsViewer(refText, field, arg, value);
  const text = typeof refText === "string" ? refText : world.selected;
  const ref = text === null ? null : parseRef(text);
  if (ref === null) return { ok: false, message: "Сначала выберите NPC" };
  if (!bridge.connected) return { ok: false, message: "Игра не подключена" };
  const store = world.get(ref);
  if (store === undefined) return { ok: false, message: `NPC ${ref} не отслеживается (его нет в списке загруженных)` };

  const v = validateSet(field, arg, value);
  if (!v.ok) return { ok: false, message: v.message };

  const r = await bridge.send(
    { cmd: "set", ref, field: v.field, ...(v.arg !== undefined ? { arg: v.arg } : {}), ...(v.value !== undefined ? { value: v.value } : {}) },
    5000,
  );
  if (r.status === "applied") {
    publishLog(ref, [store.note(`Изменено вручную${author ? ` (${author})` : ""}: ${r.message || v.field}`)]);
    return { ok: true, message: r.message || "Применено" };
  }
  return { ok: false, message: r.status === "timeout" ? "Игра не ответила за 5 с" : r.message || "Не удалось" };
}

/** Игрок просит админа изменить NPC: команда уходит по сети, админ проверяет и выполняет её. */
async function setFieldAsViewer(refText: unknown, field: unknown, arg: unknown, value: unknown): Promise<ActionResult> {
  if (hubClient === null || net.state !== "connected") return { ok: false, message: "Нет связи с админом" };
  if (!net.canEdit) return { ok: false, message: "Админ запретил игрокам править NPC" };
  const ref = typeof refText === "string" ? parseRef(refText) : null;
  if (ref === null) return { ok: false, message: "Сначала выберите NPC" };
  if (!remote.has(ref)) return { ok: false, message: `NPC ${ref} нет в списке админа` };

  const v = validateSet(field, arg, value);
  if (!v.ok) return { ok: false, message: v.message };

  const r = await hubClient.command({
    cmd: "set",
    ref,
    field: v.field,
    ...(v.arg !== undefined ? { arg: v.arg } : {}),
    ...(v.value !== undefined ? { value: v.value } : {}),
  });
  return { ok: r.ok, message: r.message || (r.ok ? "Применено" : "Не удалось") };
}

/** Админ: разрешить или запретить игрокам править NPC. */
async function netPermissions(edit: boolean): Promise<ActionResult> {
  if (net.mode !== "host" || hub === null) return { ok: false, message: "Права игроков меняет админ, пока открыта комната" };
  hub.setPermissions({ edit });
  setNet({ canEdit: edit });
  return { ok: true, message: edit ? "Игроки могут править NPC" : "Игроки больше не могут править NPC" };
}

// ---------- сеть: запуск комнаты и подключение ----------

async function netStop(): Promise<ActionResult> {
  const wasMode = net.mode;
  const h = hub;
  const c = hubClient;
  hub = null;
  hubClient = null;
  c?.stop();
  if (h) await h.close();
  remote.reset();
  net = { mode: "off", state: "off", message: "", address: "", name: "", viewers: [], canEdit: true };
  ui?.broadcast(snapshotEvent()); // панель возвращается к данным этого компьютера
  if (wasMode === "viewer" && bridge.connected) {
    // В режиме игрока своя игра не читалась: возвращаем слежение и выбранного NPC.
    void (async () => {
      if (TRACK_ALL) await worldSwitch(true);
      if (world.selected !== null) await watchFromText(world.selected);
    })();
  }
  return { ok: true, message: wasMode === "off" ? "Сеть и так выключена" : "Вы вышли из комнаты" };
}

async function netStart(raw: unknown): Promise<ActionResult> {
  const o = parseNetStart(raw);
  if (!o.ok) return { ok: false, message: o.message };
  await netStop();

  if (o.mode === "host") {
    const server = new HubServer({
      host: o.host,
      port: o.port,
      password: o.password,
      hostName: o.name,
      allowEdit: o.allowEdit,
      snapshot: () => ({ ...(snapshotEvent() as object), net: undefined, mode: undefined, readOnly: undefined, canEdit: undefined }),
    });
    // Команды игроков выполняются теми же проверками, что и свои правки админа.
    server.on("command", (viewer: ViewerInfo, cmd: ViewerCommand) => {
      void (async () => {
        let r: ActionResult;
        try {
          r = await setField(cmd.body.ref, cmd.body.field, cmd.body.arg, cmd.body.value, viewer.name);
        } catch {
          r = { ok: false, message: "внутренняя ошибка на стороне админа" };
        }
        server.reply(viewer.id, cmd.id, r.ok, r.message);
        println(`[${viewer.name}] ${r.ok ? r.message : `отказ: ${r.message}`}`);
      })();
    });
    server.on("viewers", (list: ViewerInfo[], info: { joined?: ViewerInfo; left?: ViewerInfo }) => {
      setNet({ viewers: list, message: `Комната открыта на ${o.host}:${o.port}, игроков: ${list.length}` });
      if (info.joined) println(`[+] игрок «${info.joined.name}» подключился (${info.joined.address})`);
      if (info.left) println(`[-] игрок «${info.left.name}» вышел`);
    });
    try {
      const port = await server.listen();
      hub = server;
      setNet({ mode: "host", state: "listening", address: `${o.host}:${port}`, name: o.name, viewers: [], canEdit: o.allowEdit, message: `Комната открыта на ${o.host}:${port}, игроков: 0` });
      ui?.broadcast(snapshotEvent());
      println(`[ok] комната открыта: ${o.host}:${port}`);
      return { ok: true, message: `Комната открыта на ${o.host}:${port}. Сообщите игрокам этот адрес, порт и пароль.` };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const why =
        e.code === "EADDRINUSE" ? `порт ${o.port} уже занят` : e.code === "EADDRNOTAVAIL" ? `адрес ${o.host} не принадлежит этому компьютеру` : e.code === "EACCES" ? "нет прав слушать этот порт" : e.message;
      return { ok: false, message: `Не удалось открыть комнату: ${why}` };
    }
  }

  // режим игрока
  remote.reset();
  const client = new HubClient({ host: o.host, port: o.port, password: o.password, name: o.name });
  hubClient = client;
  net = { mode: "viewer", state: "connecting", message: `подключаемся к ${o.host}:${o.port}…`, address: `${o.host}:${o.port}`, name: o.name, viewers: [], canEdit: false };
  client.on("permissions", (p: { edit: boolean }) => {
    if (hubClient !== client) return;
    net = { ...net, canEdit: p.edit };
    ui?.broadcast({ type: "net", net: publicNet() });
    println(p.edit ? "[i] админ разрешил вам править NPC" : "[i] админ запретил вам править NPC");
  });
  client.on("status", (s: HubStatus) => {
    if (hubClient !== client) return;
    net = { ...net, state: s.state, message: s.message, canEdit: s.state === "connected" ? client.canEdit : false };
    if (s.state !== "connected") {
      remote.markStale();
      ui?.broadcast({ type: "status", gameConnected: false, plugin: remote.plugin });
    }
    ui?.broadcast({ type: "net", net: publicNet() });
    if (s.state === "connected") println(`[ok] подключено к комнате админа ${o.host}:${o.port}`);
    if (s.state === "denied") println(`[!] админ отказал: ${s.message}`);
  });
  client.on("event", (ev: unknown) => {
    if (hubClient !== client) return;
    remote.apply(ev);
    const type = (ev as { type?: unknown }).type;
    ui?.broadcast(type === "snapshot" ? { ...(ev as object), mode: "viewer", readOnly: true, net: publicNet() } : ev);
  });
  client.start();
  ui?.broadcast(snapshotEvent());
  // Своя игра в режиме игрока ничего не показывает, поэтому слежение за всеми и выбранный NPC выключаем.
  if (bridge.connected) {
    void bridge.send({ cmd: "world", value: 0 });
    void bridge.send({ cmd: "unwatch" });
  }
  return { ok: true, message: `Подключаемся к ${o.host}:${o.port}…` };
}

// ---------- события от игры ----------

bridge.on("hello", (info: HelloInfo) => {
  pluginInfo = info;
  // Плагин при новом соединении забыл всё, что отслеживал: начинаем с чистого листа, оставив только выбранного.
  world.reset();
  world.setConnected(true);
  emitEvent(snapshotEvent());
  println(`[+] игра подключена: ${info.plugin} ${info.version}${info.runtime ? `, Skyrim ${info.runtime}` : ""}`);

  if (isViewer()) {
    // Режим игрока: свой мир не показываем и не нагружаем игру слежением.
    void bridge.send({ cmd: "world", value: 0 });
    void bridge.send({ cmd: "unwatch" });
    return;
  }

  void (async () => {
    if (TRACK_ALL) {
      const r = await worldSwitch(true);
      println(r.ok ? `[ok] ${r.message}` : `[!] ${r.message}`);
    }
    if (world.selected !== null) {
      const r = await watchFromText(world.selected);
      if (!r.ok) println(`[!] ${r.message}`);
    }
  })();
});

bridge.on("disconnected", () => {
  world.setConnected(false);
  emitEvent({ type: "status", gameConnected: false, plugin: pluginInfo });
  println("[-] игра отключилась");
  const store = world.selectedStore();
  if (store !== undefined && world.selected !== null) publishLog(world.selected, [store.note("Игра отключилась, данные устарели")]);
});

bridge.on("log", (text: string) => println(`[i] ${text}`));

bridge.on("state", (msg: StateMessage) => {
  const applied = world.apply(msg);
  if (applied === null) return;
  const { store, result } = applied;
  emitEvent({
    type: "state",
    ref: msg.ref,
    seq: msg.seq,
    updates: store.updates,
    updatedAt: store.updatedAt?.getTime() ?? Date.now(),
    sections: result.sections,
    log: result.log.map((e) => ({ t: e.time.getTime(), text: e.text })),
  });
  if (msg.ref === world.selected && !isViewer()) {
    if (CONSOLE_PANEL) schedulePanel();
    else for (const e of result.log) println(`${hms(e.time)}  ${e.text}`);
  }
});

bridge.on("gone", (msg: GoneMessage) => {
  const g = world.gone(msg.ref);
  emitEvent({ type: "gone", ref: msg.ref, removed: g.removed });
  if (g.entry !== undefined && !isViewer()) publishLog(msg.ref, [g.entry]);
});

// ---------- консольные команды ----------

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // браузер не открылся - не страшно, адрес напечатан в консоли
  }
}

function printList(): void {
  if (isViewer()) {
    console.log(`Режим просмотра: NPC админа в списке: ${remote.size}. Подробности в веб-панели.`);
    return;
  }
  const refs = world.refs();
  console.log(`Отслеживается NPC: ${refs.length}${world.tracking ? " (слежение за всеми включено)" : ""}; выбран: ${world.selected ?? "нет"}`);
  for (const ref of refs.slice(0, 30)) {
    const s = world.get(ref);
    const idn = s?.section("identity") as { name?: unknown } | undefined;
    const vit = s?.section("vitals") as { health?: { current?: unknown; max?: unknown } } | undefined;
    const name = typeof idn?.name === "string" && idn.name ? idn.name : "?";
    const hp = vit?.health && typeof vit.health.current === "number" && typeof vit.health.max === "number" ? `${vit.health.current.toFixed(0)}/${vit.health.max.toFixed(0)}` : "?";
    console.log(`  ${ref}  ${name}  здоровье ${hp}`);
  }
  if (refs.length > 30) console.log(`  … и ещё ${refs.length - 30} (полный список в веб-панели)`);
}

function handle(line: string): void {
  const [name = "", ...args] = line.trim().split(/\s+/);
  const done = (r: ActionResult): void => println(r.ok ? `[ok] ${r.message}` : `[!] ${r.message}`);

  switch (name.toLowerCase()) {
    case "":
      return;

    case "help":
    case "?":
      console.log(HELP);
      return;

    case "list":
      printList();
      return;

    case "world": {
      const mode = args[0]?.toLowerCase();
      if (args.length !== 1 || (mode !== "on" && mode !== "off")) {
        console.log("Использование: world on  или  world off");
        return;
      }
      void worldSwitch(mode === "on").then(done);
      return;
    }

    case "watch": {
      if (args.length === 1 && args[0]?.toLowerCase() === "off") {
        void unwatch().then(done);
        return;
      }
      if (args.length !== 1 || args[0] === undefined) {
        console.log("Использование: watch <refID | player>   или   watch off");
        return;
      }
      void watchFromText(args[0]).then(done);
      return;
    }

    case "set": {
      const [field, ...rest] = args;
      if (field === undefined) {
        console.log("Использование: set <поле> [число] [FormID]   например: set vitals.health.current 50");
        return;
      }
      // Число - первый числовой аргумент, FormID - первый нечисловой либо второй.
      let value: number | undefined;
      let arg: string | undefined;
      for (const token of rest) {
        const n = Number(token);
        if (value === undefined && token !== "" && Number.isFinite(n) && !/^0x/i.test(token) && !/^[0-9a-f]{8}$/i.test(token)) value = n;
        else if (arg === undefined) arg = token;
      }
      void setField(undefined, field, arg, value).then(done);
      return;
    }

    case "quit":
    case "exit":
      rl.close();
      return;

    default:
      console.log(`Неизвестная команда: ${name}. Введите help.`);
  }
}

async function main(): Promise<void> {
  try {
    const port = await bridge.listen();
    console.log(`CoopBridge: ждём игру на ${HOST}:${port}.`);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    console.error(
      e.code === "EADDRINUSE"
        ? `Порт ${PORT} уже занят. Закройте другой экземпляр сервера или задайте BRIDGE_PORT.`
        : `Не удалось запустить сервер: ${e.message}`,
    );
    process.exit(1);
  }

  if (UI_ENABLED) {
    const server = new UiServer(
      { host: "127.0.0.1", port: UI_PORT },
      { snapshot: snapshotEvent, watch: watchFromText, unwatch, set: setField, world: worldSwitch, netStart, netStop, netPermissions, interfaces: listInterfaces },
    );
    try {
      const uiPort = await server.listen();
      ui = server;
      const url = `http://127.0.0.1:${uiPort}/`;
      console.log(`Веб-панель: ${url}`);
      if (UI_OPEN) openBrowser(url);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      console.error(
        e.code === "EADDRINUSE"
          ? `Порт веб-панели ${UI_PORT} занят: панель отключена (задайте BRIDGE_UI_PORT). Консольные команды работают.`
          : `Веб-панель не запустилась: ${e.message}. Консольные команды работают.`,
      );
    }
  }
  console.log("Команды: world on|off, list, watch <refID>, watch off, set <поле> ..., help, quit.");

  rl.on("line", (line) => {
    handle(line);
    rl.prompt();
  });
  rl.on("close", () => {
    void netStop()
      .then(() => Promise.all([bridge.close(), ui?.close()]))
      .then(() => process.exit(0));
  });
  rl.prompt();
}

void main();
