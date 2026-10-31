// Панель пролётов: выбор маршрута, просмотр в окне и рендер в MP4.
import { renderVideo } from '@extract-moon/sdk/video';
import { mountVideoSize, placeFrameGuide } from '@extract-moon/sdk/video-size';
import { finishJob, saveOutput } from './api.js';
import { GROUP_COLORS } from './scene.js';
import { icon } from './icons.js';
import { buildFlight, KINDS, SPEEDS } from './flights.js';

const FPS = 30;
const $ = s => document.querySelector(s);
const seconds = v => `${v.toFixed(1).replace('.', ',')} с`;
const options = (el, items) => { el.innerHTML = items.map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); };

function toast(text, error = false) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.toggle('err', error);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 6000);
}

export class FlightPanel {
  constructor(scene, current) {
    this.scene = scene;
    this.current = current;
    this.playing = false;
    this.size = mountVideoSize($('#fl-size'), () => this.update());
    options($('#fl-kind'), Object.entries(KINDS).map(([k, v]) => [k, v.title]));
    options($('#fl-speed'), SPEEDS.map(v => [v, `×${String(v).replace('.', ',')}`]));
    $('#fl-speed').value = '1';
    for (const id of ['#fl-kind', '#fl-from', '#fl-to', '#fl-pause', '#fl-seconds', '#fl-proj', '#fl-speed'])
      $(id).addEventListener('input', () => this.update());
    $('#fl-play').addEventListener('click', () => this.togglePlay());
    $('#fl-render').addEventListener('click', () => this.render().catch(e => toast(`Видео не сохранено: ${e.message ?? e}`, true)));
    $('#fl-render').innerHTML = `${icon('video')}Рендерить`;
    new ResizeObserver(() => this.showGuide()).observe($('#stage'));
    this.showPlay();
  }

  toggle() {
    const panel = $('#flight');
    panel.hidden = !panel.hidden;
    if (panel.hidden) this.scene.stopFlight();
    this.showGuide();
    return !panel.hidden;
  }

  /** Другая архитектура: список групп мог измениться. */
  refresh() {
    const { schema } = this.current();
    const items = Object.entries(schema.groups).map(([g, v]) => [g, v.title ?? g]);
    const [from, to] = [$('#fl-from').value, $('#fl-to').value];
    options($('#fl-from'), items);
    options($('#fl-to'), items);
    $('#fl-from').value = items.some(i => i[0] === from) ? from : items[0][0];
    $('#fl-to').value = items.some(i => i[0] === to) ? to : items[items.length - 1][0];
    this.update();
  }

  spec() {
    return {
      kind: $('#fl-kind').value, speed: Number($('#fl-speed').value), from: $('#fl-from').value, to: $('#fl-to').value,
      pause: Math.max(Number($('#fl-pause').value) || 0, 0.5), seconds: Math.max(Number($('#fl-seconds').value) || 0, 1),
      ortho: $('#fl-proj').value === 'ortho',
    };
  }

  showGuide() {
    placeFrameGuide($('#frame-guide'), $('#stage').getBoundingClientRect(), this.size.size());
    if ($('#flight').hidden) $('#frame-guide').hidden = true;
  }

  update() {
    const spec = this.spec(), [w, h] = this.size.size();
    $('#fl-route').hidden = spec.kind !== 'groups';
    $('#fl-still').hidden = spec.kind !== 'still';
    $('#fl-speed-row').hidden = spec.kind === 'still';
    const path = buildFlight(spec, this.scene.flightContext(w / h));
    $('#fl-info').textContent = `${w} × ${h}, ${FPS} кадров в секунду, длительность ${seconds(path.duration)}`;
    this.showGuide();
  }

  showPlay() {
    $('#fl-play').innerHTML = `${icon(this.playing ? 'pause' : 'play')}${this.playing ? 'Остановить' : 'Просмотр'}`;
  }

