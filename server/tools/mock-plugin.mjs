// Имитатор плагина: позволяет проверить сервер без запуска игры.
//   node tools/mock-plugin.mjs            (в другом окне, пока работает сервер)
// В «мире» несколько выдуманных NPC и игрок. Команда world включает слежение за всеми, watch выбирает NPC
// (его данные приходят каждые 50 мс, остальных - реже), set меняет выбранного так же, как настоящий плагин.
// Каждые MOCK_HIT_MS мс выбранный NPC получает удар (-7 здоровья; 0 - без ударов), NPC медленно бродят,
// а каждые MOCK_CHURN_MS мс один из них «выгружается» и позже возвращается (0 - не выгружать).
// refID 00000000 и DEADBEEF имитируют «актёр не найден». Формат разделов и сообщения те же, что у плагина.

import net from "node:net";

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? 7777);
const HIT_MS = Number(process.env.MOCK_HIT_MS ?? 3000);
const CHURN_MS = Number(process.env.MOCK_CHURN_MS ?? 15000);
const TICK_MS = 50;

const VITAL_LABEL = { health: "Здоровье", magicka: "Магия", stamina: "Выносливость" };
const PART_LABEL = { current: "текущее", max: "максимум", base: "база", modPermanent: "постоянный модификатор", modTemporary: "временный модификатор", damage: "урон" };
const ATTR_LABEL = { aggression: "Агрессия", confidence: "Уверенность", energy: "Энергия", morality: "Мораль", mood: "Настроение", assistance: "Помощь", speedMult: "Скорость %", carryWeight: "Грузоподъёмность", healRate: "Регенерация здоровья", magickaRate: "Регенерация магии", staminaRate: "Регенерация выносливости", paralysis: "Паралич", invisibility: "Невидимость" };

const ROSTER = [
  { ref: "00000014", name: "Игрок", race: "Нордик", level: 20, hp: 180, x: 1500, y: -2200, isPlayer: true },
  { ref: "00013491", name: "Свен", race: "Норд", level: 6, hp: 91, x: 1560, y: -2150 },
  { ref: "00013492", name: "Стражник Вайтрана", race: "Нордик", level: 12, hp: 100, x: 1620, y: -2300 },
  { ref: "00013493", name: "Лидия", race: "Нордик", level: 8, hp: 140, x: 1450, y: -2100 },
  { ref: "00013494", name: "Бретонский торговец", race: "Бретон", level: 4, hp: 75, x: 1800, y: -2500 },
  { ref: "00013495", name: "Волк", race: "Волк", level: 3, hp: 60, x: 1350, y: -2400 },
  { ref: "00013496", name: "Разбойник", race: "Имперец", level: 9, hp: 110, x: 2100, y: -2000 },
];

function makeNpc(spec) {
  const vital = (base) => ({ base, modPermanent: 0, modTemporary: 0, damage: 0 });
  const wolf = spec.race === "Волк";
  return {
    spec,
    vitals: { health: vital(spec.hp), magicka: vital(50), stamina: vital(100) },
    attrs: { aggression: wolf ? 2 : 1, confidence: 3, energy: 50, morality: 3, mood: 0, assistance: 1, speedMult: 100, carryWeight: 300, healRate: 0.7, magickaRate: 3, staminaRate: 5, paralysis: 0, invisibility: 0 },
    pos: { x: spec.x, y: spec.y, z: 64.0, angleZ: 90.0 },
    dead: false,
    weaponDrawn: false,
    hits: 0,
    attacker: null,
    inCombat: false,
    combatTarget: null,
    factions: wolf ? [] : [{ id: "00028849", name: "Стража Вайтрана", rank: 0 }],
    items: wolf
      ? []
      : [
          { id: "0000000F", name: "Золото", type: "MISC", count: 120, worn: false },
          { id: "00012EB7", name: "Железный меч", type: "WEAP", count: 1, worn: true },
          { id: "00013952", name: "Железный шлем", type: "ARMO", count: 1, worn: true },
          { id: "00073936", name: "Лечебное зелье", type: "ALCH", count: 2, worn: false },
        ],
  };
}

const maxOf = (v) => v.base + v.modPermanent + v.modTemporary;
const curOf = (v) => maxOf(v) + v.damage;

