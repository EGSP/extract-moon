// Видео рендерится покадрово, а не записывается с экрана: скорость кадров
// не зависит от видеокарты, и ролик совпадает с тем, что настроено в окне.
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

/** Подпись в нижнем левом углу кадра: готовая картинка, на кадр она только накладывается.
 * Строка подписи — текст или { text, color }: цветная строка получает квадрат-метку. */
function legendImage(items, height) {
  const lines = items.map((l) => (typeof l === "string" ? { text: l } : l));
  const scale = height / 1080;
  const size = Math.round(15 * scale);
  const pad = Math.round(10 * scale);
  const step = Math.round(21 * scale);
  const font = `${size}px "IBM Plex Mono", Consolas, monospace`;
  const image = document.createElement("canvas");
  const g = image.getContext("2d");
  g.font = font;
  const indent = (l) => (l.color ? size + pad : 0);
  image.width = Math.ceil(Math.max(...lines.map((l) => indent(l) + g.measureText(l.text).width))) + pad * 2;
  image.height = step * lines.length + pad * 2;
  g.font = font; // смена размера холста сбрасывает шрифт
  g.fillStyle = "rgba(22, 22, 22, 0.72)";
  g.fillRect(0, 0, image.width, image.height);
  g.textBaseline = "middle";
  lines.forEach((l, i) => {
    const y = pad + step * (i + 0.5);
    if (l.color) {
      g.fillStyle = l.color;
      g.fillRect(pad, y - size / 2, size, size);
    }
    g.fillStyle = "#f4f4f4";
    g.fillText(l.text, pad + indent(l), y);
  });
  return { image, margin: Math.round(24 * scale) };
}

/** Сценой управляет вызывающий: prepare(w, h) задаёт размер кадра, drawFrame(j) рисует кадр на canvas, restore() возвращает окно.
 * overlay(g, j, w, h) рисует поверх кадра то, чего нет на холсте, например подписи. legend — строки подписи, пустой список её отключает. */
export async function renderVideo({ canvas, width, height, fps, frames, legend = [], prepare, drawFrame, restore, overlay, onProgress, cancelled }) {
  const w = width & ~1; // кодеку нужны чётные размеры
  const h = height & ~1;
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

  prepare(w, h);
  const sign = legend.length ? legendImage(legend, h) : null;
  const composed = sign || overlay ? new OffscreenCanvas(w, h) : null;
  const paint = composed?.getContext("2d");
  try {
    for (let j = 0; j < frames; j++) {
      if (cancelled()) return null;
      if (failure) throw failure;
      drawFrame(j);
      if (composed) {
        paint.drawImage(canvas, 0, 0, w, h);
        overlay?.(paint, j, w, h);
        if (sign) paint.drawImage(sign.image, sign.margin, h - sign.margin - sign.image.height);
      }
      const frame = new VideoFrame(composed ?? canvas, { timestamp: Math.round((j * 1e6) / fps), duration: Math.round(1e6 / fps) });
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
    restore();
  }
}
