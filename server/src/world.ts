// Реестр всех отслеживаемых актёров на сервере: для каждого свой NpcStore (данные и журнал),
// плюс выбранный NPC и признак «слежение за всеми включено».

import { NpcStore, type ApplyResult, type LogEntry, type StoreSnapshot } from "./npc.js";
import type { StateMessage } from "./protocol.js";

/** Сколько записей журнала каждого актёра отдавать новой вкладке браузера. */
const SNAPSHOT_LOG_ENTRIES = 50;

export interface WorldSnapshot {
  tracking: boolean;
  selected: string | null;
  actors: Record<string, StoreSnapshot>;
}

export class World {
  private readonly actors = new Map<string, NpcStore>();
  /** Слежение за всеми загруженными NPC включено (подтверждено плагином). */
  tracking = false;
  /** Выбранный NPC: за ним идёт быстрое чтение; его журнал печатается в консоль. */
  selected: string | null = null;
  /** Игра подключена (для панели и для отображения устаревших данных). */
  connected = true;

  get size(): number {
    return this.actors.size;
  }

  has(ref: string): boolean {
    return this.actors.has(ref);
  }

  get(ref: string): NpcStore | undefined {
    return this.actors.get(ref);
  }

  refs(): string[] {
    return [...this.actors.keys()];
  }

  /** Принимает изменения актёра; неизвестного заводит. Возвращает хранилище и результат или null. */
  apply(msg: StateMessage, now: Date = new Date()): { store: NpcStore; result: ApplyResult } | null {
    let store = this.actors.get(msg.ref);
    if (store === undefined) {
      store = new NpcStore();
      store.begin(msg.ref);
      this.actors.set(msg.ref, store);
    }
    store.connected = this.connected;
    const result = store.applyDetailed(msg, now);
    if (result === null) return null;
    return { store, result };
  }

  /**
   * Актёр выгружен из мира. Выбранного оставляем с пометкой «не загружен» (чтобы были видны последние
   * данные), остальных удаляем. Возвращает true, если запись удалена.
   */
  gone(ref: string, now: Date = new Date()): { removed: boolean; entry?: LogEntry } {
    const store = this.actors.get(ref);
    if (store === undefined) return { removed: true };
    if (ref === this.selected) {
      const entry = store.forceSection(
        "presence",
        { available: true, loaded: false, reason: "" },
        "Актёр выгружен из мира (данные могут устареть)",
        now,
      );
      return { removed: false, entry };
    }
    this.actors.delete(ref);
    return { removed: true };
  }

  /** Плагин сбросил слежение (переподключение игры или выключение): всё забываем, кроме выбранного. */
  reset(): void {
    const keep = this.selected !== null ? this.actors.get(this.selected) : undefined;
    this.actors.clear();
    if (keep !== undefined && this.selected !== null) this.actors.set(this.selected, keep);
    this.tracking = false;
  }

  /** Хранилище выбранного NPC. */
  selectedStore(): NpcStore | undefined {
    return this.selected === null ? undefined : this.actors.get(this.selected);
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    for (const s of this.actors.values()) s.connected = connected;
  }

  snapshotData(): WorldSnapshot {
    const actors: Record<string, StoreSnapshot> = {};
    for (const [ref, store] of this.actors) {
      const snap = store.snapshotData();
      actors[ref] = { ...snap, log: snap.log.slice(-SNAPSHOT_LOG_ENTRIES) };
    }
    return { tracking: this.tracking, selected: this.selected, actors };
  }
}
