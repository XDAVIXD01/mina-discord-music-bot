import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild, GuildTextBasedChannel, Message, VoiceBasedChannel } from "discord.js";

type ReaderJob = {
  id: string;
  text: string;
};

type ReaderSession = {
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  voiceChannel: VoiceBasedChannel;
  connection: VoiceConnection;
  player: AudioPlayer;
  jobs: ReaderJob[];
  speaking: boolean;
  stopped: boolean;
  transcoder?: ChildProcessWithoutNullStreams;
  wavPath?: string;
};

const sessions = new Map<string, ReaderSession>();
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const espeak = process.env.ESPEAK_PATH || "espeak-ng";
const voicePython = process.env.VOICE_PYTHON_PATH || "C:\\mina-voice-venv\\Scripts\\python.exe";
const voiceReference = process.env.VOICE_REFERENCE_PATH || path.resolve("assets", "voice", "user_reference.wav");
const voiceWorkerScript = path.resolve("scripts", "chatterbox_worker.py");
const voiceRemoteUrl = (process.env.VOICE_REMOTE_URL || process.env.MINA_REMOTE_VOICE_URL || "").replace(/\/+$/, "");
const voiceRemoteToken = process.env.VOICE_REMOTE_TOKEN || process.env.MINA_REMOTE_VOICE_TOKEN || "";
const maxTextLength = 260;

type VoiceWorker = {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending: Map<string, { reject: (error: Error) => void; resolve: (path: string) => void; timeout: NodeJS.Timeout }>;
  rl: readline.Interface;
};

