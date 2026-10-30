// Иконки Carbon: одни и те же значки над объектами сцены, в легенде и на кнопках.
import * as THREE from "three";
import asleep from "@carbon/icons/es/asleep/32.js";
import batteryCharging from "@carbon/icons/es/battery--charging/32.js";
import bot from "@carbon/icons/es/bot/32.js";
import closeLarge from "@carbon/icons/es/close--large/32.js";
import fire from "@carbon/icons/es/fire/32.js";
import flash from "@carbon/icons/es/flash/32.js";
import flashFilled from "@carbon/icons/es/flash--filled/32.js";
import addLarge from "@carbon/icons/es/add--large/32.js";
import login from "@carbon/icons/es/login/32.js";
import logout from "@carbon/icons/es/logout/32.js";
import radio from "@carbon/icons/es/radio/32.js";
import rocket from "@carbon/icons/es/rocket/32.js";
import share from "@carbon/icons/es/share/32.js";
import camera from "@carbon/icons/es/camera/32.js";
import chevronLeft from "@carbon/icons/es/chevron--left/32.js";
import chevronRight from "@carbon/icons/es/chevron--right/32.js";
import folder from "@carbon/icons/es/folder/32.js";
import pauseFilled from "@carbon/icons/es/pause--filled/32.js";
import playFilled from "@carbon/icons/es/play--filled--alt/32.js";
import previous from "@carbon/icons/es/previous--filled/32.js";
import next from "@carbon/icons/es/next--filled/32.js";
import skipBack from "@carbon/icons/es/skip--back--filled/32.js";
import skipForward from "@carbon/icons/es/skip--forward--filled/32.js";
import video from "@carbon/icons/es/video/32.js";
import view from "@carbon/icons/es/view/32.js";
import activity from "@carbon/icons/es/activity/32.js";
import home from "@carbon/icons/es/home/32.js";
import location from "@carbon/icons/es/location/32.js";
import pin from "@carbon/icons/es/pin/32.js";
import compass from "@carbon/icons/es/compass/32.js";
import rotate from "@carbon/icons/es/rotate/32.js";
import starFilled from "@carbon/icons/es/star--filled/32.js";
import stopFilled from "@carbon/icons/es/stop--filled--alt/32.js";
import trash from "@carbon/icons/es/trash-can/32.js";
import seat from "@carbon/icons/es/checkbox/32.js";

const ICONS = {
  seat,
  asleep, batteryCharging, bot, closeLarge, fire, flash, flashFilled, addLarge, login, logout, radio, rocket, share,
  camera, chevronLeft, chevronRight, folder, pauseFilled, playFilled, previous, next, skipBack,
  skipForward, video, view, activity, home, location, compass, pin, rotate, starFilled, stopFilled, trash,
};

export const FACTIONS = ["#fa4d56", "#4589ff", "#f1c21b", "#a56eff"];
export const LONER = "#a8a8a8";
export const factionColor = (f) => (f < 0 ? LONER : FACTIONS[f % FACTIONS.length]);
const DARK_TEXT = new Set(["#f1c21b", LONER, "#42be65", "#82cfff", "#ffffff"]);
export const onColor = (bg) => (DARK_TEXT.has(bg) ? "#161616" : "#ffffff");

// Значок над роботом: что он решил сделать на этом такте.
export const ACTION_ICONS = {
  harvest: "flash", deposit: "batteryCharging", board: "login", give: "share", attack: "fire", reproduce: "addLarge",
  leave: "logout",
};

export const LEGEND = [
  ["bot", "Робот, цвет значка показывает фракцию"],
  ["asleep", "Робот спит: кончилась энергия"],
  ["rocket", "Корабль, кольцо вокруг него показывает заряд"],
  ["flashFilled", "Источник энергии"],
  ["seat", "Пустое место в корабле; занятое показывает значок робота"],
  ["flash", "Добывает энергию"],
  ["batteryCharging", "Заряжает корабль"],
  ["login", "Садится в корабль"],
  ["share", "Передаёт энергию"],
  ["fire", "Атакует"],
  ["addLarge", "Создаёт робота"],
  ["logout", "Уходит из фракции"],
  ["radio", "Передаёт сигнал"],
  ["closeLarge", "Робот погиб"],
];

