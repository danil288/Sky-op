// Состояние наблюдаемого NPC на сервере: накапливает разделы от плагина,
// ведёт журнал изменений и рисует панель для консоли.
//
// Данные приходят из игры, поэтому каждое поле читается с проверкой типа:
// неожиданное значение превращается в "?" и не ломает отрисовку.

import type { Sections, StateMessage } from "./protocol.js";
import { repairDeep } from "./text.js";

type Obj = Record<string, unknown>;

export interface LogEntry {
  time: Date;
  text: string;
}

/** Результат приёма сообщения: что изменилось (после исправления кодировки) и какие записи добавились в журнал. */
export interface ApplyResult {
  sections: Sections;
  log: LogEntry[];
}

/** Полное состояние для веб-панели. Время - в миллисекундах Unix. */
export interface StoreSnapshot {
  ref: string | null;
  seq: number;
  updates: number;
  updatedAt: number | null;
  sections: Sections;
  log: Array<{ t: number; text: string }>;
}

export interface RenderOptions {
  color?: boolean;
  /** Сколько строк инвентаря показывать. */
  maxItems?: number;
  /** Сколько записей журнала показывать. */
  maxLog?: number;
}

const MAX_LOG_KEPT = 200;

// ---------- безопасное чтение ----------

function obj(v: unknown): Obj | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function f1(n: number | null): string {
  return n === null ? "?" : n.toFixed(1);
}

function signed(n: number | null): string {
  if (n === null) return "?";
  const s = Math.abs(n).toFixed(1);
  return n < 0 ? `−${s}` : `+${s}`;
}

function yesNo(v: unknown): string {
  const b = bool(v);
  return b === null ? "?" : b ? "да" : "нет";
}

