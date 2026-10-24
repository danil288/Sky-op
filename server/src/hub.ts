// Сервер комнаты на стороне админа: принимает подключения других игроков (по сети, например через
// Radmin VPN), проверяет пароль и рассылает им те же события, что получает веб-панель админа.
//
// Протокол (TCP, одна строка = одно JSON-сообщение, UTF-8):
//   хост -> игрок: {"type":"challenge","nonce":"<hex>","protocol":1,"host":"<имя админа>"}
//   игрок -> хост: {"type":"join","name":"Вася","proof":"<hex>","protocol":1}
//                  proof = HMAC-SHA256(пароль, nonce): пароль по сети не передаётся
//   хост -> игрок: {"type":"welcome","role":"viewer","permissions":{"edit":true}}
//                  затем {"type":"event","event":{...снимок...}}
//                  или {"type":"denied","reason":"..."} и закрытие соединения
//   далее хост шлёт {"type":"event","event":{...}} на каждое изменение, {"type":"ping"}
//   и {"type":"permissions","edit":bool}, когда админ меняет права; игрок отвечает {"type":"pong"}.
//
// Команды игрока (только если админ разрешил правки):
//   игрок -> хост: {"type":"cmd","id":7,"cmd":"set","ref":"00013491","field":"vitals.health.current","value":50}
//   хост -> игрок: {"type":"result","id":7,"ok":true,"message":"Здоровье, текущее: 100.0 → 50.0"}
// Игроку доступна только команда set; допустимость поля и значения проверяет админская сторона.
//
// Защита: пароль обязателен, ожидание авторизации ограничено по времени, после нескольких неудачных
// попыток адрес блокируется на минуту, число игроков ограничено, размер сообщений ограничен,
// «молчащие» игроки отключаются.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import type { AddressInfo } from "node:net";

export const HUB_PROTOCOL = 2;

const MAX_LINE_BYTES = 64 * 1024;
const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;
const MAX_FAILURES = 5;
const BLOCK_MS = 60_000;
const MAX_COMMANDS_PER_SECOND = 8;
const MAX_PENDING_COMMANDS = 4;
const COMMAND_TIMEOUT_MS = 10_000;
const FAIL_WINDOW_MS = 5 * 60_000; // неудачи старше этого срока не считаются

export function proofFor(password: string, nonce: string): string {
  return createHmac("sha256", password).update(nonce).digest("hex");
}

export interface ViewerInfo {
  id: number;
  name: string;
  address: string;
  since: number;
}

export interface HubOptions {
  host: string;
  port: number;
  password: string;
  /** Имя админа, которое увидят подключившиеся. */
  hostName?: string;
  maxViewers?: number;
  authTimeoutMs?: number;
  pingIntervalMs?: number;
  /** Сколько можно молчать, прежде чем игрока отключат. */
  idleTimeoutMs?: number;
  /** Разрешено ли игрокам править NPC (по умолчанию да). Можно менять на ходу: setPermissions. */
  allowEdit?: boolean;
  /** Сколько ждать ответа админской стороны на команду игрока. */
  commandTimeoutMs?: number;
  /** Полный снимок для только что подключившегося. */
  snapshot: () => unknown;
}

interface Viewer {
  info: ViewerInfo;
  socket: net.Socket;
  lastSeen: number;
  /** Моменты последних команд (для ограничения частоты). */
  recent: number[];
  /** Команды, на которые админская сторона ещё не ответила. */
  pending: Map<number, NodeJS.Timeout>;
}

/** Команда игрока, прошедшая проверку формы и ограничений; допустимость значения проверяет получатель. */
export interface ViewerCommand {
  id: number;
  body: { ref: string; field: string; arg?: string; value?: number };
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "Игрок";
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  return name || "Игрок";
}

