// Wires the page together: the header, the keypad view, the BUTTON and
// LIBRARY tabs, the HControl reference, and the deploy and backup flows.

import { getJson, sendJson, assetUrl } from "./api.js";
import {
  gridFor, buttonKey, recipeFromImages, isBlank, fileStem, buttonNameError, nameFromImage, imageSizeFor,
} from "./model.js";
import { renderRecipe, toBase64, loadIcons } from "./render.js";
import { createEditor, icon } from "./editor.js";
import {
  MAX_PAGES, layoutFromConfig, addPage, deletePage, setDestination, destinationOf,
  pageNumber, pageName, layoutRequest, recipesFromSaved, recipesRequest, swapDestinations,
} from "./pages.js";
import { buttonGroups, pageControlGroups, HCONTROL_NOTES } from "./hcontrol.js";

const $ = (id) => document.getElementById(id);
const projectUrl = (name) => `/api/projects/${encodeURIComponent(name)}`;
const DEFAULT_MODEL = "OMNI-KP-8BV";
const PROJECT_NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9_-])?$/;
const NAME_RULE = "Letters, digits, spaces, dashes and underscores.";

const state = {
  catalog: null,
  models: {},            // id -> { id, name, columns, rows, dial, faceplate, tested }
  project: null,         // { name, model, config, images, recipes, baseFingerprint, lastDeployed }
  projects: [],          // [{ name, model, saved }], newest first
  layout: null,          // Pages and page switching; see pages.js.
  layoutChanges: 0,      // Page and page-link changes not saved yet.
  pagesChanged: false,   // Pages added or deleted since the last save, so numbers may move.
  pageId: "",            // The page shown in the keypad view.
  selected: null,        // { pageId, button }
  recipes: new Map(),    // buttonKey(pageId, button) -> saved layers
  edits: new Map(),      // buttonKey(pageId, button) -> unsaved layers
  previews: new Map(),   // buttonKey(pageId, button) -> { off: dataURL, on: dataURL }
  linkChanged: new Set(),// buttonKey(pageId, button) whose page link changed
  showOn: false,
  tab: "button",
  renaming: null,        // { pageId, value, error }
  library: [],           // [{ name, thumbnail }]
  libQuery: "",
  keypads: [],           // The last Find result.
  keypadModel: "",       // The model of the keypad at the address, when known.
  connected: false,
  busy: null,            // "save", "load", "find", "deploy", "restore" or "backup"
};

let editor;
let drag = null;         // { kind: "key", pageId, button } or { kind: "recipe", get() }

// -- Status bar ------------------------------------------------------------------------

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
  $("status-chip").hidden = !isError;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric",
                                         hour: "2-digit", minute: "2-digit", hour12: false });
}

function renderLastDeployed() {
  const when = state.project?.lastDeployed;
  $("last-deployed").textContent = when ? `Last deployed ${formatDate(when)}` : "Not deployed yet";
}

// Per-viewer conveniences: remembered keypad address and model.
function recall(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";                                 // Storage can be unavailable.
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* Not remembered; nothing else depends on it. */ }
}

const host = () => $("host").value.trim();

// -- Buttons ----------------------------------------------------------------------------

const model = () => state.models[state.project?.model];
const keyOf = (pageId, button) => buttonKey(pageId, button);
const sourceOf = (pageId) => state.layout.pages.find((p) => p.id === pageId)?.source;

// The saved page a page comes from; new pages use page 1's structure.
function sourcePage(pageId) {
  return state.project.config.pages[(sourceOf(pageId) || 1) - 1];
}

function slotCount(pageId) {
  const page = sourcePage(pageId);
  const grid = gridFor(model(), page.buttons.length);
  return Math.min(page.buttons.length, grid.columns * grid.rows);
}

function imageNames(pageId, button, key) {
  const source = sourceOf(pageId);
  if (!source) return [];                                // New pages start empty.
  return state.project.config.pages[source - 1].buttons[button - 1]?.[key] || [];
}

function designImage(pageId, button, key) {
  const name = imageNames(pageId, button, key)[0];
  const data = name && state.project.images[name];
  return data ? `data:image/png;base64,${data}` : "";
}

// The layers to edit: unsaved ones, saved ones, or the keypad's own artwork.
function recipeFor(pageId, button) {
  const key = keyOf(pageId, button);
  if (state.edits.has(key)) return state.edits.get(key);
  if (state.recipes.has(key)) return structuredClone(state.recipes.get(key));
  const off = designImage(pageId, button, "offImage");
  const on = designImage(pageId, button, "onImage");
  const name = nameFromImage(imageNames(pageId, button, "offImage")[0] || "");
  if (!off && !on) return { version: 1, name, layers: [] };
  return recipeFromImages(off, on, name, { kind: "keypad" });
}

function buttonName(pageId, button) {
  return recipeFor(pageId, button).name || "";
}

function isKeyBlank(pageId, button) {
  const key = keyOf(pageId, button);
  const recipe = state.edits.get(key) ?? state.recipes.get(key);
  return recipe ? isBlank(recipe) : !designImage(pageId, button, "offImage");
}

function faceImage(pageId, button, on = state.showOn) {
  const preview = state.previews.get(keyOf(pageId, button));
  if (preview) return preview[on ? "on" : "off"];
  return designImage(pageId, button, on ? "onImage" : "offImage");
}

const isChanged = (key) => state.edits.has(key) || state.linkChanged.has(key);

// The pixel size of this project's button images: 150 on the 6B and 6BV, 188 on the 8BV.
const imageSize = () => imageSizeFor(model(), state.project.config.pages[0].buttons.length);

// Store new layers for a button and redraw it.
async function setEdit(pageId, button, recipe) {
  const key = keyOf(pageId, button);
  state.edits.set(key, recipe);
  updateHeader();
  renderKeypad();
  renderSelectionHead();
  const { off, on } = await renderRecipe(recipe, state.catalog, imageSize());
  if (state.edits.get(key) !== recipe) return;            // A newer edit arrived.
  state.previews.set(key, { off: off.toDataURL("image/png"), on: on.toDataURL("image/png") });
  renderKeypad();
  renderSelectionHead();
}

// -- Undo -------------------------------------------------------------------------------

// Each entry is a snapshot of the unsaved design from before a change.
// Edits are immutable recipes, so copying the maps is enough.
const history = { undo: [], redo: [] };
const HISTORY_LIMIT = 200;
const MERGE_MS = 800;        // Changes to one key this close together undo as one, like a slider drag.
let lastChange = { key: null, time: 0 };

function snapshot() {
  return {
    edits: new Map(state.edits), previews: new Map(state.previews), linkChanged: new Set(state.linkChanged),
    layout: state.layout, layoutChanges: state.layoutChanges, pagesChanged: state.pagesChanged,
    pageId: state.pageId, selected: state.selected,
  };
}

// Call before changing the design. label finishes "Undid …".
function record(label, mergeKey = null) {
  const now = Date.now();
  if (mergeKey && mergeKey === lastChange.key && now - lastChange.time < MERGE_MS) {
    lastChange.time = now;
    return;
  }
  lastChange = { key: mergeKey, time: now };
  history.undo.push({ label, snap: snapshot() });
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
}