let voiceWorker: VoiceWorker | undefined;
let espeakInstallAttempted = false;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true });
    let stderr = "";
    process.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    process.once("error", reject);
    process.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} terminó con código ${code}`)),
    );
  });
}

function startVoiceWorker(): VoiceWorker {
  if (voiceWorker && !voiceWorker.process.killed) return voiceWorker;
  const pending = new Map<VoiceWorker["pending"] extends Map<string, infer T> ? string : never, { reject: (error: Error) => void; resolve: (path: string) => void; timeout: NodeJS.Timeout }>();
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const process = spawn(voicePython, [voiceWorkerScript], {
    env: { ...processEnv(), MINA_VOICE_REFERENCE: voiceReference },
    windowsHide: true,
  });
  const rl = readline.createInterface({ input: process.stdout });
  voiceWorker = { process, ready, pending, rl };

  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line) as { error?: string; id?: string; out?: string; type?: string };
      if (event.type === "ready") {
        readyResolve();
        return;
      }
      if (event.type === "fatal") {
        readyReject(new Error(event.error || "El motor de voz no pudo iniciar."));
        return;
      }
      if (!event.id) return;
      const request = pending.get(event.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(event.id);
      if (event.type === "done" && event.out) request.resolve(event.out);
      else request.reject(new Error(event.error || "No se pudo generar la voz personalizada."));
    } catch (error) {
      console.error("[voice-worker:stdout]", line, error);
    }
  });
  process.stderr.setEncoding("utf8").on("data", (chunk) => console.error(`[voice-worker] ${chunk}`));
  process.once("error", (error) => {
    readyReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  });
  process.once("close", (code) => {
    const error = new Error(`El motor de voz se cerró con código ${code}.`);
    readyReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    rl.close();
    if (voiceWorker?.process === process) voiceWorker = undefined;
  });
  return voiceWorker;
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONIOENCODING: "utf-8" };
}

export async function warmUpReaderVoice(): Promise<boolean> {
  if (process.env.VOICE_CLONE_ENABLED === "0") return false;
  if (voiceRemoteUrl) {
    try {
      const response = await fetch(`${voiceRemoteUrl}/health`, {
        headers: voiceRemoteToken ? { Authorization: `Bearer ${voiceRemoteToken}` } : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return true;
    } catch (error) {
      console.error("[voz-remota] no disponible, usando voz local:", error);
    }
  }
  if (!existsSync(voicePython) || !existsSync(voiceReference) || !existsSync(voiceWorkerScript)) return false;
  try {
    await startVoiceWorker().ready;
    return true;
  } catch (error) {
    console.error("[voz-personalizada]", error);
    return false;
  }
}

function safeText(message: Message<true>): string | undefined {
  const cleanContent = message.cleanContent
    .replace(/https?:\/\/\S+/gi, " enlace ")
    .replace(/<a?:\w+:\d+>/g, " emoji ")
    .replace(/\s+/g, " ")
    .trim();
  const attachmentText = message.attachments.size ? " envió un archivo." : "";
  const stickerText = message.stickers.size ? " envió un sticker." : "";
  let content = `${cleanContent}${attachmentText}${stickerText}`.trim();
  if (!content) return undefined;
  if (!/[.!?¡¿…]$/.test(content)) content += ".";
  return content.length > maxTextLength ? `${content.slice(0, maxTextLength)}...` : content;
}

async function synthesizeWindows(text: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const id = createHash("sha1").update(`${Date.now()}:${randomUUID()}:${text}`).digest("hex");
  const textPath = path.join(directory, `${id}.txt`);
  const wavPath = path.join(directory, `${id}.wav`);
  const scriptPath = path.join(directory, `${id}.ps1`);
  await writeFile(textPath, text, "utf8");
  const script = [
    "param([string]$TextPath, [string]$WavPath)",
    "Add-Type -AssemblyName System.Speech",
    "$text = Get-Content -LiteralPath $TextPath -Raw -Encoding UTF8",
    "$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "try {",
    "  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('es-MX')",
    "  $speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female, [System.Speech.Synthesis.VoiceAge]::Adult, 0, $culture)",
    "} catch {",
    "  try {",
    "    $culture = [System.Globalization.CultureInfo]::GetCultureInfo('es-ES')",
    "    $speaker.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female, [System.Speech.Synthesis.VoiceAge]::Adult, 0, $culture)",
    "  } catch {}",
    "}",
    "$speaker.Rate = 1",
    "$speaker.Volume = 100",
    "$speaker.SetOutputToWaveFile($WavPath)",
    "$speaker.Speak($text)",
    "$speaker.Dispose()",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-TextPath",
    textPath,
    "-WavPath",
    wavPath,
  ]);
  await rm(textPath, { force: true });
  await rm(scriptPath, { force: true });
  return wavPath;
}

async function synthesizeLinux(text: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const id = createHash("sha1").update(`${Date.now()}:${randomUUID()}:${text}:linux`).digest("hex");
  const wavPath = path.join(directory, `${id}.wav`);
  const args = [
    "-v",
    process.env.ESPEAK_VOICE || "es-419+f3",
    "-s",
    process.env.ESPEAK_SPEED || "172",
    "-p",
    process.env.ESPEAK_PITCH || "58",
    "-a",
    process.env.ESPEAK_AMPLITUDE || "145",
    "-w",
    wavPath,
    text,
  ];
  try {
    await run(espeak, args);
  } catch (error) {
    if (espeakInstallAttempted) throw error;
    espeakInstallAttempted = true;
    console.error("[lector] espeak-ng no disponible; intentando instalarlo en Linux/Colab.", error);
    await run("apt-get", ["update", "-qq"]);
    await run("apt-get", ["install", "-y", "-qq", "espeak-ng"]);
    await run(espeak, args);
  }
  return wavPath;
}

async function synthesizeCloned(text: string, directory: string): Promise<string> {
  if (!existsSync(voicePython) || !existsSync(voiceReference) || !existsSync(voiceWorkerScript)) {
    throw new Error("Motor de voz personalizada no configurado.");
  }
  await mkdir(directory, { recursive: true });
  const id = createHash("sha1").update(`${Date.now()}:${randomUUID()}:${text}`).digest("hex");
  const wavPath = path.join(directory, `${id}.wav`);
  const worker = startVoiceWorker();
  await worker.ready;
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      worker.pending.delete(id);
      reject(new Error("La voz personalizada tardó demasiado."));
    }, 120_000);
    worker.pending.set(id, { reject, resolve, timeout });
    worker.process.stdin.write(JSON.stringify({ id, out: wavPath, text }) + "\n", "utf8");
  });
}

async function synthesizeRemote(text: string, directory: string): Promise<string> {
  if (!voiceRemoteUrl) throw new Error("API de voz remota no configurada.");
  await mkdir(directory, { recursive: true });
  const id = createHash("sha1").update(`${Date.now()}:${randomUUID()}:${text}:remote`).digest("hex");
  const wavPath = path.join(directory, `${id}.wav`);
  const response = await fetch(`${voiceRemoteUrl}/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(voiceRemoteToken ? { Authorization: `Bearer ${voiceRemoteToken}` } : {}),
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API de voz remota falló (${response.status}): ${errorText || response.statusText}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  await writeFile(wavPath, audio);
  return wavPath;
}