function sectionsOf(npc, ref) {
  const vital = (v) => ({ current: curOf(v), max: maxOf(v), base: v.base, permanent: v.base + v.modPermanent, modPermanent: v.modPermanent, modTemporary: v.modTemporary, damage: v.damage });
  const dead = npc.dead;
  const sections = {
    presence: { available: true, loaded: true, reason: "" },
    identity: { refId: ref, baseId: "0001A6A7", name: npc.spec.name, race: npc.spec.race, level: npc.spec.level, isPlayer: npc.spec.isPlayer === true },
    vitals: { health: vital(npc.vitals.health), magicka: vital(npc.vitals.magicka), stamina: vital(npc.vitals.stamina) },
    attributes: { ...npc.attrs, inventoryWeight: 35 },
    position: { ...npc.pos },
    location: { cell: { id: "00000F4C", name: "Вайтран" }, worldspace: "Тамриэль", location: "Вайтран" },
    state: { lifeState: dead ? "dead" : "alive", sitSleep: "normal", weapon: npc.weaponDrawn ? "drawn" : "sheathed", walking: false, running: false, sprinting: false, sneaking: false, swimming: false, flying: false, dead, essential: false, protected: false, ghost: false },
    combat: { inCombat: npc.inCombat, target: npc.combatTarget, hostileToPlayer: npc.inCombat, angryWithPlayer: npc.inCombat },
    package: { id: "0001B2C3", editorId: "", type: "Patrol", procedure: 1, target: null },
    follower: { teammate: false, commanded: false, commander: null, mount: null },
    factions: npc.factions.map((f) => ({ ...f })),
    effects: [],
    inventory: { gold: npc.items.find((i) => i.id === "0000000F")?.count ?? 0, items: npc.items.map((i) => ({ ...i })) },
  };
  if (npc.hits > 0) {
    sections.lastHit = { count: npc.hits, attacker: npc.attacker, source: { id: "00012EB7", name: "Железный меч" }, powerAttack: false, sneakAttack: false, bashAttack: false, blocked: false };
  }
  return sections;
}

const n1 = (v) => v.toFixed(1);