function time(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function named(v: unknown): string {
  const o = obj(v);
  if (o === null) return "нет";
  const id = str(o.id);
  const name = str(o.name);
  if (name && id) return `${name} (${id})`;
  return name || id || "нет";
}

// ---------- словари ----------

const LIFE_STATE: Record<string, string> = {
  alive: "жив",
  dying: "умирает",
  dead: "мёртв",
  unconscious: "без сознания",
  reanimate: "оживает",
  recycle: "recycle",
  restrained: "связан",
  essentialDown: "повален (неубиваемый)",
  bleedout: "при смерти (bleedout)",
};

const SIT_SLEEP: Record<string, string> = {
  normal: "обычное",
  wantToSit: "хочет сесть",
  waitingForSitAnim: "садится",
  sitting: "сидит",
  wantToStand: "встаёт",
  wantToSleep: "хочет спать",
  waitingForSleepAnim: "ложится",
  sleeping: "спит",
  wantToWake: "просыпается",
};

const WEAPON: Record<string, string> = {
  sheathed: "убрано",
  wantToDraw: "собирается достать",
  drawing: "достаёт",
  drawn: "обнажено",
  wantToSheathe: "собирается убрать",
  sheathing: "убирает",
};

function tr(map: Record<string, string>, key: unknown): string {
  const k = str(key);
  return map[k] ?? (k || "?");
}

const VITALS: ReadonlyArray<[string, string]> = [
  ["health", "Здоровье"],
  ["magicka", "Магия"],
  ["stamina", "Выносливость"],
];

const ATTRIBUTES: ReadonlyArray<[string, string]> = [
  ["aggression", "агрессия"],
  ["confidence", "уверенность"],
  ["energy", "энергия"],
  ["morality", "мораль"],
  ["mood", "настроение"],
  ["assistance", "помощь"],
  ["speedMult", "скорость %"],
  ["inventoryWeight", "вес вещей"],
  ["carryWeight", "грузоподъёмность"],
  ["healRate", "реген. здоровья"],
  ["magickaRate", "реген. магии"],
  ["staminaRate", "реген. выносливости"],
  ["paralysis", "паралич"],
  ["invisibility", "невидимость"],
];

// ---------- журнал изменений ----------

interface Item {
  id: string;
  name: string;
  type: string;
  count: number;
  worn: boolean;
}

function readItems(inv: unknown): Map<string, Item> {
  const out = new Map<string, Item>();
  for (const raw of arr(obj(inv)?.items)) {
    const o = obj(raw);
    if (o === null) continue;
    const id = str(o.id);
    if (!id) continue;
    out.set(id, {
      id,
      name: str(o.name) || id,
      type: str(o.type),
      count: num(o.count) ?? 0,
      worn: bool(o.worn) === true,
    });
  }
  return out;
}

function effectKey(e: Obj): string {
  return `${str(e.spellId)}|${str(e.effect)}`;
}

function effectLabel(e: Obj): string {
  const spell = str(e.spell) || str(e.effect) || str(e.spellId) || "?";
  const mag = num(e.magnitude);
  return mag !== null && mag !== 0 ? `${spell} (${f1(mag)})` : spell;
}

function diffSection(name: string, prev: unknown, next: unknown): string[] {
  const out: string[] = [];
  const p = obj(prev);
  const n = obj(next);

  switch (name) {
    case "vitals": {
      if (p === null || n === null) break;
      for (const [key, label] of VITALS) {
        const a = obj(p[key]);
        const b = obj(n[key]);
        const ca = num(a?.current);
        const cb = num(b?.current);
        if (ca !== null && cb !== null && Math.abs(cb - ca) >= 0.05) {
          out.push(`${label}: ${f1(ca)} → ${f1(cb)} (${signed(cb - ca)})`);
        }
        const ma = num(a?.max);
        const mb = num(b?.max);
        if (ma !== null && mb !== null && Math.abs(mb - ma) >= 0.05) {
          out.push(`${label}, максимум: ${f1(ma)} → ${f1(mb)}`);
        }
      }
      break;
    }

    case "state": {
      if (p === null || n === null) break;
      if (p.lifeState !== n.lifeState) out.push(`Состояние: ${tr(LIFE_STATE, p.lifeState)} → ${tr(LIFE_STATE, n.lifeState)}`);
      if (p.sitSleep !== n.sitSleep) out.push(`Поза: ${tr(SIT_SLEEP, p.sitSleep)} → ${tr(SIT_SLEEP, n.sitSleep)}`);
      if (p.weapon !== n.weapon) out.push(`Оружие: ${tr(WEAPON, p.weapon)} → ${tr(WEAPON, n.weapon)}`);
      for (const [key, label] of [
        ["sneaking", "Крадётся"],
        ["swimming", "Плывёт"],
        ["flying", "Летит"],
      ] as const) {
        if (p[key] !== n[key]) out.push(`${label}: ${yesNo(n[key])}`);
      }
      break;
    }

    case "combat": {
      if (p === null || n === null) break;
      if (p.inCombat !== n.inCombat) out.push(n.inCombat === true ? "Вступил в бой" : "Бой закончился");
      if (named(p.target) !== named(n.target)) out.push(`Цель боя: ${named(n.target)}`);
      if (p.hostileToPlayer !== n.hostileToPlayer) out.push(`Враждебен игроку: ${yesNo(n.hostileToPlayer)}`);
      break;
    }

    case "package": {
      const a = obj(prev);
      const b = obj(next);
      const label = (o: Obj | null): string => (o === null ? "нет" : `${str(o.type) || "?"} ${str(o.id)}${str(o.editorId) ? ` ${str(o.editorId)}` : ""}`);
      if (a?.id !== b?.id) out.push(`Пакет ИИ: ${label(a)} → ${label(b)}`);
      else if (a !== null && b !== null && a.procedure !== b.procedure) out.push(`Пакет ИИ, шаг: ${String(num(a.procedure) ?? "?")} → ${String(num(b.procedure) ?? "?")}`);
      break;
    }

    case "follower": {
      if (p === null || n === null) break;
      if (p.teammate !== n.teammate) out.push(`Спутник игрока: ${yesNo(n.teammate)}`);
      if (p.commanded !== n.commanded) out.push(`Призван/под командой: ${yesNo(n.commanded)}`);
      if (named(p.mount) !== named(n.mount)) out.push(`Верховое животное: ${named(n.mount)}`);
      break;
    }

    case "location": {
      if (p === null || n === null) break;
      const cell = (o: Obj): string => named(o.cell);
      if (cell(p) !== cell(n)) out.push(`Ячейка: ${cell(p)} → ${cell(n)}`);
      if (str(p.location) !== str(n.location)) out.push(`Локация: ${str(p.location) || "нет"} → ${str(n.location) || "нет"}`);
      break;
    }

    case "identity": {
      if (p === null || n === null) break;
      if (num(p.level) !== num(n.level)) out.push(`Уровень: ${String(num(p.level) ?? "?")} → ${String(num(n.level) ?? "?")}`);
      break;
    }

    case "presence": {
      if (p === null || n === null) break;
      if (p.available !== n.available) {
        out.push(n.available === true ? "Актёр снова доступен" : `Актёр недоступен: ${str(n.reason) || "причина неизвестна"}`);
      }
      if (p.loaded !== n.loaded && n.available === true) {
        out.push(n.loaded === true ? "Актёр загружен в мир" : "Актёр выгружен из мира (данные могут устареть)");
      }
      break;
    }

    case "attributes": {
      if (p === null || n === null) break;
      for (const [key, label] of ATTRIBUTES) {
        const a = num(p[key]);
        const b = num(n[key]);
        if (a !== null && b !== null && Math.abs(a - b) >= 0.05) out.push(`${label}: ${f1(a)} → ${f1(b)}`);
      }
      break;
    }

    case "inventory": {
      if (p === null || n === null) break;
      const a = readItems(p);
      const b = readItems(n);
      for (const [id, it] of b) {
        const old = a.get(id);
        if (old === undefined) out.push(`Инвентарь: +${it.count} ${it.name}`);
        else {
          if (old.count !== it.count) out.push(`Инвентарь: ${it.name} ${old.count} → ${it.count}`);
          if (old.worn !== it.worn) out.push(`${it.worn ? "Надел" : "Снял"}: ${it.name}`);
        }
      }
      for (const [id, it] of a) {
        if (!b.has(id)) out.push(`Инвентарь: −${it.count} ${it.name}`);
      }
      break;
    }

    case "factions": {
      const key = (v: unknown): Map<string, string> => {
        const m = new Map<string, string>();
        for (const raw of arr(v)) {
          const o = obj(raw);
          if (o !== null && str(o.id)) m.set(str(o.id), `${str(o.name) || str(o.id)} (ранг ${String(num(o.rank) ?? "?")})`);
        }
        return m;
      };
      if (!Array.isArray(prev) || !Array.isArray(next)) break;
      const a = key(prev);
      const b = key(next);
      for (const [id, label] of b) {
        if (!a.has(id)) out.push(`Фракция: +${label}`);
        else if (a.get(id) !== label) out.push(`Фракция: ${a.get(id)} → ${label}`);
      }
      for (const [id, label] of a) if (!b.has(id)) out.push(`Фракция: −${label}`);
      break;
    }

    case "effects": {
      if (!Array.isArray(prev) || !Array.isArray(next)) break;
      const map = (v: unknown[]): Map<string, string> => {
        const m = new Map<string, string>();
        for (const raw of v) {
          const o = obj(raw);
          if (o !== null) m.set(effectKey(o), effectLabel(o));
        }
        return m;
      };
      const a = map(prev);
      const b = map(next);
      for (const [k, label] of b) if (!a.has(k)) out.push(`Эффект: +${label}`);
      for (const [k, label] of a) if (!b.has(k)) out.push(`Эффект: −${label}`);
      break;
    }

    case "lastHit": {
      if (n === null) break;
      if (num(p?.count) === num(n.count)) break;
      const flags = [
        n.powerAttack === true ? "силовая" : "",
        n.sneakAttack === true ? "из скрытности" : "",
        n.bashAttack === true ? "башем" : "",
        n.blocked === true ? "заблокирован" : "",
      ].filter(Boolean);
      const source = obj(n.source) !== null ? `, ${named(n.source)}` : "";
      out.push(`Удар №${String(num(n.count) ?? "?")}: ${named(n.attacker)}${source}${flags.length ? ` [${flags.join(", ")}]` : ""}`);
      break;
    }

    default:
      break;
  }
  return out;
}

// ---------- хранилище и отрисовка ----------

export class NpcStore {
  ref: string | null = null;
  seq = 0;
  updates = 0;
  updatedAt: Date | null = null;
  connected = true;
  private sections: Sections = {};
  private log: LogEntry[] = [];

  /** Начать слежение за новым NPC: прежние данные и журнал сбрасываются. */
  begin(ref: string): void {
    this.ref = ref;
    this.sections = {};
    this.log = [];
    this.seq = 0;
    this.updates = 0;
    this.updatedAt = null;
  }

  /** Прекратить слежение. */
  clear(): void {
    this.ref = null;
    this.sections = {};
    this.log = [];
    this.seq = 0;
    this.updates = 0;
    this.updatedAt = null;
  }

  get watching(): boolean {
    return this.ref !== null;
  }

  get hasData(): boolean {
    return Object.keys(this.sections).length > 0;
  }

  note(text: string, now: Date = new Date()): LogEntry {
    return this.pushLog(now, text);
  }

  /** Принимает изменившиеся разделы. Возвращает false, если сообщение не про наблюдаемого NPC. */
  apply(msg: StateMessage, now: Date = new Date()): boolean {
    return this.applyDetailed(msg, now) !== null;
  }

  /** То же, но возвращает принятые разделы и новые записи журнала (для веб-панели и консоли). */
  applyDetailed(msg: StateMessage, now: Date = new Date()): ApplyResult | null {
    if (this.ref === null || msg.ref !== this.ref) return null;
    // Сообщения идут по одному TCP-соединению по порядку; откат seq означает новую сессию слежения.
    if (msg.seq <= this.seq && msg.seq !== 1) return null;

    const sections = repairDeep(msg.sections);
    const added: LogEntry[] = [];
    const first = !this.hasData;
    for (const [name, value] of Object.entries(sections)) {
      if (!first) {
        for (const text of diffSection(name, this.sections[name], value)) added.push(this.pushLog(now, text));
      }
      this.sections[name] = value;
    }
    if (first) added.push(this.pushLog(now, "Наблюдение начато"));
    this.seq = msg.seq;
    this.updates++;
    this.updatedAt = now;
    return { sections, log: added };
  }

  /** Подменяет раздел локально (например, пометить актёра выгруженным), записав событие в журнал. */
  forceSection(name: string, value: unknown, logText: string, now: Date = new Date()): LogEntry {
    this.sections[name] = value;
    return this.pushLog(now, logText);
  }

  /** Полное состояние для новой вкладки веб-панели. */
  snapshotData(): StoreSnapshot {
    return {
      ref: this.ref,
      seq: this.seq,
      updates: this.updates,
      updatedAt: this.updatedAt ? this.updatedAt.getTime() : null,
      sections: this.sections,
      log: this.log.map((e) => ({ t: e.time.getTime(), text: e.text })),
    };
  }

  private pushLog(time: Date, text: string): LogEntry {
    const entry: LogEntry = { time, text };
    this.log.push(entry);
    if (this.log.length > MAX_LOG_KEPT) this.log.splice(0, this.log.length - MAX_LOG_KEPT);
    return entry;
  }

  get journal(): readonly LogEntry[] {
    return this.log;
  }

  section(name: string): unknown {
    return this.sections[name];
  }

  render(options: RenderOptions = {}): string {
    const color = options.color === true;
    const maxItems = options.maxItems ?? 40;
    const maxLog = options.maxLog ?? 12;
    const paint = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
    const dim = (s: string): string => paint("2", s);
    const bold = (s: string): string => paint("1", s);

    if (this.ref === null) {
      return "Наблюдение выключено. Введите: watch <refID>   (help - справка)";
    }

    const L: string[] = [];
    const idn = obj(this.sections.identity);
    const presence = obj(this.sections.presence);

    // Заголовок
    const title = [
      idn ? str(idn.name) || "без имени" : "ожидание данных",
      idn ? str(idn.race) : "",
      idn && num(idn.level) !== null ? `ур. ${String(num(idn.level))}` : "",
    ].filter(Boolean);
    L.push(bold(`═══ NPC ${this.ref} · ${title.join(" · ")} ═══`));

    // Статус связи
    let status = paint("32", "[ОНЛАЙН]");
    if (!this.connected) status = paint("31", "[ИГРА ОТКЛЮЧЕНА, данные устарели]");
    else if (presence !== null && presence.available === false) status = paint("31", `[НЕДОСТУПЕН: ${str(presence.reason) || "?"}]`);
    else if (presence !== null && presence.loaded === false) status = paint("33", "[НЕ ЗАГРУЖЕН В МИР, данные могут быть устаревшими]");
    else if (!this.hasData) status = paint("33", "[ждём данные от игры…]");
    L.push(`${status}  ${dim(`обновлено ${this.updatedAt ? time(this.updatedAt) : "-"} · пакетов: ${this.updates} · seq ${this.seq}`)}`);
    if (idn) L.push(dim(`baseID ${str(idn.baseId) || "?"}${idn.isPlayer === true ? " · это игрок" : ""}`));
    L.push("");

    // Показатели
    const vitals = obj(this.sections.vitals);
    if (vitals) {
      L.push(bold("Показатели"));
      for (const [key, label] of VITALS) {
        const v = obj(vitals[key]);
        if (v === null) continue;
        const cur = num(v.current);
        const max = num(v.max);
        const pct = cur !== null && max !== null && max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
        const filled = Math.round(pct * 20);
        const bar = "█".repeat(filled) + "░".repeat(20 - filled);
        const barColor = key === "health" ? (pct > 0.5 ? "32" : pct > 0.25 ? "33" : "31") : key === "magicka" ? "34" : "32";
        L.push(
          `  ${label.padEnd(13)} ${f1(cur).padStart(7)} / ${f1(max).padEnd(7)} ${paint(barColor, bar)} ${String(Math.round(pct * 100)).padStart(3)}%`,
        );
        L.push(
          dim(
            `  ${"".padEnd(13)} база ${f1(num(v.base))} · постоянный ${signed(num(v.modPermanent))} · временный ${signed(num(v.modTemporary))} · урон ${signed(num(v.damage))}`,
          ),
        );
      }
      L.push("");
    }

    // Положение
    const pos = obj(this.sections.position);
    const loc = obj(this.sections.location);
    if (pos || loc) {
      L.push(bold("Положение"));
      if (pos) L.push(`  x ${f1(num(pos.x))}  y ${f1(num(pos.y))}  z ${f1(num(pos.z))}  · угол ${f1(num(pos.angleZ))}°`);
      if (loc) {
        L.push(`  ячейка: ${named(loc.cell)}`);
        L.push(`  мир: ${str(loc.worldspace) || "нет"} · локация: ${str(loc.location) || "нет"}`);
      }
      L.push("");
    }

    // ИИ и поведение
    const st = obj(this.sections.state);
    const combat = obj(this.sections.combat);
    const pkg = this.sections.package;
    const fol = obj(this.sections.follower);
    if (st || combat || pkg !== undefined || fol) {
      L.push(bold("ИИ и поведение"));
      if (st) {
        L.push(`  состояние: ${tr(LIFE_STATE, st.lifeState)} · поза: ${tr(SIT_SLEEP, st.sitSleep)} · оружие: ${tr(WEAPON, st.weapon)}`);
        const moves = [
          ["идёт", st.walking],
          ["бежит", st.running],
          ["спринт", st.sprinting],
          ["крадётся", st.sneaking],
          ["плывёт", st.swimming],
          ["летит", st.flying],
        ]
          .filter(([, v]) => v === true)
          .map(([k]) => String(k));
        L.push(`  движение: ${moves.length ? moves.join(", ") : "стоит"}`);
        const flags = [
          ["неубиваемый", st.essential],
          ["защищённый", st.protected],
          ["призрак", st.ghost],
        ]
          .filter(([, v]) => v === true)
          .map(([k]) => String(k));
        if (flags.length) L.push(`  флаги: ${flags.join(", ")}`);
      }
      if (combat) {
        L.push(
          `  бой: ${yesNo(combat.inCombat)} · цель: ${named(combat.target)} · враждебен игроку: ${yesNo(combat.hostileToPlayer)} · зол на игрока: ${yesNo(combat.angryWithPlayer)}`,
        );
      }
      if (pkg !== undefined) {
        const p = obj(pkg);
        if (p === null) L.push("  пакет ИИ: нет");
        else {
          L.push(
            `  пакет ИИ: ${str(p.type) || "?"} ${str(p.id)}${str(p.editorId) ? ` (${str(p.editorId)})` : ""} · шаг ${String(num(p.procedure) ?? "?")} · цель: ${named(p.target)}`,
          );
        }
      }
      if (fol) {
        L.push(
          `  спутник игрока: ${yesNo(fol.teammate)} · под командой: ${yesNo(fol.commanded)} · хозяин: ${named(fol.commander)} · верховое: ${named(fol.mount)}`,
        );
      }
      L.push("");
    }

    // Характеристики поведения
    const attrs = obj(this.sections.attributes);
    if (attrs) {
      L.push(bold("Характеристики"));
      const parts = ATTRIBUTES.map(([key, label]) => `${label} ${f1(num(attrs[key]))}`);
      for (let i = 0; i < parts.length; i += 4) L.push(`  ${parts.slice(i, i + 4).join(" · ")}`);
      L.push("");
    }

    // Фракции
    if (Array.isArray(this.sections.factions)) {
      const list = arr(this.sections.factions)
        .map(obj)
        .filter((o): o is Obj => o !== null)
        .map((o) => `${str(o.name) || str(o.id)} [${String(num(o.rank) ?? "?")}]`);
      L.push(bold(`Фракции (${list.length})`));
      L.push(list.length ? `  ${list.join(", ")}` : "  нет");
      L.push("");
    }

    // Эффекты
    if (Array.isArray(this.sections.effects)) {
      const list = arr(this.sections.effects)
        .map(obj)
        .filter((o): o is Obj => o !== null);
      L.push(bold(`Активные эффекты (${list.length})`));
      if (!list.length) L.push("  нет");
      for (const e of list.slice(0, 15)) {
        const remaining = num(e.remaining);
        const dur = num(e.duration);
        const timing = dur !== null && dur > 0 ? ` · осталось ${remaining ?? "?"} с из ${dur}` : " · постоянный";
        L.push(`  ${effectLabel(e)}${str(e.effect) && str(e.spell) !== str(e.effect) ? ` — ${str(e.effect)}` : ""}${timing}`);
      }
      if (list.length > 15) L.push(dim(`  … и ещё ${list.length - 15}`));
      L.push("");
    }

    // Инвентарь
    const inv = obj(this.sections.inventory);
    if (inv) {
      const items = [...readItems(inv).values()].sort(
        (a, b) => Number(b.worn) - Number(a.worn) || a.name.localeCompare(b.name, "ru"),
      );
      L.push(bold(`Инвентарь (${items.length} поз., золото ${String(num(inv.gold) ?? 0)})`));
      if (!items.length) L.push("  пусто");
      for (const it of items.slice(0, maxItems)) {
        L.push(`  ${it.worn ? paint("32", "[надето]") : "        "} ${it.name} ×${it.count} ${dim(`${it.id} ${it.type}`)}`);
      }
      if (items.length > maxItems) L.push(dim(`  … и ещё ${items.length - maxItems}`));
      L.push("");
    }

    // Последний удар
    const hit = obj(this.sections.lastHit);
    if (hit) {
      const flags = [
        hit.powerAttack === true ? "силовая" : "",
        hit.sneakAttack === true ? "из скрытности" : "",
        hit.bashAttack === true ? "башем" : "",
        hit.blocked === true ? "заблокирован" : "",
      ].filter(Boolean);
      L.push(bold("Последний удар по NPC"));
      L.push(
        `  №${String(num(hit.count) ?? "?")} · атаковал: ${named(hit.attacker)} · чем: ${obj(hit.source) ? named(hit.source) : "—"}${flags.length ? ` · ${flags.join(", ")}` : ""}`,
      );
      L.push("");
    }

    // Журнал
    L.push(bold("Журнал изменений"));
    const recent = this.log.slice(-maxLog);
    if (!recent.length) L.push("  пока пусто");
    for (const e of recent) L.push(`  ${dim(time(e.time))}  ${e.text}`);
    L.push("");
    L.push(dim("watch <refID> — сменить NPC · watch off — выключить · quit — выход"));

    return L.join("\n");
  }
}
