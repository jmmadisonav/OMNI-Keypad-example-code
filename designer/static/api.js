// Small wrappers around the designer server's JSON API.

async function parse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function getJson(path) {
  return parse(await fetch(path));
}

export async function sendJson(method, path, body) {
  return parse(await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

export function assetUrl(name) {
  return "/asset/" + name.split("/").map(encodeURIComponent).join("/");
}