function restore(snap) {
  Object.assign(state, {
    edits: new Map(snap.edits), previews: new Map(snap.previews), linkChanged: new Set(snap.linkChanged),
    layout: snap.layout, layoutChanges: snap.layoutChanges, pagesChanged: snap.pagesChanged,
    pageId: snap.pageId, selected: snap.selected, renaming: null,
  });
  lastChange = { key: null, time: 0 };
  const sel = state.selected;
  if (sel) editor.setRecipe(structuredClone(recipeFor(sel.pageId, sel.button)), { keepLayer: true });
  renderTabs();
  renderKeypad();
  renderSelection();
  updateHeader();
}

function undo() {
  const entry = history.undo.pop();
  if (!entry) return setStatus("Nothing to undo.");
  history.redo.push({ label: entry.label, snap: snapshot() });
  restore(entry.snap);
  setStatus(`Undid ${entry.label}. To redo it, press Ctrl+Y.`);
}

function redo() {
  const entry = history.redo.pop();
  if (!entry) return setStatus("Nothing to redo.");
  history.undo.push({ label: entry.label, snap: snapshot() });
  restore(entry.snap);
  setStatus(`Redid ${entry.label}.`);
}

function clearHistory() {
  history.undo = [];
  history.redo = [];
  lastChange = { key: null, time: 0 };
}

// Text fields keep the browser's own undo for their text.
function isTextField(el) {
  return el.isContentEditable || el.matches?.("textarea, select, input:not([type=range]):not([type=color])" +
    ":not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file])");
}

function onUndoKey(event) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if ((key !== "z" && key !== "y") || !$("modal").hidden || !state.project || state.busy) return;
  if (isTextField(event.target)) return;
  event.preventDefault();
  if (key === "y" || event.shiftKey) redo();
  else undo();
}

// -- Keypad view ----------------------------------------------------------------------

function renderFaceplate() {
  const m = model();
  const page = sourcePage(state.pageId);
  const portrait = m ? m.faceplate === "portrait" : page.buttons.length <= 6;
  const dial = m ? m.dial : "dial" in page;
  const face = $("faceplate");
  face.classList.toggle("portrait", portrait);
  face.classList.toggle("no-dial", !dial);
  $("dial").hidden = !dial;
  face.style.setProperty("--cols", gridFor(m, page.buttons.length).columns);
}

function renderKeypad() {
  const keypad = $("keypad");
  keypad.innerHTML = "";
  if (!state.project) return;
  renderFaceplate();
  for (let button = 1; button <= slotCount(state.pageId); button++) {
    const pageId = state.pageId;
    const key = keyOf(pageId, button);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "key";
    cell.draggable = true;
    cell.setAttribute("aria-label", `${pageName(state.layout, pageId)} key ${button}`);
    cell.classList.toggle("blank", isKeyBlank(pageId, button));
    cell.classList.toggle("selected", state.selected?.pageId === pageId && state.selected?.button === button);
    const src = faceImage(pageId, button);
    if (src && !isKeyBlank(pageId, button)) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      cell.append(img);
    }
    if (isChanged(key)) {
      const mark = document.createElement("span");
      mark.className = "changed";
      mark.title = "Unsaved changes";
      cell.append(mark);
    }
    const target = destinationOf(state.layout, pageId, button);
    if (target) {
      const badge = document.createElement("span");
      badge.className = "link-badge";
      badge.textContent = `→ ${pageName(state.layout, target)}`;
      cell.append(badge);
    }
    cell.addEventListener("click", () => selectButton(pageId, button));
    cell.addEventListener("dragstart", (event) => {
      drag = { kind: "key", pageId, button };
      event.dataTransfer.setData("text/plain", "key");
      event.dataTransfer.effectAllowed = "move";
      cell.classList.add("dragging");
    });
    cell.addEventListener("dragend", () => { drag = null; cell.classList.remove("dragging"); });
    cell.addEventListener("dragover", (event) => {
      if (!drag) return;
      event.preventDefault();
      cell.classList.add("drop-target");
    });
    cell.addEventListener("dragleave", () => cell.classList.remove("drop-target"));
    cell.addEventListener("drop", (event) => {
      event.preventDefault();
      cell.classList.remove("drop-target");
      const source = drag;
      drag = null;
      if (source?.kind === "key") swapKeys(source, { pageId, button });
      else if (source?.kind === "recipe") applyRecipe(source.get, pageId, button);
    });
    keypad.append(cell);
  }
  $("show-off").classList.toggle("current", !state.showOn);
  $("show-on").classList.toggle("current", state.showOn);
}

function setShowOn(on) {
  state.showOn = on;
  editor.setShowOn(on);
  renderKeypad();
  renderSelectionHead();
}

async function swapKeys(a, b) {
  if (a.pageId === b.pageId && a.button === b.button) return;
  record(`swapping keys ${a.button} and ${b.button}`);
  const ra = recipeFor(a.pageId, a.button);
  const rb = recipeFor(b.pageId, b.button);
  state.layout = swapDestinations(state.layout, a, b);
  state.layoutChanges++;
  state.linkChanged.add(keyOf(a.pageId, a.button)).add(keyOf(b.pageId, b.button));
  state.selected = { pageId: b.pageId, button: b.button };
  editor.setRecipe(ra);
  setEdit(a.pageId, a.button, rb);
  await setEdit(b.pageId, b.button, ra);
  renderSelection();
  const where = a.pageId === b.pageId ? `keys ${a.button} and ${b.button}`
    : `${pageName(state.layout, a.pageId)} key ${a.button} and ${pageName(state.layout, b.pageId)} key ${b.button}`;
  setStatus(`Swapped artwork and page link between ${where}. Control settings stay with each slot.`);
}

// -- Pages ------------------------------------------------------------------------------

let renderingTabs = false;   // Removing a focused rename input fires blur; ignore that one.

function renderTabs() {
  const tabs = $("page-tabs");
  renderingTabs = true;
  tabs.innerHTML = "";
  renderingTabs = false;
  for (const page of state.layout.pages) {
    const current = page.id === state.pageId;
    const tab = document.createElement("div");
    tab.className = "tab" + (current ? " current" : "");
    if (state.renaming?.pageId === page.id) {
      const input = document.createElement("input");
      input.className = "tab-input" + (state.renaming.error ? " invalid" : "");
      input.value = state.renaming.value;
      input.setAttribute("aria-label", "Page name");
      input.addEventListener("input", () => {
        state.renaming.value = input.value;
        state.renaming.error = "";
        input.classList.remove("invalid");
        renderRenameError();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") commitRename(false);
        if (event.key === "Escape") { state.renaming = null; renderTabs(); }
      });
      input.addEventListener("blur", () => { if (state.renaming && !renderingTabs) commitRename(true); });
      tab.append(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const name = document.createElement("button");
      name.type = "button";
      name.className = "tab-name";
      name.title = "Double-click to rename";
      name.textContent = page.name;
      // The first click re-renders the tabs, so a double-click is the second click, not dblclick.
      name.addEventListener("click", (event) => {
        if (event.detail === 2) startRename(page.id);
        else if (page.id !== state.pageId) showPage(page.id);
      });
      name.addEventListener("dragover", (event) => {
        if (drag && page.id !== state.pageId) showPage(page.id, { keepSelection: true });
        if (drag) event.preventDefault();
      });
      tab.append(name);
      if (current) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "tab-delete";
        remove.title = "Delete page";
        remove.setAttribute("aria-label", `Delete ${page.name}`);
        remove.textContent = "×";
        remove.disabled = state.layout.pages.length <= 1;
        remove.addEventListener("click", onDeletePage);
        tab.append(remove);
      }
    }
    tabs.append(tab);
  }
  const full = state.layout.pages.length >= MAX_PAGES;
  const add = document.createElement("button");
  add.type = "button";
  add.className = "add-page" + (full ? " full" : "");
  add.textContent = full ? `${MAX_PAGES} of ${MAX_PAGES} pages` : "+ Page";
  add.title = full ? `A design can have up to ${MAX_PAGES} pages` : "Add page";
  add.addEventListener("click", onAddPage);
  tabs.append(add);
  renderRenameError();
}

