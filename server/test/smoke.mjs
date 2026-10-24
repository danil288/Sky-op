// Проверка сервера без игры: поднимаем Bridge на свободном порту и общаемся с ним как плагин.
// Запуск: npm test  (предварительно собирает TypeScript)

import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { Bridge } from "../dist/bridge.js";
import { NpcStore } from "../dist/npc.js";
import { parseRef, parseClientMessage } from "../dist/protocol.js";
import { repairMojibake, repairDeep } from "../dist/text.js";
import { UiServer } from "../dist/ui.js";
import { validateSet } from "../dist/edit.js";
import { World } from "../dist/world.js";
import { HubServer, proofFor, HUB_PROTOCOL } from "../dist/hub.js";
import { HubClient } from "../dist/viewer.js";
import { RemoteWorld } from "../dist/remote.js";
import { parseNetStart, listInterfaces } from "../dist/net-config.js";
import http from "node:http";

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

// ---------- чистые функции протокола ----------
await test("parseRef: форматы FormID и алиас player", () => {
  assert.equal(parseRef("A2C94"), "000A2C94");
  assert.equal(parseRef("0x000a2c94"), "000A2C94");
  assert.equal(parseRef("FF000800"), "FF000800");
  assert.equal(parseRef("player"), "00000014");
  assert.equal(parseRef("0"), null);
  assert.equal(parseRef("xyz"), null);
  assert.equal(parseRef("123456789"), null);
  assert.equal(parseRef(""), null);
});

await test("parseClientMessage: отбрасывает неверные сообщения", () => {
  assert.equal(parseClientMessage(null), null);
  assert.equal(parseClientMessage([]), null);
  assert.equal(parseClientMessage({ type: "result", id: 1.5, status: "watching" }), null);
  assert.equal(parseClientMessage({ type: "result", id: 1, status: "hack" }), null);
  assert.equal(parseClientMessage({ type: "result", id: 1, status: "arrived" }), null); // старые статусы удалены
  assert.equal(parseClientMessage({ type: "hello", plugin: 5, version: "1" }), null);
  assert.deepEqual(parseClientMessage({ type: "result", id: 7, status: "watching" }), {
    type: "result",
    id: 7,
    status: "watching",
    message: "",
  });
});

await test("parseClientMessage: сообщения state", () => {
  const ok = parseClientMessage({ type: "state", ref: "000A2C94", seq: 3, sections: { vitals: { health: {} }, package: null, factions: [] } });
  assert.equal(ok.type, "state");
  assert.equal(ok.seq, 3);
  assert.equal(parseClientMessage({ type: "state", ref: "a2c94", seq: 1, sections: {} }), null); // ref не в нормальной форме
  assert.equal(parseClientMessage({ type: "state", ref: "000A2C94", seq: 1.5, sections: {} }), null);
  assert.equal(parseClientMessage({ type: "state", ref: "000A2C94", seq: -1, sections: {} }), null);
  assert.equal(parseClientMessage({ type: "state", ref: "000A2C94", seq: 1, sections: [] }), null);
  assert.equal(parseClientMessage({ type: "state", ref: "000A2C94", seq: 1 }), null);
  const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, {}]));
  assert.equal(parseClientMessage({ type: "state", ref: "000A2C94", seq: 1, sections: many }), null);
});

// ---------- хранилище NPC ----------
const vitals = (hp, max = 100) => ({
  health: { current: hp, max, base: max, permanent: max, modPermanent: 0, modTemporary: 0, damage: hp - max },
  magicka: { current: 50, max: 50, base: 50, permanent: 50, modPermanent: 0, modTemporary: 0, damage: 0 },
  stamina: { current: 100, max: 100, base: 100, permanent: 100, modPermanent: 0, modTemporary: 0, damage: 0 },
});
const msg = (seq, sections, ref = "000A2C94") => ({ type: "state", ref, seq, sections });
const item = (id, name, count, worn = false) => ({ id, name, type: "MISC", count, worn });

await test("NpcStore: полный снимок и изменение здоровья попадают в панель и журнал", () => {
  const s = new NpcStore();
  s.begin("000A2C94");
  assert.equal(s.apply(msg(1, {
    identity: { refId: "000A2C94", baseId: "0001A6A7", name: "Стражник", race: "Нордик", level: 12, isPlayer: false },
    vitals: vitals(100),
    inventory: { gold: 10, items: [item("0000000F", "Золото", 10), item("00012EB7", "Железный меч", 1, true)] },
    package: { id: "0001B2C3", editorId: "", type: "Patrol", procedure: 1, target: null },
    factions: [{ id: "00028849", name: "Стража", rank: 0 }],
    effects: [],
  })), true);

  let text = s.render();
  assert.match(text, /NPC 000A2C94 · Стражник · Нордик · ур\. 12/);
  assert.match(text, /Здоровье\s+100\.0 \/ 100\.0/);
  assert.match(text, /\[надето\] Железный меч ×1/);
  assert.match(text, /Patrol 0001B2C3/);
  assert.match(text, /Стража \[0\]/);

  // Удар: здоровье падает, приходит lastHit
  assert.equal(s.apply(msg(2, {
    vitals: vitals(93),
    lastHit: { count: 1, attacker: { id: "00000014", name: "Игрок" }, source: { id: "00012EB7", name: "Железный меч" }, powerAttack: true, sneakAttack: false, bashAttack: false, blocked: false },
  })), true);
  text = s.render();
  assert.match(text, /Здоровье\s+93\.0 \/ 100\.0/);
  assert.match(text, /Здоровье: 100\.0 → 93\.0 \(−7\.0\)/);
  assert.match(text, /Удар №1: Игрок \(00000014\), Железный меч \(00012EB7\) \[силовая\]/);
  // секции, которые не приходили, остаются прежними
  assert.match(text, /Стражник/);
  assert.match(text, /\[надето\] Железный меч/);
});

await test("NpcStore: журнал инвентаря, ИИ, боя, фракций и эффектов", () => {
  const s = new NpcStore();
  s.begin("000A2C94");
  s.apply(msg(1, {
    inventory: { gold: 10, items: [item("0000000F", "Золото", 10), item("00012EB7", "Меч", 1, true)] },
    state: { lifeState: "alive", sitSleep: "normal", weapon: "sheathed", sneaking: false },
    combat: { inCombat: false, target: null, hostileToPlayer: false },
    package: null,
    factions: [],
    effects: [],
  }));
  s.apply(msg(2, {
    inventory: { gold: 8, items: [item("0000000F", "Золото", 8), item("00012EB7", "Меч", 1, false), item("00073936", "Зелье", 2)] },
    state: { lifeState: "dead", sitSleep: "normal", weapon: "drawn", sneaking: false },
    combat: { inCombat: true, target: { id: "00000014", name: "Игрок" }, hostileToPlayer: true },
    package: { id: "0001B2C3", editorId: "", type: "Follow", procedure: 0, target: null },
    factions: [{ id: "00028849", name: "Стража", rank: 1 }],
    effects: [{ spell: "Огонь", spellId: "0001C789", effect: "Горение", magnitude: 8, duration: 5, remaining: 5, caster: null }],
  }));
  const log = s.journal.map((e) => e.text).join("\n");
  assert.match(log, /Инвентарь: Золото 10 → 8/);
  assert.match(log, /Снял: Меч/);
  assert.match(log, /Инвентарь: \+2 Зелье/);
  assert.match(log, /Состояние: жив → мёртв/);
  assert.match(log, /Оружие: убрано → обнажено/);
  assert.match(log, /Вступил в бой/);
  assert.match(log, /Цель боя: Игрок \(00000014\)/);
  assert.match(log, /Пакет ИИ: нет → Follow 0001B2C3/);
  assert.match(log, /Фракция: \+Стража \(ранг 1\)/);
  assert.match(log, /Эффект: \+Огонь \(8\.0\)/);
});

