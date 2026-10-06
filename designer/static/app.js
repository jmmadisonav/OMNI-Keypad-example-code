// Wires the page together: the connection bar, the keypad view, the editor,
// the library, and the deploy flow.

import { getJson, sendJson, assetUrl } from "./api.js";
import { GRID, buttonKey, recipeFromImages } from "./model.js";
import { renderRecipe, toBase64, loadIcons } from "./render.js";
import { createEditor } from "./editor.js";

const $ = (id) => document.getElementById(id);

const state = {
  catalog: null,
  design: null,          // { fingerprint, config, images: {name: base64} }
  host: "",
  page: 1,
  selected: null,        // { page, button }
  edits: new Map(),      // buttonKey -> recipe
  previews: new Map(),   // buttonKey -> { off: dataURL, on: dataURL }
  lastBackup: "",
  busy: false,
};

let editor;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

function storage(action, value) {
  try {
    if (action === "get") return localStorage.getItem("designer.host") || "";
    localStorage.setItem("designer.host", value);
  } catch { /* Storage can be unavailable; the host just isn't remembered. */ }
  return "";
}

// -- Keypad view ----------------------------------------------------------------------

function designImage(page, button, key) {
  const names = state.design.config.pages[page - 1].buttons[button - 1]?.[key] || [];
  const data = names[0] && state.design.images[names[0]];
  return data ? `data:image/png;base64,${data}` : "";
}

function renderTabs() {
  const tabs = $("page-tabs");
  tabs.innerHTML = "";
  state.design.config.pages.forEach((page, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = page.name || `Page ${i + 1}`;
    if (i + 1 === state.page) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => { state.page = i + 1; renderTabs(); renderKeypad(); });
    tabs.append(button);
  });
}

function renderKeypad() {
  const keypad = $("keypad");
  keypad.innerHTML = "";
  if (!state.design) return;
  const page = state.design.config.pages[state.page - 1];
  keypad.style.gridTemplateColumns = `repeat(${GRID.columns}, 120px)`;
  keypad.style.background = state.design.config.display?.panel_separator_color || "#000";
  const showOn = $("show-on").checked;
  const count = Math.min(page.buttons.length, GRID.columns * GRID.rows);
  for (let button = 1; button <= count; button++) {
    const key = buttonKey(state.page, button);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.style.background = page.background || "#000";
    cell.setAttribute("aria-label", `Page ${state.page} button ${button}`);
    cell.classList.toggle("changed", state.edits.has(key));
    cell.classList.toggle("selected", state.selected?.page === state.page && state.selected?.button === button);
    const preview = state.previews.get(key);
    const src = preview ? preview[showOn ? "on" : "off"]
                        : designImage(state.page, button, showOn ? "onImage" : "offImage");
    if (src) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      cell.append(img);
    }
    cell.addEventListener("click", () => selectButton(state.page, button));
    keypad.append(cell);
  }
}

function selectButton(page, button) {
  state.selected = { page, button };
  const key = buttonKey(page, button);
  editor.setRecipe(state.edits.get(key) ??
    recipeFromImages(designImage(page, button, "offImage"), designImage(page, button, "onImage")));
  $("save-recipe").disabled = false;
  renderKeypad();
}

async function onEdit(recipe) {
  if (!state.selected) return;
  const key = buttonKey(state.selected.page, state.selected.button);
  state.edits.set(key, recipe);
  updateDeployButton();
  const { off, on } = await renderRecipe(recipe, state.catalog);
  if (state.edits.get(key) !== recipe) return;            // A newer edit arrived.
  state.previews.set(key, { off: off.toDataURL("image/png"), on: on.toDataURL("image/png") });
  renderKeypad();
}

function updateDeployButton() {
  const n = state.edits.size;
  $("deploy").textContent = n ? `Deploy (${n} changed)` : "Deploy";
  $("deploy").disabled = !n || !state.design || state.busy;
}

// -- Loading and deploying -------------------------------------------------------------

async function loadDesign({ keepStatus = false } = {}) {
  const host = $("host").value.trim();
  if (!host) return setStatus("Enter the keypad's IP address first.", true);
  if (state.edits.size && !confirm("Loading discards the changes you haven't deployed. Continue?")) return;
  setStatus(`Loading the design from ${host}…`);
  try {
    state.design = await sendJson("POST", "/api/design/load", { host });
  } catch (error) {
    return setStatus(error.message, true);
  }
  state.host = host;
  storage("set", host);
  state.page = 1;
  state.selected = null;
  state.edits.clear();
  state.previews.clear();
  editor.setRecipe(null);
  $("save-recipe").disabled = true;
  renderTabs();
  renderKeypad();
  updateDeployButton();
  if (!keepStatus) setStatus(`Loaded the design from ${host}. Click a button to edit it.`);
}

