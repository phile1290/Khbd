import { GoogleGenAI } from "@google/genai";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method Not Allowed" } });
  }

  try {
    const { names } = req.body || {};
    if (Array.isArray(names) && names.length > 0) {
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
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
}
