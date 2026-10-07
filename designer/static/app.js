// Wires the page together: the project bar, the keypad view, the editor,
// the library, and the deploy flow.

import { getJson, sendJson, assetUrl } from "./api.js";
import { gridFor, buttonKey, recipeFromImages } from "./model.js";
import { renderRecipe, toBase64, loadIcons } from "./render.js";
import { createEditor } from "./editor.js";
import {
  layoutFromConfig, addPage, renamePage, deletePage, setDestination, destinationOf,
  destinationsTo, pageNumber, pageName, layoutRequest, recipesFromSaved, recipesRequest,
} from "./pages.js";

const $ = (id) => document.getElementById(id);
const projectUrl = (name) => `/api/projects/${encodeURIComponent(name)}`;
const DEFAULT_MODEL = "OMNI-KP-8BV";

const state = {
  catalog: null,
  models: {},            // id -> { id, name, columns, rows, dial, faceplate, tested }
  project: null,         // { name, config, images: {name: base64}, recipes, baseFingerprint }
  projects: [],          // [{ name, saved }], newest first
  layout: null,          // Pages and page switching; see pages.js.
  layoutChanges: 0,      // Page and page-switching changes not saved yet.
  pageId: "",            // The page shown in the keypad view.
  selected: null,        // { pageId, button }
  recipes: new Map(),    // buttonKey(pageId, button) -> saved layers
  edits: new Map(),      // buttonKey(pageId, button) -> unsaved layers
  previews: new Map(),   // buttonKey(pageId, button) -> { off: dataURL, on: dataURL }
  busy: false,
};

let editor;

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
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

// -- Keypad view ----------------------------------------------------------------------

// The saved page a page comes from; new pages use page 1's structure.
function sourcePage(pageId) {
  const source = state.layout.pages.find((p) => p.id === pageId)?.source;
  return state.project.config.pages[(source || 1) - 1];
}

function designImage(pageId, button, key) {
  const source = state.layout.pages.find((p) => p.id === pageId)?.source;
  if (!source) return "";                                // New pages start empty.
  const names = state.project.config.pages[source - 1].buttons[button - 1]?.[key] || [];
  const data = names[0] && state.project.images[names[0]];
  return data ? `data:image/png;base64,${data}` : "";
}

function renderTabs() {
  const tabs = $("page-tabs");
  tabs.innerHTML = "";
  state.layout.pages.forEach((page) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = page.name;
    if (page.id === state.pageId) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => { state.pageId = page.id; renderTabs(); renderKeypad(); });
    tabs.append(button);
  });
  for (const id of ["page-add", "page-rename", "page-delete"]) $(id).disabled = state.busy;
}

function renderKeypad() {
  const keypad = $("keypad");
  keypad.innerHTML = "";
  if (!state.project) return;
  const page = sourcePage(state.pageId);
  const model = state.models[state.project.model];
  const grid = gridFor(model, page.buttons.length);
  $("faceplate").className = `faceplate faceplate--${model?.faceplate || "square"}`;
  $("dial").hidden = !(model ? model.dial : "dial" in page);
  keypad.style.gridTemplateColumns = `repeat(${grid.columns}, var(--cell))`;
  keypad.style.background = state.project.config.display?.panel_separator_color || "#000";
  const showOn = $("show-on").checked;
  const count = Math.min(page.buttons.length, grid.columns * grid.rows);
  for (let button = 1; button <= count; button++) {
    const key = buttonKey(state.pageId, button);
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "cell";
    cell.style.background = page.background || "#000";
    cell.setAttribute("aria-label", `${pageName(state.layout, state.pageId)} button ${button}`);
    cell.classList.toggle("changed", state.edits.has(key));
    cell.classList.toggle("selected", state.selected?.pageId === state.pageId && state.selected?.button === button);
    const preview = state.previews.get(key);
    const src = preview ? preview[showOn ? "on" : "off"]
                        : designImage(state.pageId, button, showOn ? "onImage" : "offImage");
    if (src) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = src;
      cell.append(img);
    }
    const target = destinationOf(state.layout, state.pageId, button);
    if (target) {
      const badge = document.createElement("span");
      badge.className = "goto-badge";
      badge.textContent = `→ ${pageName(state.layout, target)}`;
      cell.append(badge);
    }
    cell.addEventListener("click", () => selectButton(state.pageId, button));
    keypad.append(cell);
  }
  renderGoTo();
}

// -- Pages and page switching ---------------------------------------------------------

