// Видео рендерится покадрово, а не записывается с экрана: скорость кадров
// не зависит от видеокарты, и ролик совпадает с тем, что настроено в проигрывателе.
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

const CODECS = [
  ["avc1.640033", "avc"],
  ["avc1.4d0033", "avc"],
  ["avc1.42003e", "avc"],
  ["vp09.00.40.08", "vp9"],
];

async function pickCodec(width, height, bitrate, framerate) {
  for (const [codec, muxer] of CODECS) {
    const config = { codec, width, height, bitrate, framerate };
    const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
    if (supported) return { config, muxer };
  }
  throw new Error("WebView2 не предоставляет кодировщик H.264 или VP9");
}

/** tickAt(j) — дробный такт кадра j с учётом скорости и плавности. */
export async function renderVideo({ world, canvas, height, fps, frames, tickAt, onProgress, cancelled }) {
  const aspect = canvas.width / canvas.height;
  const h = height & ~1;
  const w = Math.round(h * aspect) & ~1;
  const bitrate = Math.round(w * h * fps * 0.14);
  const { config, muxer: codec } = await pickCodec(w, h, bitrate, fps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec, width: w, height: h, frameRate: fps }, fastStart: "in-memory" });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  world.renderer.setPixelRatio(1);
  world.setRenderSize(w, h, false);
  try {
    for (let j = 0; j < frames; j++) {
      if (cancelled()) return null;
      if (failure) throw failure;
      world.update(tickAt(j));
      world.render();
      const frame = new VideoFrame(canvas, { timestamp: Math.round((j * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: j % (fps * 2) === 0 });
      frame.close();
      // Очередь кодировщика ограничена: иначе кадры 1080p быстро займут память.
      while (encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      if (j % 10 === 0) {
        onProgress(j / frames);
        await new Promise((r) => setTimeout(r));
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
    return { bytes: new Uint8Array(target.buffer), video: { width: w, height: h, codec: config.codec, bitrate, fps, frames } };
  } finally {
    if (encoder.state !== "closed") encoder.close();
    world.resize();
  }
}