function renderRenameError() {
  const error = state.renaming?.error || "";
  $("rename-error").hidden = !error;
  $("rename-error").textContent = error;
}

function showPage(pageId, { keepSelection = false } = {}) {
  state.pageId = pageId;
  if (!keepSelection) {
    state.selected = null;
    renderSelection();
  }
  renderTabs();
  renderKeypad();
  renderHControl();
}

function changeLayout(next) {
  state.layout = next;
  state.layoutChanges++;
  renderTabs();
  renderKeypad();
  renderSelection();
  updateHeader();
}

function startRename(pageId) {
  state.pageId = pageId;
  state.renaming = { pageId, value: pageName(state.layout, pageId), error: "" };
  renderTabs();
  renderKeypad();
}

function commitRename(fromBlur) {
  const { pageId, value } = state.renaming;
  const name = value.trim();
  if (!name || name === pageName(state.layout, pageId)) {
    state.renaming = null;
    return renderTabs();
  }
  if (state.layout.pages.some((p) => p.id !== pageId && p.name.toLowerCase() === name.toLowerCase())) {
    if (fromBlur) {
      state.renaming = null;
      renderTabs();
      return setStatus(`Page names must be unique. "${name}" is already used.`, true);
    }
    state.renaming.error = `A page named "${name}" already exists.`;
    return renderTabs();
  }
  state.renaming = null;
  record(`renaming ${pageName(state.layout, pageId)}`);
  changeLayout({ ...state.layout, pages: state.layout.pages.map((p) => (p.id === pageId ? { ...p, name } : p)) });
}

function onAddPage() {
  if (state.layout.pages.length >= MAX_PAGES) {
    return setStatus(`A design can have up to ${MAX_PAGES} pages.`, true);
  }
  record("adding a page");
  const next = addPage(state.layout);
  state.pageId = next.pages.at(-1).id;
  state.selected = null;
  state.pagesChanged = true;
  changeLayout(next);
  setStatus(`Added ${pageName(next, state.pageId)}. Dial and LED ring settings copied from ${next.pages[0].name}.`);
}

async function onDeletePage() {
  const id = state.pageId;
  const name = pageName(state.layout, id);
  if (state.layout.pages.length <= 1) return setStatus("A design needs at least one page.", true);
  const number = pageNumber(state.layout, id);
  const after = state.layout.pages.slice(number).map((p, i) =>
    `${p.name}: /page${number + i + 1}/… becomes /page${number + i}/…`);
  const ok = await confirmModal({
    title: "Delete page",
    body: `Delete ${name} and its buttons? Keys that link to it lose their page link.`,
    list: after,
    note: after.length ? "HControl paths use page numbers, for example /page3/button1/action. Apps that use paths for the renumbered pages need updating." : "",
    confirm: "Delete page",
  });
  if (!ok) return;
  record(`deleting ${name}`);
  const next = deletePage(state.layout, id);
  for (const key of [...state.edits.keys()]) {
    if (key.startsWith(`${id}-`)) { state.edits.delete(key); state.previews.delete(key); }
  }
  state.pageId = next.pages[Math.max(0, number - 2)].id;
  state.selected = null;
  state.pagesChanged = true;
  changeLayout(next);
  setStatus(`Deleted ${name}. Pages after it were renumbered.`);
}

// -- BUTTON tab -------------------------------------------------------------------------

function setTab(tab) {
  state.tab = tab;
  $("tab-button").classList.toggle("current", tab === "button");
  $("tab-library").classList.toggle("current", tab === "library");
  $("tab-button").setAttribute("aria-selected", tab === "button");
  $("tab-library").setAttribute("aria-selected", tab === "library");
  $("button-panel").hidden = tab !== "button";
  $("library-panel").hidden = tab !== "library";
}

function selectButton(pageId, button) {
  state.selected = { pageId, button };
  editor.setRecipe(structuredClone(recipeFor(pageId, button)));
  setTab("button");
  renderKeypad();
  renderSelection();
}

function renderSelectionHead() {
  const sel = state.selected;
  if (!sel) return;
  const number = pageNumber(state.layout, sel.pageId);
  $("sel-thumb").src = faceImage(sel.pageId, sel.button) || "data:,";
  $("sel-thumb").hidden = isKeyBlank(sel.pageId, sel.button);
  $("sel-overline").textContent = `Key ${sel.button} · ${pageName(state.layout, sel.pageId)} · /page${number}/button${sel.button}`;
  const name = buttonName(sel.pageId, sel.button);
  $("sel-name").textContent = name || `Key ${sel.button}`;
  $("sel-changed").hidden = !isChanged(keyOf(sel.pageId, sel.button));
  renderNameHint(name);
}

function renderNameHint(name) {
  const sel = state.selected;
  const error = buttonNameError(name);
  const stem = fileStem(name, pageNumber(state.layout, sel.pageId), sel.button);
  $("button-name").classList.toggle("invalid", Boolean(error));
  $("name-hint").classList.toggle("error", Boolean(error));
  $("name-hint").textContent = error || `Files on keypad: ${stem}_OFF.png, ${stem}_ON.png`;
}

function renderSelection() {
  const sel = state.selected;
  $("no-selection").hidden = Boolean(sel);
  $("selection").hidden = !sel;
  renderHControl();
  if (!sel) return;
  renderSelectionHead();
  $("button-name").value = buttonName(sel.pageId, sel.button);
  const options = [["", "None"], ...state.layout.pages.filter((p) => p.id !== sel.pageId).map((p) => [p.id, p.name])];
  $("goto").replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  $("goto").value = destinationOf(state.layout, sel.pageId, sel.button) || "";
}

function onNameInput() {
  const name = $("button-name").value;
  editor.rename(name);
  renderNameHint(name);
}

function onGoToChange() {
  const sel = state.selected;
  if (!sel) return;
  record(`the page link on key ${sel.button}`);
  state.linkChanged.add(keyOf(sel.pageId, sel.button));
  changeLayout(setDestination(state.layout, sel.pageId, sel.button, $("goto").value || null));
}

function onEdit(recipe) {
  const sel = state.selected;
  if (!sel) return;
  record(`the change to key ${sel.button}`, `edit ${keyOf(sel.pageId, sel.button)}`);
  setEdit(sel.pageId, sel.button, recipe);
}

function clearLayers() {
  const sel = state.selected;
  const recipe = { ...editor.getRecipe(), layers: [] };
  record(`clearing key ${sel.button}`);
  editor.setRecipe(recipe);
  setEdit(sel.pageId, sel.button, recipe);
  setStatus(`Cleared the layers on key ${sel.button}. It's now a blank button.`);
}

// -- HControl drawer -------------------------------------------------------------------

const TOKENS = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?)|\b(true|false|null)\b/g;