async function synthesize(text: string, directory: string): Promise<string> {
  if (process.env.VOICE_CLONE_ENABLED !== "0") {
    if (voiceRemoteUrl) {
      try {
        return await synthesizeRemote(text, directory);
      } catch (error) {
        console.error("[voz-remota] usando voz local:", error);
      }
    }
    try {
      return await synthesizeCloned(text, directory);
    } catch (error) {
      console.error("[voz-personalizada] usando voz de Windows:", error);
    }
  }
  if (process.platform === "win32") return await synthesizeWindows(text, directory);
  return await synthesizeLinux(text, directory);
}

async function speakNext(session: ReaderSession): Promise<void> {
  if (session.speaking || session.stopped) return;
  const job = session.jobs.shift();
  if (!job) return;
  session.speaking = true;
  const directory = path.join(tmpdir(), "mina-tts");
  let wavPath = "";
  try {
    wavPath = await synthesize(job.text, directory);
    if (session.stopped) return;

    const audioFilter = "loudnorm=I=-18:LRA=8:TP=-1.5,acompressor=threshold=-22dB:ratio=2:attack=18:release=180,alimiter=limit=0.95";

    const transcoder = spawn(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      wavPath,
      "-af",
      audioFilter,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ], { windowsHide: true });
    session.transcoder = transcoder;
    session.wavPath = wavPath;
    transcoder.stderr.setEncoding("utf8").on("data", (chunk) => console.error(`[tts-ffmpeg] ${chunk}`));
    transcoder.stdout.on("error", () => undefined);
    session.player.play(createAudioResource(transcoder.stdout, { inputType: StreamType.Raw }));
  } catch (error) {
    console.error("[lector]", error);
    session.speaking = false;
    if (wavPath) await rm(wavPath, { force: true }).catch(() => undefined);
    void speakNext(session);
  }
}

function wirePlayer(session: ReaderSession) {
  session.player.on(AudioPlayerStatus.Idle, () => {
    session.speaking = false;
    session.transcoder?.kill("SIGKILL");
    session.transcoder = undefined;
    if (session.wavPath) void rm(session.wavPath, { force: true }).catch(() => undefined);
    session.wavPath = undefined;
    void speakNext(session);
  });
  session.player.on("error", (error) => {
    console.error("[lector-player]", error);
    session.speaking = false;
    void speakNext(session);
  });
}

export async function startReader(options: {
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  voiceChannel: VoiceBasedChannel;
}): Promise<"started" | "moved"> {
  const previous = sessions.get(options.guild.id);
  if (previous) stopReader(options.guild.id);
  const connection = joinVoiceChannel({
    channelId: options.voiceChannel.id,
    guildId: options.guild.id,
    adapterCreator: options.guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  connection.on("error", (error) => {
    console.error("[lector-voice]", error);
  });
  connection.subscribe(player);
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  const session: ReaderSession = {
    guild: options.guild,
    textChannel: options.textChannel,
    voiceChannel: options.voiceChannel,
    connection,
    player,
    jobs: [],
    speaking: false,
    stopped: false,
  };
  wirePlayer(session);
  sessions.set(options.guild.id, session);
  return previous ? "moved" : "started";
}

export function stopReader(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.stopped = true;
  session.jobs = [];
  session.transcoder?.kill("SIGKILL");
  if (session.wavPath) void rm(session.wavPath, { force: true }).catch(() => undefined);
  session.player.stop(true);
  session.connection.destroy();
  sessions.delete(guildId);
  return true;
}

export function getReader(guildId: string): ReaderSession | undefined {
  return sessions.get(guildId);
}

export function handleReaderMessage(message: Message): void {
  if (!message.inGuild() || message.author.bot) return;
  const session = sessions.get(message.guild.id);
  if (!session || session.textChannel.id !== message.channel.id) return;
  const text = safeText(message);
  if (!text) return;
  session.jobs.push({ id: randomUUID(), text });
  if (session.jobs.length > 8) session.jobs.splice(0, session.jobs.length - 8);
  void speakNext(session);
}
