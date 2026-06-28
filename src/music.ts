import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
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
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type Message,
  type VoiceBasedChannel,
} from "discord.js";

export type Song = {
  title: string;
  url: string;
  duration: number;
  requestedBy: string;
  uploader: string;
  thumbnail?: string;
};

type Queue = {
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  voiceChannel: VoiceBasedChannel;
  connection: VoiceConnection;
  player: AudioPlayer;
  songs: Song[];
  history: Song[];
  current?: Song;
  nowPlayingMessage?: Message;
  downloader?: ChildProcessWithoutNullStreams;
  transcoder?: ChildProcessWithoutNullStreams;
  stopped: boolean;
  advancing: boolean;
  repeat: boolean;
  skipRepeat: boolean;
  shuffled: boolean;
};

const queues = new Map<string, Queue>();
const ytdlp = process.env.YTDLP_PATH || "yt-dlp";
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const python = process.env.PYTHON_PATH || "python";

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    process.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    process.once("error", reject);
    process.once("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} terminó con código ${code}`)),
    );
  });
}

export async function resolveSong(query: string, requestedBy: string): Promise<Song> {
  const isUrl = /^https?:\/\//i.test(query);
  let target = query;
  let musicResult: { videoId?: string; artist?: string; thumbnail?: string } | undefined;
  if (!isUrl) {
    try {
      musicResult = JSON.parse(
        await run(python, [resolve("scripts", "ytmusic_search.py"), query]),
      ) as { videoId?: string; artist?: string; thumbnail?: string };
      if (!musicResult.videoId) throw new Error("Resultado sin videoId");
      target = `https://music.youtube.com/watch?v=${musicResult.videoId}`;
    } catch (error) {
      console.warn("[YouTube Music] Búsqueda no disponible; usando YouTube normal.", error);
      target = `ytsearch1:${query}`;
    }
  }
  const raw = await run(ytdlp, [
    "--dump-single-json",
    "--no-playlist",
    "--no-warnings",
    "--skip-download",
    target,
  ]);
  const info = JSON.parse(raw);
  const item = info.entries?.[0] ?? info;
  if (!item?.webpage_url && !item?.original_url) throw new Error("No encontré esa canción.");
  return {
    title: item.title || "Título desconocido",
    url: item.webpage_url || item.original_url,
    duration: Number(item.duration) || 0,
    requestedBy,
    uploader: musicResult?.artist || item.uploader || item.channel || "YouTube",
    thumbnail: musicResult?.thumbnail || item.thumbnail,
  };
}

export async function resolveMusicPlaylist(
  url: string,
  requestedBy: string,
): Promise<{ title: string; songs: Song[] }> {
  const playlistId = new URL(url).searchParams.get("list");
  if (!playlistId) throw new Error("El enlace no contiene una playlist válida.");
  const result = JSON.parse(
    await run(python, [resolve("scripts", "ytmusic_playlist.py"), playlistId]),
  ) as {
    title: string;
    tracks: Array<{
      title: string;
      videoId: string;
      duration: number;
      artist: string;
      thumbnail?: string;
    }>;
  };
  const songs = result.tracks.map((track) => ({
    title: track.title,
    url: `https://music.youtube.com/watch?v=${track.videoId}`,
    duration: track.duration,
    requestedBy,
    uploader: track.artist || "YouTube Music",
    thumbnail: track.thumbnail,
  }));
  if (!songs.length) throw new Error("La playlist no contiene canciones disponibles.");
  return { title: result.title, songs };
}

export async function enqueueMany(options: {
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  voiceChannel: VoiceBasedChannel;
  songs: Song[];
}): Promise<{ firstPosition: number; started: boolean }> {
  let queue = queues.get(options.guild.id);
  if (queue && queue.voiceChannel.id !== options.voiceChannel.id) {
    throw new Error("Ya estoy reproduciendo música en otro canal de voz.");
  }

  if (!queue) {
    const connection = joinVoiceChannel({
      channelId: options.voiceChannel.id,
      guildId: options.guild.id,
      adapterCreator: options.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    connection.subscribe(player);
    queue = {
      guild: options.guild,
      textChannel: options.textChannel,
      voiceChannel: options.voiceChannel,
      connection,
      player,
      songs: [],
      history: [],
      stopped: false,
      advancing: false,
      repeat: false,
      skipRepeat: false,
      shuffled: false,
    };
    queues.set(options.guild.id, queue);
    attachEvents(queue);
  }

  const firstPosition = queue.songs.length + 1;
  queue.songs.push(...options.songs);
  const started = !queue.current;
  if (started) await playNext(queue);
  return { firstPosition, started };
}

export async function enqueue(options: {
  guild: Guild;
  textChannel: GuildTextBasedChannel;
  voiceChannel: VoiceBasedChannel;
  song: Song;
}): Promise<{ position: number; started: boolean }> {
  const result = await enqueueMany({ ...options, songs: [options.song] });
  return { position: result.firstPosition, started: result.started };
}

function attachEvents(queue: Queue): void {
  queue.player.on(AudioPlayerStatus.Idle, () => void playNext(queue));
  queue.player.on("error", (error) => {
    console.error(`[audio:${queue.guild.id}]`, error);
    void queue.textChannel.send("⚠️ Falló la canción actual; intentaré con la siguiente.");
    cleanupProcesses(queue);
    void playNext(queue);
  });
  queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(queue.connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(queue.connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      destroyQueue(queue.guild.id);
    }
  });
}

async function playNext(queue: Queue): Promise<void> {
  if (queue.advancing) return;
  queue.advancing = true;
  cleanupProcesses(queue);
  if (queue.stopped) {
    queue.advancing = false;
    return;
  }
  const previous = queue.current;
  if (previous) {
    if (queue.repeat && !queue.skipRepeat) {
      queue.songs.unshift(previous);
    } else {
      queue.history.push(previous);
      if (queue.history.length > 50) queue.history.shift();
    }
  }
  queue.skipRepeat = false;
  const song = queue.songs.shift();
  queue.current = song;
  if (!song) {
    await disableControls(queue);
    await queue.textChannel.send("✅ La cola terminó. Me desconecto.");
    destroyQueue(queue.guild.id);
    return;
  }

  try {
    const downloader = spawn(
      ytdlp,
      ["--no-playlist", "--no-warnings", "--quiet", "-f", "bestaudio/best", "-o", "-", song.url],
      { windowsHide: true },
    );
    const transcoder = spawn(
      ffmpeg,
      ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
      { windowsHide: true },
    );
    queue.downloader = downloader;
    queue.transcoder = transcoder;
    downloader.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") console.error("[yt-dlp stdout]", error);
    });
    transcoder.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") console.error("[ffmpeg stdin]", error);
    });
    downloader.stdout.pipe(transcoder.stdin);
    downloader.stderr.on("data", (chunk) => console.error(`[yt-dlp] ${chunk}`));
    transcoder.stderr.on("data", (chunk) => console.error(`[ffmpeg] ${chunk}`));
    downloader.on("error", (error) => queue.player.emit("error", error));
    transcoder.on("error", (error) => queue.player.emit("error", error));
    queue.player.play(createAudioResource(transcoder.stdout, { inputType: StreamType.Raw }));
    await disableControls(queue);
    queue.nowPlayingMessage = await queue.textChannel
      .send(nowPlayingCard(song, queue))
      .catch((error) => {
        console.error("[tarjeta]", error);
        return undefined;
      });
    queue.advancing = false;
  } catch (error) {
    console.error(error);
    await queue.textChannel.send(`⚠️ No pude reproducir **${song.title}**.`);
    queue.advancing = false;
    await playNext(queue);
  }
}

