// Recipes and layers: plain data, no DOM. A recipe is
// { version: 1, name, layers: [...] }, drawn bottom to top.

export const SIZE = 188;
export const CENTRE = SIZE / 2;
export const MAX_IMPORT = SIZE * 2;      // Dropped images are scaled down to this.
// A keypad's button grid, numbered left to right along the top row first.
// Without a known model, 6 buttons are 2 across (6B, 6BV) and 8 are 4 across (8BV).
export function gridFor(model, buttonCount) {
  if (model) return { columns: model.columns, rows: model.rows };
  const columns = buttonCount <= 6 ? 2 : 4;
  return { columns, rows: Math.ceil(buttonCount / columns) };
}
// The pixel size of a keypad's button images. Without a known model, a
// 6-button keypad (6B, 6BV) is 150 and an 8-button one (8BV) is SIZE.
export function imageSizeFor(model, buttonCount) {
  if (model) return model.image_size;
  return buttonCount <= 6 ? 150 : SIZE;
}
export const FONTS = ["Titillium Web", "Inter", "Roboto", "Oswald"];

const OFF_GREY = "#9AA0A6";
const ON_WHITE = "#FFFFFF";

export function buttonKey(page, button) {
  return `${page}-${button}`;
}

export function newRecipe(name = "") {
  return { version: 1, name, layers: [] };
}

export function defaultLayer(type, catalog) {
  switch (type) {
    case "shape": {
      const set = Object.keys(catalog.shapes)[0];
      const colours = Object.keys(catalog.shapes[set] || {});
      return { type, set, colour: colours.includes("Blue") ? "Blue" : colours[0], visible: true };
    }
    case "icon":
      return { type, icon: "circle", size: 80, x: CENTRE, y: CENTRE, stroke: 2,
               colour: { off: OFF_GREY, on: ON_WHITE }, visible: true };
    case "text":
      return { type, lines: ["Label"], font: FONTS[0], weight: 700, size: 24,
               x: CENTRE, y: CENTRE, align: "center",
               colour: { off: OFF_GREY, on: ON_WHITE }, visible: true };
    case "image":
      return { type, off: "", on: "", size: SIZE, x: CENTRE, y: CENTRE, visible: true };
    default:
      throw new Error(`unknown layer type ${type}`);
  }
}

export function addLayer(recipe, layer) {
  return { ...recipe, layers: [...recipe.layers, layer] };
}

export function updateLayer(recipe, index, changes) {
  return { ...recipe, layers: recipe.layers.map((l, i) => (i === index ? { ...l, ...changes } : l)) };
}

export function removeLayer(recipe, index) {
  return { ...recipe, layers: recipe.layers.filter((_, i) => i !== index) };
}

export function moveLayer(recipe, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= recipe.layers.length) return recipe;
  const layers = [...recipe.layers];
  [layers[index], layers[target]] = [layers[target], layers[index]];
  return { ...recipe, layers };
}

export function shapeFiles(catalog, set, colour) {
  return catalog.shapes[set]?.[colour] ?? null;
}

// source says where finished artwork came from: { kind: "keypad" } for a
// button loaded from a keypad, or { kind: "library", name } for ready-made art.
export function recipeFromImages(off, on, name = "", source = undefined) {
  const layer = { type: "image", off, on, size: SIZE, x: CENTRE, y: CENTRE, visible: true };
  if (source) layer.source = source;
  return { ...newRecipe(name), layers: [layer] };
}

// A Squared shape, an icon, and a label: the Quick button shortcut.
export function quickRecipe({ label, icon, colour }, name = "") {
  return { ...newRecipe(name), layers: [
    { type: "shape", set: "Squared", colour, visible: true },
    { type: "icon", icon, size: 72, x: CENTRE, y: 80, stroke: 2,
      colour: { off: ON_WHITE, on: ON_WHITE }, visible: true },
    { type: "text", lines: [label || "Label"], font: FONTS[0], weight: 700, size: 20,
      x: CENTRE, y: 150, align: "center", colour: { off: ON_WHITE, on: ON_WHITE }, visible: true },
  ] };
}

export function isBlank(recipe) {
  return !recipe.layers.some((l) => l.visible && (l.type !== "image" || l.off || l.on));
}

// A custom shape colour recolours one of the set's grey artworks. The grey
// sits at one brightness (base) with a lighter highlight and darker edges:
// base becomes the tint, highlights move part of the way to white, and edges
// darken in proportion, so the shape keeps its shading. Alpha is unchanged.
// Grey has crisp edges; White's are a soft glow, so it's the last choice.
const TINT_SOURCES = ["Grey", "LtGrey", "DkGrey", "White"];
const HIGHLIGHT = 0.6;

// The OFF and ON files to recolour for a shape set, or null if it has no grey.
export function tintSource(catalog, set) {
  const colour = TINT_SOURCES.find((c) => catalog.shapes[set]?.[c]);
  return colour ? catalog.shapes[set][colour] : null;
}

export function tintPixels(data, base, hex) {
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  for (let i = 0; i < data.length; i += 4) {
    const light = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    for (let c = 0; c < 3; c++) {
      data[i + c] = light >= base
        ? rgb[c] + (255 - rgb[c]) * ((light - base) / (1 - base || 1)) * HIGHLIGHT
        : rgb[c] * (light / base);
    }
  }
  return data;
}

export function layerSummary(layer) {
  switch (layer.type) {
    case "shape": return `${layer.set} · ${layer.tint ? "Custom" : layer.colour}`;
    case "icon": return layer.icon;
    case "text": return `"${layer.lines.filter(Boolean).join(" / ")}"`;
    case "image":
      if (!layer.off && !layer.on) return "No image";
      if (layer.source?.kind === "keypad") return "Loaded from keypad";
      if (layer.source?.kind === "library") return layer.source.name;
      return layer.offFile || layer.onFile || "Uploaded image";
  }
  return "";
}

export function clampPosition(value) {
  return Math.max(0, Math.min(SIZE, Math.round(value)));
}

// The image file name stem the server uses for a button (keypad_ops.file_base).
export function fileStem(name, page, button) {
  return name ? name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) : `p${page}b${button}`;
}

// The rule in library.validate_name, except that a button may have no name.
const NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$/;

export function buttonNameError(name) {
  if (!name || NAME.test(name)) return "";
  return "Use 1 to 64 letters, digits, spaces, dashes or underscores, with no space at either end.";
}

// "HDMI_1_OFF_0a1b2c.png" -> "HDMI_1": the name a button's images were saved under.
export function nameFromImage(file) {
  return file.replace(/\.png$/i, "").replace(/_(OFF|ON)(_[0-9a-f]{6})?$/, "");
}

export function searchIcons(tags, query, limit = 60) {
  const names = Object.keys(tags);
  const q = query.trim().toLowerCase();
  if (!q) return names.slice(0, limit);
  const byName = names.filter((n) => n.includes(q));
  const byTag = names.filter((n) => !n.includes(q) && tags[n].some((t) => t.toLowerCase().includes(q)));
  return [...byName, ...byTag].slice(0, limit);
}

export function fitWithin(width, height, max) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)),
           height: Math.max(1, Math.round(height * scale)) };
}