async function deploy(force = false) {
  state.busy = true;
  updateDeployButton();
  $("restore").hidden = true;
  setStatus("Rendering the changed buttons…");
  try {
    const buttons = [];
    for (const [key, recipe] of state.edits) {
      const [page, button] = key.split("-").map(Number);
      const { off, on } = await renderRecipe(recipe, state.catalog);
      buttons.push({ page, button, name: recipe.name || "", off: toBase64(off), on: toBase64(on) });
    }
    setStatus("Deploying. The keypad restarts, which takes about 20 seconds…");
    const result = await sendJson("POST", "/api/design/deploy",
      { host: state.host, fingerprint: state.design.fingerprint, buttons, force });
    state.lastBackup = result.backup;
    state.edits.clear();
    state.busy = false;
    await loadDesign({ keepStatus: true });
    setStatus(`Deployed. The previous design is saved as ${result.backup}.`);
  } catch (error) {
    state.busy = false;
    if (error.body?.conflict) {
      updateDeployButton();
      if (confirm("The design on the keypad changed since you loaded it. Deploy over it anyway? " +
                  "The current design is backed up first.")) {
        return await deploy(true);     // Await, so this call's finally runs after the retry.
      }
      return setStatus("Deploy cancelled. Click Load to get the keypad's current design.", true);
    }
    if (error.body?.backup) {
      state.lastBackup = error.body.backup;
      $("restore").hidden = false;
    }
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    updateDeployButton();
  }
}

async function restore() {
  if (!state.lastBackup || !confirm(`Restore ${state.lastBackup} to the keypad?`)) return;
  state.busy = true;
  updateDeployButton();
  setStatus(`Restoring ${state.lastBackup}. The keypad restarts…`);
  try {
    await sendJson("POST", "/api/design/restore", { host: state.host, backup: state.lastBackup });
    $("restore").hidden = true;
    state.edits.clear();
    state.busy = false;
    await loadDesign({ keepStatus: true });
    setStatus(`Restored ${state.lastBackup}.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    updateDeployButton();
  }
}

async function findKeypads() {
  setStatus("Looking for keypads…");
  try {
    const found = await getJson("/api/keypads");
    $("keypads").innerHTML = found.map((d) => `<option value="${d.ip}">${d.name} (${d.model} ${d.version})</option>`).join("");
    if (found.length === 1) $("host").value = found[0].ip;
    setStatus(found.length ? `Found ${found.length} keypad(s). Pick one, then click Load.`
                           : "Found no keypads. Enter the IP address instead.", !found.length);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// -- Library --------------------------------------------------------------------------

function thumb(label, src, onPick, onRemove) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "thumb";
  button.title = label;
  button.innerHTML = `<img alt=""><span></span>`;
  button.querySelector("img").src = src;
  button.querySelector("span").textContent = label;
  button.addEventListener("click", (event) => {
    if (event.target.closest(".remove")) return;
    onPick();
  });
  if (onRemove) {
    const remove = document.createElement("span");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.setAttribute("role", "button");
    remove.setAttribute("aria-label", `Delete ${label}`);
    remove.addEventListener("click", onRemove);
    button.append(remove);
  }
  return button;
}

function useRecipe(recipe) {
  if (!state.selected) return setStatus("Select a button on the keypad first.", true);
  const copy = structuredClone(recipe);
  editor.setRecipe(copy);
  onEdit(copy);
}

async function renderLibrary() {
  const items = await getJson("/api/library");
  $("library").replaceChildren(...items.map((item) => thumb(item.name, item.thumbnail,
    async () => useRecipe(await getJson(`/api/library/${encodeURIComponent(item.name)}`)),
    async () => {
      if (!confirm(`Delete ${item.name} from the library?`)) return;
      await sendJson("DELETE", `/api/library/${encodeURIComponent(item.name)}`);
      renderLibrary();
    })));
  if (!items.length) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Saved recipes appear here.";
    $("library").append(note);
  }
}

async function dataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function renderReadyMade() {
  $("ready-made").replaceChildren(...Object.entries(state.catalog.buttons).map(([name, files]) =>
    thumb(name, assetUrl(files.off), async () =>
      useRecipe(recipeFromImages(await dataUrl(assetUrl(files.off)), await dataUrl(assetUrl(files.on)), name)))));
}

async function saveRecipe() {
  const recipe = editor.getRecipe();
  if (!recipe) return;
  const name = prompt("Recipe name (letters, digits, spaces, dashes, underscores):", recipe.name || "");
  if (!name) return;
  try {
    const saved = await sendJson("PUT", `/api/library/${encodeURIComponent(name.trim())}`,
      { recipe, thumbnail: toBase64(editor.canvases.off) });
    editor.setRecipe(saved);
    onEdit(saved);
    await renderLibrary();
    setStatus(`Saved ${saved.name} to the library.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// -- Start ----------------------------------------------------------------------------

async function start() {
  try {
    const [catalog, iconTags] = await Promise.all([
      getJson("/api/assets"), getJson("/vendor/lucide/tags.json"), loadIcons()]);
    state.catalog = catalog;
    editor = createEditor({ root: $("editor"), catalog, iconTags, onChange: onEdit });
    editor.setRecipe(null);
    renderReadyMade();
    await renderLibrary();
  } catch (error) {
    return setStatus(`The designer couldn't start: ${error.message}`, true);
  }
  $("host").value = storage("get");
  $("find").addEventListener("click", findKeypads);
  $("load").addEventListener("click", () => loadDesign());
  $("host").addEventListener("keydown", (e) => { if (e.key === "Enter") loadDesign(); });
  $("deploy").addEventListener("click", () => deploy());
  $("restore").addEventListener("click", restore);
  $("show-on").addEventListener("change", renderKeypad);
  $("save-recipe").addEventListener("click", saveRecipe);
  window.addEventListener("beforeunload", (event) => {
    if (state.edits.size) { event.preventDefault(); event.returnValue = ""; }
  });
}

start();