await test("NpcStore: чужой NPC, старые пакеты и сброс", () => {
  const s = new NpcStore();
  assert.equal(s.apply(msg(1, { vitals: vitals(100) })), false); // слежения нет
  s.begin("000A2C94");
  assert.equal(s.apply(msg(1, { vitals: vitals(100) }, "00000014")), false); // другой ref
  assert.equal(s.apply(msg(1, { vitals: vitals(100) })), true);
  assert.equal(s.apply(msg(2, { vitals: vitals(90) })), true);
  assert.equal(s.apply(msg(2, { vitals: vitals(50) })), false); // дубль/устаревший
  assert.match(s.render(), /Здоровье\s+90\.0/);
  s.begin("000A2C94"); // новая сессия: seq снова с 1
  assert.equal(s.apply(msg(1, { vitals: vitals(100) })), true);
  s.clear();
  assert.match(s.render(), /Наблюдение выключено/);
});

await test("NpcStore: неожиданные типы в данных не ломают отрисовку", () => {
  const s = new NpcStore();
  s.begin("000A2C94");
  s.apply(msg(1, {
    identity: { name: 5, level: "x" },
    vitals: { health: { current: "много", max: null } },
    inventory: { items: [null, 7, { id: 1 }, { id: "00000001", name: {}, count: "x" }] },
    factions: [1, null, { id: 5 }],
    effects: [null, "x"],
    combat: 3,
    package: 7,
  }));
  s.apply(msg(2, { vitals: { health: { current: 5, max: 10 } }, inventory: "мусор", lastHit: { count: "x" } }));
  const text = s.render();
  assert.ok(text.length > 0);
  assert.match(text, /NPC 000A2C94/);
});

await test("NpcStore: состояние связи и недоступность актёра", () => {
  const s = new NpcStore();
  s.begin("000A2C94");
  assert.match(s.render(), /ждём данные/);
  s.apply(msg(1, { presence: { available: true, loaded: true, reason: "" }, vitals: vitals(100) }));
  assert.match(s.render(), /ОНЛАЙН/);
  s.apply(msg(2, { presence: { available: true, loaded: false, reason: "" } }));
  assert.match(s.render(), /НЕ ЗАГРУЖЕН/);
  s.apply(msg(3, { presence: { available: false, loaded: false, reason: "актёр удалён" } }));
  assert.match(s.render(), /НЕДОСТУПЕН: актёр удалён/);
  s.connected = false;
  assert.match(s.render(), /ИГРА ОТКЛЮЧЕНА/);
});

// ---------- сервер ----------
async function startPair(options = {}) {
  const bridge = new Bridge({ port: 0, ...options });
  const port = await bridge.listen();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  socket.setNoDelay(true); // как в плагине: без задержки Нейгла сообщения не слипаются во времени
  await once(socket, "connect");

  const received = [];
  let buf = "";
  const waiters = [];
  socket.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      received.push(m);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const nextCmd = async () => {
    while (received.length === 0) await new Promise((r) => waiters.push(r));
    return received.shift();
  };
  const reply = (obj) => socket.write(JSON.stringify(obj) + "\n");
  const hello = once(bridge, "hello");
  reply({ type: "hello", plugin: "test", version: "1", protocol: 2 });
  await hello;
  const stop = async () => {
    socket.destroy();
    await bridge.close();
  };
  return { bridge, socket, nextCmd, reply, stop };
}

await test("watch: команда доходит, ответ watching, затем приходят state", async () => {
  const { bridge, nextCmd, reply, stop } = await startPair();
  const states = [];
  bridge.on("state", (m) => states.push(m));

  const pending = bridge.send({ cmd: "watch", ref: "000A2C94" });
  const cmd = await nextCmd();
  assert.equal(cmd.type, "cmd");
  assert.equal(cmd.cmd, "watch");
  assert.equal(cmd.ref, "000A2C94");

  // result и state в одном TCP-пакете: порядок сохраняется
  reply({ type: "result", id: cmd.id, status: "watching" });
  reply({ type: "state", ref: "000A2C94", seq: 1, sections: { vitals: vitals(100) } });
  reply({ type: "state", ref: "000A2C94", seq: 2, sections: { vitals: vitals(93) } });
  const r = await pending;
  assert.equal(r.status, "watching");
  assert.equal(r.id, cmd.id);
  while (states.length < 2) await new Promise((res) => setTimeout(res, 5));
  assert.equal(states.length, 2);
  assert.equal(states[1].sections.vitals.health.current, 93);
  await stop();
});

await test("unwatch и ошибка плагина доходят до вызывающего", async () => {
  const { bridge, nextCmd, reply, stop } = await startPair();
  const a = bridge.send({ cmd: "watch", ref: "DEADBEEF" });
  const c1 = await nextCmd();
  reply({ type: "result", id: c1.id, status: "error", message: "актёр не найден" });
  const r1 = await a;
  assert.equal(r1.status, "error");
  assert.equal(r1.message, "актёр не найден");

  const b = bridge.send({ cmd: "unwatch" });
  const c2 = await nextCmd();
  assert.equal(c2.cmd, "unwatch");
  reply({ type: "result", id: c2.id, status: "unwatched" });
  assert.equal((await b).status, "unwatched");
  await stop();
});

await test("большой снимок (инвентарь на сотни предметов) проходит целиком", async () => {
  const { bridge, reply, stop } = await startPair();
  const got = new Promise((res) => bridge.once("state", res));
  const items = Array.from({ length: 800 }, (_, i) => item(i.toString(16).toUpperCase().padStart(8, "0"), `Предмет ${i}`, 1));
  reply({ type: "state", ref: "000A2C94", seq: 1, sections: { inventory: { gold: 0, items } } });
  const m = await got;
  assert.equal(m.sections.inventory.items.length, 800);
  await stop();
});

await test("мусор и неизвестные сообщения не роняют сервер", async () => {
  const { bridge, socket, nextCmd, reply, stop } = await startPair();
  socket.write('это не json\n{"type":"result","id":999,"status":"watching"}\n[1,2]\n{"type":"state","ref":"x","seq":1,"sections":{}}\n\n');
  const pending = bridge.send({ cmd: "unwatch" });
  const cmd = await nextCmd();
  reply({ type: "result", id: cmd.id, status: "unwatched" });
  assert.equal((await pending).status, "unwatched");
  await stop();
});

await test("сообщение, разбитое на куски, собирается", async () => {
  const { bridge, socket, nextCmd, stop } = await startPair();
  const pending = bridge.send({ cmd: "unwatch" });
  const cmd = await nextCmd();
  const line = JSON.stringify({ type: "result", id: cmd.id, status: "unwatched" }) + "\n";
  socket.write(line.slice(0, 10));
  await new Promise((r) => setTimeout(r, 30));
  socket.write(line.slice(10));
  assert.equal((await pending).status, "unwatched");
  await stop();
});

await test("нет подключения: сразу ошибка", async () => {
  const bridge = new Bridge({ port: 0 });
  await bridge.listen();
  const r = await bridge.send({ cmd: "watch", ref: "000A2C94" });
  assert.equal(r.status, "error");
  assert.match(r.message, /не подключена/);
  await bridge.close();
});

await test("обрыв связи завершает ожидающие команды", async () => {
  const { bridge, socket, nextCmd, stop } = await startPair();
  const pending = bridge.send({ cmd: "watch", ref: "000A2C94" });
  await nextCmd();
  const gone = once(bridge, "disconnected");
  socket.destroy();
  await gone;
  const r = await pending;
  assert.equal(r.status, "error");
  assert.match(r.message, /потеряно/);
  await stop();
});

await test("таймаут команды", async () => {
  const { bridge, nextCmd, stop } = await startPair({ commandTimeoutMs: 80 });
  const pending = bridge.send({ cmd: "watch", ref: "000A2C94" });
  await nextCmd();
  const r = await pending;
  assert.equal(r.status, "timeout");
  await stop();
});

await test("повторное подключение заменяет старое", async () => {
  const bridge = new Bridge({ port: 0 });
  const port = await bridge.listen();
  const s1 = net.createConnection({ host: "127.0.0.1", port });
  await once(s1, "connect");
  const s1closed = once(s1, "close");
  const s2 = net.createConnection({ host: "127.0.0.1", port });
  await once(s2, "connect");
  await s1closed; // старое закрыто сервером
  assert.equal(bridge.connected, true);
  s2.destroy();
  await bridge.close();
});


