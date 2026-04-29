import axios from "axios";
const auth =
  "Basic " +
  Buffer.from(`${process.env["SPLYNX_API_KEY"]}:${process.env["SPLYNX_API_SECRET"]}`).toString("base64");
const id = process.argv[2];
const r = await axios.get(
  `${process.env["SPLYNX_BASE_URL"]}/api/2.0/admin/scheduling/tasks-comments/${id}`,
  { headers: { Authorization: auth }, validateStatus: () => true },
);
console.log(`status: ${r.status}`);
console.log(JSON.stringify(r.data, null, 2));
