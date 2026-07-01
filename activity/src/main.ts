import { DiscordSDK } from "@discord/embedded-app-sdk";
import Hls from "hls.js";
import "./style.css";

type PlaybackState = {
  url: string;
  paused: boolean;
  currentTime: number;
  updatedAt: number;
  revision: number;
};

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID || import.meta.env.DISCORD_CLIENT_ID;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const form = document.querySelector<HTMLFormElement>("#source-form")!;
const input = document.querySelector<HTMLInputElement>("#source")!;
const status = document.querySelector<HTMLElement>("#status")!;
const message = document.querySelector<HTMLElement>("#message")!;
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

let accessToken = "";
let sessionId = "";
let roomId = new URLSearchParams(location.search).get("room") || "local";
let socket: WebSocket;
let hls: Hls | undefined;
let currentUrl = "";
let revision = 0;
let applyingRemote = false;
let lastSent = 0;

function showMessage(text: string, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

async function authenticate() {
  if (isLocal) {
    status.textContent = "Modo local";
    return;
  }
  if (!clientId) throw new Error("Falta VITE_DISCORD_CLIENT_ID.");
  const discord = new DiscordSDK(clientId);
  await discord.ready();
  roomId = discord.instanceId;
  const { code } = await discord.commands.authorize({
    client_id: clientId,
    response_type: "code",
    state: "",
    prompt: "none",
    scope: ["identify"],
  });
  const response = await fetch("/.proxy/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error("Discord no pudo autenticar la Activity.");
  const token = await response.json() as { access_token: string; session_id: string };
  accessToken = token.access_token;
  sessionId = token.session_id;
  await discord.commands.authenticate({ access_token: accessToken });
}

const apiPath = (path: string) => isLocal ? path : `/.proxy${path}`;
const mediaUrl = (url: string) =>
  apiPath(`/api/media?url=${encodeURIComponent(url)}&session=${encodeURIComponent(sessionId)}`);

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${location.host}${apiPath("/socket")}?room=${encodeURIComponent(roomId)}&session=${encodeURIComponent(sessionId)}`,
  );
  socket.addEventListener("open", () => {
    status.textContent = "Sincronizado";
    status.classList.add("online");
  });
  socket.addEventListener("close", () => {
    status.textContent = "Reconectando…";
    status.classList.remove("online");
    setTimeout(connect, 1500);
  });
  socket.addEventListener("message", (event) => void applyState(JSON.parse(String(event.data))));
}

async function loadSource(url: string) {
  hls?.destroy();
  hls = undefined;
  currentUrl = url;
  empty.hidden = true;
  video.hidden = false;
  const proxied = mediaUrl(url);
  if (/\.m3u8(?:$|[?#])/i.test(url) && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
    hls.loadSource(proxied);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) showMessage(`No se pudo cargar el stream: ${data.details}`, true);
    });
  } else {
    video.src = proxied;
  }
}

async function applyState(state: PlaybackState) {
  if (state.revision < revision) return;
  revision = state.revision;
  applyingRemote = true;
  try {
    if (state.url && state.url !== currentUrl) {
      input.value = state.url;
      await loadSource(state.url);
    }
    const target = state.paused
      ? state.currentTime
      : state.currentTime + Math.max(0, (Date.now() - state.updatedAt) / 1000);
    if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 1.25) video.currentTime = target;
    if (state.paused) video.pause();
    else await video.play().catch(() => showMessage("Pulsa reproducir para permitir video con sonido."));
  } finally {
    setTimeout(() => { applyingRemote = false; }, 150);
  }
}

function sendState(paused = video.paused) {
  if (applyingRemote || socket?.readyState !== WebSocket.OPEN || !currentUrl) return;
  const now = Date.now();
  if (now - lastSent < 250) return;
  lastSent = now;
  socket.send(JSON.stringify({ type: "state", url: currentUrl, paused, currentTime: video.currentTime || 0 }));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) return showMessage("Ingresa un enlace HTTP o HTTPS válido.", true);
  void loadSource(url).then(() => {
    showMessage("");
    sendState(true);
  });
});
video.addEventListener("play", () => sendState(false));
video.addEventListener("pause", () => sendState(true));
video.addEventListener("seeked", () => sendState(video.paused));

authenticate().then(connect).catch((error) => {
  status.textContent = "Error";
  showMessage(error instanceof Error ? error.message : "No se pudo iniciar.", true);
});
