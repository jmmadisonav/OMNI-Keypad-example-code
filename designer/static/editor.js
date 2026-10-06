// The centre pane: OFF and ON canvases, the layer list, and the selected
// layer's settings.

import {
  SIZE, CENTRE, MAX_IMPORT, FONTS, defaultLayer, addLayer, updateLayer, removeLayer,
  moveLayer, searchIcons, fitWithin,
} from "./model.js";
import { paintInto, loadIcons } from "./render.js";

const SCALE = 2;    // Canvases are shown at 2x.

export function createEditor({ root, catalog, iconTags, onChange }) {
  let recipe = null;
  let selected = -1;

  root.innerHTML = `
    <div class="editor-canvases">
      <figure><canvas class="editor-canvas" data-state="off" width="${SIZE}" height="${SIZE}"></canvas><figcaption>OFF</figcaption></figure>
      <figure><canvas class="editor-canvas" data-state="on" width="${SIZE}" height="${SIZE}"></canvas><figcaption>ON</figcaption></figure>
    </div>
    <div class="layer-toolbar">
      Add:
      <button type="button" data-add="shape">Shape</button>
      <button type="button" data-add="icon">Icon</button>
      <button type="button" data-add="text">Text</button>
      <button type="button" data-add="image">Image</button>
    </div>
    <ul class="layer-list"></ul>
    <form class="layer-form" autocomplete="off"></form>
    <p class="editor-status" role="status"></p>`;
  const canvases = {
    off: root.querySelector('[data-state="off"]'),
    on: root.querySelector('[data-state="on"]'),
  };
  const list = root.querySelector(".layer-list");
  const form = root.querySelector(".layer-form");
  const status = root.querySelector(".editor-status");

  function setStatus(text) {
    status.textContent = text;
  }

  function paint() {
    if (!recipe) {
      for (const c of Object.values(canvases)) c.getContext("2d").clearRect(0, 0, SIZE, SIZE);
      return;
    }
    paintInto(canvases.off, recipe, "off", catalog);
    paintInto(canvases.on, recipe, "on", catalog);
  }

  function change(next, { rebuildForm = false } = {}) {
    recipe = next;
    paint();
    renderList();
    if (rebuildForm) renderForm();
    onChange(recipe);
  }

  function describe(layer) {
    switch (layer.type) {
      case "shape": return `Shape: ${layer.set} ${layer.colour}`;
      case "icon": return `Icon: ${layer.icon}`;
      case "text": return `Text: ${layer.lines.join(" / ") || "(empty)"}`;
      case "image": return `Image${layer.off ? "" : " (empty)"}`;
    }
    return layer.type;
  }

  function renderList() {
    list.innerHTML = "";
    if (!recipe) return;
    // Show the top layer first, like most editors.
    [...recipe.layers.keys()].reverse().forEach((index) => {
      const layer = recipe.layers[index];
      const li = document.createElement("li");
      li.className = "layer-item" + (index === selected ? " selected" : "") + (layer.visible ? "" : " hidden-layer");
      li.dataset.index = index;
      li.innerHTML = `<span class="layer-name"></span>
        <button type="button" data-act="up" title="Move up" aria-label="Move up">▲</button>
        <button type="button" data-act="down" title="Move down" aria-label="Move down">▼</button>
        <button type="button" data-act="hide" title="Show or hide" aria-label="Show or hide">${layer.visible ? "👁" : "–"}</button>
        <button type="button" data-act="delete" title="Delete" aria-label="Delete">✕</button>`;
      li.querySelector(".layer-name").textContent = describe(layer);
      list.append(li);
    });
  }

  // -- Settings form -------------------------------------------------------------

  const field = (label, html) => `<label><span>${label}</span>${html}</label>`;
  const number = (key, value, min, max, step = 1) =>
    `<input type="number" name="${key}" value="${value}" min="${min}" max="${max}" step="${step}">`;
  const range = (key, value, min, max, step = 1) =>
    `<input type="range" name="${key}" value="${value}" min="${min}" max="${max}" step="${step}">`;
  const colour = (layer) =>
    field("OFF colour", `<input type="color" name="colour.off" value="${layer.colour.off}">`) +
    field("ON colour", `<input type="color" name="colour.on" value="${layer.colour.on}">`);
  const position = (layer) =>
    field("X", number("x", layer.x, -SIZE, SIZE * 2)) +
    field("Y", number("y", layer.y, -SIZE, SIZE * 2)) +
    `<button type="button" data-centre>Centre</button>`;
  const options = (values, current) =>
    values.map((v) => `<option value="${v}"${v === current ? " selected" : ""}>${v}</option>`).join("");

  function renderForm() {
    form.innerHTML = "";
    const layer = recipe?.layers[selected];
    if (!layer) {
      form.innerHTML = recipe ? "<p>Select a layer to change it.</p>" : "";
      return;
    }
    if (layer.type === "shape") {
      form.innerHTML =
        field("Set", `<select name="set">${options(Object.keys(catalog.shapes), layer.set)}</select>`) +
        field("Colour", `<select name="colour">${options(Object.keys(catalog.shapes[layer.set] || {}), layer.colour)}</select>`);
    } else if (layer.type === "icon") {
      form.innerHTML =
        field("Search icons", `<input type="search" name="iconSearch" placeholder="monitor, mic, power…">`) +
        `<div class="icon-grid" role="listbox" aria-label="Icons"></div>` +
        field("Size", range("size", layer.size, 8, SIZE)) +
        field("Stroke", range("stroke", layer.stroke, 0.5, 4, 0.25)) +
        position(layer) + colour(layer);
      renderIconGrid("");
    } else if (layer.type === "text") {
      form.innerHTML =
        field("Text (up to 2 lines)", `<textarea name="lines" rows="2"></textarea>`) +
        field("Font", `<select name="font">${options(FONTS, layer.font)}</select>`) +
        field("Weight", `<select name="weight"><option value="400"${layer.weight === 400 ? " selected" : ""}>Regular</option><option value="700"${layer.weight === 700 ? " selected" : ""}>Bold</option></select>`) +
        field("Size", range("size", layer.size, 8, 96)) +
        field("Align", `<select name="align">${options(["left", "center", "right"], layer.align)}</select>`) +
        position(layer) + colour(layer);
      form.querySelector('[name="lines"]').value = layer.lines.join("\n");
    } else if (layer.type === "image") {
      form.innerHTML =
        `<div class="drop" data-target="off">OFF image: drop a PNG or SVG here, or <input type="file" accept="image/png,image/svg+xml" data-target="off"></div>` +
        `<div class="drop" data-target="on">ON image (leave empty to use the OFF image): <input type="file" accept="image/png,image/svg+xml" data-target="on">
           <button type="button" data-clear-on>Use OFF image</button></div>` +
        field("Size", range("size", layer.size, 8, SIZE * 2)) +
        position(layer);
    }
  }

  function renderIconGrid(query) {
    const grid = form.querySelector(".icon-grid");
    if (!grid) return;
    const current = recipe.layers[selected].icon;
    grid.innerHTML = searchIcons(iconTags, query).map((name) =>
      `<button type="button" class="icon-choice${name === current ? " selected" : ""}" data-icon="${name}" title="${name}" aria-label="${name}">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="/vendor/lucide/sprite.svg#${name}"/></svg>
       </button>`).join("");
  }

  function readValue(input) {
    if (input.type === "number" || input.type === "range") return Number(input.value);
    if (input.name === "weight") return Number(input.value);
    if (input.name === "lines") return input.value.split("\n").slice(0, 2);
    return input.value;
  }

  form.addEventListener("input", (event) => {
    const input = event.target;
    if (!input.name || selected < 0) return;
    if (input.name === "iconSearch") return renderIconGrid(input.value);
    if (input.type === "number" && input.value === "") return;
    const layer = recipe.layers[selected];
    let changes;
    if (input.name.startsWith("colour.")) {
      changes = { colour: { ...layer.colour, [input.name.slice(7)]: input.value } };
    } else {
      changes = { [input.name]: readValue(input) };
    }
    if (input.name === "set") {
      // Keep the colour if the new set has it.
      const colours = Object.keys(catalog.shapes[input.value] || {});
      if (!colours.includes(layer.colour)) changes.colour = colours.includes("Blue") ? "Blue" : colours[0];
    }
    change(updateLayer(recipe, selected, changes), { rebuildForm: input.name === "set" });
  });

  form.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || selected < 0) return;
    if (button.dataset.icon) {
      change(updateLayer(recipe, selected, { icon: button.dataset.icon }));
      form.querySelectorAll(".icon-choice").forEach((b) => b.classList.toggle("selected", b === button));
    } else if (button.hasAttribute("data-centre")) {
      change(updateLayer(recipe, selected, { x: CENTRE, y: CENTRE }), { rebuildForm: true });
    } else if (button.hasAttribute("data-clear-on")) {
      change(updateLayer(recipe, selected, { on: "" }));
      setStatus("The ON state now uses the OFF image.");
    }
  });

  // -- Image import ----------------------------------------------------------------

  async function importImage(file, target) {
    if (!file || !["image/png", "image/svg+xml"].includes(file.type)) {
      setStatus(`${file ? file.name : "That file"} isn't a PNG or SVG. Choose a PNG or SVG file.`);
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("load failed"));
        i.src = url;
      });
      const natural = { width: img.naturalWidth || SIZE, height: img.naturalHeight || SIZE };
      const { width, height } = fitWithin(natural.width, natural.height, MAX_IMPORT);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      change(updateLayer(recipe, selected, { [target]: canvas.toDataURL("image/png") }), { rebuildForm: true });
      setStatus(`Added ${file.name} (${width}x${height}).`);
    } catch {
      setStatus(`Couldn't read ${file.name}. Check that it's a valid PNG or SVG.`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  form.addEventListener("change", (event) => {
    const input = event.target;
    if (input.type === "file") importImage(input.files[0], input.dataset.target);
  });
  form.addEventListener("dragover", (event) => {
    if (event.target.closest(".drop")) event.preventDefault();
  });
  form.addEventListener("drop", (event) => {
    const zone = event.target.closest(".drop");
    if (!zone) return;
    event.preventDefault();
    importImage(event.dataTransfer.files[0], zone.dataset.target);
  });

  // -- Layer list and toolbar ------------------------------------------------------

  root.querySelector(".layer-toolbar").addEventListener("click", (event) => {
    const type = event.target.dataset?.add;
    if (!type || !recipe) return;
    selected = recipe.layers.length;
    change(addLayer(recipe, defaultLayer(type, catalog)), { rebuildForm: true });
  });

  list.addEventListener("click", (event) => {
    const item = event.target.closest(".layer-item");
    if (!item) return;
    const index = Number(item.dataset.index);
    const act = event.target.dataset?.act;
    if (act === "up" || act === "down") {
      const delta = act === "up" ? 1 : -1;        // The list shows the top layer first.
      const next = moveLayer(recipe, index, delta);
      if (next !== recipe) selected = index + delta;
      change(next, { rebuildForm: true });
    } else if (act === "hide") {
      change(updateLayer(recipe, index, { visible: !recipe.layers[index].visible }));
    } else if (act === "delete") {
      selected = -1;
      change(removeLayer(recipe, index), { rebuildForm: true });
    } else {
      selected = index;
      renderList();
      renderForm();
    }
  });

  // -- Dragging on a canvas -----------------------------------------------------------

  let drag = null;
  for (const canvas of Object.values(canvases)) {
    canvas.addEventListener("pointerdown", (event) => {
      const layer = recipe?.layers[selected];
      if (!layer || !("x" in layer)) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { startX: event.clientX, startY: event.clientY, x: layer.x, y: layer.y };
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) return;
      const scale = canvas.getBoundingClientRect().width / SIZE || SCALE;
      change(updateLayer(recipe, selected, {
        x: Math.round(drag.x + (event.clientX - drag.startX) / scale),
        y: Math.round(drag.y + (event.clientY - drag.startY) / scale),
      }));
    });
    const stop = () => {
      if (drag) renderForm();
      drag = null;
    };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
  }

  loadIcons();

  return {
    canvases,
    getRecipe: () => recipe,
    setRecipe(next) {
      recipe = next;
      selected = next && next.layers.length ? next.layers.length - 1 : -1;
      root.classList.toggle("empty", !next);
      setStatus(next ? "" : "Select a button on the keypad to edit it.");
      paint();
      renderList();
      renderForm();
    },
  };
}
