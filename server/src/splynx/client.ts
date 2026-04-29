import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import FormData from "form-data";
import type { SplynxTask } from "../types.js";
import type { SplynxCommentRaw, SplynxTaskRaw } from "./types.js";

/**
 * Splynx REST wrapper.
 *
 * Endpoints + shapes are locked to the v2.0 OpenAPI spec
 * (https://api-doc.splynx.com/release-5.2.json) and verified against the live
 * tenant at https://clientzone.dkconnect.co.za. See
 * docs/splynx-probe-findings.md for the raw probe responses.
 */

export interface SplynxAuthResult {
  access_token: string;
  refresh_token: string;
  access_token_expiration: number;
  refresh_token_expiration: number;
}

export interface SplynxClientConfig {
  baseUrl: string;
  accessToken?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface SplynxAttachedFile {
  buffer: Buffer;
  filename: string;
  mimetype: string;
}

export class SplynxClient {
  private http: AxiosInstance;

  constructor(private cfg: SplynxClientConfig) {
    this.http = axios.create({
      baseURL: cfg.baseUrl.replace(/\/+$/, ""),
      timeout: 60_000,
    });
    this.applyAuthHeader();
  }

  private applyAuthHeader(): void {
    if (this.cfg.accessToken) {
      this.http.defaults.headers.common["Authorization"] = `Bearer ${this.cfg.accessToken}`;
    } else if (this.cfg.apiKey && this.cfg.apiSecret) {
      const encoded = Buffer.from(`${this.cfg.apiKey}:${this.cfg.apiSecret}`).toString("base64");
      this.http.defaults.headers.common["Authorization"] = `Basic ${encoded}`;
    } else {
      delete this.http.defaults.headers.common["Authorization"];
    }
  }

  setAccessToken(token: string): void {
    this.cfg.accessToken = token;
    this.applyAuthHeader();
  }

  setApiKey(apiKey: string, apiSecret: string): void {
    this.cfg.apiKey = apiKey;
    this.cfg.apiSecret = apiSecret;
    this.cfg.accessToken = undefined;
    this.applyAuthHeader();
  }

  // --- Auth (proxy-login model — unused with API key, kept for completeness) ---

  async login(login: string, password: string): Promise<SplynxAuthResult> {
    const { data } = await this.http.post(`/api/2.0/admin/auth/tokens`, {
      auth_type: "admin",
      login,
      password,
    });
    return data as SplynxAuthResult;
  }

  async refresh(refreshToken: string): Promise<SplynxAuthResult> {
    const { data } = await this.http.post(`/api/2.0/admin/auth/tokens`, {
      auth_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return data as SplynxAuthResult;
  }

  // --- Tasks ---

  async getTaskRaw(id: number): Promise<SplynxTaskRaw> {
    const { data } = await this.http.get<SplynxTaskRaw>(
      `/api/2.0/admin/scheduling/tasks/${id}`,
    );
    return data;
  }

  async getTask(id: number): Promise<SplynxTask> {
    return mapTask(await this.getTaskRaw(id));
  }

  // --- Comments ---

  async listTaskComments(taskId: number): Promise<SplynxCommentRaw[]> {
    const { data } = await this.http.get<SplynxCommentRaw[]>(
      `/api/2.0/admin/scheduling/tasks-comments`,
      { params: { "main_attributes[task_id]": taskId } },
    );
    return data;
  }

  /**
   * Add a comment, optionally with file attachments. Multipart when files are
   * provided so the comment + files arrive in one call (matches the spec's
   * CommentCreate body).
   */
  async addTaskComment(
    taskId: number,
    userId: number,
    comment: string,
    files: SplynxAttachedFile[] = [],
  ): Promise<{ id: number }> {
    if (files.length === 0) {
      const { data } = await this.http.post<{ id: number }>(
        `/api/2.0/admin/scheduling/tasks-comments`,
        { task_id: taskId, user_id: userId, comment },
      );
      return data;
    }
    const fd = new FormData();
    fd.append("task_id", String(taskId));
    fd.append("user_id", String(userId));
    fd.append("comment", comment);
    for (const f of files) {
      fd.append("files[]", f.buffer, { filename: f.filename, contentType: f.mimetype });
    }
    const { data } = await this.http.post<{ id: number }>(
      `/api/2.0/admin/scheduling/tasks-comments`,
      fd,
      { headers: fd.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity },
    );
    return data;
  }

  /** Edit an existing comment in place (admin "fix the AI summary" flow). */
  async updateTaskComment(commentId: number, comment: string): Promise<void> {
    await this.http.put(`/api/2.0/admin/scheduling/tasks-comments/${commentId}`, { comment });
  }

  /** Append additional files to an existing comment. */
  async uploadCommentAttachments(
    commentId: number,
    files: SplynxAttachedFile[],
  ): Promise<{ files: number[] }> {
    const fd = new FormData();
    for (const f of files) {
      fd.append("files[]", f.buffer, { filename: f.filename, contentType: f.mimetype });
    }
    const { data } = await this.http.post<{ files: number[] }>(
      `/api/2.0/admin/scheduling/tasks-comments/${commentId}--upload`,
      fd,
      { headers: fd.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity },
    );
    return data;
  }

  // --- Direct task attachments ---

  /**
   * Attach files directly to a task (lands in the task's "Attachments" tab,
   * separate from comments). Returns the array of created attachment ids.
   */
  async addTaskAttachments(
    taskId: number,
    userId: number,
    files: SplynxAttachedFile[],
  ): Promise<{ files: number[] }> {
    const fd = new FormData();
    fd.append("task_id", String(taskId));
    fd.append("user_id", String(userId));
    for (const f of files) {
      fd.append("files[]", f.buffer, { filename: f.filename, contentType: f.mimetype });
    }
    const { data } = await this.http.post<{ files: number[] }>(
      `/api/2.0/admin/scheduling/tasks-attachments`,
      fd,
      { headers: fd.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity },
    );
    return data;
  }

  // --- Escape hatch ---

  async request<T = unknown>(cfg: AxiosRequestConfig): Promise<T> {
    const { data } = await this.http.request<T>(cfg);
    return data;
  }
}

function mapTask(raw: SplynxTaskRaw): SplynxTask {
  return {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    status: String(raw.workflow_status_id),
    customer_id: raw.related_customer_id ?? undefined,
    address: raw.address,
    scheduled_at: raw.scheduled_from,
    assigned_admin_id: raw.assigned_to === "assigned_to_administrator" ? raw.assignee : undefined,
  };
}