// ---------- кодировка ----------
await test("repairMojibake: строки из реального лога восстанавливаются", () => {
  assert.equal(repairMojibake("РЎРІРµРЅ"), "Свен");
  assert.equal(repairMojibake("Р’Р°Р№С‚СЂР°РЅ"), "Вайтран");
  assert.equal(repairMojibake("РЎРєР°Р№СЂРёРј"), "Скайрим");
  assert.equal(repairMojibake("<РЅРµС‚ РёРјРµРЅРё>"), "<нет имени>");
  assert.equal(repairMojibake("Р–РµР»РµР·РЅС‹Р№ РєРёРЅР¶Р°Р»"), "Железный кинжал");
  assert.equal(repairMojibake("РљР»СЋС‡ РѕС‚ РґРѕРјР° РЎРІРµРЅР°"), "Ключ от дома Свена");
});

await test("repairMojibake: нормальный текст не меняется", () => {
  for (const s of ["Свен", "Железный меч", "Вайтран", "Riverwood Svens House Faction", "pacedon228", "", "Тест \"имя\"", "Ёжик", "日本語", "😀", "Привет, мир!", "Р", "Ря"]) {
    assert.equal(repairMojibake(s), s, s);
  }
});

await test("repairDeep: чинит строки внутри вложенных данных и не трогает остальное", () => {
  const input = { name: "РЎРІРµРЅ", n: 5, ok: true, nil: null, list: [{ name: "Р—РѕР»РѕС‚Рѕ", id: "0000000F" }, "РњРµС‡", 3] };
  assert.deepEqual(repairDeep(input), { name: "Свен", n: 5, ok: true, nil: null, list: [{ name: "Золото", id: "0000000F" }, "Меч", 3] });
});

await test("NpcStore: двойная перекодировка исправляется при приёме, журнал уже с нормальным текстом", () => {
  const s = new NpcStore();
  s.begin("00013491");
  s.apply(msg(1, { identity: { name: "РЎРІРµРЅ", race: "РќРѕСЂРґ", level: 6 }, inventory: { gold: 10, items: [item("0000000F", "Р—РѕР»РѕС‚Рѕ", 10)] } }, "00013491"));
  const r = s.applyDetailed(msg(2, { inventory: { gold: 10, items: [item("0000000F", "Р—РѕР»РѕС‚Рѕ", 10), item("0003133C", "Р’РёРЅРѕ", 1)] } }, "00013491"));
  assert.equal(r.log.length, 1);
  assert.equal(r.log[0].text, "Инвентарь: +1 Вино");
  assert.match(s.render(), /Свен · Норд · ур\. 6/);
  assert.equal(s.snapshotData().sections.identity.name, "Свен");
});

// ---------- веб-панель ----------
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function startUi() {
  const calls = [];
  const ui = new UiServer({ host: "127.0.0.1", port: 0 }, {
    snapshot: () => ({ type: "snapshot", ref: null, sections: {}, log: [] }),
    watch: async (ref) => { calls.push(["watch", ref]); return ref === "bad" ? { ok: false, message: "неверный" } : { ok: true, message: "включено " + ref }; },
    unwatch: async () => { calls.push(["unwatch"]); return { ok: true, message: "выключено" }; },
    set: async (ref, field, arg, value) => { calls.push(["set", ref, field, arg, value]); return field === "bad" ? { ok: false, message: "нельзя" } : { ok: true, message: `изменено ${field}` }; },
    world: async (on) => { calls.push(["world", on]); return { ok: true, message: on ? "все включены" : "все выключены" }; },
    netStart: async (raw) => { calls.push(["netStart", raw]); return { ok: true, message: "комната" }; },
    netStop: async () => { calls.push(["netStop"]); return { ok: true, message: "вышли" }; },
    netPermissions: async (edit) => { calls.push(["netPermissions", edit]); return { ok: true, message: edit ? "можно" : "нельзя" }; },
    interfaces: () => [{ name: "Radmin VPN", address: "26.1.2.3" }],
  });
  const port = await ui.listen();
  return { ui, port, calls };
}

await test("панель: страница отдаётся, есть заголовки безопасности", async () => {
  const { ui, port } = await startUi();
  const r = await request(port);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /text\/html/);
  assert.match(r.body, /CoopBridge/);
  assert.match(r.headers["content-security-policy"], /default-src 'none'/);
  assert.equal((await request(port, { path: "/no-such-page" })).status, 404);
  await ui.close();
});

await test("панель: поток событий начинается со снимка и получает обновления", async () => {
  const { ui, port } = await startUi();
  const chunks = [];
  const req = http.get({ host: "127.0.0.1", port, path: "/events", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    assert.match(res.headers["content-type"], /text\/event-stream/);
    res.setEncoding("utf8");
    res.on("data", (c) => chunks.push(c));
  });
  while (!chunks.join("").includes('"type":"snapshot"')) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ui.clientCount, 1);
  ui.broadcast({ type: "state", seq: 7, text: "Свен" });
  while (!chunks.join("").includes('"seq":7')) await new Promise((r) => setTimeout(r, 5));
  assert.match(chunks.join(""), /data: \{"type":"state","seq":7,"text":"Свен"\}\n\n/);
  req.destroy();
  while (ui.clientCount !== 0) await new Promise((r) => setTimeout(r, 5));
  await ui.close();
});

await test("панель: команды watch/unwatch доходят до обработчиков", async () => {
  const { ui, port, calls } = await startUi();
  const json = { "Content-Type": "application/json", "X-CoopBridge-Token": ui.token };
  let r = await request(port, { method: "POST", path: "/api/watch", headers: json, body: JSON.stringify({ ref: "00013491" }) });
  assert.deepEqual(JSON.parse(r.body), { ok: true, message: "включено 00013491" });
  r = await request(port, { method: "POST", path: "/api/watch", headers: json, body: JSON.stringify({ ref: "bad" }) });
  assert.equal(JSON.parse(r.body).ok, false);
  r = await request(port, { method: "POST", path: "/api/unwatch", headers: json, body: "" });
  assert.equal(JSON.parse(r.body).ok, true);
  assert.deepEqual(calls, [["watch", "00013491"], ["watch", "bad"], ["unwatch"]]);
  await ui.close();
});

await test("панель: плохие запросы отклоняются", async () => {
  const { ui, port, calls } = await startUi();
  const json = { "Content-Type": "application/json", "X-CoopBridge-Token": ui.token };
  // не JSON по типу содержимого (так выглядит запрос с чужой формы)
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: { "Content-Type": "text/plain", "X-CoopBridge-Token": ui.token }, body: '{"ref":"1"}' })).status, 415);
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: json, body: "{не json" })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: json, body: JSON.stringify({ ref: 5 }) })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: json, body: "x".repeat(5000) })).status, 413);
  // чужой Host (DNS rebinding) и чужой Origin (запрос с другого сайта)
  assert.equal((await request(port, { headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: { ...json, Origin: "http://evil.example" }, body: JSON.stringify({ ref: "1" }) })).status, 403);
  assert.equal((await request(port, { path: "/events", headers: { Origin: "http://evil.example" } })).status, 403);
  // свой Origin допускается
  const ok = await request(port, { method: "POST", path: "/api/watch", headers: { ...json, Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ ref: "1" }) });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  await ui.close();
});


await test("панель: без ключа команды не принимаются, с ключом работает /api/set", async () => {
  const { ui, port, calls } = await startUi();
  const json = { "Content-Type": "application/json" };
  const body = JSON.stringify({ ref: "00013491", field: "vitals.health.current", value: 50 });
  assert.equal((await request(port, { method: "POST", path: "/api/set", headers: json, body })).status, 401);
  assert.equal((await request(port, { method: "POST", path: "/api/watch", headers: json, body: JSON.stringify({ ref: "1" }) })).status, 401);
  assert.equal((await request(port, { method: "POST", path: "/api/set", headers: { ...json, "X-CoopBridge-Token": "wrong-key" }, body })).status, 401);
  assert.equal(calls.length, 0);
  const ok = await request(port, { method: "POST", path: "/api/set", headers: { ...json, "X-CoopBridge-Token": ui.token }, body: JSON.stringify({ ref: "00013492", field: "faction.add", arg: "00028849", value: 2 }) });
  assert.deepEqual(JSON.parse(ok.body), { ok: true, message: "изменено faction.add" });
  assert.deepEqual(calls, [["set", "00013492", "faction.add", "00028849", 2]]);
  await ui.close();
});

