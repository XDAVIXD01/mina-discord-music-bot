import "dotenv/config";
import { Client, Events, GatewayIntentBits, type ChatInputCommandInteraction } from "discord.js";
import {
  enqueue,
  enqueueMany,
  formatDuration,
  getControlRow,
  getQueue,
  pause,
  previous,
  resolveMusicPlaylist,
  resolveSong,
  resume,
  shuffle,
  skip,
  stop,
  togglePause,
  toggleRepeat,
} from "./music.js";
import { startActivityServer } from "./activity-server.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("Falta DISCORD_TOKEN en .env");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Conectado como ${readyClient.user.tag}`);
});

startActivityServer();

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.inCachedGuild()) return;
  try {
    if (interaction.isButton() && interaction.customId.startsWith("music:")) {
      const memberChannel = interaction.member.voice.channel;
      if (!memberChannel) {
        await interaction.deferUpdate();
        return;
      }
      const action = interaction.customId.slice("music:".length);
      const actions: Record<string, () => boolean> = {
        toggle: () => togglePause(interaction.guildId),
        previous: () => previous(interaction.guildId),
        shuffle: () => shuffle(interaction.guildId),
        skip: () => skip(interaction.guildId),
        loop: () => toggleRepeat(interaction.guildId),
      };
      await interaction.deferUpdate();
      actions[action]?.();
      if (["toggle", "shuffle", "loop"].includes(action)) {
        await interaction.message
          .edit({ components: [getControlRow(interaction.guildId)] })
          .catch(() => undefined);
      }
      return;
    }
    if (interaction.isChatInputCommand()) await handleCommand(interaction);
  } catch (error) {
    console.error(error);
    const message = `❌ ${error instanceof Error ? error.message : "Ocurrió un error inesperado."}`;
    if (!interaction.isRepliable()) return;
    if (interaction.deferred || interaction.replied) await interaction.editReply(message);
    else await interaction.reply({ content: message, ephemeral: true });
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  if (interaction.commandName === "stream") {
    if (!process.env.DISCORD_CLIENT_SECRET) {
      await interaction.reply({
        content: "El modo Stream aún no está configurado: falta DISCORD_CLIENT_SECRET.",
        ephemeral: true,
      });
      return;
    }
    await interaction.launchActivity();
    return;
  }

  const memberChannel = interaction.member.voice.channel;
  const queue = getQueue(interaction.guildId);

  if (interaction.commandName === "play") {
    if (!memberChannel) {
      await interaction.reply({ content: "Entra primero a un canal de voz.", ephemeral: true });
      return;
    }
    if (!interaction.channel?.isTextBased()) throw new Error("Usa este comando en un canal de texto.");
    await interaction.deferReply();
    const query = interaction.options.getString("busqueda", true);
    if (/^https?:\/\/music\.youtube\.com\/playlist\?/i.test(query)) {
      const playlist = await resolveMusicPlaylist(query, interaction.user.toString());
      await enqueueMany({
        guild: interaction.guild,
        textChannel: interaction.channel,
        voiceChannel: memberChannel,
        songs: playlist.songs,
      });
      await interaction.editReply(
        `📚 **${playlist.title}**: agregué **${playlist.songs.length} canciones** a la cola.`,
      );
      return;
    }
    const song = await resolveSong(
      query,
      interaction.user.toString(),
    );
    const result = await enqueue({
      guild: interaction.guild,
      textChannel: interaction.channel,
      voiceChannel: memberChannel,
      song,
    });
    await interaction.editReply(
      result.started
        ? `🔎 Encontré **${song.title}** (${formatDuration(song.duration)}).`
        : `➕ **${song.title}** quedó en la posición ${result.position}.`,
    );
    return;
  }

  if (["pause", "resume", "skip", "stop"].includes(interaction.commandName)) {
    if (!queue) throw new Error("No hay música reproduciéndose.");
    if (!memberChannel) throw new Error("Entra al canal de voz para controlar la música.");
  }

  switch (interaction.commandName) {
    case "pause":
      await interaction.reply(pause(interaction.guildId) ? "⏸️ Música pausada." : "La música ya estaba pausada.");
      break;
    case "resume":
      await interaction.reply(resume(interaction.guildId) ? "▶️ Música reanudada." : "La música no estaba pausada.");
      break;
    case "skip":
      await interaction.reply(skip(interaction.guildId) ? "⏭️ Canción saltada." : "No pude saltarla.");
      break;
    case "stop":
      stop(interaction.guildId);
      await interaction.reply("⏹️ Cola vaciada y bot desconectado.");
      break;
    case "nowplaying":
      await interaction.reply(
        queue?.current
          ? `🎵 **${queue.current.title}** (${formatDuration(queue.current.duration)})`
          : "No hay música reproduciéndose.",
      );
      break;
    case "queue": {
      if (!queue?.current) {
        await interaction.reply("La cola está vacía.");
        break;
      }
      const upcoming = queue.songs
        .slice(0, 10)
        .map((song, index) => `${index + 1}. **${song.title}** (${formatDuration(song.duration)})`)
        .join("\n");
      const extra = queue.songs.length > 10 ? `\n…y ${queue.songs.length - 10} más.` : "";
      await interaction.reply(`🎵 Ahora: **${queue.current.title}**\n${upcoming || "No hay más canciones."}${extra}`);
      break;
    }
  }
}

await client.login(token);
