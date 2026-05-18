import PDFDocument from "pdfkit";
import type { ExternalSummary } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";
import { deriveJobCardFlags } from "../format/external.js";

interface GeneratePdfArgs {
  task: SplynxTaskRaw;
  summary: ExternalSummary;
  comment: string;
  /** Photos kept in the args for backwards-compat — current PDF layout
   *  doesn't embed them (the analysis section describes each), and they
   *  remain available in Splynx Attachments. */
  photos: { buffer: Buffer; width: number; height: number }[];
  techName: string;
  submittedAt: Date;
  secondaryTechNames?: string[];
}

const ACCENT = "#34a853"; // top decorative bar
const HEADING_COLOR = "#0b1116";
const LABEL_COLOR = "#0b1116";
const BODY_COLOR = "#1c1f23";
const MUTED_COLOR = "#5b6066";
const FLAG_COLOR = "#c5221f"; // red, for the 🚩 Flags section

/**
 * Render the Job Completion Summary PDF. Sections are skipped automatically
 * when their corresponding fields on the AI-produced summary are empty, so
 * legacy submissions (whose summary_json was saved before the structured
 * fields existed) still produce a usable, smaller report.
 *
 * Type firewall: this function accepts ExternalSummary only — InternalRating
 * cannot reach here. See server/src/types.ts and __tests__/leak.test.ts.
 */
export async function generatePdf(args: GeneratePdfArgs): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title: `Job Completion Summary — Task ${args.task.id}`,
        Author: "DK Connect Task Updater",
        Subject: args.summary.headline,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Top accent bar
    const m = 50;
    doc.rect(m, m - 30, doc.page.width - m * 2, 4).fill(ACCENT);
    doc.fillColor(HEADING_COLOR);

    // Title
    doc.font("Helvetica-Bold").fontSize(16).text("Job Completion Summary", m, m - 18, {
      width: doc.page.width - m * 2,
    });
    doc.moveDown(1.5);

    // 1. Job/Task Overview
    section(doc, "1. Job/Task Overview");
    const ov = args.summary.overview;
    const dateValue = ov.job_date.trim() || formatDate(args.submittedAt);
    bulletLabel(doc, "Service type", ov.service_type, true);
    bulletLabel(doc, "Client", ov.client_name, true);
    bulletLabel(doc, "Location", ov.location || args.task.address || "");
    bulletLabel(doc, "Date", dateValue);
    bulletLabel(doc, "Task ID", `#${args.task.id}`);
    if (ov.job_start_time.trim()) bulletLabel(doc, "Job Start Time", ov.job_start_time);
    if (ov.job_end_time.trim()) bulletLabel(doc, "Job End Time", ov.job_end_time);
    if (ov.job_duration.trim()) bulletLabel(doc, "Job Duration", ov.job_duration);
    doc.moveDown(0.6);

    // Flags — only render when the AI surfaced job-card issues. Coloured
    // red so the operator can't miss them while scanning the report.
    const flags = deriveJobCardFlags(args.summary.job_card);
    if (flags.length > 0) {
      doc.font("Helvetica-Bold").fontSize(13).fillColor(FLAG_COLOR).text("🚩 Flags");
      doc.moveDown(0.2);
      for (const f of flags) {
        doc
          .font("Helvetica")
          .fontSize(10)
          .fillColor(FLAG_COLOR)
          .text(`• ${f}`, { width: doc.page.width - 100 });
      }
      doc.fillColor(HEADING_COLOR);
      doc.moveDown(0.6);
    }

    // 2. Work Completed
    if (args.summary.work_completed.length > 0) {
      section(doc, "2. Work Completed");
      for (const item of args.summary.work_completed) bullet(doc, item);
      doc.moveDown(0.6);
    }

    // 3. Photos Analysis
    if (args.summary.photo_descriptions.length > 0) {
      section(doc, "3. Photos Analysis");
      args.summary.photo_descriptions.forEach((desc, i) => {
        bulletLabel(doc, `Photo ${i + 1}`, desc, true);
      });
      doc.moveDown(0.6);
    }

    // 4. Materials/Equipment
    if (args.summary.materials.length > 0) {
      section(doc, "4. Materials/Equipment");
      for (const item of args.summary.materials) bullet(doc, item);
      doc.moveDown(0.6);
    }

    // 5. Issues & Notes
    if (args.summary.issues_notes.length > 0) {
      section(doc, "5. Issues & Notes");
      for (const item of args.summary.issues_notes) bullet(doc, item);
      doc.moveDown(0.6);
    }

    // Tech's verbatim notes — kept on the report for traceability, but small
    // and below the main analysis.
    if (args.comment.trim()) {
      doc.moveDown(0.4);
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(MUTED_COLOR)
        .text("Technician's notes (verbatim)", m);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED_COLOR)
        .text(args.comment, m, doc.y + 2, { width: doc.page.width - m * 2 });
      doc.fillColor(HEADING_COLOR);
    }

    // 6. Photos — embedded grid. Always start a fresh page so the report's
    // text portion stays cleanly readable.
    if (args.photos.length > 0) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(13).fillColor(HEADING_COLOR).text("6. Photos");
      doc.moveDown(0.4);
      drawPhotoGrid(doc, args);
    }

    // Footer
    const footerY = doc.page.height - 40;
    doc
      .strokeColor("#dddddd")
      .lineWidth(0.5)
      .moveTo(m, footerY - 6)
      .lineTo(doc.page.width - m, footerY - 6)
      .stroke();
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor(MUTED_COLOR)
      .text(
        `Generated by Task Updater  •  ${formatDateTime(args.submittedAt)}  •  Tech: ${args.techName}${
          (args.secondaryTechNames ?? []).filter((n) => n.trim()).length > 0
            ? ` (with ${(args.secondaryTechNames ?? []).map((n) => n.trim()).filter(Boolean).join(", ")})`
            : ""
        }`,
        m,
        footerY,
        { width: doc.page.width - m * 2, align: "center" },
      );

    doc.end();
  });
}

