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

export function recipeFromImages(off, on, name = "") {
  return { ...newRecipe(name), layers: [
    { type: "image", off, on, size: SIZE, x: CENTRE, y: CENTRE, visible: true }] };
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
