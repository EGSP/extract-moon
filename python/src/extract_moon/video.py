"""Запись кадров RGB в MP4 через ffmpeg из imageio-ffmpeg."""

from __future__ import annotations

import subprocess
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def encoder(out: Path, width: int, height: int, fps: int) -> Iterator[Callable[[bytes], object]]:
    """Отдаёт функцию записи кадра. Кодеку нужны чётные размеры."""
    import imageio_ffmpeg

    cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{width}x{height}", "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-crf", "18", "-movflags", "+faststart", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    try:
        yield proc.stdin.write
        proc.stdin.close()
        err = proc.stderr.read().decode(errors="replace")
        if proc.wait():
            raise RuntimeError(f"ffmpeg завершился с ошибкой: {err.strip()}")
    except BaseException:
        proc.kill()
        raise
