var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/auth.js
var PBKDF2_ITERS = 25e3;
var SESSION_TTL_MS = 30 * 24 * 3600 * 1e3;
var enc = new TextEncoder();
function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
__name(b64, "b64");
function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
__name(fromB64, "fromB64");
async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256
  );
}
__name(pbkdf2, "pbkdf2");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERS);
  return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${b64(hash)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const [scheme, iters, salt, expected] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const hash = b64(await pbkdf2(password, fromB64(salt), Number(iters)));
  return hash === expected;
}
__name(verifyPassword, "verifyPassword");
async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(newToken, "newToken");
function validUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_]{3,16}$/.test(u);
}
__name(validUsername, "validUsername");
function validPassword(p) {
  return typeof p === "string" && p.length >= 8 && p.length <= 128;
}
__name(validPassword, "validPassword");
async function createSession(db, accountId) {
  const token = newToken();
  await db.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)").bind(await sha256hex(token), accountId, Date.now() + SESSION_TTL_MS).run();
  return token;
}
__name(createSession, "createSession");
async function authenticate(db, request) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const row = await db.prepare(
    `SELECT a.id, a.username FROM sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(await sha256hex(token), Date.now()).first();
  return row ?? null;
}
__name(authenticate, "authenticate");
async function deleteSession(db, request) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
}
__name(deleteSession, "deleteSession");

// ../game/assets/content/items.json
var items_default = [
  {
    name: "stick",
    label: "STICK",
    sprite: "itm_stick",
    kind: "sword",
    damage: 1,
    durability: 18
  },
  {
    name: "driftwood_sword",
    label: "DRIFTWOOD SWORD",
    sprite: "sword_down",
    kind: "sword",
    damage: 1,
    durability: 40
  },
  {
    name: "iron_sword",
    label: "IRON SWORD",
    sprite: "sword_down",
    kind: "sword",
    damage: 2,
    durability: 60
  },
  {
    name: "oak_bow",
    label: "OAK BOW",
    sprite: "itm_bow",
    kind: "bow",
    damage: 1,
    durability: 30
  },
  {
    name: "wooden_shield",
    label: "WOODEN SHIELD",
    sprite: "itm_shield",
    kind: "shield",
    durability: 20
  },
  {
    name: "bomb",
    label: "BOMB",
    sprite: "itm_bomb",
    kind: "bomb"
  },
  {
    name: "arrow",
    label: "ARROW",
    sprite: "arrow_h",
    kind: "arrow"
  },
  {
    name: "fishing_rod",
    label: "FISHING ROD",
    sprite: "itm_rod",
    kind: "rod",
    durability: 25
  },
  {
    name: "raw_perch",
    label: "RAW PERCH",
    sprite: "itm_fish",
    kind: "material"
  },
  {
    name: "raw_eel",
    label: "RAW EEL",
    sprite: "itm_fish",
    kind: "material"
  },
  {
    name: "raw_sunfish",
    label: "RAW SUNFISH",
    sprite: "itm_fish",
    kind: "material"
  },
  {
    name: "raw_brackfish",
    label: "RAW BRACKFISH",
    sprite: "itm_fish",
    kind: "material"
  },
  {
    name: "marsh_herb",
    label: "MARSH HERB",
    sprite: "itm_herb",
    kind: "material"
  },
  {
    name: "ember_cap",
    label: "EMBER CAP",
    sprite: "itm_mushroom",
    kind: "material",
    fuse_effect: "fire"
  },
  {
    name: "small_key",
    label: "SMALL KEY",
    sprite: "itm_key",
    kind: "material"
  },
  {
    name: "boss_key",
    label: "BOSS KEY",
    sprite: "itm_bosskey",
    kind: "material"
  },
  {
    name: "hare_meat",
    label: "HARE MEAT",
    sprite: "itm_meat",
    kind: "material"
  },
  {
    name: "venison",
    label: "VENISON",
    sprite: "itm_meat",
    kind: "material"
  },
  {
    name: "grilled_perch",
    label: "GRILLED PERCH",
    sprite: "itm_food",
    kind: "food",
    heal: 4
  },
  {
    name: "smoked_eel",
    label: "SMOKED EEL",
    sprite: "itm_food",
    kind: "food",
    heal: 6
  },
  {
    name: "hare_skewer",
    label: "HARE SKEWER",
    sprite: "itm_food",
    kind: "food",
    heal: 4
  },
  {
    name: "seared_venison",
    label: "SEARED VENISON",
    sprite: "itm_food",
    kind: "food",
    heal: 6
  },
  {
    name: "fish_stew",
    label: "FISH STEW",
    sprite: "itm_food",
    kind: "food",
    heal: 8
  },
  {
    name: "hearty_roast",
    label: "HEARTY ROAST",
    sprite: "itm_food",
    kind: "food",
    heal: 12
  },
  {
    name: "golden_sunfish",
    label: "GOLDEN SUNFISH",
    sprite: "itm_food",
    kind: "food",
    heal: 10
  },
  {
    name: "crab_claw",
    label: "CRAB CLAW",
    sprite: "mat_claw",
    kind: "material",
    fuse_damage: 1
  },
  {
    name: "wasp_stinger",
    label: "WASP STINGER",
    sprite: "mat_stinger",
    kind: "material",
    fuse_effect: "poison"
  },
  {
    name: "gel_core",
    label: "GEL CORE",
    sprite: "mat_gelcore",
    kind: "material",
    fuse_damage: 1
  },
  {
    name: "hardwood",
    label: "HARDWOOD",
    sprite: "mat_wood",
    kind: "material",
    fuse_damage: 1
  },
  {
    name: "stag_pelt",
    label: "STAG PELT",
    sprite: "mat_pelt",
    kind: "material",
    fuse_damage: 1
  }
];

// ../game/assets/content/quests.json
var quests_default = [
  {
    id: "ashes_and_embers",
    giver: "elder_maru",
    title: "ASHES AND EMBERS",
    offer: [
      ["THORNLINGS CHOKE", "OUR WOODS. CULL", "THREE OF THEM."],
      ["TAKE THIS TASK,", "AND MY OLD IRON", "BLADE IS YOURS."]
    ],
    incomplete: [["THE THORNLINGS", "STILL HISS IN", "THE BRAMBLES..."]],
    complete: [
      ["THE WOODS BREATHE", "EASIER. TAKE THE", "IRON SWORD."]
    ],
    objectives: [{ type: "kill", target: "thornling", count: 3 }],
    rewards: { shells: 20, items: [{ item: "iron_sword", qty: 1 }] }
  },
  {
    id: "three_perch_for_pike",
    giver: "pike",
    title: "THREE PERCH FOR PIKE",
    offer: [
      ["MY BACK IS DONE", "FOR. CATCH ME", "THREE RAW PERCH?"]
    ],
    incomplete: [["THE PERCH WONT", "CATCH THEMSELVES,", "FRIEND."]],
    complete: [
      ["FAT ONES TOO!", "HERE, FOR YOUR", "TROUBLE."]
    ],
    objectives: [{ type: "collect", target: "raw_perch", count: 3 }],
    rewards: { shells: 30, items: [{ item: "arrow", qty: 10 }] }
  },
  {
    id: "a_proper_meal",
    giver: "wren",
    title: "A PROPER MEAL",
    offer: [
      ["RAW FOOD DULLS", "THE SPIRIT. COOK", "TWO REAL MEALS."]
    ],
    incomplete: [["THE FIRE IS LIT.", "THE POT WAITS."]],
    complete: [
      ["NOW THAT IS", "COOKING! TAKE", "THESE HERBS."]
    ],
    objectives: [{ type: "cook", count: 2 }],
    rewards: { shells: 25, items: [{ item: "marsh_herb", qty: 2 }] }
  },
  {
    id: "the_stag_of_greenreach",
    giver: "bramble",
    title: "THE STAG OF GREENREACH",
    offer: [
      ["THE HOLLOW STAG.", "NONE HAVE TAKEN", "IT. CAN YOU?"]
    ],
    incomplete: [["GREENREACH, EAST.", "MOVE QUIET, LOOSE", "ARROWS FAST."]],
    complete: [
      ["BY THE ROOTS...", "YOU DID IT. THE", "HUNT HONORS YOU."]
    ],
    objectives: [{ type: "kill", target: "hollow_stag", count: 1 }],
    rewards: { shells: 40, items: [{ item: "bomb", qty: 5 }] }
  },
  {
    id: "sharper_than_it_looks",
    giver: "tink",
    title: "SHARPER THAN IT LOOKS",
    offer: [
      ["YOU CARRY PARTS", "AND NO VISION!", "FUSE SOMETHING."]
    ],
    incomplete: [["PACK. WEAPON.", "MATERIAL. FUSE.", "SIMPLE!"]],
    complete: [
      ["HA! NOW YOU SEE.", "TAKE THIS STINGER", "FOR THE NEXT ONE."]
    ],
    objectives: [{ type: "fuse", count: 1 }],
    rewards: { shells: 15, items: [{ item: "wasp_stinger", qty: 1 }] }
  },
  {
    id: "the_rootcellar",
    giver: "elder_maru",
    requires: "ashes_and_embers",
    title: "THE ROOTCELLAR",
    offer: [
      ["THE STIRRING HAS", "A NAME. MOLDRA,", "THE ROOT-TYRANT."],
      ["IT FESTERS IN THE", "ROOTCELLAR, UNDER", "THE OLD TERRACES."],
      ["END IT, AND THE", "ISLE IS FREE.", "GO WELL, FRIEND."]
    ],
    incomplete: [["MOLDRA GNAWS ON.", "THE CELLAR DOOR", "WAITS, NORTHEAST."]],
    complete: [
      ["THE ROOTS REST.", "THE ISLE OWES YOU", "EVERYTHING."],
      ["REST NOW, HERO", "OF BRACK. YOUR", "TALE IS TOLD."]
    ],
    objectives: [{ type: "kill", target: "moldra", count: 1 }],
    rewards: { shells: 200, items: [{ item: "hearty_roast", qty: 3 }] }
  }
];

// src/validate.js
var ITEM_NAMES = new Set(items_default.map((i) => i.name));
var QUEST_IDS = new Set(quests_default.map((q) => q.id));
var LIMITS = {
  maxShells: 1e6,
  maxSkillXp: 1e7,
  maxHp: 40,
  maxInventory: 16,
  maxQty: 99,
  maxDurability: 250,
  maxProgress: 1e4
};
function validateSave(data) {
  if (typeof data !== "object" || data === null) return "not an object";
  if (data.schema_version !== 1) return "unknown schema_version";
  if (!Number.isInteger(data.hp) || !Number.isInteger(data.max_hp)) return "bad hp";
  if (data.max_hp < 2 || data.max_hp > LIMITS.maxHp) return "max_hp out of range";
  if (data.hp < 0 || data.hp > data.max_hp) return "hp out of range";
  if (!Number.isInteger(data.shells) || data.shells < 0 || data.shells > LIMITS.maxShells) {
    return "shells out of range";
  }
  if (!Array.isArray(data.skills) || data.skills.length !== 3) return "bad skills";
  for (const xp of data.skills) {
    if (!Number.isInteger(xp) || xp < 0 || xp > LIMITS.maxSkillXp) return "skill xp out of range";
  }
  if (!Array.isArray(data.inventory) || data.inventory.length > LIMITS.maxInventory) {
    return "bad inventory";
  }
  for (const s of data.inventory) {
    if (typeof s !== "object" || s === null) return "bad item";
    if (!ITEM_NAMES.has(s.item)) return `unknown item ${s.item}`;
    if (!Number.isInteger(s.qty) || s.qty < 1 || s.qty > LIMITS.maxQty) return "item qty";
    if (!Number.isInteger(s.durability) || s.durability < 0 || s.durability > LIMITS.maxDurability) {
      return "item durability";
    }
    if (s.fused != null && !ITEM_NAMES.has(s.fused)) return "unknown fused item";
  }
  if (!Array.isArray(data.quests)) return "bad quests";
  for (const q of data.quests) {
    if (typeof q !== "object" || q === null) return "bad quest";
    if (!QUEST_IDS.has(q.id)) return `unknown quest ${q.id}`;
    if (typeof q.done !== "boolean") return "bad quest done";
    if (!Array.isArray(q.progress) || q.progress.length > 8) return "bad quest progress";
    for (const c of q.progress) {
      if (!Number.isInteger(c) || c < 0 || c > LIMITS.maxProgress) return "quest progress";
    }
  }
  for (const k of ["sx", "sy", "x", "y"]) {
    if (!Number.isInteger(data[k]) || Math.abs(data[k]) > 1e3) return "bad position";
  }
  return null;
}
__name(validateSave, "validateSave");

// src/characters.js
var WRITE_INTERVAL_MS = 1e4;
var MAX_CHARACTERS = 3;
var MAX_SAVE_BYTES = 32 * 1024;
async function listCharacters(db, accountId) {
  const { results } = await db.prepare(
    "SELECT id, name, level, schema_version, updated_at FROM characters WHERE account_id = ?"
  ).bind(accountId).all();
  return results;
}
__name(listCharacters, "listCharacters");
async function getCharacter(db, accountId, id) {
  return db.prepare("SELECT id, name, data, updated_at FROM characters WHERE id = ? AND account_id = ?").bind(id, accountId).first();
}
__name(getCharacter, "getCharacter");
async function createCharacter(db, accountId, name, data) {
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM characters WHERE account_id = ?").bind(accountId).first();
  if (existing.n >= MAX_CHARACTERS) return { error: "character limit reached", status: 409 };
  const err = checkPayload(data);
  if (err) return err;
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO characters (id, account_id, name, schema_version, level, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, accountId, String(name).slice(0, 16), data.schema_version, level(data), JSON.stringify(data), Date.now()).run();
  return { id };
}
__name(createCharacter, "createCharacter");
async function updateCharacter(db, accountId, id, data) {
  const row = await db.prepare("SELECT updated_at FROM characters WHERE id = ? AND account_id = ?").bind(id, accountId).first();
  if (!row) return { error: "not found", status: 404 };
  if (Date.now() - row.updated_at < WRITE_INTERVAL_MS) {
    return { error: "too many saves; slow down", status: 429 };
  }
  const err = checkPayload(data);
  if (err) return err;
  await db.prepare(
    "UPDATE characters SET data = ?, schema_version = ?, level = ?, updated_at = ? WHERE id = ?"
  ).bind(JSON.stringify(data), data.schema_version, level(data), Date.now(), id).run();
  return { ok: true };
}
__name(updateCharacter, "updateCharacter");
function checkPayload(data) {
  if (JSON.stringify(data ?? null).length > MAX_SAVE_BYTES) {
    return { error: "save too large", status: 413 };
  }
  const reason = validateSave(data);
  if (reason) return { error: `invalid save: ${reason}`, status: 422 };
  return null;
}
__name(checkPayload, "checkPayload");
function level(data) {
  const max = Math.max(...data.skills, 0);
  return 1 + Math.floor(Math.sqrt(max / 50));
}
__name(level, "level");

// src/friends.js
async function listFriends(db, accountId) {
  const { results } = await db.prepare(
    `SELECT a.username,
              f.status,
              f.account_id = ?1 AS outgoing,
              (SELECT MAX(level) FROM characters c WHERE c.account_id = a.id) AS level
       FROM friends f
       JOIN accounts a ON a.id = CASE WHEN f.account_id = ?1 THEN f.friend_id ELSE f.account_id END
       WHERE f.account_id = ?1 OR f.friend_id = ?1`
  ).bind(accountId).all();
  return results.map((r) => ({
    username: r.username,
    level: r.level ?? 1,
    status: r.status === "accepted" ? "friend" : r.outgoing ? "sent" : "incoming"
  }));
}
__name(listFriends, "listFriends");
async function sendRequest(db, accountId, username) {
  const target = await db.prepare("SELECT id FROM accounts WHERE username = ?").bind(username ?? "").first();
  if (!target) return { error: "no such player", status: 404 };
  if (target.id === accountId) return { error: "that is you", status: 400 };
  const existing = await db.prepare(
    "SELECT status FROM friends WHERE (account_id = ?1 AND friend_id = ?2) OR (account_id = ?2 AND friend_id = ?1)"
  ).bind(accountId, target.id).first();
  if (existing) return { error: "request already exists", status: 409 };
  await db.prepare(
    "INSERT INTO friends (account_id, friend_id, status, created_at) VALUES (?, ?, 'pending', ?)"
  ).bind(accountId, target.id, Date.now()).run();
  return { ok: true };
}
__name(sendRequest, "sendRequest");
async function respondRequest(db, accountId, username, accept) {
  const from = await db.prepare("SELECT id FROM accounts WHERE username = ?").bind(username ?? "").first();
  if (!from) return { error: "no such player", status: 404 };
  if (accept) {
    const r = await db.prepare(
      "UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ? AND status = 'pending'"
    ).bind(from.id, accountId).run();
    if (!r.meta.changes) return { error: "no pending request", status: 404 };
  } else {
    await db.prepare("DELETE FROM friends WHERE account_id = ? AND friend_id = ?").bind(from.id, accountId).run();
  }
  return { ok: true };
}
__name(respondRequest, "respondRequest");

// src/room.js
var MAX_MEMBERS = 4;
var RoomDO = class {
  static {
    __name(this, "RoomDO");
  }
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      name: null,
      host: false,
      joined: false
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  members() {
    return this.state.getWebSockets().map((ws) => ({ ws, meta: ws.deserializeAttachment() }));
  }
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  broadcast(msg, exceptId) {
    for (const { ws, meta } of this.members()) {
      if (meta.joined && meta.id !== exceptId) this.send(ws, msg);
    }
  }
  webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: "error", code: "bad-json" });
    }
    const meta = ws.deserializeAttachment();
    const all = this.members();
    const joined = all.filter((m) => m.meta.joined);
    switch (msg.t) {
      case "create": {
        if (joined.some((m) => m.meta.host)) {
          return this.send(ws, { t: "error", code: "exists", msg: "party already exists" });
        }
        Object.assign(meta, { host: true, joined: true, name: String(msg.name ?? "host").slice(0, 16) });
        ws.serializeAttachment(meta);
        return this.send(ws, { t: "created", self_id: meta.id });
      }
      case "join": {
        const host = joined.find((m) => m.meta.host);
        if (!host) {
          return this.send(ws, { t: "error", code: "no-party", msg: "no such party" });
        }
        if (joined.length >= MAX_MEMBERS) {
          return this.send(ws, { t: "error", code: "full", msg: "party is full" });
        }
        Object.assign(meta, { joined: true, name: String(msg.name ?? "player").slice(0, 16) });
        ws.serializeAttachment(meta);
        this.broadcast({ t: "peer-joined", id: meta.id, name: meta.name }, meta.id);
        return this.send(ws, {
          t: "joined",
          self_id: meta.id,
          host_id: host.meta.id,
          peers: joined.map((m) => ({ id: m.meta.id, name: m.meta.name }))
        });
      }
      case "signal": {
        if (!meta.joined) return;
        const target = all.find((m) => m.meta.id === msg.to && m.meta.joined);
        if (target) {
          this.send(target.ws, { t: "signal", from: meta.id, payload: msg.payload });
        }
        return;
      }
      case "leave":
        return ws.close(1e3, "leave");
      default:
        return this.send(ws, { t: "error", code: "bad-type" });
    }
  }
  webSocketClose(ws) {
    const meta = ws.deserializeAttachment();
    if (meta.joined) {
      this.broadcast(meta.host ? { t: "host-left" } : { t: "peer-left", id: meta.id }, meta.id);
    }
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
};

// src/index.js
var PARTY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === "https://nak.as") return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}
__name(allowedOrigin, "allowedOrigin");
function corsHeaders(request) {
  const origin = allowedOrigin(request.headers.get("Origin"));
  return {
    "Access-Control-Allow-Origin": origin ?? "https://nak.as",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
__name(corsHeaders, "corsHeaders");
function json(request, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) }
  });
}
__name(json, "json");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
__name(readJson, "readJson");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const db = env.DB;
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (method === "POST" && url.pathname === "/auth/register") {
      const body = await readJson(request);
      if (!body || !validUsername(body.username)) {
        return json(request, 400, { error: "username: 3-16 letters/digits/_" });
      }
      if (!validPassword(body.password)) {
        return json(request, 400, { error: "password: at least 8 characters" });
      }
      const taken = await db.prepare("SELECT id FROM accounts WHERE username = ?").bind(body.username).first();
      if (taken) return json(request, 409, { error: "username is taken" });
      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO accounts (id, username, pass_hash, created_at) VALUES (?, ?, ?, ?)").bind(id, body.username, await hashPassword(body.password), Date.now()).run();
      const token = await createSession(db, id);
      return json(request, 200, { token, username: body.username });
    }
    if (method === "POST" && url.pathname === "/auth/login") {
      const body = await readJson(request);
      if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
        return json(request, 400, { error: "missing credentials" });
      }
      const account2 = await db.prepare("SELECT id, username, pass_hash FROM accounts WHERE username = ?").bind(body.username).first();
      if (!account2 || !await verifyPassword(body.password, account2.pass_hash)) {
        return json(request, 401, { error: "wrong username or password" });
      }
      const token = await createSession(db, account2.id);
      return json(request, 200, { token, username: account2.username });
    }
    if (method === "POST" && url.pathname === "/auth/logout") {
      await deleteSession(db, request);
      return json(request, 200, { ok: true });
    }
    if (method === "POST" && url.pathname === "/party") {
      let code = "";
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      for (const b of bytes) code += PARTY_ALPHABET[b % PARTY_ALPHABET.length];
      return json(request, 200, { code });
    }
    const room = url.pathname.match(/^\/ws\/room\/([A-Z2-9]{5})$/);
    if (room) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json(request, 426, { error: "expected websocket" });
      }
      if (request.headers.get("Origin") && !allowedOrigin(request.headers.get("Origin"))) {
        return json(request, 403, { error: "origin not allowed" });
      }
      const id = env.ROOMS.idFromName(room[1]);
      return env.ROOMS.get(id).fetch(request);
    }
    const account = await authenticate(db, request);
    if (!account) return json(request, 401, { error: "not logged in" });
    if (method === "GET" && url.pathname === "/me") {
      return json(request, 200, { username: account.username });
    }
    if (method === "GET" && url.pathname === "/characters") {
      return json(request, 200, { characters: await listCharacters(db, account.id) });
    }
    if (method === "POST" && url.pathname === "/characters") {
      const body = await readJson(request);
      if (!body?.data) return json(request, 400, { error: "missing data" });
      const result = await createCharacter(db, account.id, body.name ?? account.username, body.data);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }
    if (method === "GET" && url.pathname === "/friends") {
      return json(request, 200, { friends: await listFriends(db, account.id) });
    }
    if (method === "POST" && url.pathname === "/friends/request") {
      const body = await readJson(request);
      const result = await sendRequest(db, account.id, body?.username);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }
    if (method === "POST" && url.pathname === "/friends/respond") {
      const body = await readJson(request);
      const result = await respondRequest(db, account.id, body?.username, !!body?.accept);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }
    const charGet = url.pathname.match(/^\/characters\/([0-9a-f-]{36})$/);
    if (charGet && method === "GET") {
      const row = await getCharacter(db, account.id, charGet[1]);
      if (!row) return json(request, 404, { error: "not found" });
      return json(request, 200, { ...row, data: JSON.parse(row.data) });
    }
    if (charGet && method === "PUT") {
      const body = await readJson(request);
      if (!body?.data) return json(request, 400, { error: "missing data" });
      const result = await updateCharacter(db, account.id, charGet[1], body.data);
      if (result.error) return json(request, result.status, { error: result.error });
      return json(request, 200, result);
    }
    return json(request, 404, { error: "not found" });
  }
};

// ../../../../../opt/homebrew/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../opt/homebrew/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-HcGfIf/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// ../../../../../opt/homebrew/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-HcGfIf/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  RoomDO,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
