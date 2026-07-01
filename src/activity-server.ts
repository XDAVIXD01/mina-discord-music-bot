import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import path from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

type PlaybackState = {
  url: string;
  paused: boolean;
  currentTime: number;
  updatedAt: number;
  revision: number;
};

const rooms = new Map<string, { state?: PlaybackState; clients: Set<WebSocket> }>();
const sessions = new Map<string, number>();
const activityPort = Number(process.env.PORT || process.env.ACTIVITY_PORT || 3001);
const localMode = process.env.NODE_ENV !== "production";
const execFileAsync = promisify(execFile);

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:")) return true;
  if (!isIP(address) || address.includes(":")) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

async function validateRemoteUrl(raw: string): Promise<URL> {
  if (raw.length > 8_000) throw new Error("URL demasiado larga.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Solo se permiten enlaces HTTP o HTTPS.");
  if (url.username || url.password) throw new Error("La URL no puede incluir credenciales.");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("No se permiten direcciones locales o privadas.");
  }
  return url;
}

function verifySession(sessionId: string): boolean {
  if (localMode && !sessionId) return true;
  return Boolean(sessionId && (sessions.get(sessionId) || 0) > Date.now());
}

function isYouTubeUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "youtu.be";
}

async function resolveYouTubeVideo(rawUrl: string): Promise<string> {
  const url = await validateRemoteUrl(rawUrl);
  if (!isYouTubeUrl(url)) throw new Error("El enlace no pertenece a YouTube.");
  const ytDlp = process.env.YTDLP_PATH || "yt-dlp";
  const { stdout } = await execFileAsync(ytDlp, [
    "--no-playlist",
    "--no-warnings",
    "--format", "best[ext=mp4][protocol^=http]/best[protocol^=http]/best",
    "--get-url",
    url.href,
  ], {
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const resolved = stdout.split(/\r?\n/).find((line) => /^https?:\/\//i.test(line.trim()))?.trim();
  if (!resolved) throw new Error("YouTube no entregó un formato reproducible.");
  await validateRemoteUrl(resolved);
  return resolved;
}

async function fetchValidated(start: URL, range?: string): Promise<{ response: Response; finalUrl: URL }> {
  let url = start;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "MINA-Discord-Activity/1.0",
        ...(range ? { Range: range } : {}),
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: url };
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirección inválida.");
    url = await validateRemoteUrl(new URL(location, url).href);
  }
  throw new Error("Demasiadas redirecciones.");
}

function proxyUrl(url: string, sessionId: string): string {
  return `/api/media?url=${encodeURIComponent(url)}&session=${encodeURIComponent(sessionId)}`;
}

function rewriteManifest(text: string, base: URL, sessionId: string): string {
  return text.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (!line.startsWith("#")) return proxyUrl(new URL(line, base).href, sessionId);
    return line.replace(/URI="([^"]+)"/g, (_match, uri: string) =>
      `URI="${proxyUrl(new URL(uri, base).href, sessionId)}"`);
  }).join("\n");
}

export function startActivityServer(): void {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, service: "mina-stream" }));

  app.post("/api/token", async (req, res) => {
    try {
      const clientId = process.env.DISCORD_CLIENT_ID;
      const clientSecret = process.env.DISCORD_CLIENT_SECRET;
      const code = String(req.body?.code || "");
      if (!clientId || !clientSecret || !code) return res.status(400).json({ error: "Configuración OAuth incompleta." });
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      });
      const response = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok || typeof data.access_token !== "string") return res.status(response.status).json(data);
      const sessionId = randomUUID();
      sessions.set(sessionId, Date.now() + Math.min(Number(data.expires_in || 3600), 3600) * 1000);
      res.json({ ...data, session_id: sessionId });
    } catch (error) {
      console.error("OAuth Activity:", error);
      res.status(500).json({ error: "No se pudo autenticar." });
    }
  });

  app.get("/api/resolve", async (req, res) => {
    try {
      const sessionId = String(req.query.session || "");
      if (!verifySession(sessionId)) return res.status(401).json({ error: "No autorizado." });
      const sourceUrl = String(req.query.url || "");
      const parsed = new URL(sourceUrl);
      if (!isYouTubeUrl(parsed)) return res.json({ type: "direct", url: sourceUrl });
      const resolvedUrl = await resolveYouTubeVideo(sourceUrl);
      res.json({ type: "youtube", url: resolvedUrl });
    } catch (error) {
      console.error("Resolución de video:", error);
      res.status(400).json({
        error: error instanceof Error ? error.message : "No se pudo resolver el video.",
      });
    }
  });

  app.get("/api/media", async (req, res) => {
    try {
      const sessionId = String(req.query.session || "");
      if (!verifySession(sessionId)) return res.status(401).send("No autorizado.");
      const initialUrl = await validateRemoteUrl(String(req.query.url || ""));
      const { response, finalUrl } = await fetchValidated(initialUrl, req.headers.range);
      if (!response.ok && response.status !== 206) return res.status(response.status).send("El servidor de video rechazó la solicitud.");

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      const isManifest = contentType.includes("mpegurl") || /\.m3u8(?:$|[?#])/i.test(finalUrl.href);
      res.status(response.status);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", isManifest ? "no-store" : "public, max-age=300");

      if (isManifest) {
        const text = await response.text();
        if (text.length > 2_000_000) return res.status(413).send("Lista HLS demasiado grande.");
        return res.type("application/vnd.apple.mpegurl").send(rewriteManifest(text, finalUrl, sessionId));
      }

      for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (!response.body) return res.end();
      Readable.fromWeb(response.body as never).pipe(res);
    } catch (error) {
      res.status(400).send(error instanceof Error ? error.message : "No se pudo cargar el video.");
    }
  });

  const staticDirectory = path.resolve(process.cwd(), "activity-dist");
  app.use(express.static(staticDirectory));
  app.use((_req, res) => res.sendFile(path.join(staticDirectory, "index.html")));

  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      if (url.pathname !== "/socket" || !verifySession(url.searchParams.get("session") || "")) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, url));
    } catch {
      socket.destroy();
    }
  });

  sockets.on("connection", (ws, url: URL) => {
    const roomId = (url.searchParams.get("room") || "").slice(0, 128);
    if (!roomId) return ws.close(1008, "Falta la sala.");
    const room = rooms.get(roomId) || { clients: new Set<WebSocket>() };
    rooms.set(roomId, room);
    room.clients.add(ws);
    if (room.state) ws.send(JSON.stringify(room.state));

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Partial<PlaybackState> & { type?: string };
        if (message.type !== "state" || typeof message.url !== "string" || message.url.length > 8_000) return;
        room.state = {
          url: message.url,
          paused: Boolean(message.paused),
          currentTime: Math.max(0, Number(message.currentTime) || 0),
          updatedAt: Date.now(),
          revision: (room.state?.revision || 0) + 1,
        };
        const payload = JSON.stringify(room.state);
        for (const client of room.clients) if (client.readyState === WebSocket.OPEN) client.send(payload);
      } catch {
        // Ignora mensajes malformados.
      }
    });
    ws.on("close", () => {
      room.clients.delete(ws);
      if (!room.clients.size) setTimeout(() => {
        if (!room.clients.size) rooms.delete(roomId);
      }, 30 * 60_000);
    });
  });

  server.listen(activityPort, () => console.log(`MINA Stream escuchando en http://localhost:${activityPort}`));
}
