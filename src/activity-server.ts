import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
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

type Room = {
  state?: PlaybackState;
  clients: Set<WebSocket>;
  controllerKey?: string;
  ownerUserId?: string;
};

type ActivitySession = {
  controller: boolean;
  expiresAt: number;
  roomId: string;
};

type YouTubeStream = {
  createdAt: number;
  directory: string;
  id: string;
  process: ChildProcess;
};

const rooms = new Map<string, Room>();
const sessions = new Map<string, ActivitySession>();
const youtubeStreamsByUrl = new Map<string, YouTubeStream>();
const youtubeStreamsById = new Map<string, YouTubeStream>();
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

function getSession(sessionId: string): ActivitySession | undefined {
  if (localMode && !sessionId) return { controller: true, expiresAt: Infinity, roomId: "local" };
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt <= Date.now()) return undefined;
  return session;
}

function isYouTubeUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  return hostname === "youtube.com" || hostname === "m.youtube.com" || hostname === "youtu.be";
}

async function prepareYouTubeStream(rawUrl: string): Promise<YouTubeStream> {
  const url = await validateRemoteUrl(rawUrl);
  if (!isYouTubeUrl(url)) throw new Error("El enlace no pertenece a YouTube.");
  const cached = youtubeStreamsByUrl.get(url.href);
  if (cached && (cached.process.exitCode === null || cached.process.exitCode === 0)) return cached;

  const ytDlp = process.env.YTDLP_PATH || "yt-dlp";
  const { stdout } = await execFileAsync(ytDlp, [
    "--no-playlist",
    "--no-warnings",
    "--format",
    "bestvideo[height<=1080][vcodec^=avc1][ext=mp4]+bestaudio[acodec^=mp4a][ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]",
    "--get-url",
    url.href,
  ], {
    timeout: 45_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const mediaUrls = stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  if (!mediaUrls.length) throw new Error("YouTube no entregó un formato reproducible.");
  await Promise.all(mediaUrls.map(validateRemoteUrl));

  const id = randomUUID();
  const directory = path.join(os.tmpdir(), "mina-youtube", id);
  await mkdir(directory, { recursive: true });
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const inputArgs = mediaUrls.flatMap((mediaUrl) => ["-i", mediaUrl]);
  const mapArgs = mediaUrls.length > 1
    ? ["-map", "0:v:0", "-map", "1:a:0"]
    : ["-map", "0:v:0", "-map", "0:a:0?"];
  const ffmpegProcess = spawn(ffmpeg, [
    "-hide_banner", "-loglevel", "warning",
    ...inputArgs,
    ...mapArgs,
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-f", "hls",
    "-hls_time", "2",
    "-hls_list_size", "0",
    "-hls_flags", "independent_segments",
    "-hls_segment_filename", path.join(directory, "segment-%05d.ts"),
    path.join(directory, "index.m3u8"),
  ], { windowsHide: true });
  let ffmpegError = "";
  ffmpegProcess.stderr?.on("data", (chunk: Buffer) => {
    ffmpegError = `${ffmpegError}${chunk.toString()}`.slice(-4_000);
  });

  const stream: YouTubeStream = { createdAt: Date.now(), directory, id, process: ffmpegProcess };
  youtubeStreamsByUrl.set(url.href, stream);
  youtubeStreamsById.set(id, stream);
  ffmpegProcess.once("exit", (code) => {
    if (code && !youtubeStreamsById.has(id)) void rm(directory, { recursive: true, force: true });
  });

  const manifestPath = path.join(directory, "index.m3u8");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (ffmpegProcess.exitCode !== null && ffmpegProcess.exitCode !== 0) {
      throw new Error(`FFmpeg no pudo preparar el video. ${ffmpegError.trim()}`);
    }
    try {
      const manifest = await readFile(manifestPath, "utf8");
      if (manifest.includes("#EXTINF")) return stream;
    } catch {
      // Espera el primer segmento.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  ffmpegProcess.kill();
  throw new Error("El video tardó demasiado en prepararse.");
}

export function registerActivityRoom(instanceId: string, ownerUserId: string): void {
  const room = rooms.get(instanceId) || { clients: new Set<WebSocket>() };
  room.ownerUserId = ownerUserId;
  rooms.set(instanceId, room);
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

  app.post("/api/session", (req, res) => {
    const roomId = String(req.body?.room || "").slice(0, 128);
    if (!roomId) return res.status(400).json({ error: "Falta la sala de Discord." });
    const room = rooms.get(roomId) || { clients: new Set<WebSocket>() };
    rooms.set(roomId, room);

    const suppliedControllerKey = String(req.body?.controller_key || "");
    let controller = Boolean(room.controllerKey && suppliedControllerKey === room.controllerKey);
    if (!room.controllerKey) {
      room.controllerKey = randomUUID();
      controller = true;
    }

    const sessionId = randomUUID();
    sessions.set(sessionId, {
      controller,
      expiresAt: Date.now() + 12 * 60 * 60_000,
      roomId,
    });
    res.json({
      controller,
      controller_key: controller ? room.controllerKey : undefined,
      session_id: sessionId,
    });
  });

  app.get("/api/resolve", async (req, res) => {
    try {
      const sessionId = String(req.query.session || "");
      if (!getSession(sessionId)) return res.status(401).json({ error: "No autorizado." });
      const sourceUrl = String(req.query.url || "");
      const parsed = new URL(sourceUrl);
      if (!isYouTubeUrl(parsed)) return res.json({ type: "direct", url: sourceUrl });
      const stream = await prepareYouTubeStream(sourceUrl);
      res.json({ type: "hls", url: `/api/youtube-stream/${stream.id}/index.m3u8` });
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
      if (!getSession(sessionId)) return res.status(401).send("No autorizado.");
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

  app.get("/api/youtube-stream/:id/:file", async (req, res) => {
    try {
      const sessionId = String(req.query.session || "");
      if (!getSession(sessionId)) return res.status(401).send("No autorizado.");
      const id = String(req.params.id);
      const file = String(req.params.file);
      if (!/^[0-9a-f-]{36}$/i.test(id) || !/^(?:index\.m3u8|segment-\d{5}\.ts)$/.test(file)) {
        return res.status(400).send("Ruta inválida.");
      }
      const stream = youtubeStreamsById.get(id);
      if (!stream) return res.status(404).send("El stream expiró.");
      const filePath = path.join(stream.directory, file);
      await stat(filePath);
      if (file === "index.m3u8") {
        const manifest = await readFile(filePath, "utf8");
        const rewritten = manifest.replace(
          /^(segment-\d{5}\.ts)$/gm,
          `$1?session=${encodeURIComponent(sessionId)}`,
        );
        return res.type("application/vnd.apple.mpegurl").set("Cache-Control", "no-store").send(rewritten);
      }
      res.type("video/mp2t").set("Cache-Control", "public, max-age=3600").sendFile(filePath);
    } catch {
      res.status(404).send("Segmento no disponible.");
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
      const session = getSession(url.searchParams.get("session") || "");
      const roomId = (url.searchParams.get("room") || "").slice(0, 128);
      if (url.pathname !== "/socket" || !session || session.roomId !== roomId) {
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
    const sessionId = url.searchParams.get("session") || "";
    const session = getSession(sessionId);
    if (!roomId) return ws.close(1008, "Falta la sala.");
    if (!session || session.roomId !== roomId) return ws.close(1008, "Sesión inválida.");
    const room = rooms.get(roomId) || { clients: new Set<WebSocket>() };
    rooms.set(roomId, room);
    room.clients.add(ws);
    ws.send(JSON.stringify({ type: "role", controller: session.controller }));
    if (room.state) ws.send(JSON.stringify({ type: "state", ...room.state }));

    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Partial<PlaybackState> & { type?: string };
        if (!session.controller) return;
        if (message.type !== "state" || typeof message.url !== "string" || message.url.length > 8_000) return;
        room.state = {
          url: message.url,
          paused: Boolean(message.paused),
          currentTime: Math.max(0, Number(message.currentTime) || 0),
          updatedAt: Date.now(),
          revision: (room.state?.revision || 0) + 1,
        };
        const payload = JSON.stringify({ type: "state", ...room.state });
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

  setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60_000;
    for (const [sourceUrl, stream] of youtubeStreamsByUrl) {
      if (stream.createdAt >= cutoff) continue;
      stream.process.kill();
      youtubeStreamsByUrl.delete(sourceUrl);
      youtubeStreamsById.delete(stream.id);
      void rm(stream.directory, { recursive: true, force: true });
    }
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= Date.now()) sessions.delete(sessionId);
    }
  }, 15 * 60_000).unref();
}