// "set {...}" with the command and the JSON coloured like a code editor.
function highlight(text) {
  const space = text.indexOf(" ");
  const command = text.slice(0, space);
  let json = "";
  let last = 0;
  const body = text.slice(space);
  for (const match of body.matchAll(TOKENS)) {
    json += escapeHtml(body.slice(last, match.index));
    if (match[1] && match[2]) json += `<span class="tok-key">${escapeHtml(match[1])}</span>${match[2]}`;
    else if (match[1]) json += `<span class="tok-str">${escapeHtml(match[1])}</span>`;
    else json += `<span class="tok-num">${match[0]}</span>`;
    last = match.index + match[0].length;
  }
  json += escapeHtml(body.slice(last));
  return `<span class="${command.startsWith("@") ? "tok-reply" : "tok-cmd"}">${escapeHtml(command)}</span>${json}`;
}

let drawerLines = [];        // The strings the drawer shows, for Copy all.

function renderHControl() {
  const sel = state.selected;
  const pageId = sel?.pageId || state.pageId;
  if (!state.layout || !pageId) return;
  const page = pageNumber(state.layout, pageId);
  const name = pageName(state.layout, pageId);
  const dial = model() ? model().dial : "dial" in sourcePage(pageId);
  const rows = [];
  let number = 0;
  const comment = (text) => rows.push(`<div class="code-row"><span class="ln">${++number}</span><span class="dir"></span>
    <span class="src tok-comment">// ${escapeHtml(text)}</span></div>`);
  const groups = (list) => {
    for (const group of list) {
      rows.push(`<div class="code-row gap"></div>`);
      comment(group.title);
      for (const line of group.lines) {
        drawerLines.push(`${line.send ? "->" : "<-"} ${line.text}`);
        rows.push(`<div class="code-row" role="listitem"><span class="ln">${++number}</span>
          <span class="dir${line.send ? " send" : ""}" title="${line.send ? "Send" : "Expect"}">${line.send ? "→" : "←"}</span>
          <span class="src">${highlight(line.text)}</span>
          <button type="button" class="copy" title="Copy" aria-label="Copy this line" data-copy="${escapeHtml(line.text)}">${icon("copy", 13)}</button></div>`);
      }
    }
  };
  drawerLines = [];
  comment(`TCP ${host() || "<keypad IP>"}:4197. One line per message: a command, a space, a JSON object and a line feed.`);
  if (sel) {
    const target = destinationOf(state.layout, sel.pageId, sel.button);
    groups(buttonGroups({ page, button: sel.button, pageName: name, target: target ? pageName(state.layout, target) : "" }));
  } else {
    comment("Select a key on the keypad to see its strings.");
  }
  if (dial) {
    rows.push(`<div class="code-row gap"></div>`);
    comment(`Page controls · ${name}`);
    groups(pageControlGroups(page));
  }
  $("hc-code").innerHTML = rows.join("");
  $("drawer-path").textContent = sel ? `/page${page}/button${sel.button} · Key ${sel.button} · ${name}` : name;
  $("drawer-warn").hidden = !state.pagesChanged;
  $("copy-all").disabled = !drawerLines.length;
}

function renderNotes() {
  $("hc-notes").innerHTML = HCONTROL_NOTES.map((n) => `<p><strong>${n.title}.</strong> ${escapeHtml(n.text)}</p>`).join("");
}

function setDrawerOpen(open) {
  $("drawer").classList.toggle("collapsed", !open);
  $("drawer-toggle").setAttribute("aria-expanded", open);
  $("drawer-chevron").innerHTML = icon(open ? "chevron-down" : "chevron-up", 14);
  remember("designer.drawer", open ? "open" : "closed");
}

function setDrawerHeight(height) {
  const room = $("drawer").parentElement.getBoundingClientRect().height;
  const clamped = Math.round(Math.max(120, Math.min(height, room - 220)));
  $("drawer").style.setProperty("--drawer-h", `${clamped}px`);
  return clamped;
}

