import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PAGES, layoutFromConfig, addPage, renamePage, deletePage, setDestination,
  destinationOf, destinationsTo, pageNumber, pageName, layoutRequest,
} from "./pages.js";

const button = (destination = "") => ({ offImage: [], onImage: [], destination });
const config = {
  pages: [
    { name: "Page 1", buttons: [button(), button("Page 2")] },
    { name: "Page 2", buttons: [button("Page 1"), button("Gone")] },
  ],
};

test("layoutFromConfig keeps pages and known destinations", () => {
  const layout = layoutFromConfig(config);
  assert.deepEqual(layout.pages.map((p) => [p.id, p.name, p.source]),
    [["L1", "Page 1", 1], ["L2", "Page 2", 2]]);
  assert.equal(destinationOf(layout, "L1", 2), "L2");
  assert.equal(destinationOf(layout, "L2", 1), "L1");
  assert.equal(destinationOf(layout, "L2", 2), null);     // Unknown page name: ignored.
});

test("addPage picks a free name and a new id", () => {
  let layout = renamePage(layoutFromConfig(config), "L2", "Page 3");
  layout = addPage(layout);
  const added = layout.pages.at(-1);
  assert.equal(added.source, null);
  assert.equal(added.name, "Page 4");
  assert.match(added.id, /^N\d+$/);
  assert.equal(pageNumber(layout, added.id), 3);
});

test("addPage refuses more than MAX_PAGES", () => {
  let layout = layoutFromConfig(config);
  while (layout.pages.length < MAX_PAGES) layout = addPage(layout);
  assert.throws(() => addPage(layout), /9 pages/);
});

test("renamePage keeps destinations and rejects bad names", () => {
  const layout = renamePage(layoutFromConfig(config), "L2", "  Lights ");
  assert.equal(pageName(layout, "L2"), "Lights");
  assert.equal(destinationOf(layout, "L1", 2), "L2");
  assert.throws(() => renamePage(layout, "L1", "   "), /name/);
  assert.throws(() => renamePage(layout, "L1", "lights"), /already/);
  assert.equal(renamePage(layout, "L2", "Lights").pages[1].name, "Lights");   // Same page: fine.
});

test("deletePage clears destinations to and from it", () => {
  const layout = layoutFromConfig(config);
  assert.equal(destinationsTo(layout, "L2"), 1);
  const after = deletePage(layout, "L2");
  assert.deepEqual(after.pages.map((p) => p.id), ["L1"]);
  assert.equal(destinationOf(after, "L1", 2), null);
  assert.deepEqual(Object.keys(after.destinations), []);
  assert.throws(() => deletePage(after, "L1"), /last page/);
});

test("setDestination sets and clears without mutating", () => {
  const layout = layoutFromConfig(config);
  const set = setDestination(layout, "L1", 1, "L2");
  assert.equal(destinationOf(set, "L1", 1), "L2");
  assert.equal(destinationOf(layout, "L1", 1), null);
  assert.equal(destinationOf(setDestination(set, "L1", 1, null), "L1", 1), null);
});

test("layoutRequest uses current numbers and names", () => {
  let layout = addPage(layoutFromConfig(config));
  layout = deletePage(layout, "L1");
  layout = renamePage(layout, "L2", "Main");
  const extra = layout.pages[1].id;
  layout = setDestination(layout, extra, 1, "L2");
  assert.deepEqual(layoutRequest(layout), {
    pages: [{ name: "Main", source: 2 }, { name: layout.pages[1].name, source: null }],
    destinations: [{ page: 2, button: 1, destination: "Main" }],
  });
});
