import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const serverUploadedFileCache = new Map<string, { uri: string; mimeType: string; name: string }>();

function getGeminiClient() {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

async function startServer() {
  const app = express();
  // Dev server must always run on port 3000 as required by AI Studio environment
  const PORT = 3000;

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Server-side Gemini API: generateContent
  app.post("/api/gemini/generate-content", async (req, res) => {
    try {
      const { model, contents, config } = req.body || {};
      if (!model) {
        return res.status(400).json({ error: { message: "Missing model parameter" } });
      }
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model,
        contents,
        config,
      });
      return res.status(200).json({
        text: response.text || "",
        candidates: response.candidates || [],
      });
    } catch (error: any) {
      const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600 ? error.status : 500;
      return res.status(status).json({
        error: {
          message: error?.message || String(error),
          status: error?.status,
        },
      });
    }
  });

  // Server-side Gemini API: upload file
  app.post("/api/gemini/upload-file", async (req, res) => {
    try {
      const { base64Data, mimeType, displayName, cacheKey } = req.body || {};
      if (cacheKey && serverUploadedFileCache.has(cacheKey)) {
        return res.status(200).json(serverUploadedFileCache.get(cacheKey));
      }
      if (!base64Data) {
        return res.status(400).json({ error: { message: "Missing base64Data parameter" } });
      }
      const ai = getGeminiClient();
      const resolvedMimeType = mimeType || "application/pdf";
      const buffer = Buffer.from(base64Data, "base64");
      const blob = new Blob([buffer], { type: resolvedMimeType });
      const uploaded = await ai.files.upload({
        file: blob,
        config: {
          mimeType: resolvedMimeType,
          displayName: displayName || "uploaded_file",
        },
      });
      const result = {
        uri: uploaded.uri || "",
        mimeType: uploaded.mimeType || resolvedMimeType,
        name: uploaded.name || "",
      };
      if (cacheKey && result.uri) {
        serverUploadedFileCache.set(cacheKey, result);
      }
      return res.status(200).json(result);
    } catch (error: any) {
      const status = typeof error?.status === "number" && error.status >= 400 && error.status < 600 ? error.status : 500;
      return res.status(status).json({
        error: {
          message: error?.message || String(error),
          status: error?.status,
        },
      });
    }
  });

  // Server-side Gemini API: delete temporary files
  app.post("/api/gemini/delete-files", async (req, res) => {
    try {
      const { names } = req.body || {};
      if (Array.isArray(names) && names.length > 0) {
        const ai = getGeminiClient();
        await Promise.all(
          names.map((name: string) =>
            name ? ai.files.delete({ name }).catch(() => {}) : Promise.resolve()
          )
        );
      }
      return res.status(200).json({ ok: true });
    } catch (error: any) {
      return res.status(200).json({ ok: false, error: error?.message || String(error) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));

    // For Express 5 (if applicable, fallback to '*' for express 4 just in case)
    try {
      app.get("*all", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    } catch (e) {
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
