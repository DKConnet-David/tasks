import axios, { type AxiosInstance, type AxiosRequestConfig } from "axios";
import type { SplynxTask } from "../types.js";
import type { SplynxCommentRaw, SplynxTaskRaw } from "./types.js";

/**
 * Splynx REST wrapper.
 *
 * Endpoint paths and shapes are locked from the live probe against
 * https://clientzone.dkconnect.co.za (see docs/splynx-probe-findings.md).
 *
 * NOTE: this self-hosted Splynx version did NOT expose any working
 * file-upload endpoint via the API key. Photos + PDF are kept on our backend
 * and referenced by URL in the Splynx comment instead. The previous
 * `uploadTaskFile()` method is intentionally absent until the right endpoint
 * is found.
 */

export interface SplynxAuthResult {
  access_token: string;
  refresh_token: string;
  access_token_expiration: number; // unix seconds
  refresh_token_expiration: number;
}

export interface SplynxClientConfig {
  baseUrl: string;
  /** OAuth-style bearer token from a per-admin login flow. */
  accessToken?: string;
  /** Splynx API key (used together with apiSecret for service-account auth). */
  apiKey?: string;
  /** Splynx API secret. */
  apiSecret?: string;
}

export class SplynxClient {
  private http: AxiosInstance;

  constructor(private cfg: SplynxClientConfig) {
    this.http = axios.create({
      baseURL: cfg.baseUrl.replace(/\/+$/, ""),
      timeout: 30_000,
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

  async getTaskRaw(id: number): Promise<SplynxTaskRaw> {
    const { data } = await this.http.get<SplynxTaskRaw>(
      `/api/2.0/admin/scheduling/tasks/${id}`,
    );
    return data;
  }

  async getTask(id: number): Promise<SplynxTask> {
    const raw = await this.getTaskRaw(id);
    return mapTask(raw);
  }

  async listTaskComments(taskId: number): Promise<SplynxCommentRaw[]> {
    const { data } = await this.http.get<SplynxCommentRaw[]>(
      `/api/2.0/admin/scheduling/tasks-comments`,
      { params: { "main_attributes[task_id]": taskId } },
    );
    return data;
  }

  async addTaskComment(
    taskId: number,
    userId: number,
    comment: string,
  ): Promise<{ id: number }> {
    const { data } = await this.http.post(`/api/2.0/admin/scheduling/tasks-comments`, {
      task_id: taskId,
      user_id: userId,
      comment,
    });
    return data;
  }

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
