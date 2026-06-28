import json
import sys

from ytmusicapi import YTMusic


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    query = sys.argv[1]
    results = YTMusic().search(query, filter="songs", limit=1)
    if not results:
        raise RuntimeError("YouTube Music no devolvió resultados")

    song = results[0]
    thumbnails = song.get("thumbnails") or []
    thumbnail = thumbnails[-1].get("url") if thumbnails else None
    if thumbnail and "=" in thumbnail:
        thumbnail = thumbnail.split("=", 1)[0] + "=w544-h544-l90-rj"
    print(json.dumps({
        "videoId": song.get("videoId"),
        "title": song.get("title"),
        "artist": ", ".join(artist.get("name", "") for artist in song.get("artists", [])),
        "thumbnail": thumbnail,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
