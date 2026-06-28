import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId) {
  throw new Error("Faltan DISCORD_TOKEN o DISCORD_CLIENT_ID en .env");
}

const rest = new REST({ version: "10" }).setToken(token);
const route = guildId
  ? Routes.applicationGuildCommands(clientId, guildId)
  : Routes.applicationCommands(clientId);

await rest.put(route, { body: commands });
console.log(`Se registraron ${commands.length} comandos ${guildId ? "en el servidor de pruebas" : "globalmente"}.`);
