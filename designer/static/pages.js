// The design's pages and where each button switches to: plain data, no DOM.
// Pages have stable ids ("L2" for loaded page 2, "N1" for the first new
// page), so edits and destinations survive pages being added or deleted.
// A layout is { pages: [{ id, name, source }], destinations: { "<id>-<button>": id }, next }.

export const MAX_PAGES = 9;

const key = (pageId, button) => `${pageId}-${button}`;

export function layoutFromConfig(config) {
  const pages = config.pages.map((page, i) => ({ id: `L${i + 1}`, name: page.name, source: i + 1 }));
  const byName = new Map(pages.map((p) => [p.name, p.id]));
  const destinations = {};
  config.pages.forEach((page, i) => {
    (page.buttons || []).forEach((button, j) => {
      const target = byName.get(button.destination);
      if (target) destinations[key(`L${i + 1}`, j + 1)] = target;
    });
  });
  return { pages, destinations, next: 1 };
}

export function pageNumber(layout, id) {
  return layout.pages.findIndex((p) => p.id === id) + 1;
}

export function pageName(layout, id) {
  return layout.pages.find((p) => p.id === id)?.name ?? "";
}

export function addPage(layout) {
  if (layout.pages.length >= MAX_PAGES) {
    throw new Error(`A design can have at most ${MAX_PAGES} pages.`);
  }
  const taken = new Set(layout.pages.map((p) => p.name.toLowerCase()));
  let n = layout.pages.length + 1;
  while (taken.has(`page ${n}`)) n++;
  const page = { id: `N${layout.next}`, name: `Page ${n}`, source: null };
  return { ...layout, pages: [...layout.pages, page], next: layout.next + 1 };
}

export function renamePage(layout, id, name) {
  const clean = name.trim();
  if (!clean) throw new Error("Enter a name for the page.");
  if (layout.pages.some((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`There's already a page called ${clean}.`);
  }
  return { ...layout, pages: layout.pages.map((p) => (p.id === id ? { ...p, name: clean } : p)) };
}

export function deletePage(layout, id) {
  if (layout.pages.length <= 1) throw new Error("You can't delete the last page.");
  const destinations = Object.fromEntries(Object.entries(layout.destinations)
    .filter(([from, to]) => to !== id && !from.startsWith(`${id}-`)));
  return { ...layout, pages: layout.pages.filter((p) => p.id !== id), destinations };
}

export function destinationsTo(layout, id) {
  return Object.values(layout.destinations).filter((to) => to === id).length;
}

export function destinationOf(layout, pageId, button) {
  return layout.destinations[key(pageId, button)] ?? null;
}

export function setDestination(layout, pageId, button, targetId) {
  const destinations = { ...layout.destinations };
  if (targetId) destinations[key(pageId, button)] = targetId;
  else delete destinations[key(pageId, button)];
  return { ...layout, destinations };
}

// The deploy request's "layout": current page numbers and names.
export function layoutRequest(layout) {
  return {
    pages: layout.pages.map((p) => ({ name: p.name, source: p.source })),
    destinations: Object.entries(layout.destinations).map(([from, to]) => {
      const [pageId, button] = from.split("-");
      return { page: pageNumber(layout, pageId), button: Number(button), destination: pageName(layout, to) };
    }),
  };
}

// Saved projects key button layers by page number ("2-3"); the page keys
// them by page id ("L2-3"), like edits.
export function recipesFromSaved(saved) {
  return Object.fromEntries(Object.entries(saved || {}).map(([k, recipe]) => [`L${k}`, recipe]));
}

export function recipesRequest(layout, recipes) {
  const result = {};
  for (const [k, recipe] of recipes) {
    const [pageId, button] = k.split("-");
    const page = pageNumber(layout, pageId);
    if (page) result[`${page}-${button}`] = recipe;
  }
  return result;
}
