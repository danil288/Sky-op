import net from "node:net";
import { EventEmitter } from "node:events";
import {
  type CommandBody,
  type CommandResult,
  type HelloInfo,
  type ResultMessage,
  type GoneMessage,
  type StateMessage,
  parseClientMessage,
} from "./protocol.js";

export interface BridgeOptions {
  /** Адрес прослушивания. По умолчанию только локальный: 127.0.0.1. */
  host?: string;
  /** Порт. 0 - выбрать свободный (удобно для тестов). */
  port?: number;
  /** Сколько ждать финального ответа на команду. */
  commandTimeoutMs?: number;
}

interface Pending {
  resolve: (r: CommandResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * Защита от мусора: строка длиннее этого предела считается ошибкой, соединение закрывается.
 * Полный снимок NPC с большим инвентарём занимает десятки килобайт, поэтому запас большой.
 */
const MAX_LINE_BYTES = 1024 * 1024;

/**
 * Принимает одно подключение от игры (плагина), отправляет ему команды и принимает данные NPC.
 * Если игра подключилась повторно, старое соединение закрывается (например, после вылета).
 *
 * События:
 *  - "hello"        (info: HelloInfo)      плагин представился
 *  - "disconnected" ()                     игра отключилась
 *  - "result"       (msg: ResultMessage)   ответ плагина на команду
 *  - "state"        (msg: StateMessage)    изменившиеся разделы данных отслеживаемого NPC
 *  - "gone"         (msg: GoneMessage)     NPC выгружен из мира или слежение за ним снято
 *  - "log"          (text: string)         служебные сообщения
 */
export class Bridge extends EventEmitter {
  readonly host: string;
  private port: number;
  private readonly timeoutMs: number;
  private readonly server: net.Server;
  private client: net.Socket | null = null;
  private info: HelloInfo | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(options: BridgeOptions = {}) {
    super();
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 7777;
    this.timeoutMs = options.commandTimeoutMs ?? 120_000;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  /** Запускает прослушивание. Возвращает реальный порт. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.server.once("error", onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off("error", onError);
        const addr = this.server.address();
        if (addr !== null && typeof addr === "object") this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  get listeningPort(): number {
    return this.port;
  }

  get connected(): boolean {
    return this.client !== null && !this.client.destroyed;
  }

  get pluginInfo(): HelloInfo | null {
    return this.info;
  }

  /**
   * Отправляет команду и ждёт финального ответа. Промис не отклоняется:
   * нет связи, обрыв и таймаут возвращаются как результат со статусом "error" / "timeout".
   */
  send(body: CommandBody, timeoutMs: number = this.timeoutMs): Promise<CommandResult> {
    const socket = this.client;
    if (socket === null || socket.destroyed) {
      return Promise.resolve({ id: 0, status: "error", message: "игра не подключена" });
    }

    const id = this.nextId++;
    const line = JSON.stringify({ type: "cmd", id, ...body }) + "\n";

    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, {
          id,
          status: "timeout",
          message: `нет ответа за ${Math.round(timeoutMs / 1000)} с`,
        });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });

      socket.write(line, (err) => {
        if (err) {
          this.settle(id, { id, status: "error", message: `ошибка отправки: ${err.message}` });
        }
      });
    });
  }

  /** Останавливает сервер, закрывает соединение и завершает все ожидающие команды. */
  close(): Promise<void> {
    this.failAllPending("сервер остановлен");
    this.client?.destroy();
    this.client = null;
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    if (this.client !== null && !this.client.destroyed) {
      this.emit("log", "новое подключение заменяет старое");
      const old = this.client;
      this.client = null;
      this.failAllPending("соединение заменено новым");
      old.destroy();
    }

    this.client = socket;
    this.info = null;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setEncoding("utf8");

    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) this.handleLine(line);
        nl = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        this.emit("log", "слишком длинная строка от клиента, соединение закрыто");
        socket.destroy();
      }
    });

    socket.on("error", (err) => {
      this.emit("log", `ошибка сокета: ${err.message}`);
    });

    socket.on("close", () => {
      if (this.client !== socket) return; // это уже заменённое соединение
      this.client = null;
      this.info = null;
      this.failAllPending("соединение с игрой потеряно");
      this.emit("disconnected");
    });
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.emit("log", `не JSON: ${line.slice(0, 120)}`);
      return;
    }

    const msg = parseClientMessage(raw);
    if (msg === null) {
      this.emit("log", `неизвестное сообщение: ${line.slice(0, 120)}`);
      return;
    }

    if (msg.type === "hello") {
      const { type: _type, ...info } = msg;
      this.info = info;
      this.emit("hello", info);
      return;
    }

    if (msg.type === "state") {
      this.emit("state", msg satisfies StateMessage);
      return;
    }

    if (msg.type === "gone") {
      this.emit("gone", msg satisfies GoneMessage);
      return;
    }

    this.emit("result", msg satisfies ResultMessage);
    this.settle(msg.id, { id: msg.id, status: msg.status, message: msg.message });
  }

  private settle(id: number, result: CommandResult): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(result);
  }

  private failAllPending(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, { id, status: "error", message: reason });
    }
  }
}
