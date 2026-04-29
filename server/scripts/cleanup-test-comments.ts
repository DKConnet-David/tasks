import axios from "axios";

const auth =
  "Basic " +
  Buffer.from(`${process.env["SPLYNX_API_KEY"]}:${process.env["SPLYNX_API_SECRET"]}`).toString("base64");

const idsToDelete = process.argv.slice(2).map(Number);
if (idsToDelete.length === 0) {
  console.error("usage: npx tsx scripts/cleanup-test-comments.ts <id> [<id> ...]");
  process.exit(2);
}

for (const id of idsToDelete) {
  const r = await axios.delete(
    `${process.env["SPLYNX_BASE_URL"]}/api/2.0/admin/scheduling/tasks-comments/${id}`,
    { headers: { Authorization: auth }, validateStatus: () => true },
  );
  console.log(`DELETE comment ${id} → ${r.status} ${typeof r.data === "string" ? r.data.slice(0, 80) : JSON.stringify(r.data)}`);
}
