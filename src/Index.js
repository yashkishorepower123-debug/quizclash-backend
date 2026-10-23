
import { DurableObject } from "cloudflare:workers";

const SITE_ORIGIN =
  "https://yashkishorepower123-debug.github.io";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function cors(request, response) {
  if (response.status === 101) return response;

  const headers = new Headers(response.headers);
  const origin = request.headers.get("Origin");

  if (origin === SITE_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", SITE_ORIGIN);
  }

  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Vary", "Origin");

  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function validName(name) {
  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name.trim().length <= 18;
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": SITE_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname === "/api/health" &&
        request.method === "GET") {
      return cors(request, json({
        ok: true,
        app: "QuizClash",
        rooms: "enabled"
      }));
    }

    if (url.pathname === "/api/rooms" &&
        request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return cors(request, json({ error: "Invalid JSON" }, 400));
      }

      if (!validName(body.name)) {
        return cors(request, json({
          error: "Name must be 1–18 characters"
        }, 400));
      }

      for (let i = 0; i < 5; i++) {
        const code = roomCode();
        const stub = env.ROOMS.getByName(code);

        const response = await stub.fetch(
          "https://room.internal/create",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: body.name.trim(), code })
          }
        );

        if (response.status !== 409) {
          return cors(request, response);
        }
      }

      return cors(request, json({
        error: "Could not create a room. Try again."
      }, 503));
    }

    const match = url.pathname.match(
      /^\/api\/rooms\/([A-Z0-9]{6})\/(join|state|ws)$/
    );

    if (!match) {
      return cors(request, json({ error: "Not found" }, 404));
    }

    const [, code, action] = match;
    const stub = env.ROOMS.getByName(code);

    if (action === "join" && request.method !== "POST") {
      return cors(request, json({ error: "Use POST" }, 405));
    }

    if (action === "state" && request.method !== "GET") {
      return cors(request, json({ error: "Use GET" }, 405));
    }

    if (action === "ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return cors(request, json({
          error: "WebSocket upgrade required"
        }, 426));
      }

      const internal = new URL("https://room.internal/ws");
      internal.search = url.search;

      return stub.fetch(new Request(internal, request));
    }

    if (action === "join") {
      let body;

      try {
        body = await request.json();
      } catch {
        return cors(request, json({ error: "Invalid JSON" }, 400));
      }

      if (!validName(body.name)) {
        return cors(request, json({
          error: "Name must be 1–18 characters"
        }, 400));
      }

      const internal = new Request(
        "https://room.internal/join",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: body.name.trim() })
        }
      );

      return cors(request, await stub.fetch(internal));
    }

    return cors(request, await stub.fetch(
      "https://room.internal/state"
    ));
  }
};

export class QuizRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async readRoom() {
    return await this.ctx.storage.get("room");
  }

  async saveRoom(room) {
    await this.ctx.storage.put("room", room);
  }

  async broadcast() {
    const room = await this.readRoom();
    if (!room) return;

    const message = JSON.stringify({
      type: "room",
      room
    });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/create" &&
        request.method === "POST") {
      if (await this.readRoom()) {
        return json({ error: "Room code already exists" }, 409);
      }

      const { name, code } = await request.json();

      const room = {
        code,
        status: "waiting",
        createdAt: Date.now(),
        players: [{
          id: crypto.randomUUID(),
          name,
          ready: false,
          online: false
        }]
      };

      await this.saveRoom(room);

      return json({
        room,
        playerId: room.players[0].id
      }, 201);
    }

    if (url.pathname === "/join" &&
        request.method === "POST") {
      const room = await this.readRoom();

      if (!room) {
        return json({ error: "Room not found" }, 404);
      }

      if (room.status !== "waiting" ||
          room.players.length >= 2) {
        return json({ error: "Room is full" }, 409);
      }

      const { name } = await request.json();

      if (!validName(name)) {
        return json({ error: "Invalid name" }, 400);
      }

      const player = {
        id: crypto.randomUUID(),
        name,
        ready: false,
        online: false
      };

      room.players.push(player);
      await this.saveRoom(room);
      await this.broadcast();

      return json({ room, playerId: player.id }, 201);
    }

    if (url.pathname === "/state") {
      const room = await this.readRoom();

      return room
        ? json({ room })
        : json({ error: "Room not found" }, 404);
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return json({ error: "WebSocket required" }, 426);
      }

      const playerId = url.searchParams.get("playerId");
      const room = await this.readRoom();

      if (!room) {
        return json({ error: "Room not found" }, 404);
      }

      const player = room.players.find(
        p => p.id === playerId
      );

      if (!player) {
        return json({ error: "Unknown player" }, 401);
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ playerId });

      player.online = true;
      await this.saveRoom(room);
      await this.broadcast();

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    return json({ error: "Not found" }, 404);
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 1000) {
      return;
    }

    let data;

    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ error: "Invalid message" }));
      return;
    }

    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (data.type !== "ready" ||
        typeof data.ready !== "boolean") {
      ws.send(JSON.stringify({ error: "Unsupported message" }));
      return;
    }

    const attachment = ws.deserializeAttachment();
    const room = await this.readRoom();

    if (!room || !attachment) return;

    const player = room.players.find(
      p => p.id === attachment.playerId
    );

    if (!player) return;

    player.ready = data.ready;
    await this.saveRoom(room);
    await this.broadcast();
  }

  async webSocketClose(ws) {
    const attachment = ws.deserializeAttachment();
    const room = await this.readRoom();

    if (!room || !attachment) return;

    const player = room.players.find(
      p => p.id === attachment.playerId
    );

    if (player) {
      player.online = false;
      player.ready = false;
      await this.saveRoom(room);
      await this.broadcast();
    }
  }
}
