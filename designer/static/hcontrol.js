// The HControl strings a programmer sends to, and receives from, a keypad to
// use one button: plain data, no DOM. Each line is { send, text }, where send
// is true for a line you send and false for one the keypad sends.

const json = (value) => JSON.stringify(value);
const send = (command, params) => ({ send: true, text: `${command} ${json(params)}` });
const expect = (command, params) => ({ send: false, text: `${command} ${json(params)}` });
const group = (title, lines) => ({ title, lines });

// Requests and replies that carry an enum use its name, not its index.
const str = (path, extra = {}) => ({ path, format: "string", ...extra });

export function buttonGroups({ page, button, pageName = "", target = "" }) {
  const action = `/page${page}/button${button}/action`;
  const state = `/page${page}/button${button}/state`;
  const enabled = `/page${page}/button${button}/enabled`;
  const groups = [
    group("Subscribe to presses", [
      send("subscribe", str(action)),
      expect("@subscribe", str(action, { value: "RELEASE" }))]),
    group("When pressed and released", [
      expect("publish", str(action, { value: "PUSH" })),
      send("@publish", str(action, { value: "PUSH" })),
      expect("publish", str(action, { value: "RELEASE" })),
      send("@publish", str(action, { value: "RELEASE" }))]),
    group("Get the feedback state", [
      send("get", str(state)),
      expect("@get", str(state, { value: "OFF" }))]),
    group("Set the feedback state (OFF, ON or Alt)", [
      send("set", str(state, { value: "ON" })),
      expect("@set", str(state, { value: "ON" }))]),
    group("Enable or disable", [
      send("set", { path: enabled, value: false }),
      expect("@set", { path: enabled, value: false })]),
  ];
  if (target) {
    const current = "/settings/currentpage";
    groups.push(group(`Follow page changes · links to ${target}`, [
      send("subscribe", str(current)),
      expect("@subscribe", str(current, { value: pageName })),
      expect("publish", str(current, { value: target })),
      send("@publish", str(current, { value: target }))]));
  }
  return groups;
}

export function pageControlGroups(page) {
  const dial = `/page${page}/dial/level`;
  const dialButton = `/page${page}/dial_button/action`;
  const ring = `/page${page}/ledring/level`;
  return [
    group("Dial level", [
      send("subscribe", { path: dial }),
      expect("@subscribe", { path: dial, value: 0 })]),
    group("Dial button", [
      send("subscribe", str(dialButton)),
      expect("@subscribe", str(dialButton, { value: "RELEASE" }))]),
    group("LED ring level", [
      send("set", { path: ring, value: 40 }),
      expect("@set", { path: ring, value: 40 })]),
  ];
}

export const HCONTROL_NOTES = [
  { title: "One request at a time", text: "Every request gets exactly one reply that starts with @. Wait for it before you send the next request." },
  { title: "Acknowledge publishes", text: "A publish is sent when the button changes. Echo the line back unchanged with @ in front, or the keypad won't send the next one." },
  { title: "Interleaving", text: "A publish can arrive between your request and its reply, so match each reply by its command and path." },
  { title: "Use string format", text: "Include \"format\":\"string\" so action and state use names (PUSH, ON). Without it, they're indexes, for example 2 for ON." },
  { title: "Feedback is up to you", text: "Pressing a button doesn't change its state. Your code sets state to show feedback." },
  { title: "Page-switch buttons", text: "A button with a Go to page link still sends PUSH and RELEASE. The keypad then changes page by itself and publishes the new page name on /settings/currentpage. To change pages yourself, set /settings/currentpage to a page name." },
  { title: "Paths use numbers", text: "Paths use page and button numbers, not names. Deleting a page renumbers the pages after it." },
  { title: "Redeploying", text: "Deploying a design drops every connection and resets button states. Your code needs to reconnect and subscribe again." },
  { title: "Unbound controls only", text: "Only controls that aren't bound to an OMNI device are available over HControl." },
];
