import { GoogleGenAI } from "@google/genai";

export const maxDuration = 300;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method Not Allowed" } });
  }

  try {
    const { model, contents, config } = req.body || {};
    if (!model) {
      return res.status(400).json({ error: { message: "Missing model parameter" } });
    }

    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

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
