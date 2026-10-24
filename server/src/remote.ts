// Копия мира админа на стороне игрока: накапливает события, полученные от админа, чтобы новая вкладка
// браузера сразу получила полный снимок. Устроено так же, как модель в веб-панели.

type Obj = Record<string, unknown>;

interface Actor {
  sections: Obj;
  log: Array<{ t: number; text: string }>;
  seq: number;
  updates: number;
  updatedAt: number | null;
}

const MAX_LOG = 200;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class RemoteWorld {
  private actors = new Map<string, Actor>();
  tracking = false;
  selected: string | null = null;
  gameConnected = false;
  plugin: unknown = null;

  get size(): number {
    return this.actors.size;
  }

  has(ref: string): boolean {
    return this.actors.has(ref);
  }

  reset(): void {
    this.actors.clear();
    this.tracking = false;
    this.selected = null;
    this.gameConnected = false;
    this.plugin = null;
  }

  /** Связь с админом потеряна: данные остаются, но помечаются устаревшими. */
  markStale(): void {
    this.gameConnected = false;
  }

  private entry(ref: string): Actor {
    let a = this.actors.get(ref);
    if (a === undefined) {
      a = { sections: {}, log: [], seq: 0, updates: 0, updatedAt: null };
      this.actors.set(ref, a);
    }
    return a;
  }

  private pushLog(a: Actor, entries: unknown): void {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (isObj(e) && typeof e.t === "number" && typeof e.text === "string") a.log.push({ t: e.t, text: e.text });
    }
    if (a.log.length > MAX_LOG) a.log.splice(0, a.log.length - MAX_LOG);
  }

  /** Применяет событие админа. Неизвестные и некорректные события игнорируются. */
  apply(ev: unknown): void {
    if (!isObj(ev)) return;
    switch (ev.type) {
      case "snapshot": {
        this.actors.clear();
        if (isObj(ev.actors)) {
          for (const [ref, v] of Object.entries(ev.actors)) {
            if (!isObj(v)) continue;
            const a = this.entry(ref);
            a.sections = isObj(v.sections) ? { ...v.sections } : {};
            a.seq = typeof v.seq === "number" ? v.seq : 0;
            a.updates = typeof v.updates === "number" ? v.updates : 0;
            a.updatedAt = typeof v.updatedAt === "number" ? v.updatedAt : null;
            this.pushLog(a, v.log);
          }
        }
        this.tracking = ev.tracking === true;
        this.selected = typeof ev.selected === "string" ? ev.selected : null;
        this.gameConnected = ev.gameConnected === true;
        this.plugin = ev.plugin ?? null;
        break;
      }
      case "state": {
        if (typeof ev.ref !== "string" || !isObj(ev.sections)) break;
        const a = this.entry(ev.ref);
        Object.assign(a.sections, ev.sections);
        if (typeof ev.seq === "number") a.seq = ev.seq;
        if (typeof ev.updates === "number") a.updates = ev.updates;
        if (typeof ev.updatedAt === "number") a.updatedAt = ev.updatedAt;
        this.pushLog(a, ev.log);
        break;
      }
      case "gone": {
        if (typeof ev.ref !== "string") break;
        if (ev.removed === false) {
          const a = this.actors.get(ev.ref);
          if (a !== undefined) a.sections.presence = { available: true, loaded: false, reason: "" };
        } else {
          this.actors.delete(ev.ref);
        }
        break;
      }
      case "log": {
        if (typeof ev.ref !== "string") break;
        const a = this.actors.get(ev.ref);
        if (a !== undefined) this.pushLog(a, ev.entries);
        break;
      }
      case "world":
        this.tracking = ev.tracking === true;
        break;
      case "status":
        this.gameConnected = ev.gameConnected === true;
        if (ev.plugin !== undefined) this.plugin = ev.plugin;
        break;
      default:
        break;
    }
  }

  snapshotEvent(): Obj {
    const actors: Obj = {};
    for (const [ref, a] of this.actors) {
      actors[ref] = { sections: a.sections, log: a.log.slice(-50), seq: a.seq, updates: a.updates, updatedAt: a.updatedAt };
    }
    return { type: "snapshot", gameConnected: this.gameConnected, plugin: this.plugin, tracking: this.tracking, selected: this.selected, actors };
  }
}
