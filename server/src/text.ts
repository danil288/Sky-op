// Восстановление текста, который плагин перекодировал дважды.
//
// Игра отдаёт строки уже в UTF-8, а плагин считает их ANSI (cp1251) и переводит в UTF-8 ещё раз.
// Из "Свен" получается "РЎРІРµРЅ". Здесь это отменяется: символы переводятся обратно в байты cp1251,
// и если байты складываются в корректный UTF-8, возвращается исправленная строка.
// Нормальный русский текст в такой UTF-8 не складывается, поэтому он остаётся без изменений.
// Правильное исправление - в плагине (Text.cpp); это защита на стороне сервера.

const CP1251_BYTE: ReadonlyMap<string, number> | null = (() => {
  try {
    const decoder = new TextDecoder("windows-1251");
    const map = new Map<string, number>();
    for (let b = 0x80; b <= 0xff; b++) {
      map.set(decoder.decode(Uint8Array.of(b)), b);
    }
    return map;
  } catch {
    return null; // сборка Node без нужной кодировки: восстановление отключено
  }
})();

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

export function repairMojibake(text: string): string {
  if (CP1251_BYTE === null || text === "") return text;

  const bytes: number[] = [];
  let hasHigh = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const b = CP1251_BYTE.get(ch);
    if (b === undefined) return text; // символ вне cp1251: это не результат двойной перекодировки
    bytes.push(b);
    hasHigh = true;
  }
  if (!hasHigh) return text;

  try {
    return UTF8_STRICT.decode(Uint8Array.from(bytes));
  } catch {
    return text;
  }
}

/** Применяет repairMojibake ко всем строкам внутри значения (ключи объектов не трогаются). */
export function repairDeep<T>(value: T): T {
  if (typeof value === "string") return repairMojibake(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => repairDeep(v)) as unknown as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = repairDeep(v);
    return out as T;
  }
  return value;
}
