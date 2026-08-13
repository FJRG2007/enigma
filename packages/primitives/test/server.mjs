import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(process.env.PORT ?? 4173);

const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8"
};

createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    try {
        const body = await readFile(file);
        response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
        response.end(body);
    } catch {
        response.writeHead(404).end("not found");
    }
}).listen(port, () => console.log(`fixture server on http://localhost:${port}`));
