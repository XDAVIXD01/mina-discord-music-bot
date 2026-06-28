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
].map((command) => command.toJSON());
