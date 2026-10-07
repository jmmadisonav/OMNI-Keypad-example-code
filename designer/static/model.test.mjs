import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIZE, CENTRE, buttonKey, newRecipe, defaultLayer, addLayer, updateLayer, removeLayer,
  moveLayer, shapeFiles, recipeFromImages, searchIcons, fitWithin, gridFor,
} from "./model.js";

const catalog = {
  shapes: {
    "Bubble": { "Aqua": { off: "Bubble/A_OFF.png", on: "Bubble/A_ON.png" },
                "Blue": { off: "Bubble/B_OFF.png", on: "Bubble/B_ON.png" } },
    "Squared": { "Black": { off: "Squared/K.png", on: "Squared/K.png" } },
  },
  buttons: {},
};

test("buttonKey joins page and button", () => {
  assert.equal(buttonKey(1, 3), "1-3");
});

test("defaultLayer builds each type", () => {
  assert.deepEqual(defaultLayer("shape", catalog),
    { type: "shape", set: "Bubble", colour: "Blue", visible: true });
  const icon = defaultLayer("icon", catalog);
  assert.equal(icon.type, "icon");
  assert.equal(icon.x, CENTRE);
  assert.deepEqual(Object.keys(icon.colour), ["off", "on"]);
  assert.equal(defaultLayer("text", catalog).lines[0], "Label");
  assert.equal(defaultLayer("image", catalog).size, SIZE);
  assert.throws(() => defaultLayer("video", catalog));
});

test("layer operations return new recipes", () => {
  const empty = newRecipe("x");
  const one = addLayer(empty, defaultLayer("shape", catalog));
  const two = addLayer(one, defaultLayer("text", catalog));
  assert.equal(empty.layers.length, 0);
  assert.equal(two.layers.length, 2);
  const moved = moveLayer(two, 1, -1);
  assert.equal(moved.layers[0].type, "text");
  assert.equal(two.layers[0].type, "shape");
  assert.equal(moveLayer(two, 0, -1), two);           // Out of range: unchanged.
  const updated = updateLayer(two, 1, { size: 40 });
  assert.equal(updated.layers[1].size, 40);
  assert.notEqual(two.layers[1].size, 40);
  assert.equal(removeLayer(two, 0).layers[0].type, "text");
});

test("shapeFiles finds files or returns null", () => {
  assert.deepEqual(shapeFiles(catalog, "Bubble", "Aqua"),
    { off: "Bubble/A_OFF.png", on: "Bubble/A_ON.png" });
  assert.equal(shapeFiles(catalog, "Bubble", "Pink"), null);
  assert.equal(shapeFiles(catalog, "Nope", "Aqua"), null);
});

test("recipeFromImages makes one full-size image layer", () => {
  const recipe = recipeFromImages("data:a", "data:b", "HDMI");
  assert.equal(recipe.name, "HDMI");
  assert.deepEqual(recipe.layers, [{ type: "image", off: "data:a", on: "data:b",
    size: SIZE, x: CENTRE, y: CENTRE, visible: true }]);
});

test("searchIcons ranks name matches before tag matches", () => {
  const tags = { "tv": ["monitor", "screen"], "monitor": ["screen"], "mic": ["audio"] };
  assert.deepEqual(searchIcons(tags, ""), ["tv", "monitor", "mic"]);
  assert.deepEqual(searchIcons(tags, "MONITOR"), ["monitor", "tv"]);
  assert.deepEqual(searchIcons(tags, "screen", 1), ["tv"]);
  assert.deepEqual(searchIcons(tags, "zzz"), []);
});

test("fitWithin only scales down and keeps the ratio", () => {
  assert.deepEqual(fitWithin(4000, 2000, 376), { width: 376, height: 188 });
  assert.deepEqual(fitWithin(100, 50, 376), { width: 100, height: 50 });
  assert.deepEqual(fitWithin(5000, 1, 376), { width: 376, height: 1 });
});

test("gridFor uses the model, or guesses from the button count", () => {
  assert.deepEqual(gridFor({ columns: 2, rows: 3 }, 6), { columns: 2, rows: 3 });
  assert.deepEqual(gridFor(undefined, 8), { columns: 4, rows: 2 });
  assert.deepEqual(gridFor(undefined, 6), { columns: 2, rows: 3 });
});

test("fileStem matches the server's image file names", async () => {
  const { fileStem } = await import("./model.js");
  assert.equal(fileStem("HDMI 1", 1, 3), "HDMI_1");
  assert.equal(fileStem("", 2, 5), "p2b5");
  assert.equal(fileStem("a".repeat(70), 1, 1), "a".repeat(64));
});

test("buttonNameError allows empty and file-safe names only", async () => {
  const { buttonNameError } = await import("./model.js");
  assert.equal(buttonNameError(""), "");
  assert.equal(buttonNameError("HDMI 1"), "");
  assert.equal(buttonNameError("Room_off-2"), "");
  assert.match(buttonNameError("HDMI/1"), /letters, digits/);
  assert.match(buttonNameError(" HDMI"), /letters, digits/);
});

