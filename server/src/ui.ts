// Веб-панель сервера: страница в браузере, поток обновлений (Server-Sent Events) и две команды.
//
//   GET  /            страница панели (ui/index.html)
//   GET  /events      поток событий: сначала {"type":"snapshot",...}, затем обновления
//   POST /api/watch   {"ref":"000A2C94"}                         выбрать NPC (читается каждый такт)
//   POST /api/unwatch {}                                         снять выбор
//   POST /api/world   {"on":true}                                следить за всеми загруженными NPC (или выключить)
//   POST /api/set     {"ref":"000A2C94","field":"vitals.health.current","value":50}  изменить параметр NPC
//   POST /api/net/start {"mode":"host"|"viewer","host":"26.1.2.3","port":7788,"password":"…","name":"…"}
//                                                                запустить комнату (админ) или подключиться к ней (игрок)
//   POST /api/net/stop  {}                                        выйти из комнаты
//   POST /api/net/permissions {"edit":true}                       админ: разрешить или запретить игрокам править NPC
//   GET  /api/interfaces                                          адреса этого компьютера (в том числе Radmin VPN)
//
// Безопасность: слушает только локальный адрес, проверяет заголовки Host (защита от DNS rebinding)
// и Origin (защита от запросов с чужих сайтов). Команды принимает только как application/json и только
// с ключом (заголовок X-CoopBridge-Token). Ключ создаётся при каждом запуске сервера и вставляется в
// страницу панели, поэтому другая программа или сайт без доступа к странице управлять NPC не смогут.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface UiHandlers {
  /** Полное состояние для нового клиента (первое событие потока). */
  snapshot(): unknown;
  watch(refText: string): Promise<ActionResult>;
  unwatch(): Promise<ActionResult>;
  /** Слежение за всеми загруженными NPC. */
  world(on: boolean): Promise<ActionResult>;
  /** Запуск комнаты или подключение к ней; настройки приходят из сети и проверяются обработчиком. */
  netStart(raw: unknown): Promise<ActionResult>;
  netStop(): Promise<ActionResult>;
  /** Админ: разрешить или запретить игрокам править NPC. */
  netPermissions(edit: boolean): Promise<ActionResult>;
  /** Адреса этого компьютера для выбора в панели. */
  interfaces(): unknown;
  /** Изменение параметра NPC; входные значения приходят из сети и проверяются обработчиком. */
  set(ref: unknown, field: unknown, arg: unknown, value: unknown): Promise<ActionResult>;
}

export interface UiOptions {
  host: string;
  port: number;
  /** Путь к странице панели; по умолчанию server/ui/index.html. */
  htmlUrl?: URL;
  /** Ключ для команд; по умолчанию создаётся случайный. */
  token?: string;
}

