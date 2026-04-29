export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message?: string) {
    super(message ?? `request failed with ${status}`);
  }
}

// All requests prefix with /api — server-side, nginx routes /api/* to the
// backend container; the frontend /admin, /tasks/:id, /login routes belong
// to React Router and are served by the SPA's index.html fallback.
const API_PREFIX = "/api";

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const url = path.startsWith("/api/") ? path : `${API_PREFIX}${path}`;
  const res = await fetch(url, {
    ...init,
    body,
    headers,
    credentials: "include",
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  get: <T = unknown>(path: string) => request<T>(path),
  post: <T = unknown>(path: string, json?: unknown) =>
    request<T>(path, { method: "POST", json }),
  patch: <T = unknown>(path: string, json?: unknown) =>
    request<T>(path, { method: "PATCH", json }),
  delete: <T = unknown>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T = unknown>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form }),
};

export interface Me {
  app_login: string;
  splynx_admin_id: number;
  is_admin: boolean;
}
