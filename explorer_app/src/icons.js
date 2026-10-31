// Иконки Carbon для кнопок, как в плеере.
import activity from "@carbon/icons/es/activity/16.js";
import chevronDown from "@carbon/icons/es/chevron--down/16.js";
import chevronRight from "@carbon/icons/es/chevron--right/16.js";
import compare from "@carbon/icons/es/compare/16.js";
import copy from "@carbon/icons/es/copy/16.js";
import cube from "@carbon/icons/es/cube/16.js";
import document from "@carbon/icons/es/document/16.js";
import folder from "@carbon/icons/es/folder/16.js";
import model from "@carbon/icons/es/model/16.js";
import pauseFilled from "@carbon/icons/es/pause--filled/16.js";
import play from "@carbon/icons/es/play/16.js";
import playFilled from "@carbon/icons/es/play--filled--alt/16.js";
import renew from "@carbon/icons/es/renew/16.js";
import sidePanel from "@carbon/icons/es/side-panel--open/16.js";
import video from "@carbon/icons/es/video/16.js";

const ICONS = { activity, chevronDown, chevronRight, compare, copy, cube, document, folder, model, pauseFilled, play,
  playFilled, renew, sidePanel, video };

function nodeToSvg({ elem, attrs, content = [] }) {
  const attr = Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("");
  return `<${elem}${attr}>${content.map(nodeToSvg).join("")}</${elem}>`;
}

export function iconSvg(name, size = 16) {
  const icon = ICONS[name];
  return nodeToSvg({ ...icon, attrs: { ...icon.attrs, width: size, height: size, fill: "currentColor", "aria-hidden": "true" } });
}
