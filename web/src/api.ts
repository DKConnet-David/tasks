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

export interface UploadProgress {
  /** Total bytes already uploaded. */
  loaded: number;
  /** Total bytes to upload (0 if unknown — should always be known for FormData). */
  total: number;
  /** 0..1, or null when total isn't known. */
  fraction: number | null;
}

export interface UploadOptions {
  onProgress?: (p: UploadProgress) => void;
  /** Fires once the request body has been fully transmitted (server is now
   *  processing). */
  onUploadComplete?: () => void;
}

/**
 * XHR-based upload so we can subscribe to progress events. fetch in browsers
 * doesn't expose upload progress in a portable way yet.
 */
function uploadWithProgress<T>(
  path: string,
  form: FormData,
  options: UploadOptions = {},
): Promise<T> {
  const url = path.startsWith("/api/") ? path : `${API_PREFIX}${path}`;
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.responseType = "text";

    xhr.upload.onprogress = (e: ProgressEvent) => {
      if (!options.onProgress) return;
      options.onProgress({
        loaded: e.loaded,
        total: e.total,
        fraction: e.lengthComputable && e.total > 0 ? e.loaded / e.total : null,
      });
    };
    xhr.upload.onload = () => {
      // upload.onload fires when the request body is fully sent — server is
      // now processing the multipart parts (sharp resize + AI calls + …).
      options.onUploadComplete?.();
    };

    xhr.onload = () => {
      let body: unknown = undefined;
      if (xhr.responseText) {
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = xhr.responseText;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new ApiError(xhr.status, body));
    };
    xhr.onerror = () => reject(new ApiError(0, null, "network error"));
    xhr.ontimeout = () => reject(new ApiError(0, null, "timeout"));
    xhr.timeout = 0; // server-side pipeline can take 30s+ for large jobs

    xhr.send(form);
  });
}

export const api = {
  get: <T = unknown>(path: string) => request<T>(path),
  post: <T = unknown>(path: string, json?: unknown) =>
    request<T>(path, { method: "POST", json }),
  patch: <T = unknown>(path: string, json?: unknown) =>
    request<T>(path, { method: "PATCH", json }),
  delete: <T = unknown>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T = unknown>(path: string, form: FormData, options?: UploadOptions) =>
    uploadWithProgress<T>(path, form, options),
};

export interface Me {
  app_login: string;
  splynx_admin_id: number;
  is_admin: boolean;
}
