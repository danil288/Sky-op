// Проверка настроек сети из панели и список адресов этого компьютера.

import net from "node:net";
import os from "node:os";

export type NetStart =
  | { ok: true; mode: "host" | "viewer"; host: string; port: number; password: string; name: string; allowEdit: boolean }
  | { ok: false; message: string };

/** Проверяет запрос на запуск комнаты (режим админа) или подключение (режим игрока). */
export function parseNetStart(raw: unknown): NetStart {
  if (typeof raw !== "object" || raw === null) return { ok: false, message: "некорректный запрос" };
  const o = raw as Record<string, unknown>;

  const mode = o.mode;
  if (mode !== "host" && mode !== "viewer") return { ok: false, message: "не выбран режим: админ или игрок" };

  const host = typeof o.host === "string" ? o.host.trim() : "";
  if (mode === "host") {
    if (host === "" || net.isIP(host) !== 4) return { ok: false, message: "адрес для прослушивания: IPv4, например 26.1.2.3 или 0.0.0.0 (все интерфейсы)" };
  } else {
    if (host === "") return { ok: false, message: "введите адрес админа (его адрес в Radmin VPN)" };
    if (host.length > 255 || !/^[A-Za-z0-9.\-_]+$/.test(host)) return { ok: false, message: "адрес админа содержит недопустимые символы" };
  }

  const port = typeof o.port === "number" ? o.port : typeof o.port === "string" ? Number(o.port) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, message: "порт: целое число от 1 до 65535" };

  const password = typeof o.password === "string" ? o.password : "";
  if (password.length < 4) return { ok: false, message: "пароль комнаты: не короче 4 символов" };
  if (password.length > 64) return { ok: false, message: "пароль комнаты: не длиннее 64 символов" };

  const rawName = typeof o.name === "string" ? o.name : "";
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32) || (mode === "host" ? "Админ" : "Игрок");

  // Разрешение игрокам править NPC (только для админа); по умолчанию разрешено.
  if (o.allowEdit !== undefined && typeof o.allowEdit !== "boolean") return { ok: false, message: "allowEdit: нужно true или false" };
  const allowEdit = o.allowEdit !== false;

  return { ok: true, mode, host, port, password, name, allowEdit };
}

export interface LocalInterface {
  name: string;
  address: string;
}

/** IPv4-адреса этого компьютера (в том числе Radmin VPN и Hamachi) для выбора в панели. */
export function listInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}