await test("панель: ключ вставляется в страницу и каждый запуск свой", async () => {
  const a = await startUi();
  const b = await startUi();
  const pa = await request(a.port);
  assert.ok(pa.body.includes(`content="${a.ui.token}"`));
  assert.ok(!pa.body.includes("{{TOKEN}}"));
  assert.notEqual(a.ui.token, b.ui.token);
  assert.match(a.ui.token, /^[0-9a-f]{32}$/);
  await a.ui.close();
  await b.ui.close();
});

// ---------- допустимые правки ----------
await test("validateSet: допустимые поля нормализуются", () => {
  assert.deepEqual(validateSet("vitals.health.current", undefined, 50), { ok: true, field: "vitals.health.current", value: 50 });
  assert.deepEqual(validateSet("vitals.magicka.damage", undefined, -10), { ok: true, field: "vitals.magicka.damage", value: -10 });
  assert.deepEqual(validateSet("attributes.aggression", undefined, 2), { ok: true, field: "attributes.aggression", value: 2 });
  assert.deepEqual(validateSet("position.angleZ", undefined, 180), { ok: true, field: "position.angleZ", value: 180 });
  assert.deepEqual(validateSet("action.kill", undefined, undefined), { ok: true, field: "action.kill" });
  assert.deepEqual(validateSet("action.startCombat", "player", undefined), { ok: true, field: "action.startCombat", arg: "00000014" });
  assert.deepEqual(validateSet("faction.add", "28849", undefined), { ok: true, field: "faction.add", arg: "00028849", value: 0 });
  assert.deepEqual(validateSet("faction.rank", "0x28849", 3), { ok: true, field: "faction.rank", arg: "00028849", value: 3 });
  assert.deepEqual(validateSet("faction.remove", "00028849", undefined), { ok: true, field: "faction.remove", arg: "00028849" });
  assert.deepEqual(validateSet("inventory.add", "3133c", undefined), { ok: true, field: "inventory.add", arg: "0003133C", value: 1 });
  assert.deepEqual(validateSet("inventory.remove", "0003133C", 5), { ok: true, field: "inventory.remove", arg: "0003133C", value: 5 });
  assert.deepEqual(validateSet("inventory.equip", "0003133C", undefined), { ok: true, field: "inventory.equip", arg: "0003133C" });
});

await test("validateSet: постоянные данные и неверные значения отклоняются", () => {
  // постоянные данные записи
  for (const f of ["identity.name", "identity.level", "identity.race", "identity.refId", "identity.baseId", "state.essential", "state.protected", "name", "level", "package.id", "lastHit.count", "presence.available", "attributes.inventoryWeight"]) {
    const r = validateSet(f, undefined, 1);
    assert.equal(r.ok, false, f);
  }
  // мусор в поле
  for (const f of [undefined, null, 5, "", "vitals", "vitals.health", "vitals.health.current.x", "vitals.speed.current", "vitals.health.bogus", "action.explode", "x".repeat(65), "../etc/passwd"]) {
    assert.equal(validateSet(f, undefined, 1).ok, false, String(f));
  }
  // значения
  assert.equal(validateSet("vitals.health.current", undefined, 0).ok, false); // для смерти есть «Убить»
  assert.equal(validateSet("vitals.health.current", undefined, -5).ok, false);
  assert.equal(validateSet("vitals.stamina.max", undefined, -1).ok, false);
  assert.equal(validateSet("vitals.stamina.damage", undefined, -50).ok, true); // отрицательный урон - это обычно
  assert.equal(validateSet("vitals.health.current", undefined, "50").ok, false);
  assert.equal(validateSet("vitals.health.current", undefined, NaN).ok, false);
  assert.equal(validateSet("vitals.health.current", undefined, Infinity).ok, false);
  assert.equal(validateSet("vitals.health.current", undefined, 1e9).ok, false);
  assert.equal(validateSet("vitals.health.current", undefined, undefined).ok, false);
  assert.equal(validateSet("position.angleZ", undefined, 1000).ok, false);
  assert.equal(validateSet("position.x", undefined, 5e6).ok, false);
  // аргументы
  assert.equal(validateSet("inventory.add", undefined, 1).ok, false);
  assert.equal(validateSet("inventory.add", "не-форм-ид", 1).ok, false);
  assert.equal(validateSet("inventory.add", "0", 1).ok, false);
  assert.equal(validateSet("inventory.add", "0003133C", 0).ok, false);
  assert.equal(validateSet("inventory.add", "0003133C", 1.5).ok, false);
  assert.equal(validateSet("inventory.add", "0003133C", 100001).ok, false);
  assert.equal(validateSet("faction.add", "00028849", 128).ok, false);
  assert.equal(validateSet("faction.add", "00028849", 1.5).ok, false);
  assert.equal(validateSet("action.startCombat", undefined, undefined).ok, false);
  assert.equal(validateSet("action.startCombat", { x: 1 }, undefined).ok, false);
});

await test("set: команда доходит до плагина со всеми полями, ответ applied", async () => {
  const { bridge, nextCmd, reply, stop } = await startPair();
  const pending = bridge.send({ cmd: "set", ref: "00013491", field: "inventory.add", arg: "0003133C", value: 2 }, 2000);
  const cmd = await nextCmd();
  assert.deepEqual({ ...cmd, id: 0 }, { type: "cmd", id: 0, cmd: "set", ref: "00013491", field: "inventory.add", arg: "0003133C", value: 2 });
  reply({ type: "result", id: cmd.id, status: "applied", message: "Предмет 0003133C: 1 → 3 шт." });
  const r = await pending;
  assert.equal(r.status, "applied");
  assert.equal(r.message, "Предмет 0003133C: 1 → 3 шт.");

  // без arg и value ключи не отправляются
  const p2 = bridge.send({ cmd: "set", ref: "00013491", field: "action.kill" }, 2000);
  const c2 = await nextCmd();
  assert.deepEqual({ ...c2, id: 0 }, { type: "cmd", id: 0, cmd: "set", ref: "00013491", field: "action.kill" });
  reply({ type: "result", id: c2.id, status: "error", message: "NPC уже мёртв" });
  assert.equal((await p2).status, "error");

  // короткий таймаут на команду
  const p3 = bridge.send({ cmd: "set", ref: "00013491", field: "action.kill" }, 60);
  await nextCmd();
  assert.equal((await p3).status, "timeout");
  await stop();
});

await test("parseClientMessage: статус applied принимается", () => {
  assert.deepEqual(parseClientMessage({ type: "result", id: 3, status: "applied", message: "ок" }), { type: "result", id: 3, status: "applied", message: "ок" });
});


await test("панель: /api/world переключает слежение за всеми, мусор отклоняется", async () => {
  const { ui, port, calls } = await startUi();
  const h = { "Content-Type": "application/json", "X-CoopBridge-Token": ui.token };
  let r = await request(port, { method: "POST", path: "/api/world", headers: h, body: JSON.stringify({ on: true }) });
  assert.deepEqual(JSON.parse(r.body), { ok: true, message: "все включены" });
  r = await request(port, { method: "POST", path: "/api/world", headers: h, body: JSON.stringify({ on: false }) });
  assert.equal(JSON.parse(r.body).message, "все выключены");
  assert.equal((await request(port, { method: "POST", path: "/api/world", headers: h, body: JSON.stringify({ on: "yes" }) })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/world", headers: h, body: "{}" })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/world", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on: true }) })).status, 401);
  assert.deepEqual(calls, [["world", true], ["world", false]]);
  await ui.close();
});

await test("parseClientMessage: сообщение gone и статусы tracking/untracked", () => {
  assert.deepEqual(parseClientMessage({ type: "gone", ref: "00013491" }), { type: "gone", ref: "00013491" });
  assert.equal(parseClientMessage({ type: "gone", ref: "13491" }), null);
  assert.equal(parseClientMessage({ type: "gone" }), null);
  for (const status of ["tracking", "untracked"]) {
    assert.equal(parseClientMessage({ type: "result", id: 1, status }).status, status);
  }
});

