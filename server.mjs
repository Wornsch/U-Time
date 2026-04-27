import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.join(__dirname, "dist");
const upstreamOrigin = "https://www.wienerlinien.at";
const port = Number(process.env.PORT || 4173);

const app = express();

app.use("/api/wl", async (req, res) => {
  try {
    const upstreamPath = req.originalUrl.replace(/^\/api\/wl/, "") || "/";
    const upstreamUrl = new URL(upstreamPath, upstreamOrigin);
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        accept: req.headers.accept || "*/*",
        "user-agent": "U-Time/0.1 (+https://www.wienerlinien.at/open-data)",
      },
    });

    res.status(upstreamResponse.status);
    const contentType = upstreamResponse.headers.get("content-type");
    if (contentType) {
      res.setHeader("content-type", contentType);
    }
    res.setHeader("cache-control", "public, max-age=20");

    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    res.send(body);
  } catch (error) {
    res.status(502).json({
      error: "Wiener-Linien-Daten konnten nicht geladen werden.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.listen(port, () => {
  console.log(`U-Time läuft auf http://localhost:${port}`);
});