/** Имитация Editor.cpp: те же поля, те же сообщения об ошибках. Возвращает { ok, message }. */
function applySet(npc, msg) {
  const parts = String(msg.field).split(".");
  const [group, a, b] = parts;
  const value = msg.value;
  const ok = (message) => ({ ok: true, message });
  const fail = (message) => ({ ok: false, message });

  if (group === "vitals" && parts.length === 3) {
    const v = npc.vitals[a];
    if (!v || !(b in PART_LABEL)) return fail("неизвестный показатель: " + a);
    if (typeof value !== "number") return fail("нужно число (value)");
    const cur = curOf(v), max = maxOf(v);
    let delta, read, apply;
    if (b === "current") { const t = Math.min(value, max); delta = t - cur; read = () => curOf(v); apply = () => { v.damage += delta; }; }
    else if (b === "max") { delta = value - max; read = () => maxOf(v); apply = () => { v.modPermanent += delta; }; }
    else if (b === "base") { delta = value - v.base; read = () => v.base; apply = () => { v.base += delta; }; }
    else { delta = value - v[b === "damage" ? "damage" : b]; read = () => v[b]; apply = () => { v[b] += delta; }; }
    if (a === "health" && cur + delta < 1) return fail("здоровье упало бы до нуля или ниже; для смерти используйте действие «Убить»");
    const before = read(); apply(); const after = read();
    return ok(`${VITAL_LABEL[a]}, ${PART_LABEL[b]}: ${n1(before)} → ${n1(after)}`);
  }
  if (group === "attributes" && parts.length === 2) {
    if (!(a in npc.attrs)) return fail("неизвестная характеристика: " + a);
    if (typeof value !== "number") return fail("нужно число (value)");
    const before = npc.attrs[a]; npc.attrs[a] = value;
    return ok(`${ATTR_LABEL[a]}: ${n1(before)} → ${n1(value)}`);
  }
  if (group === "position" && parts.length === 2) {
    if (!(a in npc.pos)) return fail("неизвестная ось: " + a);
    if (typeof value !== "number") return fail("нужно число (value)");
    const before = npc.pos[a]; npc.pos[a] = value;
    return ok(a === "angleZ" ? `Угол: ${n1(before)}° → ${n1(value)}°` : `Координата ${a}: ${n1(before)} → ${n1(value)}`);
  }
  if (group === "action" && parts.length === 2) {
    switch (a) {
      case "kill": if (npc.dead) return fail("NPC уже мёртв"); npc.dead = true; npc.vitals.health.damage = -maxOf(npc.vitals.health); return ok("NPC убит");
      case "resurrect": if (!npc.dead) return fail("NPC жив, воскрешать нечего"); npc.dead = false; npc.vitals.health.damage = 0; return ok("NPC воскрешён");
      case "drawWeapon": npc.weaponDrawn = true; return ok("Оружие доставать: команда отправлена");
      case "sheatheWeapon": npc.weaponDrawn = false; return ok("Оружие убирать: команда отправлена");
      case "stopCombat": if (!npc.inCombat) return fail("NPC не в бою"); npc.inCombat = false; npc.combatTarget = null; return ok("Бой прекращён");
      case "startCombat": npc.inCombat = true; npc.combatTarget = { id: msg.arg, name: msg.arg === "00000014" ? "Игрок" : "" }; return ok(`Бой начат с ${msg.arg}`);
    }
  }
  if (group === "faction" && parts.length === 2) {
    const f = npc.factions.find((x) => x.id === msg.arg);
    if (a === "remove") { if (!f) return fail("NPC не состоит в этой фракции"); npc.factions = npc.factions.filter((x) => x !== f); return ok(`Фракция ${msg.arg}: удалена`); }
    if (a === "rank" && !f) return fail("NPC не состоит в этой фракции: используйте добавление");
    const rank = msg.value ?? 0;
    if (f) { const before = f.rank; f.rank = rank; return ok(`Фракция ${msg.arg}: ранг ${before} → ${rank}`); }
    npc.factions.push({ id: msg.arg, name: "Фракция " + msg.arg, rank }); return ok(`Фракция ${msg.arg}: добавлена, ранг ${rank}`);
  }
  if (group === "inventory" && parts.length === 2) {
    const item = npc.items.find((x) => x.id === msg.arg);
    const before = item?.count ?? 0;
    if (a === "add") { const n = msg.value ?? 1; if (item) item.count += n; else npc.items.push({ id: msg.arg, name: "Предмет " + msg.arg, type: "MISC", count: n, worn: false }); return ok(`Предмет ${msg.arg}: ${before} → ${before + n} шт.`); }
    if (a === "remove") { const n = msg.value ?? 1; if (before < n) return fail(`у NPC только ${before} шт. предмета ${msg.arg}`); item.count -= n; if (item.count === 0) npc.items = npc.items.filter((x) => x !== item); return ok(`Предмет ${msg.arg}: ${before} → ${before - n} шт.`); }
    if (!item) return fail(`у NPC нет предмета ${msg.arg}`);
    if (a === "equip") { item.worn = true; return ok(`Предмет ${msg.arg}: надевание запрошено`); }
    if (a === "unequip") { item.worn = false; return ok(`Предмет ${msg.arg}: снятие запрошено`); }
  }
  return fail("неизвестное или недоступное для изменения поле: " + msg.field);
}