await test("мост: gone доходит событием, world отправляется плагину", async () => {
  const { bridge, nextCmd, reply, stop } = await startPair();
  const gone = [];
  bridge.on("gone", (m) => gone.push(m));
  const pending = bridge.send({ cmd: "world", value: 1 }, 2000);
  const cmd = await nextCmd();
  assert.deepEqual({ ...cmd, id: 0 }, { type: "cmd", id: 0, cmd: "world", value: 1 });
  reply({ type: "gone", ref: "00013491" });
  reply({ type: "result", id: cmd.id, status: "tracking" });
  assert.equal((await pending).status, "tracking");
  while (gone.length < 1) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(gone, [{ type: "gone", ref: "00013491" }]);
  await stop();
});

// ---------- реестр всех NPC ----------
await test("World: несколько актёров ведутся независимо, у каждого свой журнал", () => {
  const w = new World();
  const a = w.apply(msg(1, { identity: { name: "Свен" }, vitals: vitals(91, 91) }, "00013491"));
  const b = w.apply(msg(1, { identity: { name: "Лидия" }, vitals: vitals(140, 140) }, "00013493"));
  assert.ok(a && b);
  assert.equal(w.size, 2);
  w.apply(msg(2, { vitals: vitals(80, 91) }, "00013491"));
  assert.match(w.get("00013491").journal.map((e) => e.text).join("\n"), /Здоровье: 91\.0 → 80\.0/);
  assert.doesNotMatch(w.get("00013493").journal.map((e) => e.text).join("\n"), /Здоровье/);
  // дубль и откат seq отбрасываются отдельно для каждого
  assert.equal(w.apply(msg(2, { vitals: vitals(1, 91) }, "00013491")), null);
  assert.ok(w.apply(msg(2, { vitals: vitals(130, 140) }, "00013493")));
});

await test("World: gone удаляет невыбранного, а выбранного оставляет с пометкой", () => {
  const w = new World();
  w.apply(msg(1, { vitals: vitals(100) }, "00013491"));
  w.apply(msg(1, { vitals: vitals(100) }, "00013492"));
  w.selected = "00013491";
  assert.deepEqual(w.gone("00013492"), { removed: true });
  assert.equal(w.has("00013492"), false);
  const g = w.gone("00013491");
  assert.equal(g.removed, false);
  assert.match(g.entry.text, /выгружен/);
  assert.equal(w.get("00013491").section("presence").loaded, false);
  assert.match(w.get("00013491").render(), /НЕ ЗАГРУЖЕН/);
  assert.deepEqual(w.gone("0000AAAA"), { removed: true }); // неизвестный - не ошибка
});

await test("World: после возвращения выгруженного приходит полный снимок и он заменяет старое", () => {
  const w = new World();
  w.apply(msg(1, { vitals: vitals(100) }, "00013492"));
  w.apply(msg(2, { vitals: vitals(90) }, "00013492"));
  w.gone("00013492");
  assert.equal(w.has("00013492"), false);
  w.apply(msg(1, { vitals: vitals(75) }, "00013492")); // плагин начал с seq=1
  assert.equal(w.get("00013492").section("vitals").health.current, 75);
});

await test("World: reset после переподключения оставляет только выбранного", () => {
  const w = new World();
  w.apply(msg(1, { vitals: vitals(100) }, "00013491"));
  w.apply(msg(1, { vitals: vitals(100) }, "00013492"));
  w.selected = "00013491";
  w.tracking = true;
  w.reset();
  assert.equal(w.size, 1);
  assert.equal(w.has("00013491"), true);
  assert.equal(w.tracking, false);
  // новая сессия плагина начинает с seq=1 и принимается
  assert.ok(w.apply(msg(1, { vitals: vitals(55) }, "00013491")));
});

await test("World: снимок для панели содержит всех актёров, журнал обрезан", () => {
  const w = new World();
  w.apply(msg(1, { vitals: vitals(100) }, "00013491"));
  for (let i = 2; i <= 70; i++) w.apply(msg(i, { vitals: vitals(100 - i) }, "00013491"));
  w.apply(msg(1, { vitals: vitals(100) }, "00013492"));
  w.selected = "00013492";
  w.tracking = true;
  const snap = w.snapshotData();
  assert.deepEqual(Object.keys(snap.actors).sort(), ["00013491", "00013492"]);
  assert.equal(snap.tracking, true);
  assert.equal(snap.selected, "00013492");
  assert.equal(snap.actors["00013491"].log.length, 50);
  assert.equal(snap.actors["00013491"].sections.vitals.health.current, 30);
});

await test("World: много актёров за раз (300 по 40 предметов) обрабатываются быстро", () => {
  const w = new World();
  const items = Array.from({ length: 40 }, (_, i) => item(i.toString(16).toUpperCase().padStart(8, "0"), `Предмет ${i}`, 1));
  const t0 = Date.now();
  for (let a = 0; a < 300; a++) {
    const ref = (0x20000 + a).toString(16).toUpperCase().padStart(8, "0");
    w.apply(msg(1, { identity: { name: `NPC ${a}` }, vitals: vitals(100), inventory: { gold: 0, items }, position: { x: a, y: 0, z: 0, angleZ: 0 } }, ref));
    for (let k = 2; k <= 6; k++) w.apply(msg(k, { vitals: vitals(100 - k), position: { x: a + k, y: 0, z: 0, angleZ: 0 } }, ref));
  }
  assert.equal(w.size, 300);
  assert.ok(Date.now() - t0 < 3000, "слишком медленно: " + (Date.now() - t0) + " мс");
});


// ---------- сеть между игроками ----------
const waitFor = async (check, ms = 3000, what = "условие") => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("не дождались: " + what);
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function startHub(opts = {}) {
  const hub = new HubServer({ host: "127.0.0.1", port: 0, password: "секрет-1", snapshot: () => ({ type: "snapshot", actors: { "00013491": { sections: {}, log: [] } }, tracking: true }), ...opts });
  const port = await hub.listen();
  return { hub, port };
}

function makeClient(port, opts = {}) {
  const client = new HubClient({ host: "127.0.0.1", port, password: "секрет-1", name: "Вася", retryMinMs: 30, retryMaxMs: 60, ...opts });
  const statuses = [];
  const events = [];
  client.on("status", (s) => statuses.push(s.state));
  client.on("event", (e) => events.push(e));
  return { client, statuses, events };
}

// «сырое» подключение к комнате для проверки защиты
function rawConnect(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  const lines = [];
  let buf = "";
  let closed = false;
  socket.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) !== -1) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) lines.push(JSON.parse(l)); } });
  socket.on("close", () => { closed = true; });
  socket.on("error", () => {});
  return { socket, lines, isClosed: () => closed };
}

await test("комната: верный пароль - игрок получает снимок и события, админ видит игрока", async () => {
  const { hub, port } = await startHub();
  const changes = [];
  hub.on("viewers", (list, info) => changes.push([list.length, info.joined?.name, info.left?.name]));
  const { client, statuses, events } = makeClient(port);
  client.start();
  await waitFor(() => events.length >= 1, 3000, "снимок");
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[0].tracking, true);
  assert.ok(statuses.includes("connected"));
  assert.equal(hub.list().length, 1);
  assert.equal(hub.list()[0].name, "Вася");
  assert.match(hub.list()[0].address, /127\.0\.0\.1/);

  hub.broadcast({ type: "state", ref: "00013491", seq: 2, sections: { vitals: { health: { current: 50 } } } });
  await waitFor(() => events.length >= 2, 3000, "событие");
  assert.equal(events[1].seq, 2);

  client.stop();
  await waitFor(() => hub.list().length === 0, 3000, "уход игрока");
  assert.deepEqual(changes, [[1, "Вася", undefined], [0, undefined, "Вася"]]);
  await hub.close();
});

