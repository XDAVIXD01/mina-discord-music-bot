# Bot de música para Discord y YouTube

Bot en TypeScript con comandos slash, cola por servidor y reproducción mediante `yt-dlp` + FFmpeg.

## Funciones

- `/play busqueda:` acepta nombres o enlaces de YouTube.
- `/pause`, `/resume`, `/skip`, `/stop`.
- `/queue` y `/nowplaying`.
- Una cola independiente por servidor.
- Reconexión básica y limpieza de procesos.

## Requisitos

- Node.js 22 o superior.
- [FFmpeg](https://ffmpeg.org/download.html) en `PATH`.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) en `PATH`.
- Python 3.10 o superior para búsquedas en YouTube Music.
- Una aplicación creada en el [Discord Developer Portal](https://discord.com/developers/applications).

En Windows puedes comprobar los programas con:

```powershell
ffmpeg -version
yt-dlp --version
```

## Preparación

1. En el Developer Portal, crea una aplicación y añade un bot.
2. En **OAuth2 > URL Generator**, marca `bot` y `applications.commands`.
3. Da al bot permisos: **View Channels**, **Send Messages**, **Connect** y **Speak**.
4. Invítalo a tu servidor con la URL generada.
5. Copia `.env.example` como `.env` y completa el token y el ID de aplicación.

Nunca publiques ni subas el archivo `.env`.

## Instalación y ejecución

```powershell
npm.cmd install
python -m pip install -r requirements.txt
npm.cmd run deploy
npm.cmd run build
npm.cmd start
```

Si defines `DISCORD_GUILD_ID`, los comandos aparecen de inmediato en ese servidor de pruebas. Sin ese valor se registran globalmente y pueden tardar en propagarse.

Para desarrollo:

```powershell
npm.cmd run dev
```

Las búsquedas escritas se resuelven primero como canciones en YouTube Music. Los enlaces se abren directamente con YouTube; si YouTube Music no responde, el bot usa automáticamente la búsqueda normal de YouTube.

Los enlaces de playlists de YouTube Music agregan todas sus canciones disponibles a la cola, conservando el orden y las carátulas cuadradas.

## Actualización del motor de YouTube

YouTube cambia con frecuencia. Si deja de reproducir, primero actualiza `yt-dlp`:

```powershell
yt-dlp -U
```

El uso de contenido debe respetar los derechos de autor y los términos aplicables de YouTube y Discord. Este proyecto no descarga ni conserva archivos: transmite audio temporalmente al canal de voz.
