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
