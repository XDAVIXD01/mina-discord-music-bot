import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproduce o agrega música de YouTube a la cola")
    .addStringOption((option) =>
      option
        .setName("busqueda")
        .setDescription("Nombre de una canción o URL de YouTube")
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName("pause").setDescription("Pausa la reproducción"),
  new SlashCommandBuilder().setName("resume").setDescription("Reanuda la reproducción"),
  new SlashCommandBuilder().setName("skip").setDescription("Salta la canción actual"),
  new SlashCommandBuilder().setName("stop").setDescription("Vacía la cola y desconecta el bot"),
  new SlashCommandBuilder().setName("queue").setDescription("Muestra la cola de reproducción"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Muestra la canción actual"),
  new SlashCommandBuilder()
    .setName("stream")
    .setDescription("Abre el reproductor de video sincronizado de MINA"),
  new SlashCommandBuilder()
    .setName("leer")
    .setDescription("Hace que MINA lea en voz alta los mensajes de este canal")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("iniciar")
        .setDescription("MINA entra a tu canal de voz y lee este canal de texto"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("detener")
        .setDescription("Detiene la lectura en voz alta"),
    ),
].map((command) => command.toJSON());
