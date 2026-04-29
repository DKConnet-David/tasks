import PDFDocument from "pdfkit";
import type { ExternalSummary } from "../types.js";
import type { SplynxTaskRaw } from "../splynx/types.js";

interface GeneratePdfArgs {
  task: SplynxTaskRaw;
  summary: ExternalSummary;
  comment: string;
  photos: { buffer: Buffer; width: number; height: number }[];
  techName: string;
  submittedAt: Date;
}

/**
 * Render the field-tech job report PDF using pdfkit.
 *
 * Layout: a single A4 document — header, summary block, tech notes,
 * then a 2-column photo grid that flows across pages as needed.
 *
 * NOTE on the type firewall: this function accepts ExternalSummary only.
 * The InternalRating type cannot reach here — the compiler refuses. This is
 * the structural guarantee that admin-only rating data never lands in the PDF.
 */
export async function generatePdf(args: GeneratePdfArgs): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title: `Job Report — Task ${args.task.id}`,
        Author: "DK Connect Task Updater",
        Subject: args.summary.headline,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ---- Header ----
    doc.fontSize(18).font("Helvetica-Bold").fillColor("#0b3d91");
    doc.text("Field-Tech Job Report", { align: "center" });
    doc.fillColor("black");

    doc.moveDown(0.4);
    doc.fontSize(10).font("Helvetica").fillColor("#666");
    doc.text(
      `Task #${args.task.id}  •  ${formatDateTime(args.submittedAt)}  •  Tech: ${args.techName}`,
      { align: "center" },
    );
    doc.fillColor("black");
    doc.moveDown(1);

    // Horizontal rule
    const ruleY = doc.y;
    doc
      .strokeColor("#cccccc")
      .lineWidth(1)
      .moveTo(50, ruleY)
      .lineTo(doc.page.width - 50, ruleY)
      .stroke();
    doc.moveDown(0.5);

    // ---- Summary headline ----
    doc.fontSize(15).font("Helvetica-Bold").text(args.summary.headline);
    doc.moveDown(0.4);

    // ---- Site / scheduling line ----
    doc.fontSize(10).font("Helvetica").fillColor("#444");
    if (args.task.address) doc.text(`Site: ${args.task.address}`);
    if (args.task.scheduled_from && args.task.scheduled_from !== "0000-00-00 00:00:00") {
      doc.text(`Scheduled: ${args.task.scheduled_from}`);
    }
    doc.fillColor("black");
    doc.moveDown(0.6);

    // ---- Body sections ----
    sectionHeading(doc, "What was done");
    bodyText(doc, args.summary.what_was_done);

    if (args.summary.observations.trim()) {
      sectionHeading(doc, "Observations");
      bodyText(doc, args.summary.observations);
    }

    if (args.summary.follow_ups.trim()) {
      sectionHeading(doc, "Follow-ups");
      bodyText(doc, args.summary.follow_ups);
    }

    if (args.comment.trim()) {
      sectionHeading(doc, "Technician's notes (verbatim)");
      doc.fontSize(10).font("Helvetica-Oblique").fillColor("#444");
      doc.text(args.comment, { align: "left" });
      doc.fillColor("black");
      doc.moveDown(0.5);
    }

    // ---- Photos ----
    if (args.photos.length > 0) {
      doc.moveDown(0.5);
      sectionHeading(doc, `Photos (${args.photos.length})`);

      const margin = 50;
      const gap = 8;
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const colWidth = (pageW - margin * 2 - gap) / 2;

      let col = 0;
      let rowY = doc.y;
      let rowH = 0;

      for (const photo of args.photos) {
        const aspect = photo.width / photo.height || 1;
        const w = colWidth;
        const h = w / aspect;

        // Force a new page if the next image would overflow
        if (rowY + h > pageH - margin) {
          doc.addPage();
          rowY = margin;
          col = 0;
          rowH = 0;
        }

        const x = margin + col * (colWidth + gap);
        try {
          doc.image(photo.buffer, x, rowY, { fit: [w, h] });
        } catch {
          // Bad image data — draw a placeholder and keep going.
          doc.rect(x, rowY, w, h).stroke("#cccccc");
          doc.fillColor("#999").fontSize(9).text("(unreadable)", x + 4, rowY + 4);
          doc.fillColor("black");
        }

        if (h > rowH) rowH = h;
        col += 1;

        if (col === 2) {
          col = 0;
          rowY += rowH + gap;
          rowH = 0;
          // Move pdfkit cursor below the row so subsequent text would land
          // there if we ever continue past photos.
          doc.y = rowY;
        }
      }
    }

    doc.end();
  });
}

function sectionHeading(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.4);
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#0b3d91").text(title);
  doc.fillColor("black");
  doc.moveDown(0.2);
}

function bodyText(doc: PDFKit.PDFDocument, text: string): void {
  doc.fontSize(11).font("Helvetica").text(text, { align: "left" });
  doc.moveDown(0.4);
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