function nodeToSvg({ elem, attrs, content = [] }) {
  const attr = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${elem}${attr}>${content.map(nodeToSvg).join("")}</${elem}>`;
}

export function iconSvg(name, size = 16) {
  const icon = ICONS[name];
  return nodeToSvg({ ...icon, attrs: { ...icon.attrs, width: size, height: size, fill: "currentColor", "aria-hidden": "true" } });
}

const images = new Map();

function imageKey(name, color) {
  return `${name}|${color}`;
}

async function loadImage(name, color) {
  const svg = iconSvg(name, 64).replace('fill="currentColor"', `fill="${color}"`);
  const img = new Image();
  img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await img.decode();
  images.set(imageKey(name, color), img);
}

/** SVG становится картинкой асинхронно, поэтому все значки готовятся до начала отрисовки. */
export async function preloadIcons() {
  const scene = [...LEGEND.map(([name]) => name)];
  await Promise.all(scene.flatMap((n) => [loadImage(n, "#ffffff"), loadImage(n, "#161616")]));
}

const textures = new Map();

function makeTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Плитка со значком. dim — приглушённая плитка спящего: тёмный фон и рамка цвета фракции. */
export function badgeTexture(name, bg, dim = false) {
  const key = `${name}|${bg}|${dim}`;
  if (textures.has(key)) return textures.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = dim ? "#262626" : bg;
  g.fillRect(0, 0, 96, 96);
  g.strokeStyle = dim ? bg : "#161616";
  g.lineWidth = dim ? 6 : 3;
  g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, 96 - g.lineWidth, 96 - g.lineWidth);
  const fg = dim ? "#ffffff" : onColor(bg);
  g.drawImage(images.get(imageKey(name, fg)), 14, 14, 68, 68);
  const tex = makeTexture(c);
  textures.set(key, tex);
  return tex;
}

/** Пустое место в корабле: тёмная плитка с пунктирной рамкой. */
export function slotTexture() {
  if (textures.has("slot")) return textures.get("slot");
  const c = document.createElement("canvas");
  c.width = c.height = 96;
  const g = c.getContext("2d");
  g.fillStyle = "#262626e6";
  g.fillRect(0, 0, 96, 96);
  g.strokeStyle = "#c6c6c6";
  g.lineWidth = 6;
  g.setLineDash([20, 12]);
  g.strokeRect(3, 3, 90, 90);
  const tex = makeTexture(c);
  textures.set("slot", tex);
  return tex;
}

/** Мягкое круглое пятно для вспышек. */
export function glowTexture() {
  if (textures.has("glow")) return textures.get("glow");
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.25, "rgba(255,255,255,.65)");
  r.addColorStop(0.6, "rgba(255,255,255,.14)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const tex = makeTexture(c);
  textures.set("glow", tex);
  return tex;
}

/** Острый четырёхлучевой блик попадания. */
export function glintTexture() {
  if (textures.has("glint")) return textures.get("glint");
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  for (const [dx, dy] of [[1, 0], [0, 1], [0.34, 0.34], [0.34, -0.34]]) {
    g.beginPath();
    g.moveTo(64 + dx * 64, 64 + dy * 64);
    g.lineTo(64 - dy * 5, 64 + dx * 5);
    g.lineTo(64 - dx * 64, 64 - dy * 64);
    g.lineTo(64 + dy * 5, 64 - dx * 5);
    g.fill();
  }
  const tex = makeTexture(c);
  textures.set("glint", tex);
  return tex;
}

/** Подпись сигнала: символ и уровень. */
export function labelTexture(text) {
  if (textures.has(text)) return textures.get(text);
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#262626";
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = "#d0e2ff";
  g.font = '500 42px "IBM Plex Mono", Consolas, monospace';
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 64, 34);
  const tex = makeTexture(c);
  textures.set(text, tex);
  return tex;
}