function wireDrawer() {
  renderNotes();
  setDrawerOpen(recall("designer.drawer") !== "closed");
  const saved = Number(recall("designer.drawerHeight"));
  if (saved) setDrawerHeight(saved);
  $("drawer-toggle").addEventListener("click", () => setDrawerOpen($("drawer").classList.contains("collapsed")));  $("hc-code").addEventListener("click", onCopy);
  $("copy-all").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(drawerLines.join("\n"));
      setStatus(`Copied ${drawerLines.length} lines. -> marks lines you send, <- lines you receive.`);
    } catch {
      setStatus("Couldn't copy to the clipboard. Select the text and copy it instead.", true);
    }
  });
  const handle = $("drawer-resize");
  handle.addEventListener("pointerdown", (event) => {
    handle.setPointerCapture(event.pointerId);
    $("drawer").classList.add("resizing");
    const bottom = $("drawer").getBoundingClientRect().bottom;
    const move = (e) => setDrawerHeight(bottom - e.clientY);
    const up = (e) => {
      remember("designer.drawerHeight", String(setDrawerHeight(bottom - e.clientY)));
      $("drawer").classList.remove("resizing");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

async function onCopy(event) {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
  } catch {
    return setStatus("Couldn't copy to the clipboard. Select the text and copy it instead.", true);
  }
  button.innerHTML = icon("check", 13);
  button.style.visibility = "visible";
  setTimeout(() => { button.innerHTML = icon("copy", 13); button.style.visibility = ""; }, 1400);
}

// -- LIBRARY tab ------------------------------------------------------------------------

function tile({ name, label, title, src, onPick, onDrag, onRemove }) {
  const wrap = document.createElement("div");
  wrap.className = "tile";
  const face = document.createElement("button");
  face.type = "button";
  face.className = "tile-face";
  face.title = title;
  face.draggable = true;
  face.setAttribute("aria-label", `Apply ${name}`);
  const img = document.createElement("img");
  img.alt = "";
  img.src = src;
  face.append(img);
  face.addEventListener("click", (event) => {
    if (!event.target.closest(".tile-delete")) onPick();
  });
  face.addEventListener("dragstart", (event) => {
    drag = { kind: "recipe", get: onDrag };
    event.dataTransfer.setData("text/plain", "recipe");
    event.dataTransfer.effectAllowed = "copy";
  });
  face.addEventListener("dragend", () => { drag = null; });
  if (onRemove) {
    const remove = document.createElement("span");
    remove.className = "tile-delete";
    remove.setAttribute("role", "button");
    remove.title = "Delete recipe";
    remove.setAttribute("aria-label", `Delete ${name}`);
    remove.innerHTML = icon("x", 12);
    remove.addEventListener("click", onRemove);
    face.append(remove);
  }
  const caption = document.createElement("div");
  caption.className = "tile-name";
  caption.textContent = label;
  wrap.append(face, caption);
  return wrap;
}

async function dataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

const readyMade = (name, files) => async () => recipeFromImages(
  await dataUrl(assetUrl(files.off)), await dataUrl(assetUrl(files.on)), name, { kind: "library", name });
const savedRecipe = (name) => async () => getJson(`/api/library/${encodeURIComponent(name)}`);

// Replace a button's layers and name with a recipe. Its page link stays.
async function applyRecipe(get, pageId, button) {
  if (!pageId) {
    if (!state.selected) return setStatus("Select a key on the keypad first.", true);
    ({ pageId, button } = state.selected);
  }
  let recipe;
  try {
    recipe = structuredClone(await get());
  } catch (error) {
    return setStatus(error.message, true);
  }
  record(`applying ${recipe.name || "the recipe"} to key ${button}`);
  state.pageId = pageId;
  state.selected = { pageId, button };
  editor.setRecipe(recipe);
  setTab("button");
  await setEdit(pageId, button, recipe);
  renderTabs();
  renderSelection();
  setStatus(`Applied ${recipe.name || "the recipe"} to key ${button}.`);
}

function renderLibrary() {
  const q = state.libQuery.trim().toLowerCase();
  const saved = state.library.filter((item) => !q || item.name.toLowerCase().includes(q));
  $("saved-empty").hidden = state.library.length > 0;
  $("saved").replaceChildren(...saved.map((item) => tile({
    name: item.name, label: item.name, title: item.name, src: item.thumbnail,
    onPick: () => applyRecipe(savedRecipe(item.name)), onDrag: savedRecipe(item.name),
    onRemove: async (event) => {
      event.stopPropagation();
      const ok = await confirmModal({ title: "Delete recipe", confirm: "Delete",
        body: `Delete "${item.name}" from the library? Buttons already using it keep their layers.` });
      if (!ok) return;
      try {
        await sendJson("DELETE", `/api/library/${encodeURIComponent(item.name)}`);
        await refreshLibrary();
        setStatus(`Deleted recipe ${item.name}.`);
      } catch (error) {
        setStatus(error.message, true);
      }
    },
  })));
  const ready = Object.entries(state.catalog.buttons).filter(([name]) => !q || name.toLowerCase().includes(q));
  $("ready").replaceChildren(...ready.map(([name, files]) => tile({
    name, label: name, title: `${files.off} / ${files.on}`, src: assetUrl(files.off),
    onPick: () => applyRecipe(readyMade(name, files)), onDrag: readyMade(name, files),
  })));
  $("lib-none").hidden = saved.length + ready.length > 0;
}

async function refreshLibrary() {
  state.library = await getJson("/api/library");
  renderLibrary();
}

async function saveRecipe() {
  const recipe = editor.getRecipe();
  if (!recipe) return;
  const result = await nameModal({
    title: "Save to library",
    body: "Saves this button's layers as a recipe. The name also names its image files on the keypad.",
    label: "Recipe name",
    value: (recipe.name || "").replace(/_/g, " "),
    hint: (name) => { const stem = fileStem(name.trim(), 1, 1); return `Files on keypad: ${name.trim() ? stem : "Name"}_OFF.png, ${name.trim() ? stem : "Name"}_ON.png`; },
    confirm: "Save",
    submit: async (name) => {
      const saved = await sendJson("PUT", `/api/library/${encodeURIComponent(name)}`,
        { recipe, thumbnail: toBase64(editor.canvases.off) });
      return saved;
    },
  });
  if (!result) return;
  editor.setRecipe(result);
  onEdit(result);
  $("button-name").value = result.name;
  await refreshLibrary();
  setStatus(`Saved recipe ${result.name} to the library.`);
}

// -- Header -----------------------------------------------------------------------------

function pendingChanges() {
  return state.edits.size + state.layoutChanges;
}

function updateHeader() {
  const open = Boolean(state.project);
  const unsaved = pendingChanges() > 0;
  const m = model();
  $("unsaved").hidden = !unsaved;
  $("save").classList.toggle("faded", !unsaved);
  $("save").textContent = state.busy === "save" ? "Saving…" : "Save";
  $("find").textContent = state.busy === "find" ? "Finding…" : "Find";
  $("load").textContent = state.busy === "load" ? "Loading…" : "Load";
  const chip = $("model-chip");
  chip.hidden = !open;
  if (open) {
    chip.textContent = m ? state.project.model : `${state.project.model} · Model missing`;
    chip.classList.toggle("missing", !m);
    chip.title = m ? modelDescription(m) : "The model file for this project is missing";
  }
  $("model-banner").hidden = !open || Boolean(m);
  if (open && !m) {
    $("model-banner-text").textContent = `The model file for ${state.project.model} is missing. ` +
      "You can edit this project, but you can't deploy it until the model file is restored.";
  }
  const blocked = !open || !m || Boolean(state.busy);
  $("deploy").classList.toggle("off", blocked);
  $("deploy").title = open && !m ? `Model file for ${state.project.model} is missing` : "";
  document.body.classList.toggle("busy", Boolean(state.busy));
  $("conn").classList.toggle("on", state.connected);
  $("find-list").hidden = state.keypads.length < 2;
  $("find-list").innerHTML = icon("chevron-down", 14);
}

function setBusy(busy) {
  state.busy = busy;
  updateHeader();
}

function modelDescription(m) {
  const shape = m.faceplate === "portrait" ? "portrait" : "square";
  const dial = m.dial ? (m.faceplate === "portrait" ? "dial and LED ring below" : "dial and LED ring") : "no dial";
  return `${m.columns}×${m.rows} buttons, ${shape} faceplate, ${dial}`;
}

// -- Projects --------------------------------------------------------------------------

function showProject(project) {
  state.project = project;
  state.layout = layoutFromConfig(project.config);
  state.layoutChanges = 0;
  state.pagesChanged = false;
  state.pageId = state.layout.pages[0].id;
  state.selected = null;
  state.renaming = null;
  state.recipes = new Map(Object.entries(recipesFromSaved(project.recipes)));
  state.edits.clear();
  state.previews.clear();
  state.linkChanged.clear();
  clearHistory();
  editor.setImageSize(imageSize());
  editor.setRecipe(null);
  $("project-name").textContent = project.name;
  $("project-name").title = project.name;
  renderTabs();
  renderKeypad();
  renderSelection();
  renderLastDeployed();
  updateHeader();
  refreshProjects();
}

async function refreshProjects() {
  try {
    state.projects = await getJson("/api/projects");
  } catch {
    state.projects = [];
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Open";
  $("projects").replaceChildren(placeholder, ...state.projects.map((p) => {
    const option = document.createElement("option");
    option.value = p.name;
    option.textContent = `${p.name} · ${p.model}`;
    return option;
  }));
}

async function guard(action) {
  if (!pendingChanges()) return true;
  return confirmModal({ title: "Discard unsaved changes", confirm: "Discard changes",
    body: `${state.project.name} has unsaved changes. ${action} will discard them.` });
}

function freeName(base) {
  const taken = new Set(state.projects.map((p) => p.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

function projectNameError(name) {
  if (!name) return "Enter a name.";
  if (!PROJECT_NAME.test(name)) return "Use letters, digits, spaces, dashes and underscores only.";
  if (state.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return "That name is already used.";
  return "";
}

async function newProject() {
  if (!(await guard("Starting a new project"))) return;
  const last = recall("designer.model");
  let chosen = state.models[last] ? last : DEFAULT_MODEL;
  const models = document.createElement("div");
  models.className = "stack";
  const renderModels = () => {
    models.innerHTML = `<span class="label">Keypad model</span>` + Object.values(state.models).map((m) => `
      <button type="button" class="model-option${m.id === chosen ? " current" : ""}" data-model="${m.id}">
        <span class="radio"></span><span class="model-glyph${m.faceplate === "portrait" ? " portrait" : ""}"></span>
        <span class="option-text"><span class="option-name">${m.id} <span class="sub">${m.tested ? "" : "(untested)"}</span></span>
          <span class="option-desc">${modelDescription(m)}</span></span></button>`).join("");
  };
  models.addEventListener("click", (event) => {
    const option = event.target.closest("[data-model]");
    if (option) { chosen = option.dataset.model; renderModels(); }
  });
  renderModels();
  const project = await nameModal({
    title: "New project",
    body: "Choose the keypad model now. It can't be changed after the project is created.",
    label: "Project name",
    value: freeName("Untitled"),
    hint: () => NAME_RULE,
    extra: models,
    confirm: "Create",
    validate: projectNameError,
    submit: (name) => sendJson("POST", "/api/projects", { name, model: chosen }),
  });
  if (!project) return;
  remember("designer.model", chosen);
  showProject(project);
  setStatus(`Created ${project.name} for ${chosen}. Click a key to design it.`);
}

async function openProject() {
  const name = $("projects").value;
  $("projects").value = "";
  if (!name || !(await guard(`Opening ${name}`))) return;
  try {
    const project = await getJson(projectUrl(name));
    showProject(project);
    if (state.models[project.model]) setStatus(`Opened ${name}.`);
    else setStatus(`Opened ${name}. Its model file (${project.model}) is missing, so it can't be deployed.`, true);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function saveRequest() {
  const buttons = [];
  for (const [key, recipe] of state.edits) {
    const [pageId, button] = key.split("-");
    const page = pageNumber(state.layout, pageId);
    if (!page) continue;                                // Its page was deleted.
    const { off, on } = await renderRecipe(recipe, state.catalog, imageSize());
    buttons.push({ page, button: Number(button), name: recipe.name || "",
                   off: toBase64(off), on: toBase64(on) });
  }
  const request = { buttons, recipes: recipesRequest(state.layout, new Map([...state.recipes, ...state.edits])) };
  if (state.layoutChanges) request.layout = layoutRequest(state.layout);
  return request;
}

function invalidName() {
  for (const [key, recipe] of state.edits) {
    if (buttonNameError(recipe.name)) {
      const [pageId, button] = key.split("-");
      if (pageNumber(state.layout, pageId)) return { pageId, button: Number(button) };
    }
  }
  return null;
}

// Save the unsaved changes to a project (the open one by default).
// Returns false if saving failed. The page is locked while it saves, because
// the saved project replaces the page's state when the save returns.
async function saveProject(name = state.project.name) {
  const bad = invalidName();
  if (bad) {
    setStatus(`Fix the button name on ${pageName(state.layout, bad.pageId)} key ${bad.button} first. ` +
              "Use letters, digits, spaces, dashes or underscores.", true);
    return false;
  }
  const wasBusy = state.busy;
  setBusy(state.busy || "save");
  document.querySelector(".main").inert = true;
  setStatus(`Saving ${name}…`);
  // Page ids change when the saved project comes back, so keep numbers.
  const page = pageNumber(state.layout, state.pageId);
  const sel = state.selected && { page: pageNumber(state.layout, state.selected.pageId), button: state.selected.button };
  try {
    showProject(await sendJson("PUT", projectUrl(name), await saveRequest()));
    state.pageId = state.layout.pages[page - 1]?.id || state.layout.pages[0].id;
    renderTabs();
    renderKeypad();
    const selPage = sel && state.layout.pages[sel.page - 1];
    if (selPage) selectButton(selPage.id, sel.button);
    setStatus(`Saved ${name}.`);
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    document.querySelector(".main").inert = false;
    setBusy(wasBusy);
  }
}

async function onSave() {
  if (pendingChanges()) await saveProject();
}

async function saveAs() {
  const to = await nameModal({
    title: "Save as",
    body: "Save a copy of this project under a new name.",
    label: "Project name",
    value: freeName(`${state.project.name} copy`),
    hint: () => NAME_RULE,
    confirm: "Save",
    validate: projectNameError,
    submit: async (name) => {
      await sendJson("POST", `${projectUrl(state.project.name)}/copy`, { to: name });
      return name;
    },
  });
  if (!to) return;
  if (pendingChanges()) {
    await saveProject(to);
  } else {
    showProject(await getJson(projectUrl(to)));
    setStatus(`Saved as ${to}.`);
  }
}

// -- Keypad address and Find ------------------------------------------------------------

function useKeypad(keypad, message) {
  $("host").value = keypad.ip;
  $("host").title = "";
  remember("designer.host", keypad.ip);
  state.keypadModel = keypad.model;
  state.connected = true;
  $("find-popover").hidden = true;
  updateHeader();
  setStatus(message);
}

function renderFindPopover() {
  const pop = $("find-popover");
  pop.innerHTML = `<div class="popover-head label">${state.keypads.length} keypads found</div>`;
  for (const keypad of state.keypads) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "found" + (keypad.ip === host() ? " current" : "");
    row.innerHTML = `<span class="found-text"><span class="found-name"></span><span class="found-meta"></span></span><span class="found-ip"></span>`;
    row.querySelector(".found-name").textContent = keypad.name;    // Names come from the network.
    row.querySelector(".found-meta").textContent = `${keypad.model} · firmware ${keypad.version}`;
    row.querySelector(".found-ip").textContent = keypad.ip;
    row.addEventListener("click", () => useKeypad(keypad, `Selected ${keypad.name} (${keypad.model}) at ${keypad.ip}.`));
    pop.append(row);
  }
}

async function findKeypads() {
  setBusy("find");
  $("find-popover").hidden = true;
  setStatus("Looking for keypads…");
  try {
    state.keypads = await getJson("/api/keypads");
  } catch (error) {
    setBusy(null);
    return setStatus(error.message, true);
  }
  setBusy(null);
  if (!state.keypads.length) {
    state.connected = false;
    updateHeader();
    return setStatus("Find returned no keypads. Check the keypad is powered and on this network.", true);
  }
  if (state.keypads.length === 1) {
    const [keypad] = state.keypads;
    return useKeypad(keypad, `Found ${keypad.name} (${keypad.model}) at ${keypad.ip}.`);
  }
  renderFindPopover();
  $("find-popover").hidden = false;
  updateHeader();
  setStatus(`Found ${state.keypads.length} keypads. Pick one.`);
}

function onHostInput() {
  remember("designer.host", host());
  $("host").title = "";
  state.connected = false;
  state.keypadModel = state.keypads.find((k) => k.ip === host())?.model || "";
  updateHeader();
  renderHControl();
}

function needHost() {
  if (host()) return false;
  setStatus("Enter the keypad's IP address first, or click Find.", true);
  $("host").focus();
  return true;
}

async function loadFromKeypad() {
  if (needHost() || !(await guard("Loading from the keypad"))) return;
  const address = host();
  setBusy("load");
  setStatus(`Loading the design from ${address}…`);
  try {
    const project = await sendJson("POST", "/api/projects/from-keypad", { host: address });
    state.connected = true;
    state.keypadModel = project.model;
    showProject(project);
    setStatus(`Loaded ${address} into new project "${project.name}". A copy is saved in Backups.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(null);
  }
}

// -- Modals -----------------------------------------------------------------------------

let modalClosable = true;
let modalCancel = null;
let clock = null;

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Show a modal. view: { title, body, content: [nodes], secondary, primary,
// closable }. secondary and primary are { text, onClick }.
function showModal(view) {
  clearInterval(clock);
  $("modal-title").innerHTML = `${escapeHtml(view.title)}<span class="dot">.</span>`;
  $("modal-body").textContent = view.body || "";
  $("modal-content").replaceChildren(...(view.content || []));
  const actions = [];
  if (view.secondary) {
    const button = el("button", "secondary", view.secondary.text);
    button.type = "button";
    button.addEventListener("click", view.secondary.onClick);
    actions.push(button);
  }
  if (view.primary) {
    const button = el("button", "primary", view.primary.text);
    button.type = "button";
    button.append(el("span", "", ">"));
    button.addEventListener("click", view.primary.onClick);
    actions.push(button);
  }
  $("modal-actions").replaceChildren(...actions);
  modalClosable = view.closable !== false;
  modalCancel = view.secondary?.onClick || null;
  $("modal").hidden = false;
  const focus = $("modal-content").querySelector("input") || actions.at(-1);
  focus?.focus();
}

function closeModal() {
  clearInterval(clock);
  $("modal").hidden = true;
  modalCancel = null;
}

function rows(entries) {
  return entries.map(([k, v]) => {
    const row = el("div", "summary-row");
    row.append(el("span", "", k), el("span", "", v));
    return row;
  });
}

function result(ok, text) {
  const box = el("div", ok ? "result ok" : "result");
  box.append(el("span", ok ? "chip-done" : "chip-error", ok ? "Done" : "Error"), el("span", "", text));
  return box;
}

function running(text) {
  const bar = el("div", "indeterminate");
  const line = el("div", "run-line");
  const elapsed = el("span", "elapsed", "0:00 elapsed");
  line.append(el("span", "", text), elapsed);
  const start = Date.now();
  setTimeout(() => {
    clock = setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} elapsed`;
    }, 1000);
  });
  return [bar, line];
}

function confirmModal({ title, body, list = [], note = "", confirm }) {
  return new Promise((resolve) => {
    const content = [];
    if (list.length) {
      const box = el("div", "code-list");
      for (const line of list) box.append(el("div", "", line));
      content.push(box);
    }
    if (note) content.push(el("div", "boxed-note", note));
    const done = (value) => { closeModal(); resolve(value); };
    showModal({ title, body, content,
      secondary: { text: "Cancel", onClick: () => done(false) },
      primary: { text: confirm, onClick: () => done(true) } });
  });
}

// Ask for a name, then call submit(name). Resolves with submit's result, or
// null if cancelled. Errors from validate or submit show under the field.
function nameModal({ title, body, label, value, hint, extra, confirm, validate = () => "", submit }) {
  return new Promise((resolve) => {
    const wrap = el("label", "stack");
    const input = el("input", "field");
    input.value = value;
    input.spellcheck = false;
    input.maxLength = 64;
    const help = el("span", "help", hint(value));
    wrap.append(el("span", "label", label), input, help);
    const showError = (message) => {
      input.classList.toggle("invalid", Boolean(message));
      help.classList.toggle("error", Boolean(message));
      help.textContent = message || hint(input.value);
    };
    input.addEventListener("input", () => showError(""));
    const go = async () => {
      const name = input.value.trim();
      const error = validate(name) || (name ? "" : "Enter a name.");
      if (error) return showError(error);
      try {
        const value = await submit(name);
        closeModal();
        resolve(value);
      } catch (err) {
        showError(err.message);
      }
    };
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") go(); });
    showModal({ title, body, content: extra ? [wrap, extra] : [wrap],
      secondary: { text: "Cancel", onClick: () => { closeModal(); resolve(null); } },
      primary: { text: confirm, onClick: go } });
  });
}

// -- Deploy -----------------------------------------------------------------------------

function openDeploy() {
  if (!state.project || state.busy) return;
  if (!model()) return setStatus(`Can't deploy: the model file for ${state.project.model} is missing.`, true);
  if (needHost()) return;
  const address = host();
  const keypad = state.keypadModel ? `${address} · ${state.keypadModel}` : address;
  const pages = state.layout.pages.length;
  const content = rows([["Keypad", keypad], ["Project", `${state.project.name} · ${state.project.model}`],
                        ["Pages", `${pages} ${pages === 1 ? "page" : "pages"}`]]);
  if (pendingChanges()) content.push(el("div", "boxed-note", "This project has unsaved changes. They are saved before the upload."));
  showModal({
    title: "Deploy to keypad",
    body: "Replaces the design on the keypad. If the keypad already has a design, it's backed up to this computer first.",
    content,
    secondary: { text: "Cancel", onClick: closeModal },
    primary: { text: "Deploy", onClick: () => runDeploy(address, false) },
  });
}

async function runDeploy(address, force) {
  setBusy("deploy");
  try {
    if (pendingChanges()) {
      showModal({ title: "Deploy to keypad", body: "Saving the project first.", content: running("Saving the project…"), closable: false });
      if (!(await saveProject())) {
        return showModal({ title: "Deploy failed", content: [result(false, `The project couldn't be saved, so nothing was uploaded. ${$("status").textContent}`)],
                           secondary: { text: "Close", onClick: closeModal } });
      }
    }
    showModal({
      title: "Deploying",
      body: `Uploading to ${address}. This usually takes 15 to 40 seconds. The keypad restarts at the end, which takes about 20 seconds.`,
      content: running("Checking the keypad's design first. A keypad with no design can take up to 15 seconds."),
      closable: false,
    });
    const name = state.project.name;
    const res = await sendJson("POST", `${projectUrl(name)}/deploy`, { host: address, force });
    remember("designer.host", address);
    state.connected = true;
    state.keypadModel = state.project.model;
    state.project.baseFingerprint = res.fingerprint;
    state.project.lastDeployed = res.deployed;
    renderLastDeployed();
    const ok = res.backup ? `Deployed to ${address}. The previous design was backed up to ${res.backup}.`
      : `Deployed to ${address}. The keypad had no design, so there was nothing to back up.`;
    showModal({ title: "Deployed", content: [result(true, ok)], secondary: { text: "Close", onClick: closeModal } });
    setStatus(res.backup ? `Deployed to ${address}. Backed up to ${res.backup}.` : `Deployed to ${address}. Nothing to back up.`);
  } catch (error) {
    if (error.body?.conflict) {
      return showModal({
        title: "Replace the keypad's design",
        body: "The keypad has a different design from the one this project last loaded or deployed. Replace it? It's backed up first.",
        secondary: { text: "Cancel", onClick: () => { closeModal(); setStatus("Deploy cancelled.", true); } },
        primary: { text: "Replace", onClick: () => runDeploy(address, true) },
      });
    }
    if (error.body?.model) {
      showModal({ title: "Deploy refused", content: [result(false, `${error.message} Nothing was uploaded.`)],
                  secondary: { text: "Close", onClick: closeModal } });
      return setStatus(`Deploy refused: the keypad isn't ${state.project.model}.`, true);
    }
    if (error.body?.backup) {
      const backup = error.body.backup;
      showModal({ title: "Deploy failed",
        content: [result(false, `${error.message}. The previous design was backed up to ${backup} first, and that backup is selected.`)],
        secondary: { text: "Close", onClick: closeModal },
        primary: { text: "Restore backup", onClick: () => openBackups(backup) } });
      return setStatus(`Deploy failed after backup. ${backup} is selected for restore.`, true);
    }
    showModal({ title: "Deploy failed", content: [result(false, error.message)], secondary: { text: "Close", onClick: closeModal } });
    setStatus(error.message, true);
  } finally {
    setBusy(null);
  }
}

// -- Backups ----------------------------------------------------------------------------

const KIND_TAGS = { deploy: "Before deploy", loaded: "Loaded", manual: "Manual" };

function formatSize(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

async function openBackups(select = "") {
  let backups;
  try {
    backups = await getJson("/api/backups");
  } catch (error) {
    return setStatus(error.message, true);
  }
  let selected = select || backups[0]?.name || "";
  let backingUp = false;
  const content = [];
  const list = el("div", "backup-list");
  const addLink = el("button", "link-red", "+ Back up keypad now");
  addLink.type = "button";
  addLink.style.alignSelf = "flex-start";
  const error = el("div");
  const render = () => {
    list.replaceChildren(...backups.map((b) => {
      const row = el("button", "backup-row" + (b.name === selected ? " current" : ""));
      row.type = "button";
      const text = el("span", "option-text");
      const date = el("span", "backup-date", formatDate(b.saved));
      date.append(el("span", `tag ${b.kind}`, KIND_TAGS[b.kind].toUpperCase()));
      text.append(date, el("span", "backup-file", `${b.name} · ${b.model || "unknown model"}`));
      row.append(el("span", "radio"), text, el("span", "backup-size", formatSize(b.size)));
      row.addEventListener("click", () => { selected = b.name; render(); });
      return row;
    }));
    if (!backups.length) list.replaceChildren(el("div", "pad note", "There are no backups yet."));
    addLink.textContent = backingUp ? "Backing up…" : "+ Back up keypad now";
    addLink.disabled = backingUp;
  };
  addLink.addEventListener("click", async () => {
    if (needHost()) return;
    backingUp = true;
    error.replaceChildren();
    render();
    try {
      const made = await sendJson("POST", "/api/backups", { host: host() });
      backups = await getJson("/api/backups");
      selected = made.name;
      state.connected = true;
      updateHeader();
      setStatus(`Backed up ${host()} to ${made.name}.`);
    } catch (err) {
      error.replaceChildren(result(false, err.message));
      setStatus(err.message, true);
    } finally {
      backingUp = false;
      render();
    }
  });
  render();
  content.push(list, addLink, error);
  const view = {
    title: "Backups",
    body: "Stored on this computer in designer/backups/. Deploy saves backup_ files. Load from keypad saves loaded_ files. Back up keypad now saves manual_ files.",
    content,
    secondary: { text: "Close", onClick: closeModal },
    primary: { text: "Restore", onClick: () => { if (selected && !needHost()) runRestore(selected, view); } },
  };
  showModal(view);
}

async function runRestore(backup, listView) {
  const address = host();
  setBusy("restore");
  showModal({ title: "Restoring", body: `Restoring ${backup} to ${address}. The keypad restarts when it's done, which takes about 20 seconds.`,
              content: running("Waiting for the keypad."), closable: false });
  try {
    await sendJson("POST", "/api/design/restore", { host: address, backup });
    state.connected = true;
    showModal({ title: "Restored", content: [result(true, `Restored ${backup} to ${address}. The keypad has restarted. To edit it, click Load.`)],
                secondary: { text: "Close", onClick: closeModal } });
    setStatus(`Restored ${backup}.`);
  } catch (error) {
    const refused = Boolean(error.body?.model);
    showModal({ title: refused ? "Restore refused" : "Restore failed",
                content: [result(false, refused ? `${error.message} Restore refused.` : error.message)],
                secondary: { text: "Back", onClick: () => showModal(listView) } });
    setStatus(refused ? "Restore refused: the backup's model differs from the keypad." : error.message, true);
  } finally {
    setBusy(null);
  }
}

// -- Start ------------------------------------------------------------------------------

// In the desktop app, the main process asks the page to show messages, such
// as licensing's (see electron/app-dialog.ts). One at a time, in order; each
// must be answered, so they can't be dismissed with Escape or the backdrop.
function wireAppDialogs() {
  const bridge = window.appDialog;
  if (!bridge) return;                        // In a browser, there's no main process.
  const queue = [];
  const seen = new Set();
  let showing = false;
  const next = () => {
    if (showing || !queue.length) return;
    const request = queue.shift();
    showing = true;
    const done = (confirmed) => {
      closeModal();
      bridge.answer(request.id, confirmed);
      showing = false;
      next();
    };
    showModal({
      title: request.title,
      body: request.message,
      closable: false,
      secondary: request.cancelLabel ? { text: request.cancelLabel, onClick: () => done(false) } : null,
      primary: { text: request.confirmLabel, onClick: () => done(true) },
    });
  };
  const add = (request) => {
    if (seen.has(request.id)) return;         // Both pushed and pending.
    seen.add(request.id);
    queue.push(request);
    next();
  };
  bridge.onShow(add);
  bridge.getPending().then((pending) => pending.forEach(add));
}

function wire() {
  wireAppDialogs();
  $("new").addEventListener("click", newProject);
  $("projects").addEventListener("change", openProject);
  $("save").addEventListener("click", onSave);
  $("save-as").addEventListener("click", () => state.project && saveAs());
  $("host").addEventListener("input", onHostInput);
  $("find").addEventListener("click", findKeypads);
  $("find-list").addEventListener("click", () => {
    renderFindPopover();
    $("find-popover").hidden = !$("find-popover").hidden;
  });
  $("load").addEventListener("click", loadFromKeypad);
  $("backups").addEventListener("click", () => openBackups());
  $("deploy").addEventListener("click", openDeploy);
  $("show-off").addEventListener("click", () => setShowOn(false));
  $("show-on").addEventListener("click", () => setShowOn(true));
  $("tab-button").addEventListener("click", () => setTab("button"));
  $("tab-library").addEventListener("click", () => setTab("library"));
  $("button-name").addEventListener("input", onNameInput);
  $("goto").addEventListener("change", onGoToChange);
  wireDrawer();
  $("save-recipe").addEventListener("click", saveRecipe);
  $("clear-layers").addEventListener("click", clearLayers);
  $("lib-query").addEventListener("input", () => { state.libQuery = $("lib-query").value; renderLibrary(); });
  // Clicking empty stage deselects the key.
  $("stage").addEventListener("click", (event) => {
    // A click can re-render what was clicked, so check where it started, not where it is now.
    if (!event.target.isConnected || !state.selected ||
        event.target.closest(".faceplate, .tabs-wrap, .stage-controls, .banner")) return;
    state.selected = null;
    renderKeypad();
    renderSelection();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".device-area")) $("find-popover").hidden = true;
  });
  $("modal").addEventListener("click", (event) => {
    if (event.target === $("modal") && modalClosable) (modalCancel || closeModal)();
  });
  document.addEventListener("keydown", onUndoKey);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("modal").hidden && modalClosable) (modalCancel || closeModal)();
  });
  window.addEventListener("beforeunload", (event) => {
    if (pendingChanges()) { event.preventDefault(); event.returnValue = ""; }
  });
}

async function start() {
  try {
    const [catalog, iconTags, models] = await Promise.all([
      getJson("/api/assets"), getJson("/vendor/lucide/tags.json"), getJson("/api/models"), loadIcons()]);
    state.catalog = catalog;
    state.models = Object.fromEntries(models.map((m) => [m.id, m]));
    editor = createEditor({
      root: $("editor"), catalog, iconTags, onChange: onEdit,
      onPreview: setShowOn, onChooseLibrary: () => setTab("library"), onStatus: setStatus,
    });
    await refreshLibrary();
  } catch (error) {
    return setStatus(`The designer couldn't start: ${error.message}`, true);
  }
  const remembered = recall("designer.host");
  $("host").value = remembered;
  if (remembered) $("host").title = "Remembered from your last session";
  wire();
  updateHeader();
  renderLastDeployed();
  // Open the newest project, or create one the first time. A project that
  // can't be opened mustn't stop you from opening or creating another.
  await refreshProjects();
  const newest = state.projects[0]?.name;
  try {
    showProject(newest ? await getJson(projectUrl(newest))
                       : await sendJson("POST", "/api/projects", { name: "Untitled", model: DEFAULT_MODEL, unique: true }));
    setStatus(newest ? `Opened ${newest}.` : "Created Untitled. Click a key to design it.");
  } catch (error) {
    setStatus(`Couldn't open ${newest || "a new project"}: ${error.message}. ` +
              "Choose another project in Open, or click New.", true);
  }
}

start();