function connect() {
  const socket = net.createConnection({ host: HOST, port: PORT });
  socket.setEncoding("utf8");

  const send = (obj) => socket.write(JSON.stringify(obj) + "\n");
  const result = (id, status, message = "") => send({ type: "result", id, status, message });

  // «Мир» этого соединения: после переподключения плагин всё забывает, как и настоящий.
  const npcs = new Map(ROSTER.map((spec) => [spec.ref, makeNpc(spec)])); // загруженные сейчас
  const unloaded = new Map(); // выгруженные: вернутся позже
  const sent = new Map(); // ref -> { last: Map(section -> json), seq }
  let world = false;
  let focus = null;
  let tick = 0;
  const timers = [];

  const tracked = () => {
    const set = new Set(world ? npcs.keys() : []);
    if (focus && npcs.has(focus)) set.add(focus);
    return set;
  };

  /** Приводит набор отправленных к нужному: для выпавших шлёт gone. */
  function syncTracked() {
    const want = tracked();
    for (const ref of [...sent.keys()]) {
      if (!want.has(ref)) { sent.delete(ref); send({ type: "gone", ref }); }
    }
    for (const ref of want) if (!sent.has(ref)) sent.set(ref, { last: new Map(), seq: 0 });
  }

  function emit(ref) {
    const npc = npcs.get(ref);
    const st = sent.get(ref);
    if (!npc || !st) return;
    const all = sectionsOf(npc, ref);
    const changed = {};
    for (const [name, value] of Object.entries(all)) {
      const text = JSON.stringify(value);
      if (st.last.get(name) !== text) { st.last.set(name, text); changed[name] = value; }
    }
    if (Object.keys(changed).length === 0) return;
    send({ type: "state", ref, seq: ++st.seq, sections: changed });
  }

  socket.on("connect", () => {
    console.log(`[mock] подключён к ${HOST}:${PORT}`);
    send({ type: "hello", plugin: "CoopBridge(mock)", version: "0.4.0", runtime: "mock", protocol: 4 });
  });

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handle(line);
    }
  });

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type !== "cmd") return;
    console.log(`[mock] команда: ${line}`);

    if (msg.cmd === "world") {
      world = msg.value === 1;
      syncTracked();
      return result(msg.id, world ? "tracking" : "untracked");
    }

    if (msg.cmd === "unwatch") {
      focus = null;
      syncTracked();
      return result(msg.id, "unwatched");
    }

    if (msg.cmd === "watch") {
      if (!npcs.has(msg.ref)) return result(msg.id, "error", `актёр ${msg.ref} не найден`);
      focus = msg.ref;
      syncTracked();
      result(msg.id, "watching");
      emit(msg.ref);
      return;
    }

    if (msg.cmd === "set") {
      if (!tracked().has(msg.ref)) return result(msg.id, "error", "NPC не отслеживается: выберите его или включите слежение за всеми");
      const r = applySet(npcs.get(msg.ref), msg);
      result(msg.id, r.ok ? "applied" : "error", r.message);
      if (r.ok) emit(msg.ref);
      return;
    }

    result(msg.id, "error", `неизвестная команда ${msg.cmd}`);
  }

  // Основной такт: выбранный NPC каждые 50 мс, остальные каждые 250 мс (как в настоящем плагине по умолчанию).
  timers.push(setInterval(() => {
    tick++;
    if (focus) emit(focus);
    if (tick % 5 === 0) for (const ref of sent.keys()) if (ref !== focus) emit(ref);
  }, TICK_MS));

  // Блуждание: NPC понемногу двигаются, чтобы менялось расстояние до игрока.
  timers.push(setInterval(() => {
    for (const npc of npcs.values()) {
      if (npc.spec.isPlayer || npc.dead) continue;
      npc.pos.x += (Math.random() - 0.5) * 60;
      npc.pos.y += (Math.random() - 0.5) * 60;
    }
  }, 1000));

  // Удары по выбранному NPC.
  if (HIT_MS > 0) {
    timers.push(setInterval(() => {
      const n = focus ? npcs.get(focus) : null;
      if (!n || n.dead) return;
      const hp = n.vitals.health;
      if (curOf(hp) - 7 < 1) { hp.damage = 0; n.hits = 0; n.inCombat = false; n.attacker = null; return; } // «лечим», чтобы демонстрация шла дальше
      hp.damage -= 7;
      n.hits++;
      n.inCombat = true;
      n.attacker = { id: "00000014", name: "Игрок" };
      n.pos.x += 12;
    }, HIT_MS));
  }

  // Загрузка и выгрузка: изредка кто-то из NPC уходит из мира и возвращается.
  if (CHURN_MS > 0) {
    timers.push(setInterval(() => {
      if (unloaded.size > 0) {
        const [ref, npc] = unloaded.entries().next().value;
        unloaded.delete(ref);
        npcs.set(ref, npc);
        syncTracked();
        return;
      }
      const candidates = [...npcs.keys()].filter((r) => r !== "00000014" && r !== focus);
      if (candidates.length === 0) return;
      const ref = candidates[Math.floor(Math.random() * candidates.length)];
      unloaded.set(ref, npcs.get(ref));
      npcs.delete(ref);
      syncTracked();
    }, CHURN_MS));
  }

  socket.on("error", () => {});
  socket.on("close", () => {
    for (const t of timers) clearInterval(t);
    console.log("[mock] соединение закрыто, повтор через 2 с");
    setTimeout(connect, 2000);
  });
}

connect();
