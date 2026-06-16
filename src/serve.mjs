import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const siteDir = path.join(process.cwd(), "site");
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

createServer(async (request, response) => {
  const requested = decodeURIComponent(new URL(request.url, `http://localhost:${port}`).pathname);
  const fileName = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const filePath = path.join(siteDir, fileName);

  if (!filePath.startsWith(siteDir)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, () => {
  console.log(`Serving http://localhost:${port}`);
});