const MAX_BODY_BYTES = 2048;
const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export class UiServer {
  private readonly server: http.Server;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly htmlUrl: URL;
  private allowedHosts = new Set<string>();
  private keepalive: NodeJS.Timeout | null = null;
  /** Ключ, который страница панели должна присылать с каждой командой. */
  readonly token: string;

  constructor(
    private readonly options: UiOptions,
    private readonly handlers: UiHandlers,
  ) {
    this.htmlUrl = options.htmlUrl ?? new URL("../ui/index.html", import.meta.url);
    this.token = options.token ?? randomBytes(16).toString("hex");
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) this.json(res, 500, { ok: false, message: `внутренняя ошибка: ${(err as Error).message}` });
        else res.end();
      });
    });
  }

  get clientCount(): number {
    return this.clients.size;
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
    const port = (this.server.address() as AddressInfo).port;
    this.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    this.keepalive = setInterval(() => this.writeAll(": ping\n\n"), KEEPALIVE_MS);
    this.keepalive.unref();
    return port;
  }

  async close(): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive);
    for (const res of this.clients) res.end();
    this.clients.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Отправляет событие всем открытым вкладкам панели. */
  broadcast(event: unknown): void {
    if (this.clients.size === 0) return;
    this.writeAll(`data: ${JSON.stringify(event)}\n\n`);
  }

  private writeAll(chunk: string): void {
    for (const res of this.clients) {
      try {
        if (res.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
          // Вкладка не успевает читать: отключаем, она переподключится и получит свежий снимок.
          this.clients.delete(res);
          res.destroy();
          continue;
        }
        res.write(chunk);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private hostAllowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    if (typeof host !== "string" || !this.allowedHosts.has(host.toLowerCase())) return false;
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    // Origin есть у запросов из браузера со страницы; допускаем только собственную страницу панели.
    return typeof origin === "string" && [...this.allowedHosts].some((h) => origin.toLowerCase() === `http://${h}`);
  }

  private tokenValid(req: http.IncomingMessage): boolean {
    const given = req.headers["x-coopbridge-token"];
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async readBody(req: http.IncomingMessage): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.hostAllowed(req)) {
      this.json(res, 403, { ok: false, message: "запрещено: неверный Host или Origin" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";

    if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      let html: Buffer;
      try {
        html = Buffer.from((await readFile(this.htmlUrl, "utf8")).replace("{{TOKEN}}", this.token), "utf8");
      } catch {
        this.json(res, 500, { ok: false, message: "не найден файл панели server/ui/index.html" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Content-Length": html.length,
      });
      res.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      res.write("retry: 1000\n\n");
      res.write(`data: ${JSON.stringify(this.handlers.snapshot())}\n\n`);
      this.clients.add(res);
      req.on("close", () => this.clients.delete(res));
      return;
    }

    if (method === "GET" && url.pathname === "/api/interfaces") {
      this.json(res, 200, { interfaces: this.handlers.interfaces() });
      return;
    }

    if (method === "POST" && (url.pathname === "/api/watch" || url.pathname === "/api/unwatch" || url.pathname === "/api/set" || url.pathname === "/api/world" || url.pathname === "/api/net/start" || url.pathname === "/api/net/stop" || url.pathname === "/api/net/permissions")) {
      if (!this.tokenValid(req)) {
        this.json(res, 401, { ok: false, message: "нет ключа: обновите страницу панели" });
        return;
      }
      const type = req.headers["content-type"];
      if (typeof type !== "string" || !type.toLowerCase().startsWith("application/json")) {
        this.json(res, 415, { ok: false, message: "нужен Content-Type: application/json" });
        return;
      }
      const body = await this.readBody(req);
      if (body === null) {
        this.json(res, 413, { ok: false, message: "слишком большой запрос" });
        return;
      }
      let data: unknown;
      try {
        data = body.trim() === "" ? {} : JSON.parse(body);
      } catch {
        this.json(res, 400, { ok: false, message: "некорректный JSON" });
        return;
      }
      if (url.pathname === "/api/unwatch") {
        this.json(res, 200, await this.handlers.unwatch());
        return;
      }
      if (url.pathname === "/api/net/start") {
        this.json(res, 200, await this.handlers.netStart(data));
        return;
      }
      if (url.pathname === "/api/net/permissions") {
        const edit = typeof data === "object" && data !== null ? (data as { edit?: unknown }).edit : undefined;
        if (typeof edit !== "boolean") {
          this.json(res, 400, { ok: false, message: "нужно поле edit (true или false)" });
          return;
        }
        this.json(res, 200, await this.handlers.netPermissions(edit));
        return;
      }
      if (url.pathname === "/api/net/stop") {
        this.json(res, 200, await this.handlers.netStop());
        return;
      }
      if (url.pathname === "/api/set") {
        const d = typeof data === "object" && data !== null ? (data as { ref?: unknown; field?: unknown; arg?: unknown; value?: unknown }) : {};
        this.json(res, 200, await this.handlers.set(d.ref, d.field, d.arg, d.value));
        return;
      }
      if (url.pathname === "/api/world") {
        const on = typeof data === "object" && data !== null ? (data as { on?: unknown }).on : undefined;
        if (typeof on !== "boolean") {
          this.json(res, 400, { ok: false, message: "нужно поле on (true или false)" });
          return;
        }
        this.json(res, 200, await this.handlers.world(on));
        return;
      }
      const ref = typeof data === "object" && data !== null ? (data as { ref?: unknown }).ref : undefined;
      if (typeof ref !== "string") {
        this.json(res, 400, { ok: false, message: "нужно поле ref (строка)" });
        return;
      }
      this.json(res, 200, await this.handlers.watch(ref));
      return;
    }

    this.json(res, 404, { ok: false, message: "не найдено" });
  }
}