function renderGoTo() {
  const select = $("goto");
  const sel = state.selected;
  select.disabled = !sel || state.busy;
  const options = [["", "None"]];
  if (sel) {
    for (const page of state.layout.pages) {
      if (page.id !== sel.pageId) options.push([page.id, page.name]);
    }
  }
  select.replaceChildren(...options.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = (sel && destinationOf(state.layout, sel.pageId, sel.button)) || "";
}

function changeLayout(next) {
  state.layout = next;
  state.layoutChanges++;
  renderTabs();
  renderKeypad();
  updateButtons();
}

function onAddPage() {
  try {
    const next = addPage(state.layout);
    state.pageId = next.pages.at(-1).id;
    changeLayout(next);
    setStatus(`Added ${pageName(next, state.pageId)}. It has page 1's dial settings and no button images.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function onRenamePage() {
  const name = prompt("Page name:", pageName(state.layout, state.pageId));
  if (name === null) return;
  try {
    changeLayout(renamePage(state.layout, state.pageId, name));
  } catch (error) {
    setStatus(error.message, true);
  }
}

function onDeletePage() {
  const id = state.pageId;
  const name = pageName(state.layout, id);
  const links = destinationsTo(state.layout, id);
  const message = [`Delete ${name}?`,
    links ? `${links} button(s) that go to it will stop switching pages.` : "",
    "Pages after it move up one number, so apps that use /pageN paths need updating."]
    .filter(Boolean).join(" ");
  if (state.layout.pages.length > 1 && !confirm(message)) return;
  try {
    const next = deletePage(state.layout, id);
    for (const key of [...state.edits.keys()]) {
      if (key.startsWith(`${id}-`)) { state.edits.delete(key); state.previews.delete(key); }
    }
    if (state.selected?.pageId === id) {
      state.selected = null;
      editor.setRecipe(null);
      $("save-recipe").disabled = true;
    }
    state.pageId = next.pages[Math.max(0, pageNumber(state.layout, id) - 2)].id;
    changeLayout(next);
    setStatus(`Deleted ${name}. Click Save to keep the change.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

function onGoToChange() {
  const sel = state.selected;
  if (!sel) return;
  changeLayout(setDestination(state.layout, sel.pageId, sel.button, $("goto").value || null));
}

function selectButton(pageId, button) {
  state.selected = { pageId, button };
  const key = buttonKey(pageId, button);
  editor.setRecipe(state.edits.get(key) ?? structuredClone(state.recipes.get(key)) ??
    recipeFromImages(designImage(pageId, button, "offImage"), designImage(pageId, button, "onImage")));
  $("save-recipe").disabled = false;
  renderKeypad();
}

async function onEdit(recipe) {
  if (!state.selected) return;
  const key = buttonKey(state.selected.pageId, state.selected.button);
  state.edits.set(key, recipe);
  updateButtons();
  const { off, on } = await renderRecipe(recipe, state.catalog);
  if (state.edits.get(key) !== recipe) return;            // A newer edit arrived.
  state.previews.set(key, { off: off.toDataURL("image/png"), on: on.toDataURL("image/png") });
  renderKeypad();
}

function pendingChanges() {
  return state.edits.size + state.layoutChanges;
}

function updateButtons() {
  const open = Boolean(state.project);
  const unsaved = pendingChanges() > 0;
  $("unsaved").hidden = !unsaved;
  $("save").disabled = !open || !unsaved || state.busy;
  $("save-as").disabled = !open || state.busy;
  $("deploy").disabled = !open || state.busy;
  for (const id of ["new", "projects", "load", "restore"]) $(id).disabled = state.busy;
}

// -- Projects --------------------------------------------------------------------------

function showProject(project) {
  state.project = project;
  state.layout = layoutFromConfig(project.config);
  state.layoutChanges = 0;
  state.pageId = state.layout.pages[0].id;
  state.selected = null;
  state.recipes = new Map(Object.entries(recipesFromSaved(project.recipes)));
  state.edits.clear();
  state.previews.clear();
  editor.setRecipe(null);
  $("save-recipe").disabled = true;
  const model = state.models[project.model];
  $("project-name").textContent = `${project.name} · ${model ? model.name : project.model}`;
  renderTabs();
  renderKeypad();
  updateButtons();
  refreshProjects();
  if (!model) setStatus(`${project.name} is for ${project.model}, which the designer doesn't know. ` +
                        "You can edit it, but not deploy it.", true);
}

async function refreshProjects() {
  try {
    state.projects = await getJson("/api/projects");
  } catch {
    state.projects = [];
  }
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Open…";
  $("projects").replaceChildren(placeholder, ...state.projects.map((p) => {
    const option = document.createElement("option");
    option.value = option.textContent = p.name;
    return option;
  }));
}

function confirmDiscard() {
  return !pendingChanges() || confirm("You have unsaved changes. Discard them?");
}

function freeName(base) {
  const taken = new Set(state.projects.map((p) => p.name.toLowerCase()));
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

async function newProject() {
  if (!confirmDiscard()) return;
  const dialog = $("new-dialog");
  $("new-name").value = freeName("Untitled");
  $("new-model").replaceChildren(...Object.values(state.models).map((m) => {
    const option = document.createElement("option");
    option.value = m.id;
    option.textContent = m.tested ? m.name : `${m.name} (untested)`;
    return option;
  }));
  const last = recall("designer.model");
  $("new-model").value = state.models[last] ? last : DEFAULT_MODEL;
  dialog.returnValue = "";
  dialog.showModal();
  await new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
  if (dialog.returnValue !== "create") return;
  const name = $("new-name").value.trim();
  const model = $("new-model").value;
  try {
    showProject(await sendJson("POST", "/api/projects", { name, model }));
    remember("designer.model", model);
    setStatus(`Created ${name} for the ${state.models[model].name}. Click a button to design it.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function openProject() {
  const name = $("projects").value;
  $("projects").value = "";
  if (!name || !confirmDiscard()) return;
  try {
    showProject(await getJson(projectUrl(name)));
    setStatus(`Opened ${name}.`);
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
    const { off, on } = await renderRecipe(recipe, state.catalog);
    buttons.push({ page, button: Number(button), name: recipe.name || "",
                   off: toBase64(off), on: toBase64(on) });
  }
  const request = { buttons, recipes: recipesRequest(state.layout, new Map([...state.recipes, ...state.edits])) };
  if (state.layoutChanges) request.layout = layoutRequest(state.layout);
  return request;
}

// Save the unsaved changes to a project (the open one by default).
// Returns false if saving failed. The page is locked while it saves, because
// the saved project replaces the page's state when the save returns.
async function saveProject(name = state.project.name) {
  const wasBusy = state.busy;
  state.busy = true;
  document.querySelector("main").inert = true;
  updateButtons();
  setStatus(`Saving ${name}…`);
  try {
    showProject(await sendJson("PUT", projectUrl(name), await saveRequest()));
    setStatus(`Saved ${name}.`);
    return true;
  } catch (error) {
    setStatus(error.message, true);
    return false;
  } finally {
    document.querySelector("main").inert = false;
    state.busy = wasBusy;
    updateButtons();
  }
}

async function saveAs() {
  const input = prompt("Save as (letters, digits, spaces, dashes, underscores):", freeName(state.project.name));
  if (input === null) return;
  const to = input.trim();
  try {
    await sendJson("POST", `${projectUrl(state.project.name)}/copy`, { to });
  } catch (error) {
    return setStatus(error.message, true);
  }
  if (pendingChanges()) {
    await saveProject(to);
  } else {
    showProject(await getJson(projectUrl(to)));
    setStatus(`Saved as ${to}.`);
  }
}

async function loadFromKeypad() {
  const host = $("host").value.trim();
  if (!host) return setStatus("Enter the keypad's IP address first.", true);
  if (!confirmDiscard()) return;
  setStatus(`Loading the design from ${host}…`);
  try {
    const project = await sendJson("POST", "/api/projects/from-keypad", { host });
    remember("designer.host", host);
    showProject(project);
    refreshBackups();
    setStatus(`Loaded the design from ${host} as the project ${project.name}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// -- Deploy and restore ------------------------------------------------------------------

async function refreshBackups(select = "") {
  let names = [];
  try {
    names = await getJson("/api/backups");
  } catch { /* Leave the picker empty; the status line shows other errors. */ }
  const list = $("backups");
  list.replaceChildren(...names.map((name) => {
    const option = document.createElement("option");
    option.value = option.textContent = name;
    return option;
  }));
  if (select) list.value = select;
  list.hidden = $("restore").hidden = !names.length;
}

async function deploy(force = false) {
  const host = $("host").value.trim();
  if (!host) return setStatus("Enter the keypad's IP address first.", true);
  state.busy = true;
  updateButtons();
  try {
    if (pendingChanges() && !(await saveProject())) return;
    setStatus(`Deploying ${state.project.name} to ${host}. A keypad with no design takes about ` +
              "15 seconds to check, and the keypad then restarts, which takes about 20 seconds…");
    const result = await sendJson("POST", `${projectUrl(state.project.name)}/deploy`, { host, force });
    remember("designer.host", host);
    state.project.baseFingerprint = result.fingerprint;
    await refreshBackups(result.backup);
    setStatus(result.backup ? `Deployed. The keypad's previous design is saved as ${result.backup}.`
                            : "Deployed. The keypad had no design, so there was nothing to back up.");
  } catch (error) {
    if (error.body?.conflict) {
      state.busy = false;
      updateButtons();
      if (confirm(`The keypad at ${host} has a different design. Replace it? It's backed up first.`)) {
        return await deploy(true);     // Await, so this call's finally runs after the retry.
      }
      return setStatus("Deploy cancelled.", true);
    }
    if (error.body?.backup) {
      await refreshBackups(error.body.backup);
      return setStatus(`${error.message}. To put back the previous design, click Restore backup.`, true);
    }
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    updateButtons();
  }
}

async function restore() {
  const backup = $("backups").value;
  const host = $("host").value.trim();
  if (!backup) return;
  if (!host) return setStatus("Enter the keypad's IP address first.", true);
  if (!confirm(`Restore ${backup} to the keypad at ${host}?`)) return;
  state.busy = true;
  updateButtons();
  setStatus(`Restoring ${backup}. The keypad restarts…`);
  try {
    await sendJson("POST", "/api/design/restore", { host, backup });
    setStatus(`Restored ${backup} to ${host}. To edit it, click Load from keypad.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
    updateButtons();
  }
}

async function findKeypads() {
  setStatus("Looking for keypads…");
  try {
    const found = await getJson("/api/keypads");
    $("keypads").replaceChildren(...found.map((d) => {
      const option = document.createElement("option");    // Names come from the network.
      option.value = d.ip;
      option.textContent = `${d.name} (${d.model} ${d.version})`;
      return option;
    }));
    if (found.length === 1) $("host").value = found[0].ip;
    setStatus(found.length ? `Found ${found.length} keypad(s). Pick one, then click Load from keypad or Deploy.`
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
    const [catalog, iconTags, models] = await Promise.all([
      getJson("/api/assets"), getJson("/vendor/lucide/tags.json"), getJson("/api/models"), loadIcons()]);
    state.catalog = catalog;
    state.models = Object.fromEntries(models.map((m) => [m.id, m]));
    editor = createEditor({ root: $("editor"), catalog, iconTags, onChange: onEdit });
    editor.setRecipe(null);
    renderReadyMade();
    await renderLibrary();
  } catch (error) {
    return setStatus(`The designer couldn't start: ${error.message}`, true);
  }
  $("host").value = recall("designer.host");
  refreshBackups();
  $("new").addEventListener("click", newProject);
  $("new-cancel").addEventListener("click", () => $("new-dialog").close("cancel"));
  $("projects").addEventListener("change", openProject);
  $("save").addEventListener("click", () => saveProject());
  $("save-as").addEventListener("click", saveAs);
  $("find").addEventListener("click", findKeypads);
  $("load").addEventListener("click", loadFromKeypad);
  $("deploy").addEventListener("click", () => deploy());
  $("restore").addEventListener("click", restore);
  $("show-on").addEventListener("change", renderKeypad);
  $("page-add").addEventListener("click", onAddPage);
  $("page-rename").addEventListener("click", onRenamePage);
  $("page-delete").addEventListener("click", onDeletePage);
  $("goto").addEventListener("change", onGoToChange);
  $("save-recipe").addEventListener("click", saveRecipe);
  window.addEventListener("beforeunload", (event) => {
    if (pendingChanges()) { event.preventDefault(); event.returnValue = ""; }
  });
  updateButtons();
  // Open the newest project, or create one the first time. A project that
  // can't be opened mustn't stop you from opening or creating another.
  await refreshProjects();
  const newest = state.projects[0]?.name;
  try {
    showProject(newest ? await getJson(projectUrl(newest))
                       : await sendJson("POST", "/api/projects", { name: "Untitled", model: DEFAULT_MODEL, unique: true }));
  } catch (error) {
    setStatus(`Couldn't open ${newest || "a new project"}: ${error.message}. ` +
              "Choose another project in Open…, or click New.", true);
  }
}

start();
