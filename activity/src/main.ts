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
const syncButton = document.querySelector<HTMLButtonElement>("#sync-button")!;
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

let sessionId = "";
let roomId = new URLSearchParams(location.search).get("room") || "local";
let socket: WebSocket;
let hls: Hls | undefined;
let currentUrl = "";
let revision = 0;
let applyingRemote = false;
let lastSent = 0;
let controller = false;
let latestState: PlaybackState | undefined;

function showMessage(text: string, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}

async function createSession() {
  if (!isLocal) {
    if (!clientId) throw new Error("Falta VITE_DISCORD_CLIENT_ID.");
    const discord = new DiscordSDK(clientId);
    await discord.ready();
    roomId = discord.instanceId;
  }
  const storageKey = `mina-controller:${roomId}`;
  const response = await fetch(apiPath("/api/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      room: roomId,
      controller_key: localStorage.getItem(storageKey) || "",
    }),
  });
  const result = await response.json() as {
    controller?: boolean;
    controller_key?: string;
    error?: string;
    session_id?: string;
  };
  if (!response.ok || !result.session_id) throw new Error(result.error || "No se pudo entrar a la sala.");
  sessionId = result.session_id;
  controller = Boolean(result.controller);
  if (result.controller_key) localStorage.setItem(storageKey, result.controller_key);
  configureRole();
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
    status.textContent = controller ? "Tú controlas" : "Espectador";
    status.classList.add("online");
  });
  socket.addEventListener("close", () => {
    status.textContent = "Reconectando…";
    status.classList.remove("online");
    setTimeout(connect, 1500);
  });
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data)) as PlaybackState & { type?: string; controller?: boolean };
    if (data.type === "role") {
      controller = Boolean(data.controller);
      configureRole();
      return;
    }
    if (data.type === "state") void applyState(data);
  });
}

function configureRole() {
  form.hidden = !controller;
  input.disabled = !controller;
  video.controls = controller;
  status.textContent = controller ? "Tú controlas" : "Espectador";
  if (!controller) showMessage("Solo quien inició el Stream puede cambiar el video.");
}

async function loadSource(url: string) {
  hls?.destroy();
  hls = undefined;
  currentUrl = url;
  empty.hidden = true;
  video.hidden = false;
  showMessage("Preparando video…");
  let playableUrl = url;
  let internalStream = false;
  if (/(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)/i.test(url)) {
    const response = await fetch(apiPath(
      `/api/resolve?url=${encodeURIComponent(url)}&session=${encodeURIComponent(sessionId)}`,
    ));
    const result = await response.json() as { type?: string; url?: string; error?: string };
    if (!response.ok || !result.url) throw new Error(result.error || "No se pudo preparar el video de YouTube.");
    playableUrl = result.url;
    internalStream = result.type === "hls";
  }
  const proxied = internalStream
    ? apiPath(`${playableUrl}?session=${encodeURIComponent(sessionId)}`)
    : mediaUrl(playableUrl);
  if (/\.m3u8(?:$|[?#])/i.test(playableUrl) && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true });
    hls.loadSource(proxied);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) showMessage(`No se pudo cargar el stream: ${data.details}`, true);
    });
  } else {
    video.src = proxied;
  }
  showMessage(controller ? "" : "Solo quien inició el Stream puede cambiar el video.");
}

async function applyState(state: PlaybackState) {
  if (state.revision < revision) return;
  revision = state.revision;
  latestState = state;
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
    else await video.play().then(() => {
      syncButton.hidden = true;
    }).catch(() => {
      if (!controller) {
        syncButton.hidden = false;
        showMessage("Toca el botón sobre el video para permitir reproducción con sonido.");
      }
    });
  } finally {
    setTimeout(() => { applyingRemote = false; }, 150);
  }
}

function sendState(paused = video.paused) {
  if (!controller || applyingRemote || socket?.readyState !== WebSocket.OPEN || !currentUrl) return;
  const now = Date.now();
  if (now - lastSent < 250) return;
  lastSent = now;
  socket.send(JSON.stringify({ type: "state", url: currentUrl, paused, currentTime: video.currentTime || 0 }));
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) return showMessage("Ingresa un enlace HTTP o HTTPS válido.", true);
  void loadSource(url)
    .then(() => sendState(true))
    .catch((error) => showMessage(error instanceof Error ? error.message : "No se pudo cargar el video.", true));
});
video.addEventListener("play", () => sendState(false));
video.addEventListener("pause", () => sendState(true));
video.addEventListener("seeked", () => sendState(video.paused));
syncButton.addEventListener("click", () => {
  if (latestState) void applyState(latestState);
});
setInterval(() => {
  if (controller && !video.paused) sendState(false);
}, 5_000);

createSession().then(connect).catch((error) => {
  status.textContent = "Error";
  showMessage(error instanceof Error ? error.message : "No se pudo iniciar.", true);
});