function cleanupProcesses(queue: Queue): void {
  if (queue.downloader && queue.transcoder) {
    queue.downloader.stdout.unpipe(queue.transcoder.stdin);
  }
  queue.downloader?.kill();
  queue.transcoder?.stdin.destroy();
  queue.transcoder?.kill();
  queue.downloader = undefined;
  queue.transcoder = undefined;
}

function destroyQueue(guildId: string): void {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.stopped = true;
  cleanupProcesses(queue);
  queue.connection.destroy();
  queues.delete(guildId);
}

function controls(queue?: Queue, disabled = false) {
  const paused =
    queue?.player.state.status === AudioPlayerStatus.Paused ||
    queue?.player.state.status === AudioPlayerStatus.AutoPaused;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("music:shuffle")
      .setEmoji("🔀")
      .setStyle(queue?.shuffled ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music:previous")
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || !queue?.history.length),
    new ButtonBuilder()
      .setCustomId("music:toggle")
      .setEmoji(paused ? "▶️" : "⏸️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music:skip")
      .setEmoji("⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId("music:loop")
      .setEmoji("🔁")
      .setStyle(queue?.repeat ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

function nowPlayingCard(song: Song, queue: Queue) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setAuthor({ name: "Now Playing" })
    .setDescription(`[${song.title}](${song.url})`)
    .addFields(
      { name: "Duration", value: formatDuration(song.duration), inline: true },
      { name: "Author", value: song.uploader.slice(0, 30), inline: true },
      { name: "Requested By", value: song.requestedBy, inline: true },
    )
  if (song.thumbnail) embed.setThumbnail(song.thumbnail);
  return { embeds: [embed], components: [controls(queue)] };
}

async function disableControls(queue: Queue): Promise<void> {
  if (!queue.nowPlayingMessage) return;
  await queue.nowPlayingMessage
    .edit({ components: [controls(queue, true)] })
    .catch(() => undefined);
  queue.nowPlayingMessage = undefined;
}

export function pause(guildId: string): boolean {
  return queues.get(guildId)?.player.pause() ?? false;
}

export function resume(guildId: string): boolean {
  return queues.get(guildId)?.player.unpause() ?? false;
}

export function togglePause(guildId: string): boolean {
  const player = queues.get(guildId)?.player;
  if (!player) return false;
  if (player.state.status === AudioPlayerStatus.Paused || player.state.status === AudioPlayerStatus.AutoPaused) {
    return player.unpause();
  }
  return player.pause();
}

export function skip(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  queue.skipRepeat = true;
  return queue.player.stop();
}

export function previous(guildId: string): boolean {
  const queue = queues.get(guildId);
  const song = queue?.history.pop();
  if (!queue || !song) return false;
  if (queue.current) queue.songs.unshift(queue.current);
  queue.current = undefined;
  queue.skipRepeat = true;
  queue.songs.unshift(song);
  return queue.player.stop();
}

export function toggleRepeat(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  queue.repeat = !queue.repeat;
  return true;
}

export function shuffle(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  for (let index = queue.songs.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [queue.songs[index], queue.songs[other]] = [queue.songs[other], queue.songs[index]];
  }
  queue.shuffled = !queue.shuffled;
  return true;
}

export function getControlRow(guildId: string) {
  return controls(queues.get(guildId));
}

export function stop(guildId: string): boolean {
  if (!queues.has(guildId)) return false;
  destroyQueue(guildId);
  return true;
}

export function getQueue(guildId: string): { current?: Song; songs: Song[] } | undefined {
  const queue = queues.get(guildId);
  return queue ? { current: queue.current, songs: [...queue.songs] } : undefined;
}

export function formatDuration(seconds: number): string {
  if (!seconds) return "en vivo/desconocida";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