await test("комната: неверный пароль - отказ без повторов, никого не пускает", async () => {
  const { hub, port } = await startHub();
  const { client, statuses } = makeClient(port, { password: "не-тот-пароль" });
  let message = "";
  client.on("status", (s) => { if (s.state === "denied") message = s.message; });
  client.start();
  await waitFor(() => statuses.includes("denied"), 3000, "отказ");
  assert.equal(message, "неверный пароль");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(statuses.filter((s) => s === "connecting").length, 1); // повторов нет
  assert.equal(hub.list().length, 0);
  await hub.close();
});

await test("комната: перебор пароля блокирует адрес на минуту", async () => {
  const { hub, port } = await startHub();
  for (let i = 0; i < 5; i++) {
    const { client, statuses } = makeClient(port, { password: "неверный" + i });
    client.start();
    await waitFor(() => statuses.includes("denied"), 3000, "отказ " + i);
  }
  const { client, statuses } = makeClient(port); // уже с верным паролем
  let message = "";
  client.on("status", (s) => { if (s.state === "denied") message = s.message; });
  client.start();
  await waitFor(() => statuses.includes("denied"), 3000, "блокировка");
  assert.match(message, /слишком много/);
  assert.equal(hub.list().length, 0);
  await hub.close();
});

await test("комната: лимит игроков и несовместимая версия", async () => {
  const { hub, port } = await startHub({ maxViewers: 1 });
  const a = makeClient(port, { name: "Первый" });
  a.client.start();
  await waitFor(() => hub.list().length === 1, 3000, "первый");
  const b = makeClient(port, { name: "Второй" });
  let message = "";
  b.client.on("status", (s) => { if (s.state === "denied") message = s.message; });
  b.client.start();
  await waitFor(() => b.statuses.includes("denied"), 3000, "второй");
  assert.equal(message, "комната заполнена");
  assert.equal(hub.list().length, 1);

  // неверная версия протокола в join
  const raw = rawConnect(port);
  await waitFor(() => raw.lines.length >= 1, 3000, "challenge");
  raw.socket.write(JSON.stringify({ type: "join", name: "x", proof: proofFor("секрет-1", raw.lines[0].nonce), protocol: 99 }) + "\n");
  await waitFor(() => raw.lines.some((l) => l.type === "denied"), 3000, "denied");
  assert.match(raw.lines.find((l) => l.type === "denied").reason, /версия протокола/);
  a.client.stop();
  await hub.close();
});

await test("комната: защита от мусора, медленной авторизации и огромных сообщений", async () => {
  const { hub, port } = await startHub({ authTimeoutMs: 120 });
  // молчащий клиент: получает challenge, затем отказ по времени
  const slow = rawConnect(port);
  await waitFor(() => slow.lines.some((l) => l.type === "denied"), 3000, "тайм-аут авторизации");
  assert.match(slow.lines.find((l) => l.type === "denied").reason, /время ожидания/);
  await waitFor(() => slow.isClosed(), 3000, "закрытие");

  // мусор вместо join
  const junk = rawConnect(port);
  await waitFor(() => junk.lines.length >= 1, 3000, "challenge");
  junk.socket.write("это не json\n");
  await waitFor(() => junk.lines.some((l) => l.type === "denied"), 3000, "отказ за мусор");

  // сообщение не join
  const wrong = rawConnect(port);
  await waitFor(() => wrong.lines.length >= 1, 3000, "challenge");
  wrong.socket.write(JSON.stringify({ type: "hello" }) + "\n");
  await waitFor(() => wrong.lines.some((l) => l.type === "denied"), 3000, "отказ за не join");

  // огромная строка без перевода строки
  const big = rawConnect(port);
  await waitFor(() => big.lines.length >= 1, 3000, "challenge");
  big.socket.write("x".repeat(100 * 1024));
  await waitFor(() => big.isClosed(), 3000, "закрытие за размер");
  assert.equal(hub.list().length, 0);
  await hub.close();
});

await test("комната: молчащий игрок отключается, отвечающий остаётся", async () => {
  const { hub, port } = await startHub({ pingIntervalMs: 40, idleTimeoutMs: 200 });
  const good = makeClient(port, { name: "Живой" });
  good.client.start();
  await waitFor(() => hub.list().length === 1, 3000, "живой вошёл");

  // «зависший» игрок: вошёл правильно, но на ping не отвечает
  const dead = rawConnect(port);
  await waitFor(() => dead.lines.length >= 1, 3000, "challenge");
  dead.socket.write(JSON.stringify({ type: "join", name: "Зависший", proof: proofFor("секрет-1", dead.lines[0].nonce), protocol: HUB_PROTOCOL }) + "\n");
  await waitFor(() => hub.list().length === 2, 3000, "зависший вошёл");
  await waitFor(() => dead.isClosed(), 3000, "отключение зависшего");
  assert.deepEqual(hub.list().map((v) => v.name), ["Живой"]);
  await new Promise((r) => setTimeout(r, 300)); // дольше idleTimeout
  assert.equal(hub.list().length, 1);
  good.client.stop();
  await hub.close();
});

await test("игрок: переподключается после перезапуска комнаты и получает новый снимок", async () => {
  const first = await startHub();
  const { client, statuses, events } = makeClient(first.port);
  client.start();
  await waitFor(() => events.length === 1, 3000, "первый снимок");
  await first.hub.close();
  await waitFor(() => statuses.includes("disconnected"), 3000, "обрыв");
  const second = new HubServer({ host: "127.0.0.1", port: first.port, password: "секрет-1", snapshot: () => ({ type: "snapshot", actors: {}, tracking: false, marker: 2 }) });
  await second.listen();
  await waitFor(() => events.length === 2, 5000, "второй снимок");
  assert.equal(events[1].marker, 2);
  assert.equal(statuses.at(-1), "connected");
  client.stop();
  await second.close();
});

await test("игрок: недоступный админ и потеря связи без данных сообщаются понятно", async () => {
  // порт, на котором никто не слушает
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const closedPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const a = new HubClient({ host: "127.0.0.1", port: closedPort, password: "секрет-1", name: "x", retryMinMs: 50, retryMaxMs: 60 });
  const msgs = [];
  a.on("status", (s) => msgs.push(s));
  a.start();
  await waitFor(() => msgs.some((m) => m.state === "disconnected"), 3000, "недоступен");
  assert.match(msgs.find((m) => m.state === "disconnected").message, /админ недоступен/);
  a.stop();
  assert.equal(a.state, "stopped");

  // «админ» принимает, говорит welcome и замолкает
  const mute = net.createServer((s) => {
    s.setEncoding("utf8");
    s.write(JSON.stringify({ type: "challenge", nonce: "ab", protocol: HUB_PROTOCOL, host: "тест" }) + "\n");
    s.on("data", () => { s.write(JSON.stringify({ type: "welcome", role: "viewer" }) + "\n"); });
    s.on("error", () => {});
  });
  await new Promise((r) => mute.listen(0, "127.0.0.1", r));
  const b = new HubClient({ host: "127.0.0.1", port: mute.address().port, password: "секрет-1", name: "x", idleTimeoutMs: 150, retryMinMs: 5000 });
  const msgs2 = [];
  b.on("status", (s) => msgs2.push(s));
  b.start();
  await waitFor(() => msgs2.some((m) => m.state === "connected"), 3000, "подключено");
  await waitFor(() => msgs2.some((m) => m.state === "disconnected"), 3000, "тишина");
  assert.match(msgs2.find((m) => m.state === "disconnected").message, /не отвечает/);
  b.stop();
  mute.close();
});

