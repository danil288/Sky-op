// Подключение игрока к серверу админа (см. hub.ts). Получает события админа, сам ничего не меняет.
// При обрыве переподключается; при неверном пароле или несовместимой версии останавливается.

import { EventEmitter } from "node:events";
import net from "node:net";
import { HUB_PROTOCOL, proofFor } from "./hub.js";

export type HubState = "connecting" | "connected" | "disconnected" | "denied" | "stopped";

export interface HubStatus {
  state: HubState;
  message: string;
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

/** Что игрок может попросить у админа: сейчас только изменение параметра NPC. */
export type ViewerCommandBody = { cmd: "set"; ref: string; field: string; arg?: string; value?: number };

export interface HubClientOptions {
  host: string;
  port: number;
  password: string;
  name: string;
  connectTimeoutMs?: number;
  /** Сколько можно не получать данные от админа, прежде чем считать связь потерянной. */
  idleTimeoutMs?: number;
  /** Пауза перед повторным подключением: начальная и предельная. */
  retryMinMs?: number;
  retryMaxMs?: number;
}

const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class HubClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs: number;
  private current: HubState = "stopped";
  private edit = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: CommandResult) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: HubClientOptions) {
    super();
    this.retryMs = options.retryMinMs ?? 1000;
  }

  get state(): HubState {
    return this.current;
  }

  /** Разрешил ли админ игрокам править NPC (приходит от админа и меняется на ходу). */
  get canEdit(): boolean {
    return this.edit;
  }

  /** Отправляет команду админу и ждёт ответ. Никогда не отклоняется: ошибки приходят как { ok: false }. */
  command(body: ViewerCommandBody, timeoutMs = 6000): Promise<CommandResult> {
    const socket = this.socket;
    if (this.current !== "connected" || socket === null || !socket.writable) {
      return Promise.resolve({ ok: false, message: "нет связи с админом" });
    }
    const id = this.nextId++;
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, message: "админ не ответил вовремя" });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      socket.write(`${JSON.stringify({ type: "cmd", id, ...body })}\n`);
    });
  }

  private failPending(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, message });
    }
    this.pending.clear();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.failPending("вы вышли из комнаты");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.setState("stopped", "остановлено");
  }

  private setState(state: HubState, message: string): void {
    this.current = state;
    this.emit("status", { state, message } satisfies HubStatus);
  }

  private setEdit(source: unknown): void {
    const edit = typeof source === "object" && source !== null && (source as { edit?: unknown }).edit === true;
    if (edit === this.edit) return;
    this.edit = edit;
    this.emit("permissions", { edit });
  }

  private scheduleRetry(reason: string): void {
    if (this.stopped) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs ?? 10_000);
    this.setState("disconnected", `${reason}; повтор через ${Math.round(wait / 1000)} с`);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting", `подключаемся к ${this.options.host}:${this.options.port}…`);

    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(this.options.connectTimeoutMs ?? 8000);

    let buffer = "";
    let denied = false;
    let welcomed = false;
    let failReason = "связь потеряна";

    socket.on("timeout", () => {
      failReason = welcomed ? "админ давно не отвечает" : "нет ответа от админа";
      socket.destroy();
    });

    socket.on("data", (chunk: string) => {
      socket.setTimeout(this.options.idleTimeoutMs ?? 30_000);
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        failReason = "слишком большое сообщение от админа";
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          msg = parsed as Record<string, unknown>;
        } catch {
          continue;
        }

        switch (msg.type) {
          case "challenge": {
            if (typeof msg.nonce !== "string") break;
            if (msg.protocol !== HUB_PROTOCOL) {
              denied = true;
              this.setState("denied", "несовместимая версия протокола: обновите сервер");
              socket.destroy();
              return;
            }
            socket.write(`${JSON.stringify({ type: "join", name: this.options.name, proof: proofFor(this.options.password, msg.nonce), protocol: HUB_PROTOCOL })}\n`);
            break;
          }
          case "welcome":
            welcomed = true;
            this.setEdit(msg.permissions);
            this.retryMs = this.options.retryMinMs ?? 1000;
            this.setState("connected", `подключено к ${this.options.host}:${this.options.port}`);
            break;
          case "denied": {
            denied = true;
            const reason = typeof msg.reason === "string" ? msg.reason : "отказано";
            this.setState("denied", reason);
            socket.destroy();
            return;
          }
          case "permissions":
            if (welcomed) this.setEdit(msg);
            break;
          case "result": {
            const id = msg.id;
            const p = typeof id === "number" ? this.pending.get(id) : undefined;
            if (p !== undefined && typeof id === "number") {
              clearTimeout(p.timer);
              this.pending.delete(id);
              p.resolve({ ok: msg.ok === true, message: typeof msg.message === "string" ? msg.message : "" });
            }
            break;
          }
          case "ping":
            if (socket.writable) socket.write(`${JSON.stringify({ type: "pong" })}\n`);
            break;
          case "event":
            if (welcomed && typeof msg.event === "object" && msg.event !== null) this.emit("event", msg.event);
            break;
        }
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") failReason = "админ недоступен (порт закрыт или сервер не запущен)";
      else if (err.code === "ETIMEDOUT" || err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") failReason = "нет маршрута до админа (проверьте Radmin VPN и адрес)";
      else if (err.code === "ENOTFOUND") failReason = "адрес не найден";
      else failReason = err.code ?? err.message;
    });

    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.failPending("связь с админом потеряна");
      if (denied || this.stopped) return;
      this.scheduleRetry(failReason);
    });
  }
}
