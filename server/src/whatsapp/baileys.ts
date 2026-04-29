import path from "node:path";
import fs from "node:fs/promises";
import qrcode from "qrcode";
import {
  default as makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
} from "@whiskeysockets/baileys";

/**
 * Baileys WhatsApp socket — singleton.
 *
 * Auth state lives in {DATA_DIR}/baileys-auth and is written via Baileys'
 * useMultiFileAuthState helper. It survives container restarts because
 * /data is a docker volume.
 *
 * Lifecycle (status field):
 *   stopped     — never started, or admin paused
 *   starting    — sock being created, awaiting first connection.update event
 *   qr          — sock alive but pairing QR in flight; admin must scan
 *   connecting  — re-handshaking after a transient drop
 *   open        — connected and ready to send
 *   logged-out  — auth invalidated by WhatsApp (user removed Linked Devices,
 *                 stale creds, etc.). Admin must re-scan; auto-reconnect off.
 *   error       — startup raised; check lastError + retry from UI
 *
 * Risk reminder: Baileys violates WhatsApp TOS. Use a dedicated number,
 * keep volume modest, accept the (small) ban risk. Documented in the plan.
 */

export type BaileysStatus =
  | "stopped"
  | "starting"
  | "qr"
  | "connecting"
  | "open"
  | "logged-out"
  | "error";

interface State {
  status: BaileysStatus;
  qrDataUrl: string | null;
  lastError: string | null;
  groups: { id: string; subject: string }[];
  startedAt: number | null;
}

const state: State = {
  status: "stopped",
  qrDataUrl: null,
  lastError: null,
  groups: [],
  startedAt: null,
};

let sock: WASocket | null = null;
let authDir: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

export function getStatus(): Readonly<State> {
  return state;
}

export async function start(dataDir: string): Promise<void> {
  if (sock) return; // already alive
  authDir = path.join(dataDir, "baileys-auth");
  await fs.mkdir(authDir, { recursive: true });

  state.status = "starting";
  state.lastError = null;
  state.startedAt = Date.now();

  try {
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: authState,
      printQRInTerminal: false,
      browser: ["Task Updater", "Chrome", "1.0"],
      // Default markOnlineOnConnect=true makes the linked phone show "online" — we
      // suppress so the WhatsApp number doesn't appear active just because our
      // service is up.
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      handleConnectionUpdate(update).catch((err) => {
        state.lastError = err instanceof Error ? err.message : String(err);
      });
    });
  } catch (err) {
    state.status = "error";
    state.lastError = err instanceof Error ? err.message : String(err);
    sock = null;
  }
}

async function handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    state.qrDataUrl = await qrcode.toDataURL(qr, { scale: 8, margin: 1 });
    state.status = "qr";
  }

  if (connection === "connecting") {
    if (state.status !== "qr") state.status = "connecting";
  }

  if (connection === "open") {
    state.status = "open";
    state.qrDataUrl = null;
    state.lastError = null;
    await refreshGroups();
  }

  if (connection === "close") {
    sock = null;
    state.qrDataUrl = null;
    const errorObj = lastDisconnect?.error as
      | { output?: { statusCode?: number }; message?: string }
      | undefined;
    const reason = errorObj?.output?.statusCode;
    const isLoggedOut = reason === DisconnectReason.loggedOut;

    if (isLoggedOut) {
      state.status = "logged-out";
      state.lastError = "WhatsApp session was logged out — re-scan the QR.";
      // Wipe creds so the next start surfaces a fresh QR. We keep the directory
      // around so the path stays the same across restarts.
      if (authDir) {
        try {
          const entries = await fs.readdir(authDir);
          await Promise.all(
            entries.map((f) => fs.rm(path.join(authDir!, f), { force: true })),
          );
        } catch {
          /* ignore — best-effort */
        }
      }
      return;
    }

    state.status = "connecting";
    state.lastError = errorObj?.message ?? `closed (status ${reason ?? "?"})`;
    // Auto-reconnect after a short delay.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!authDir) return;
      void start(path.dirname(authDir));
    }, 3000);
  }
}

async function refreshGroups(): Promise<void> {
  if (!sock) return;
  try {
    const groupsMap = await sock.groupFetchAllParticipating();
    state.groups = Object.entries(groupsMap)
      .map(([id, g]) => ({
        id,
        subject: (g as { subject?: string }).subject ?? "(no subject)",
      }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
  }
}

export async function listGroups(): Promise<{ id: string; subject: string }[]> {
  if (state.status === "open") await refreshGroups();
  return state.groups;
}

export async function sendDocumentToGroup(args: {
  jid: string;
  caption: string;
  pdf: Buffer;
  fileName: string;
}): Promise<string | null> {
  if (!sock || state.status !== "open") {
    throw new Error(`WhatsApp not connected (status=${state.status})`);
  }

  // Baileys' media upload occasionally hits "Media upload failed on all
  // hosts" when WhatsApp's CDN rotates or rate-limits — retrying with
  // backoff almost always succeeds. The text protocol that "Send test
  // message" uses doesn't go through the media CDN at all, which is why
  // text works while document fails.
  const maxAttempts = 3;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sent = await sock.sendMessage(args.jid, {
        document: args.pdf,
        mimetype: "application/pdf",
        fileName: args.fileName,
        caption: args.caption,
      });
      if (attempt > 1) {
        state.lastError = null;
      }
      return sent?.key?.id ?? null;
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < maxAttempts) {
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      // Out of attempts. Re-throw so the pipeline records it.
      const wrapped = new Error(
        `WhatsApp document upload failed after ${maxAttempts} attempts: ${msg}`,
      );
      throw wrapped;
    }
  }
  // Unreachable but keeps the typesystem happy.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function sendTextToGroup(jid: string, text: string): Promise<string | null> {
  if (!sock || state.status !== "open") {
    throw new Error(`WhatsApp not connected (status=${state.status})`);
  }
  const sent = await sock.sendMessage(jid, { text });
  return sent?.key?.id ?? null;
}

export async function logoutAndWipe(): Promise<void> {
  try {
    await sock?.logout();
  } catch {
    /* ignore */
  }
  sock = null;
  if (authDir) {
    try {
      const entries = await fs.readdir(authDir);
      await Promise.all(
        entries.map((f) => fs.rm(path.join(authDir!, f), { force: true })),
      );
    } catch {
      /* ignore */
    }
  }
  state.status = "stopped";
  state.qrDataUrl = null;
  state.groups = [];
  state.lastError = null;
}
