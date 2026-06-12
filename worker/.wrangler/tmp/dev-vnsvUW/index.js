var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

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
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method === "POST" && url.pathname === "/party") {
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

// .wrangler/tmp/bundle-iz59wd/middleware-insertion-facade.js
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

// .wrangler/tmp/bundle-iz59wd/middleware-loader.entry.ts
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
