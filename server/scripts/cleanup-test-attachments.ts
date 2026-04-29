import axios from "axios";

const auth =
  "Basic " +
  Buffer.from(`${process.env["SPLYNX_API_KEY"]}:${process.env["SPLYNX_API_SECRET"]}`).toString("base64");

const ids = process.argv.slice(2).map(Number);
if (ids.length === 0) {
  console.error("usage: npx tsx scripts/cleanup-test-attachments.ts <id> [<id> ...]");
  process.exit(2);
}

for (const id of ids) {
  const r = await axios.delete(
    `${process.env["SPLYNX_BASE_URL"]}/api/2.0/admin/scheduling/tasks-attachments/${id}`,
    {
      headers: { Authorization: auth },
      validateStatus: () => true,
    },
  );
  console.log(
    `DELETE attachment ${id} → ${r.status} ${typeof r.data === "string" ? r.data.slice(0, 80) : JSON.stringify(r.data)}`,
  );
}