await test("RemoteWorld: копия мира админа собирается из событий", () => {
  const r = new RemoteWorld();
  r.apply({ type: "snapshot", tracking: true, selected: "00013491", gameConnected: true, plugin: { plugin: "CoopBridge", version: "0.4.0" }, actors: {
    "00013491": { sections: { identity: { name: "Свен" }, vitals: { health: { current: 90 } } }, log: [{ t: 1, text: "Наблюдение начато" }], seq: 3, updates: 3, updatedAt: 100 },
    "00013492": { sections: { identity: { name: "Лидия" } }, log: [], seq: 1, updates: 1, updatedAt: 50 },
  } });
  assert.equal(r.size, 2);
  r.apply({ type: "state", ref: "00013491", seq: 4, updates: 4, updatedAt: 200, sections: { vitals: { health: { current: 70 } } }, log: [{ t: 2, text: "Здоровье: 90.0 → 70.0 (−20.0)" }] });
  r.apply({ type: "state", ref: "00013499", seq: 1, updates: 1, updatedAt: 1, sections: { identity: { name: "Новый" } }, log: [] }); // неизвестный заводится
  let snap = r.snapshotEvent();
  assert.equal(Object.keys(snap.actors).length, 3);
  assert.equal(snap.actors["00013491"].sections.vitals.health.current, 70);
  assert.equal(snap.actors["00013491"].sections.identity.name, "Свен"); // старые разделы сохранились
  assert.equal(snap.actors["00013491"].log.length, 2);
  assert.equal(snap.actors["00013491"].seq, 4);
  assert.equal(snap.tracking, true);

  r.apply({ type: "gone", ref: "00013492", removed: true });
  r.apply({ type: "gone", ref: "00013491", removed: false });
  snap = r.snapshotEvent();
  assert.equal(snap.actors["00013492"], undefined);
  assert.equal(snap.actors["00013491"].sections.presence.loaded, false);

  r.apply({ type: "log", ref: "00013491", entries: [{ t: 3, text: "ещё" }, { t: "x" }, null] });
  assert.equal(r.snapshotEvent().actors["00013491"].log.at(-1).text, "ещё");
  r.apply({ type: "world", tracking: false });
  r.apply({ type: "status", gameConnected: false });
  assert.equal(r.tracking, false);
  assert.equal(r.gameConnected, false);

  // мусор не ломает
  for (const bad of [null, 5, "x", [], { type: "state" }, { type: "state", ref: 5, sections: {} }, { type: "gone" }, { type: "log" }, { type: "неизвестно" }]) r.apply(bad);
  assert.equal(r.size, 2);

  // журнал ограничен
  for (let i = 0; i < 300; i++) r.apply({ type: "log", ref: "00013491", entries: [{ t: i, text: "x" + i }] });
  assert.ok(r.snapshotEvent().actors["00013491"].log.length <= 50);
  r.reset();
  assert.equal(r.size, 0);
});

await test("parseNetStart: проверка настроек комнаты и подключения", () => {
  const ok = parseNetStart({ mode: "host", host: "26.1.2.3", port: 7788, password: "секрет", name: "  Админ  " });
  assert.deepEqual(ok, { ok: true, mode: "host", host: "26.1.2.3", port: 7788, password: "секрет", name: "Админ", allowEdit: true });
  assert.deepEqual(parseNetStart({ mode: "viewer", host: "26.9.9.9", port: "7788", password: "1234" }), { ok: true, mode: "viewer", host: "26.9.9.9", port: 7788, password: "1234", name: "Игрок", allowEdit: true });
  assert.equal(parseNetStart({ mode: "host", host: "0.0.0.0", port: 7788, password: "abcd" }).ok, true);
  assert.equal(parseNetStart({ mode: "viewer", host: "admin-pc.local", port: 7788, password: "abcd" }).ok, true);
  for (const bad of [
    null, 5, {}, { mode: "x" },
    { mode: "host", host: "", port: 7788, password: "abcd" },
    { mode: "host", host: "не-адрес", port: 7788, password: "abcd" },
    { mode: "host", host: "1.2.3", port: 7788, password: "abcd" },
    { mode: "viewer", host: "", port: 7788, password: "abcd" },
    { mode: "viewer", host: "a b", port: 7788, password: "abcd" },
    { mode: "viewer", host: "x;rm", port: 7788, password: "abcd" },
    { mode: "viewer", host: "26.1.1.1", port: 0, password: "abcd" },
    { mode: "viewer", host: "26.1.1.1", port: 70000, password: "abcd" },
    { mode: "viewer", host: "26.1.1.1", port: 1.5, password: "abcd" },
    { mode: "viewer", host: "26.1.1.1", port: "abc", password: "abcd" },
    { mode: "viewer", host: "26.1.1.1", port: 7788, password: "abc" },
    { mode: "viewer", host: "26.1.1.1", port: 7788, password: "x".repeat(65) },
    { mode: "viewer", host: "26.1.1.1", port: 7788 },
  ]) assert.equal(parseNetStart(bad).ok, false, JSON.stringify(bad));
  assert.equal(parseNetStart({ mode: "viewer", host: "26.1.1.1", port: 7788, password: "abcd", name: "a\u0000b\u0007c".repeat(20) }).name.length <= 32, true);
});

