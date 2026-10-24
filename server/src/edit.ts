// Допустимые правки NPC. Здесь проверяется форма и диапазон; окончательные проверки (жив ли NPC,
// есть ли предмет, загружен ли актёр) делает плагин, потому что только он видит игру.
//
// Меняются только данные экземпляра. Имя, FormID, baseID, уровень, раса, флаги неубиваемости
// и другие постоянные данные записи в списке отсутствуют: изменить их нельзя.

import { parseRef } from "./protocol.js";

export interface SetRequest {
  field: string;
  arg?: string;
  value?: number;
}

export type Validated = ({ ok: true } & SetRequest) | { ok: false; message: string };

const VITALS = ["health", "magicka", "stamina"] as const;
const VITAL_PARTS = ["current", "max", "base", "modPermanent", "modTemporary", "damage"] as const;
export const ATTRIBUTES = [
  "aggression",
  "confidence",
  "energy",
  "morality",
  "mood",
  "assistance",
  "speedMult",
  "carryWeight",
  "healRate",
  "magickaRate",
  "staminaRate",
  "paralysis",
  "invisibility",
] as const;
const POSITIONS = ["x", "y", "z"] as const;
const SIMPLE_ACTIONS = ["kill", "resurrect", "drawWeapon", "sheatheWeapon", "stopCombat"] as const;

const MAX_ABS = 1_000_000;
const MAX_ANGLE = 720;

function inList(list: readonly string[], v: string): boolean {
  return list.includes(v);
}

function needNumber(value: unknown, limit: number): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, message: "нужно число" };
  if (Math.abs(value) > limit) return { ok: false, message: `число вне допустимого диапазона (по модулю не больше ${limit})` };
  return { ok: true, value };
}

function needInteger(value: unknown, min: number, max: number, fallback?: number): { ok: true; value: number } | { ok: false; message: string } {
  const v = value === undefined || value === null ? fallback : value;
  if (typeof v !== "number" || !Number.isInteger(v)) return { ok: false, message: "нужно целое число" };
  if (v < min || v > max) return { ok: false, message: `число должно быть от ${min} до ${max}` };
  return { ok: true, value: v };
}

function needRef(arg: unknown, what: string): { ok: true; arg: string } | { ok: false; message: string } {
  if (typeof arg !== "string") return { ok: false, message: `нужен FormID: ${what}` };
  const ref = parseRef(arg);
  if (ref === null) return { ok: false, message: `«${arg.trim().slice(0, 40)}» не похоже на FormID (до 8 шестнадцатеричных цифр или player)` };
  return { ok: true, arg: ref };
}

/** Проверяет запрос на изменение и приводит его к виду, который понимает плагин. */
export function validateSet(field: unknown, arg: unknown, value: unknown): Validated {
  if (typeof field !== "string" || field.length === 0 || field.length > 64) return { ok: false, message: "не указано поле" };
  const parts = field.split(".");
  const [group, a, b] = parts;

  if (group === "vitals" && parts.length === 3 && a && b && inList(VITALS, a) && inList(VITAL_PARTS, b)) {
    const n = needNumber(value, MAX_ABS);
    if (!n.ok) return n;
    if (a === "health" && b === "current" && n.value < 1) {
      return { ok: false, message: "здоровье не может быть меньше 1; для смерти используйте действие «Убить»" };
    }
    if (b !== "modPermanent" && b !== "modTemporary" && b !== "damage" && n.value < 0) {
      return { ok: false, message: "значение не может быть отрицательным" };
    }
    return { ok: true, field, value: n.value };
  }

  if (group === "attributes" && parts.length === 2 && a && inList(ATTRIBUTES, a)) {
    const n = needNumber(value, MAX_ABS);
    if (!n.ok) return n;
    return { ok: true, field, value: n.value };
  }

  if (group === "position" && parts.length === 2 && a && (inList(POSITIONS, a) || a === "angleZ")) {
    const n = needNumber(value, a === "angleZ" ? MAX_ANGLE : MAX_ABS);
    if (!n.ok) return n;
    return { ok: true, field, value: n.value };
  }

  if (group === "action" && parts.length === 2 && a) {
    if (inList(SIMPLE_ACTIONS, a)) return { ok: true, field };
    if (a === "startCombat") {
      const r = needRef(arg, "цель боя");
      return r.ok ? { ok: true, field, arg: r.arg } : r;
    }
  }

  if (group === "faction" && parts.length === 2 && a) {
    if (a === "add" || a === "rank") {
      const r = needRef(arg, "фракция");
      if (!r.ok) return r;
      const rank = needInteger(value, -128, 127, 0);
      if (!rank.ok) return { ok: false, message: `ранг: ${rank.message}` };
      return { ok: true, field, arg: r.arg, value: rank.value };
    }
    if (a === "remove") {
      const r = needRef(arg, "фракция");
      return r.ok ? { ok: true, field, arg: r.arg } : r;
    }
  }

  if (group === "inventory" && parts.length === 2 && a) {
    if (a === "add" || a === "remove") {
      const r = needRef(arg, "предмет");
      if (!r.ok) return r;
      const count = needInteger(value, 1, 100_000, 1);
      if (!count.ok) return { ok: false, message: `количество: ${count.message}` };
      return { ok: true, field, arg: r.arg, value: count.value };
    }
    if (a === "equip" || a === "unequip") {
      const r = needRef(arg, "предмет");
      return r.ok ? { ok: true, field, arg: r.arg } : r;
    }
  }

  return { ok: false, message: `поле «${field}» нельзя изменить (постоянные данные NPC не редактируются)` };
}
