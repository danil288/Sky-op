// Протокол обмена между сервером и плагином CoopBridge.
//
// Транспорт: TCP, одна строка = одно JSON-сообщение (разделитель "\n", UTF-8).
//
// Сервер -> плагин:
//   {"type":"cmd","id":1,"cmd":"watch","ref":"000A2C94"}   выбрать актёра: читать его каждый такт (~50 мс)
//   {"type":"cmd","id":2,"cmd":"unwatch"}                  снять выбор
//   {"type":"cmd","id":4,"cmd":"world","value":1}          следить за ВСЕМИ загруженными NPC (0 - выключить)
//   {"type":"cmd","id":3,"cmd":"set","ref":"000A2C94","field":"vitals.health.current","value":50}
//                                                          изменить параметр наблюдаемого NPC
//     поля field, а также arg (FormID) и value (число), описаны в edit.ts; меняются только
//     данные экземпляра, постоянные данные записи (имя, id, уровень, раса) изменить нельзя
//
// Плагин -> сервер:
//   {"type":"hello","plugin":"CoopBridge","version":"0.2.0","runtime":"1.6.1170.0","protocol":2}
//   {"type":"result","id":1,"status":"watching","message":""}
//     status: watching | unwatched | applied (правка применена, message - что стало) | error
//   {"type":"state","ref":"000A2C94","seq":7,"sections":{"vitals":{...},"position":{...}}}
//   {"type":"gone","ref":"000A2C94"}                       актёр выгружен из мира (или слежение за ним снято)
//
// Каждый отслеживаемый актёр сначала присылает полный снимок (все разделы), затем - только те
// разделы, что изменились. Выбранный командой watch читается каждый такт (~20 раз в секунду),
// остальные - по очереди в пределах бюджета времени (по умолчанию быстрые данные раз в 250 мс,
// медленные раз в секунду). Раздел всегда приходит целиком и заменяет предыдущий.
// Номер seq у каждого актёра свой, после переподключения плагин начинает с единицы.
//
// Разделы: presence, identity, vitals, attributes, position, location, state, combat,
// package, follower, factions, effects, inventory, lastHit.
//
// "ref" - FormID экземпляра (refID) в виде 8 шестнадцатеричных цифр, включая индекс
// в порядке загрузки (то, что показывает консоль игры по клику на NPC).

export const PROTOCOL_VERSION = 4;

/** FormID в виде 8 шестнадцатеричных цифр в верхнем регистре, например "000A2C94". */
export type RefId = string;

/** Статусы, которые может прислать плагин. */
export type PluginStatus = "watching" | "unwatched" | "tracking" | "untracked" | "applied" | "error";

/** Результат команды для вызывающего кода; "timeout" формируется самим сервером. */
export type ResultStatus = PluginStatus | "timeout";

export interface CommandResult {
  id: number;
  status: ResultStatus;
  message: string;
}

export type CommandBody =
  | { cmd: "watch"; ref: RefId }
  | { cmd: "unwatch" }
  | { cmd: "world"; value: 0 | 1 }
  | { cmd: "set"; ref: RefId; field: string; arg?: string; value?: number };

export interface HelloInfo {
  plugin: string;
  version: string;
  runtime?: string;
  protocol?: number;
}

export interface HelloMessage extends HelloInfo {
  type: "hello";
}

export interface ResultMessage {
  type: "result";
  id: number;
  status: PluginStatus;
  message: string;
}

/** Содержимое разделов не проверяется на уровне протокола: его читает npc.ts с защитой от неверных типов. */
export type Sections = Record<string, unknown>;

export interface StateMessage {
  type: "state";
  ref: RefId;
  seq: number;
  sections: Sections;
}

export interface GoneMessage {
  type: "gone";
  ref: RefId;
}

export type ClientMessage = HelloMessage | ResultMessage | StateMessage | GoneMessage;

const PLUGIN_STATUSES: ReadonlySet<string> = new Set<PluginStatus>(["watching", "unwatched", "tracking", "untracked", "applied", "error"]);

const PLAYER_REF = "00000014";
const REF_RE = /^(?:0x)?([0-9a-fA-F]{1,8})$/;
const STRICT_REF_RE = /^[0-9A-F]{8}$/;
const MAX_SECTIONS = 64;

/**
 * Разбирает FormID: "A2C94", "0x000A2C94", "000a2c94". Слово "player" означает игрока (0x14).
 * Возвращает null, если строка не похожа на FormID или равна нулю.
 */
export function parseRef(text: string): RefId | null {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === "player") return PLAYER_REF;
  const m = REF_RE.exec(trimmed);
  if (!m || m[1] === undefined) return null;
  const id = m[1].toUpperCase().padStart(8, "0");
  return id === "00000000" ? null : id;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Проверяет сообщение, пришедшее от плагина. Всё неожиданное отбрасывается (null). */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isPlainObject(raw)) return null;
  const o = raw;

  if (o.type === "hello") {
    if (typeof o.plugin !== "string" || typeof o.version !== "string") return null;
    const msg: HelloMessage = { type: "hello", plugin: o.plugin, version: o.version };
    if (typeof o.runtime === "string") msg.runtime = o.runtime;
    if (typeof o.protocol === "number") msg.protocol = o.protocol;
    return msg;
  }

  if (o.type === "result") {
    if (typeof o.id !== "number" || !Number.isInteger(o.id)) return null;
    if (typeof o.status !== "string" || !PLUGIN_STATUSES.has(o.status)) return null;
    return {
      type: "result",
      id: o.id,
      status: o.status as PluginStatus,
      message: typeof o.message === "string" ? o.message : "",
    };
  }

  if (o.type === "gone") {
    if (typeof o.ref !== "string" || !STRICT_REF_RE.test(o.ref)) return null;
    return { type: "gone", ref: o.ref };
  }

  if (o.type === "state") {
    if (typeof o.ref !== "string" || !STRICT_REF_RE.test(o.ref)) return null;
    if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null;
    if (!isPlainObject(o.sections)) return null;
    if (Object.keys(o.sections).length > MAX_SECTIONS) return null;
    return { type: "state", ref: o.ref, seq: o.seq, sections: o.sections };
  }

  return null;
}