await test("listInterfaces: возвращает адреса IPv4 без служебных", () => {
  const list = listInterfaces();
  assert.ok(Array.isArray(list));
  for (const i of list) {
    assert.equal(typeof i.name, "string");
    assert.match(i.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.notEqual(i.address, "127.0.0.1");
  }
});


await test("панель: сеть - запуск и выход только с ключом, адреса компьютера отдаются", async () => {
  const { ui, port, calls } = await startUi();
  const h = { "Content-Type": "application/json", "X-CoopBridge-Token": ui.token };
  const body = { mode: "viewer", host: "26.9.9.9", port: 7788, password: "секрет-1", name: "Вася" };
  assert.equal((await request(port, { method: "POST", path: "/api/net/start", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await request(port, { method: "POST", path: "/api/net/stop", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal(calls.length, 0);
  const r = await request(port, { method: "POST", path: "/api/net/start", headers: h, body: JSON.stringify(body) });
  assert.deepEqual(JSON.parse(r.body), { ok: true, message: "комната" });
  assert.deepEqual(calls, [["netStart", body]]);
  assert.deepEqual(JSON.parse((await request(port, { method: "POST", path: "/api/net/stop", headers: h, body: "{}" })).body), { ok: true, message: "вышли" });
  const ifs = JSON.parse((await request(port, { path: "/api/interfaces" })).body);
  assert.deepEqual(ifs, { interfaces: [{ name: "Radmin VPN", address: "26.1.2.3" }] });
  // чужой Origin и Host для адресов сети не проходят
  assert.equal((await request(port, { path: "/api/interfaces", headers: { Host: "evil.example" } })).status, 403);
  assert.equal((await request(port, { method: "POST", path: "/api/net/start", headers: { ...h, Origin: "http://evil.example" }, body: JSON.stringify(body) })).status, 403);
  await ui.close();
});


// ---------- команды игрока ----------
/** Комната, в которой админская сторона отвечает на команды по заданному правилу. */
async function startHubWithAdmin(handler, opts = {}) {
  const { hub, port } = await startHub(opts);
  const seen = [];
  hub.on("command", (viewer, cmd) => {
    seen.push({ viewer: viewer.name, ...cmd });
    const r = handler(viewer, cmd);
    if (r) setTimeout(() => hub.reply(viewer.id, cmd.id, r.ok, r.message), 5);
  });
  return { hub, port, seen };
}

async function joined(port, name = "Вася", opts = {}) {
  const m = makeClient(port, { name, ...opts });
  m.client.start();
  await waitFor(() => m.statuses.includes("connected"), 3000, "подключение " + name);
  return m;
}

await test("команды игрока: set доходит до админа, ответ возвращается игроку", async () => {
  const { hub, port, seen } = await startHubWithAdmin((v, c) => ({ ok: true, message: `Здоровье, текущее: 100.0 → ${c.body.value}.0 (${v.name})` }));
  const a = await joined(port, "Вася");
  assert.equal(a.client.canEdit, true);
  const r = await a.client.command({ cmd: "set", ref: "00013491", field: "vitals.health.current", value: 50 });
  assert.deepEqual(r, { ok: true, message: "Здоровье, текущее: 100.0 → 50.0 (Вася)" });
  assert.deepEqual(seen[0].body, { ref: "00013491", field: "vitals.health.current", value: 50 });
  assert.equal(seen[0].viewer, "Вася");
  // отказ админской стороны тоже доходит
  const { hub: h2, port: p2 } = await startHubWithAdmin(() => ({ ok: false, message: "NPC не отслеживается" }));
  const b = await joined(p2, "Петя");
  assert.deepEqual(await b.client.command({ cmd: "set", ref: "00013491", field: "action.kill" }), { ok: false, message: "NPC не отслеживается" });
  a.client.stop(); b.client.stop();
  await hub.close(); await h2.close();
});

await test("команды игрока: ответы идут именно тому, кто спросил", async () => {
  const { hub, port } = await startHubWithAdmin((v, c) => ({ ok: true, message: `${v.name}:${c.body.field}` }));
  const a = await joined(port, "Первый");
  const b = await joined(port, "Второй");
  const [ra, rb] = await Promise.all([
    a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" }),
    b.client.command({ cmd: "set", ref: "00013492", field: "action.resurrect" }),
  ]);
  assert.equal(ra.message, "Первый:action.kill");
  assert.equal(rb.message, "Второй:action.resurrect");
  a.client.stop(); b.client.stop();
  await hub.close();
});

await test("команды игрока: админ может запретить и разрешить правки на ходу", async () => {
  const { hub, port, seen } = await startHubWithAdmin(() => ({ ok: true, message: "ок" }), { allowEdit: false });
  const a = await joined(port, "Вася");
  assert.equal(a.client.canEdit, false);
  const perms = [];
  a.client.on("permissions", (p) => perms.push(p.edit));
  // запрещено: команда до админской стороны не доходит
  const denied = await a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" });
  assert.equal(denied.ok, false);
  assert.match(denied.message, /запретил/);
  assert.equal(seen.length, 0);

  hub.setPermissions({ edit: true });
  await waitFor(() => a.client.canEdit === true, 3000, "права выданы");
  assert.equal((await a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" })).ok, true);
  assert.equal(seen.length, 1);

  hub.setPermissions({ edit: false });
  await waitFor(() => a.client.canEdit === false, 3000, "права отозваны");
  assert.deepEqual(perms, [true, false]);
  assert.equal((await a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" })).ok, false);
  assert.equal(seen.length, 1);
  a.client.stop();
  await hub.close();
});

await test("команды игрока: частота ограничена, мусор и чужие команды отклоняются", async () => {
  const { hub, port, seen } = await startHubWithAdmin((v, c) => ({ ok: true, message: "ок" }));
  const raw = rawConnect(port);
  await waitFor(() => raw.lines.length >= 1, 3000, "challenge");
  raw.socket.write(JSON.stringify({ type: "join", name: "Сырой", proof: proofFor("секрет-1", raw.lines[0].nonce), protocol: HUB_PROTOCOL }) + "\n");
  await waitFor(() => raw.lines.some((l) => l.type === "welcome"), 3000, "welcome");
  const results = () => raw.lines.filter((l) => l.type === "result");
  const send = (o) => raw.socket.write(JSON.stringify(o) + "\n");

  // чужие и некорректные команды сразу получают отказ
  send({ type: "cmd", id: 101, cmd: "world", value: 1 });
  send({ type: "cmd", id: 102, cmd: "watch", ref: "00013491" });
  send({ type: "cmd", id: 103, cmd: "set", ref: 5, field: "action.kill" });
  send({ type: "cmd", id: 104, cmd: "set", ref: "00013491", field: "x".repeat(65) });
  send({ type: "cmd", id: 105, cmd: "set", ref: "00013491", field: "a.b", value: "50" });
  send({ type: "cmd", id: 106, cmd: "set", ref: "00013491", field: "a.b", arg: 7 });
  send({ type: "cmd", cmd: "set", ref: "00013491", field: "action.kill" }); // без номера: ответить нельзя, игнорируется
  send({ type: "cmd", id: -1, cmd: "set", ref: "00013491", field: "action.kill" });
  send({ type: "cmd", id: 1.5, cmd: "set", ref: "00013491", field: "action.kill" });
  await waitFor(() => results().length >= 6, 3000, "отказы");
  assert.deepEqual(results().map((r) => r.id), [101, 102, 103, 104, 105, 106]);
  assert.ok(results().every((r) => r.ok === false));
  assert.equal(seen.length, 0);

  // ограничение частоты: из 20 быстрых команд до админа дойдёт не больше 8
  await new Promise((r) => setTimeout(r, 1100));
  const before = results().length;
  for (let i = 0; i < 20; i++) send({ type: "cmd", id: 200 + i, cmd: "set", ref: "00013491", field: "action.kill" });
  await waitFor(() => results().length >= before + 20, 3000, "ответы на пачку");
  const batch = results().slice(before);
  assert.ok(batch.filter((r) => /слишком часто/.test(r.message)).length >= 10, "ограничение не сработало");
  assert.ok(seen.length <= 8, "до админа дошло " + seen.length);
  raw.socket.destroy();
  await hub.close();
});

await test("команды игрока: админ не ответил - игрок получает отказ; игрок ушёл - ничего не ломается", async () => {
  const { hub, port } = await startHubWithAdmin(() => null, { commandTimeoutMs: 120 }); // админская сторона молчит
  const a = await joined(port, "Вася");
  const r = await a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" }, 3000);
  assert.equal(r.ok, false);
  assert.match(r.message, /не ответил/);

  // игрок уходит, пока команда висит: клиент получает отказ, запоздалый ответ админа игнорируется
  let cmdSeen = null;
  hub.on("command", (v, c) => { cmdSeen = [v.id, c.id]; });
  const pending = a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" }, 3000);
  await waitFor(() => cmdSeen !== null, 3000, "команда дошла");
  a.client.stop();
  assert.deepEqual(await pending, { ok: false, message: "вы вышли из комнаты" });
  await waitFor(() => hub.list().length === 0, 3000, "игрок ушёл");
  hub.reply(cmdSeen[0], cmdSeen[1], true, "поздно"); // не должно бросать
  await hub.close();
});

await test("игрок: команда без связи и при обрыве возвращает понятный отказ", async () => {
  const idle = new HubClient({ host: "127.0.0.1", port: 1, password: "секрет-1", name: "x" });
  assert.deepEqual(await idle.command({ cmd: "set", ref: "00013491", field: "action.kill" }), { ok: false, message: "нет связи с админом" });

  const { hub, port } = await startHubWithAdmin(() => null);
  const a = await joined(port, "Вася");
  const pending = a.client.command({ cmd: "set", ref: "00013491", field: "action.kill" }, 5000);
  await new Promise((r) => setTimeout(r, 50));
  await hub.close(); // админ пропал
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.message, /связь с админом потеряна/);
  a.client.stop();
});

await test("parseNetStart: allowEdit по умолчанию да; RemoteWorld.has", () => {
  assert.equal(parseNetStart({ mode: "host", host: "0.0.0.0", port: 7788, password: "abcd" }).allowEdit, true);
  assert.equal(parseNetStart({ mode: "host", host: "0.0.0.0", port: 7788, password: "abcd", allowEdit: false }).allowEdit, false);
  assert.equal(parseNetStart({ mode: "host", host: "0.0.0.0", port: 7788, password: "abcd", allowEdit: "нет" }).ok, false);
  const r = new RemoteWorld();
  r.apply({ type: "state", ref: "00013491", seq: 1, sections: { identity: { name: "Свен" } } });
  assert.equal(r.has("00013491"), true);
  assert.equal(r.has("00013499"), false);
});


await test("панель: /api/net/permissions принимает только true/false и только с ключом", async () => {
  const { ui, port, calls } = await startUi();
  const h = { "Content-Type": "application/json", "X-CoopBridge-Token": ui.token };
  assert.deepEqual(JSON.parse((await request(port, { method: "POST", path: "/api/net/permissions", headers: h, body: JSON.stringify({ edit: false }) })).body), { ok: true, message: "нельзя" });
  assert.deepEqual(JSON.parse((await request(port, { method: "POST", path: "/api/net/permissions", headers: h, body: JSON.stringify({ edit: true }) })).body), { ok: true, message: "можно" });
  assert.equal((await request(port, { method: "POST", path: "/api/net/permissions", headers: h, body: JSON.stringify({ edit: "да" }) })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/net/permissions", headers: h, body: "{}" })).status, 400);
  assert.equal((await request(port, { method: "POST", path: "/api/net/permissions", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edit: true }) })).status, 401);
  assert.deepEqual(calls, [["netPermissions", false], ["netPermissions", true]]);
  await ui.close();
});

console.log(`\nВсе проверки пройдены: ${passed}`);