  togglePlay() {
    if (this.playing) { this.scene.stopFlight(); return; }
    const spec = this.spec(), [w, h] = this.size.size();
    const box = $('#caption');
    this.playing = true;
    this.showPlay();
    this.scene.playFlight(buildFlight(spec, this.scene.flightContext(w / h)), spec.ortho, at => {
      box.hidden = !at.caption;
      if (!at.caption) return;
      box.style.setProperty('--c', at.caption.color);
      box.style.opacity = at.alpha;
      const key = at.caption.title;
      if (box.dataset.key === key) return;
      box.dataset.key = key;
      box.innerHTML = '<b></b><span></span>';
      box.querySelector('b').textContent = at.caption.title;
      box.querySelector('span').textContent = at.caption.text;
    }, () => {
      this.playing = false;
      box.hidden = true;
      delete box.dataset.key;
      this.showPlay();
    });
  }

  /** Подпись в углу ролика: что показано и из чего состоит. */
  legend() {
    const { arch, run, schema, kind } = this.current();
    const lines = [`Архитектура: ${arch.title}`, `Весов: ${arch.instance.total_params.toLocaleString('ru-RU')}`];
    if (kind === 'run') lines.push(`Модель: ${run.name}`);
    return [...lines, ...Object.entries(schema.groups).map(([g, v]) => ({ text: v.title ?? g, color: GROUP_COLORS[g] ?? '#8d8d8d' }))];
  }

  fileStem(spec, w, h) {
    const { kind, arch, run } = this.current();
    return `${kind === 'run' ? run.name : arch.id}_${spec.kind}_${spec.ortho ? 'ortho' : 'persp'}_${w}x${h}`;
  }

  async render(job = null) {
    this.scene.stopFlight();
    const spec = job ? { speed: 1, pause: 2.5, seconds: 10, from: null, to: null, ortho: false, ...job } : this.spec();
    const [width, height] = job ? [job.width ?? 1920, job.height ?? 1080] : this.size.size();
    const legendOn = job ? job.legend ?? true : $('#fl-legend').checked;
    if (spec.kind === 'groups') {
      const groups = Object.keys(this.current().schema.groups);
      spec.from ??= groups[0];
      spec.to ??= groups[groups.length - 1];
    }
    await Promise.all([document.fonts.load('600 30px "IBM Plex Sans"', 'Память'), document.fonts.load('400 17px "IBM Plex Sans"', 'Память'),
      document.fonts.load('15px "IBM Plex Mono"', 'Память')]);
    const path = buildFlight(spec, this.scene.flightContext(width / height));
    const frames = Math.round(path.duration * FPS) + 1;
    const recorder = this.scene.recorder(path, spec.ortho, { showLabels: true });
    let stop = false, at = null;
    $('#modal-cancel').onclick = () => { stop = true; };
    $('#modal-text').textContent = `${width} × ${height}, ${FPS} кадров в секунду, длительность ${seconds(path.duration)}`;
    $('#modal-bar').style.width = '0';
    $('#modal').hidden = false;
    try {
      const result = await renderVideo({
        canvas: this.scene.canvas, width, height, fps: FPS, frames, legend: legendOn ? this.legend() : [],
        prepare: recorder.prepare,
        drawFrame: j => { at = recorder.draw(j / FPS); },
        overlay: (g, _j, w, h) => recorder.overlay(g, at, w, h),
        restore: recorder.restore,
        onProgress: k => { $('#modal-bar').style.width = `${k * 100}%`; },
        cancelled: () => stop,
      });
      if (!result) return;
      const stem = job?.stem ?? this.fileStem(spec, width, height);
      const out = await saveOutput(`${stem}.mp4`, result.bytes);
      const meta = JSON.stringify({ createdAt: new Date().toISOString(), video: { file: `${stem}.mp4`, ...result.video }, flight: spec, durationSeconds: path.duration }, null, 2);
      await saveOutput(`${stem}.json`, new TextEncoder().encode(meta));
      toast(`Видео сохранено: ${out}`);
    } finally {
      $('#modal').hidden = true;
    }
  }

  /** Задание рендера из файла: один ролик без диалогов, окно закрывается само. */
  async runJob(job) {
    try {
      await this.render(job);
    } catch (e) {
      await saveOutput(`${job.stem ?? 'models'}.error.txt`, new TextEncoder().encode(String(e?.stack ?? e)));
    }
    await finishJob();
  }
}