function drawPhotoGrid(doc: PDFKit.PDFDocument, args: GeneratePdfArgs): void {
  const m = 50;
  const gap = 8;
  const labelHeight = 12;
  const cols = 2;
  const rowsPerPage = 3; // 6 photos per page
  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const colWidth = (pageW - m * 2 - gap * (cols - 1)) / cols;
  // Aim for 3 rows per page including labels — back into per-cell height.
  const cellHeight = (pageH - m * 2 - 30 - gap * (rowsPerPage - 1)) / rowsPerPage;
  const imgHeight = cellHeight - labelHeight - 4;

  let col = 0;
  let row = 0;
  let baseY = doc.y;

  for (let i = 0; i < args.photos.length; i++) {
    const photo = args.photos[i]!;
    const x = m + col * (colWidth + gap);
    const y = baseY + row * (cellHeight + gap);

    // Centre the image in its cell while preserving aspect ratio.
    try {
      doc.image(photo.buffer, x, y, {
        fit: [colWidth, imgHeight],
        align: "center",
        valign: "center",
      });
    } catch {
      doc.rect(x, y, colWidth, imgHeight).stroke("#cccccc");
      doc.fillColor("#999").fontSize(9).text("(unreadable)", x + 4, y + 4);
      doc.fillColor(HEADING_COLOR);
    }

    // Label = "Photo N" referencing the description in section 3.
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(HEADING_COLOR)
      .text(`Photo ${i + 1}`, x, y + imgHeight + 2, {
        width: colWidth,
        align: "center",
        lineBreak: false,
      });

    col += 1;
    if (col >= cols) {
      col = 0;
      row += 1;
      if (row >= rowsPerPage && i < args.photos.length - 1) {
        doc.addPage();
        doc.font("Helvetica-Bold").fontSize(13).fillColor(HEADING_COLOR).text("6. Photos (cont.)");
        doc.moveDown(0.4);
        baseY = doc.y;
        row = 0;
      }
    }
  }
}

// ---------- layout helpers ----------

function section(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 60);
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(HEADING_COLOR).text(title);
  doc.moveDown(0.2);
}

function bullet(doc: PDFKit.PDFDocument, text: string): void {
  ensureSpace(doc, 24);
  const m = 50;
  const indent = m + 16;
  const startY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor(BODY_COLOR);
  doc.text("•", m + 6, startY, { lineBreak: false });
  doc.text(text, indent, startY, { width: doc.page.width - indent - m });
  doc.moveDown(0.15);
}

function bulletLabel(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  inlineColon = true,
): void {
  if (!value || !value.trim()) return;
  ensureSpace(doc, 24);
  const m = 50;
  const indent = m + 16;
  const startY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor(BODY_COLOR);
  doc.text("•", m + 6, startY, { lineBreak: false });

  // Bold label, then value continued on the same paragraph.
  doc.font("Helvetica-Bold").fillColor(LABEL_COLOR).text(`${label}${inlineColon ? ":" : ""} `, indent, startY, {
    continued: true,
  });
  doc.font("Helvetica").fillColor(BODY_COLOR).text(value, {
    continued: false,
    width: doc.page.width - indent - m,
  });
  doc.moveDown(0.15);
}

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - 50;
  if (doc.y + needed > bottom) doc.addPage();
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-ZA", { year: "numeric", month: "long", day: "numeric" });
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
