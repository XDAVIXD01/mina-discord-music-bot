import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
  root: "activity",
  envDir: "..",
  define: {
    "import.meta.env.VITE_DISCORD_CLIENT_ID": JSON.stringify(env.DISCORD_CLIENT_ID || ""),
  },
  build: {
    outDir: "../activity-dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/socket": { target: "ws://localhost:3001", ws: true },
    },
  },
  };
});
