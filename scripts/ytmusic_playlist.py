import json
import sys

from ytmusicapi import YTMusic


def square_thumbnail(track: dict) -> str | None:
    thumbnails = track.get("thumbnails") or []
    if not thumbnails:
        return None
    url = thumbnails[-1].get("url")
    if url and "=" in url:
        return url.split("=", 1)[0] + "=w544-h544-l90-rj"
    return url


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    playlist_id = sys.argv[1]
    playlist = YTMusic().get_playlist(playlist_id, limit=None)
    tracks = []
    for track in playlist.get("tracks") or []:
        video_id = track.get("videoId")
        if not video_id or track.get("isAvailable") is False:
            continue
        tracks.append({
            "title": track.get("title") or "Título desconocido",
            "videoId": video_id,
            "duration": track.get("duration_seconds") or 0,
            "artist": ", ".join(artist.get("name", "") for artist in track.get("artists", [])),
            "thumbnail": square_thumbnail(track),
        })
    print(json.dumps({
        "title": playlist.get("title") or "Playlist de YouTube Music",
        "tracks": tracks,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