export class HubServer extends EventEmitter {
  private readonly server: net.Server;
  private readonly viewers = new Map<number, Viewer>();
  private readonly failures = new Map<string, { count: number; last: number; until: number }>();
  private readonly sockets = new Set<net.Socket>();
  private nextId = 1;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly maxViewers: number;
  private readonly authTimeoutMs: number;
  private readonly pingIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private edit: boolean;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: HubOptions) {
    super();
    this.edit = options.allowEdit ?? true;
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.maxViewers = options.maxViewers ?? 8;
    this.authTimeoutMs = options.authTimeoutMs ?? 5000;
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 40_000;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    this.pingTimer = setInterval(() => this.heartbeat(), this.pingIntervalMs);
    this.pingTimer.unref();
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const v of this.viewers.values()) {
      for (const t of v.pending.values()) clearTimeout(t);
      v.socket.destroy();
    }
    this.viewers.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get permissions(): { edit: boolean } {
    return { edit: this.edit };
  }

  /** Меняет права игроков на ходу; все подключённые узнают сразу. */
  setPermissions(p: { edit: boolean }): void {
    if (this.edit === p.edit) return;
    this.edit = p.edit;
    const line = `${JSON.stringify({ type: "permissions", edit: p.edit })}\n`;
    for (const v of this.viewers.values()) this.write(v.socket, line);
  }

  /** Ответ игроку на его команду (вызывается после события "command"). */
  reply(viewerId: number, id: number, ok: boolean, message: string): void {
    const v = this.viewers.get(viewerId);
    const timer = v?.pending.get(id);
    if (v === undefined || timer === undefined) return; // игрок ушёл или ответ запоздал
    clearTimeout(timer);
    v.pending.delete(id);
    this.send(v.socket, { type: "result", id, ok, message });
  }

  list(): ViewerInfo[] {
    return [...this.viewers.values()].map((v) => v.info);
  }

  /** Отправляет событие всем подключённым игрокам. */
  broadcast(event: unknown): void {
    if (this.viewers.size === 0) return;
    const line = `${JSON.stringify({ type: "event", event })}\n`;
    for (const v of [...this.viewers.values()]) {
      if (v.socket.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
        // Игрок не успевает читать: отключаем, при переподключении он получит свежий снимок.
        v.socket.destroy();
        continue;
      }
      this.write(v.socket, line);
    }
  }

  private write(socket: net.Socket, line: string): void {
    if (socket.writable) socket.write(line);
  }

  private send(socket: net.Socket, message: unknown): void {
    this.write(socket, `${JSON.stringify(message)}\n`);
  }

  private heartbeat(): void {
    const now = Date.now();
    for (const v of [...this.viewers.values()]) {
      if (now - v.lastSeen > this.idleTimeoutMs) {
        v.socket.destroy();
        continue;
      }
      this.send(v.socket, { type: "ping" });
    }
  }

  private noteFailure(address: string): void {
    const now = Date.now();
    const f = this.failures.get(address);
    // Счёт продолжается, пока неудачи идут в пределах окна и блокировка не истекла; иначе начинается заново.
    const fresh = f === undefined || now - f.last > FAIL_WINDOW_MS || (f.until !== 0 && f.until <= now);
    const count = fresh ? 1 : f.count + 1;
    this.failures.set(address, { count, last: now, until: count >= MAX_FAILURES ? now + BLOCK_MS : 0 });
  }

  private onCommand(v: Viewer, msg: Record<string, unknown>): void {
    const id = msg.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return; // без номера ответить нельзя
    const fail = (message: string): void => this.send(v.socket, { type: "result", id, ok: false, message });

    const now = Date.now();
    v.recent = v.recent.filter((t) => now - t < 1000);
    if (v.recent.length >= MAX_COMMANDS_PER_SECOND) return fail("слишком часто, подождите секунду");
    v.recent.push(now);

    if (!this.edit) return fail("админ запретил игрокам править NPC");
    if (v.pending.has(id)) return fail("команда с таким номером уже выполняется");
    if (v.pending.size >= MAX_PENDING_COMMANDS) return fail("слишком много незавершённых команд");
    if (msg.cmd !== "set") return fail("эта команда игрокам недоступна");

    const { ref, field, arg, value } = msg;
    const okShape =
      typeof ref === "string" && ref.length > 0 && ref.length <= 16 &&
      typeof field === "string" && field.length > 0 && field.length <= 64 &&
      (arg === undefined || (typeof arg === "string" && arg.length <= 64)) &&
      (value === undefined || (typeof value === "number" && Number.isFinite(value)));
    if (!okShape) return fail("некорректная команда");

    v.pending.set(id, setTimeout(() => {
      if (v.pending.delete(id)) this.send(v.socket, { type: "result", id, ok: false, message: "админ не ответил вовремя" });
    }, this.commandTimeoutMs));
    const body: ViewerCommand["body"] = { ref: ref as string, field: field as string };
    if (arg !== undefined) body.arg = arg as string;
    if (value !== undefined) body.value = value as number;
    this.emit("command", v.info, { id, body } satisfies ViewerCommand);
  }

  private onConnection(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setEncoding("utf8");
    const address = socket.remoteAddress ?? "?";
    this.sockets.add(socket);

    const deny = (reason: string, failure: boolean): void => {
      if (failure) this.noteFailure(address);
      this.send(socket, { type: "denied", reason });
      socket.end();
      setTimeout(() => socket.destroy(), 500).unref();
    };

    const block = this.failures.get(address);
    if (block && block.until > Date.now()) {
      deny("слишком много неудачных попыток, подождите минуту", false);
      return;
    }

    const nonce = randomBytes(16).toString("hex");
    this.send(socket, { type: "challenge", nonce, protocol: HUB_PROTOCOL, host: this.options.hostName ?? "Админ" });

    let viewer: Viewer | null = null;
    let buffer = "";
    const authTimer = setTimeout(() => {
      if (viewer === null) deny("время ожидания авторизации истекло", true);
    }, this.authTimeoutMs);

    const join = (msg: Record<string, unknown>): void => {
      if (msg.type !== "join") return deny("ожидалось сообщение join", true);
      if (msg.protocol !== HUB_PROTOCOL) return deny("несовместимая версия протокола: обновите сервер", false);
      const proof = typeof msg.proof === "string" ? msg.proof : "";
      const expected = proofFor(this.options.password, nonce);
      const a = Buffer.from(proof);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return deny("неверный пароль", true);
      if (this.viewers.size >= this.maxViewers) return deny("комната заполнена", false);

      clearTimeout(authTimer);
      this.failures.delete(address);
      const id = this.nextId++;
      viewer = { info: { id, name: cleanName(msg.name), address, since: Date.now() }, socket, lastSeen: Date.now(), recent: [], pending: new Map() };
      this.viewers.set(id, viewer);
      this.send(socket, { type: "welcome", role: "viewer", permissions: { edit: this.edit } });
      this.send(socket, { type: "event", event: this.options.snapshot() });
      this.emit("viewers", this.list(), { joined: viewer.info });
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (viewer !== null) viewer.lastSeen = Date.now();
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          if (viewer === null) return deny("некорректное сообщение", true);
          continue;
        }
        if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
          if (viewer === null) return deny("некорректное сообщение", true);
          continue;
        }
        if (viewer === null) {
          join(msg as Record<string, unknown>);
          if (viewer === null) return;
        }
        // После входа от игрока принимаются pong и команды set; всё остальное игнорируется.
        if (viewer !== null && (msg as Record<string, unknown>).type === "cmd") this.onCommand(viewer, msg as Record<string, unknown>);
      }
    });

    const cleanup = (): void => {
      clearTimeout(authTimer);
      this.sockets.delete(socket);
      if (viewer !== null && this.viewers.delete(viewer.info.id)) {
        for (const t of viewer.pending.values()) clearTimeout(t);
        viewer.pending.clear();
        this.emit("viewers", this.list(), { left: viewer.info });
      }
    };
    socket.on("close", cleanup);
    socket.on("error", () => {});
  }
}
