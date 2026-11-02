import { GoogleGenAI } from "@google/genai";

export const maxDuration = 300;

const uploadedCache = new Map<string, { uri: string; mimeType: string; name: string }>();

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method Not Allowed" } });
  }

  try {
    const { base64Data, mimeType, displayName, cacheKey } = req.body || {};
    if (cacheKey && uploadedCache.has(cacheKey)) {
      return res.status(200).json(uploadedCache.get(cacheKey));
    }
    if (!base64Data) {
      return res.status(400).json({ error: { message: "Missing base64Data parameter" } });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

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
      uploadedCache.set(cacheKey, result);
    }
    return res.status(200).json(result);
  } catch (error: any) {
    const status =
      typeof error?.status === "number" && error.status >= 400 && error.status < 600
        ? error.status
        : 500;
    return res.status(status).json({
      error: {
        message: error?.message || String(error),
        status: error?.status,
      },
    });
  }
}
