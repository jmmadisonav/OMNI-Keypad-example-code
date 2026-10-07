// Draws a recipe onto a 188x188 canvas for the OFF or ON state.

import { SIZE, shapeFiles, tintPixels, tintSource } from "./model.js";
import { assetUrl } from "./api.js";

const images = new Map();       // src -> Promise<HTMLImageElement>
const symbols = new Map();      // icon name -> inner SVG markup
const generations = new WeakMap();
let iconsLoaded = null;

export function loadIcons() {
  iconsLoaded ??= fetch("/vendor/lucide/sprite.svg")
    .then((r) => r.text())
    .then((text) => {
      const doc = new DOMParser().parseFromString(text, "image/svg+xml");
      for (const symbol of doc.querySelectorAll("symbol")) {
        symbols.set(symbol.id, symbol.innerHTML);
      }
    });
  return iconsLoaded;
}

export function iconMarkup(name) {
  return symbols.get(name) ?? null;
}

function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { images.delete(src); reject(new Error(`couldn't load ${src.slice(0, 60)}`)); };
      img.src = src;
    }));
  }
  return images.get(src);
}

const tinted = new Map();       // src + colour -> Promise<canvas>

// White shape artwork recoloured to a custom colour; see tintPixels.
function tintedShape(src, colour) {
  const key = `${src} ${colour}`;
  if (!tinted.has(key)) {
    tinted.set(key, loadImage(src).then((img) => {
      const canvas = blankCanvas();
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const image = ctx.getImageData(0, 0, SIZE, SIZE);
      const d = image.data;
      const centre = (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 4;
      const base = Math.max(0.05, (0.299 * d[centre] + 0.587 * d[centre + 1] + 0.114 * d[centre + 2]) / 255);
      tintPixels(d, base, colour);
      ctx.putImageData(image, 0, 0);
      return canvas;
    }));
  }
  return tinted.get(key);
}

function iconSource(name, size, colour, stroke) {
  const inner = iconMarkup(name);
  if (inner === null) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 24 24" fill="none" stroke="${colour}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function drawLayer(ctx, layer, state, catalog) {
  switch (layer.type) {
    case "shape": {
      const grey = tintSource(catalog, layer.set);
      const tint = layer.tint?.[state];
      if (grey && /^#[0-9a-f]{6}$/i.test(tint || "")) {
        ctx.drawImage(await tintedShape(assetUrl(grey[state]), tint), 0, 0, SIZE, SIZE);
        return;
      }
      const files = shapeFiles(catalog, layer.set, layer.colour);
      if (!files) return;
      ctx.drawImage(await loadImage(assetUrl(files[state])), 0, 0, SIZE, SIZE);
      return;
    }
    case "icon": {
      await loadIcons();
      const src = iconSource(layer.icon, layer.size, layer.colour[state], layer.stroke);
      if (!src) return;
      ctx.drawImage(await loadImage(src), layer.x - layer.size / 2, layer.y - layer.size / 2,
                    layer.size, layer.size);
      return;
    }
    case "text": {
      const font = `${layer.weight} ${layer.size}px "${layer.font}"`;
      await document.fonts.load(font);
      ctx.font = font;
      ctx.fillStyle = layer.colour[state];
      ctx.textAlign = layer.align;
      ctx.textBaseline = "middle";
      const lines = layer.lines.filter((l, i) => i < 2);
      const step = layer.size * 1.15;
      lines.forEach((line, i) => {
        ctx.fillText(line, layer.x, layer.y + (i - (lines.length - 1) / 2) * step);
      });
      return;
    }
    case "image": {
      const src = layer[state] || layer.off || layer.on;
      if (!src) return;
      const img = await loadImage(src);
      const scale = layer.size / Math.max(img.naturalWidth, img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, layer.x - w / 2, layer.y - h / 2, w, h);
      return;
    }
  }
}

export async function drawRecipe(ctx, recipe, state, catalog) {
  ctx.clearRect(0, 0, SIZE, SIZE);
  for (const layer of recipe.layers) {
    if (!layer.visible) continue;
    ctx.save();
    try {
      await drawLayer(ctx, layer, state, catalog);
    } catch (error) {
      console.warn("Skipped a layer:", error);
    } finally {
      ctx.restore();
    }
  }
}

function blankCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  return canvas;
}

export async function renderRecipe(recipe, catalog) {
  const result = {};
  for (const state of ["off", "on"]) {
    result[state] = blankCanvas();
    await drawRecipe(result[state].getContext("2d"), recipe, state, catalog);
  }
  return result;
}

export async function paintInto(canvas, recipe, state, catalog) {
  const generation = (generations.get(canvas) ?? 0) + 1;
  generations.set(canvas, generation);
  const scratch = blankCanvas();
  await drawRecipe(scratch.getContext("2d"), recipe, state, catalog);
  if (generations.get(canvas) !== generation) return;     // A newer paint started.
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(scratch, 0, 0);
}

export function toBase64(canvas) {
  return canvas.toDataURL("image/png").split(",")[1];
}