test("nameFromImage recovers a button name from its image file", async () => {
  const { nameFromImage } = await import("./model.js");
  assert.equal(nameFromImage("AudioMute_Squared_OFF.png"), "AudioMute_Squared");
  assert.equal(nameFromImage("HDMI_1_OFF_0a1b2c.png"), "HDMI_1");
  assert.equal(nameFromImage("logo.png"), "logo");
  assert.equal(nameFromImage(""), "");
});

test("recipeFromImages records where the artwork came from", () => {
  const recipe = recipeFromImages("data:off", "data:on", "Cast", { kind: "library", name: "Cast_Squared" });
  assert.equal(recipe.name, "Cast");
  assert.deepEqual(recipe.layers[0].source, { kind: "library", name: "Cast_Squared" });
  assert.equal(recipeFromImages("a", "b").layers[0].source, undefined);
});

test("isBlank is true when no layer is visible", async () => {
  const { isBlank } = await import("./model.js");
  assert.equal(isBlank(newRecipe()), true);
  const icon = defaultLayer("icon", catalog);
  assert.equal(isBlank(addLayer(newRecipe(), icon)), false);
  assert.equal(isBlank(addLayer(newRecipe(), { ...icon, visible: false })), true);
  assert.equal(isBlank(addLayer(newRecipe(), defaultLayer("image", catalog))), true);
});

test("layerSummary describes each layer for the layer list", async () => {
  const { layerSummary } = await import("./model.js");
  assert.equal(layerSummary({ type: "shape", set: "Squared", colour: "Red" }), "Squared · Red");
  assert.equal(layerSummary({ type: "icon", icon: "house" }), "house");
  assert.equal(layerSummary({ type: "text", lines: ["HDMI", "1"] }), "\"HDMI / 1\"");
  assert.equal(layerSummary({ type: "image", off: "x", source: { kind: "keypad" } }), "Loaded from keypad");
  assert.equal(layerSummary({ type: "image", off: "x", source: { kind: "library", name: "Cast_Squared" } }), "Cast_Squared");
  assert.equal(layerSummary({ type: "image", off: "x", offFile: "logo.png" }), "logo.png");
  assert.equal(layerSummary({ type: "image", off: "" }), "No image");
});

test("quickRecipe builds a shape, an icon, and a label", async () => {
  const { quickRecipe } = await import("./model.js");
  const recipe = quickRecipe({ label: "Home", icon: "house", colour: "Blue" }, "Home");
  assert.deepEqual(recipe.layers.map((l) => l.type), ["shape", "icon", "text"]);
  assert.equal(recipe.layers[0].set, "Squared");
  assert.equal(recipe.layers[0].colour, "Blue");
  assert.equal(recipe.layers[1].icon, "house");
  assert.deepEqual(recipe.layers[2].lines, ["Home"]);
  assert.equal(recipe.name, "Home");
});

test("clampPosition keeps a layer centre on the canvas", async () => {
  const { clampPosition } = await import("./model.js");
  assert.equal(clampPosition(-5), 0);
  assert.equal(clampPosition(200), SIZE);
  assert.equal(clampPosition(93.6), 94);
});

test("tintPixels recolours white artwork and keeps its shading", async () => {
  const { tintPixels } = await import("./model.js");
  const base = 0.8;
  const grey = Math.round(255 * base);
  const data = new Uint8ClampedArray([grey, grey, grey, 255, 255, 255, 255, 128, 0, 0, 0, 255]);
  tintPixels(data, base, "#E31837");
  assert.deepEqual([...data.slice(0, 4)], [227, 24, 55, 255]);       // Base brightness -> the tint.
  assert.ok(data[5] > 24 && data[5] < 255);                          // A highlight is lighter.
  assert.equal(data[7], 128);                                        // Alpha is unchanged.
  assert.deepEqual([...data.slice(8, 11)], [0, 0, 0]);               // Black stays black.
});

test("layerSummary names a custom shape colour", async () => {
  const { layerSummary } = await import("./model.js");
  assert.equal(layerSummary({ type: "shape", set: "Bubble", colour: "White", tint: { off: "#112233", on: "#445566" } }),
    "Bubble · Custom");
});

test("tintSource prefers crisp grey artwork", async () => {
  const { tintSource } = await import("./model.js");
  const shapes = { shapes: { A: { White: { off: "w" }, Grey: { off: "g" } }, B: { White: { off: "w" }, LtGrey: { off: "l" } }, C: { Red: {} } } };
  assert.equal(tintSource(shapes, "A").off, "g");
  assert.equal(tintSource(shapes, "B").off, "l");
  assert.equal(tintSource(shapes, "C"), null);
});
