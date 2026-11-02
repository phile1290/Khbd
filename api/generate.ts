import { GoogleGenAI } from "@google/genai";

export const maxDuration = 300; 

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { userPrompt, mainParts, referenceParts, systemInstruction } = req.body;
    
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    
    const modelsToTry = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    let delay = 3000;
    const maxAttempts = 9; 
    let lastErr: any;

    for (let i = 0; i < maxAttempts; i++) {
        const currentModel = modelsToTry[i % modelsToTry.length];
        try {
            const response = await ai.models.generateContent({
                model: currentModel,
                contents: { 
                    parts: [
                        { text: userPrompt },
                        ...(mainParts || []),
                        ...(referenceParts || [])
                    ]
                },
                config: {
                    systemInstruction: systemInstruction,
                    responseMimeType: "application/json",
                    temperature: 0.7
                }
            });
            
            return res.status(200).json({ text: response.text });
        } catch (err: any) {
            lastErr = err;
            console.error(`Vercel API Error (attempt ${i + 1}/${maxAttempts}, model ${currentModel}):`, err);
            
            const errMsg = err.message ? String(err.message).toLowerCase() : '';
            const isRetryable = (
                errMsg.includes('quota') ||
                errMsg.includes('503') ||
                errMsg.includes('429') ||
                errMsg.includes('resource_exhausted') ||
                errMsg.includes('resource exhausted') ||
                errMsg.includes('fetch') ||
                errMsg.includes('json') ||
                errMsg.includes('parse') ||
                errMsg.includes('định dạng')
            );

            if (i === maxAttempts - 1 || !isRetryable) {
                if (isRetryable) {
                    throw new Error("API Key đã vượt giới hạn lượt gọi (Quota/429) sau nhiều lần thử lại. Vui lòng dùng API Key mới hoặc đợi vài phút.");
                }
                throw new Error(err.message || "Lỗi không xác định khi gọi AI.");
            }

            if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('resource_exhausted')) {
                delay = Math.max(delay, 5000); 
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 1.5;
        }
    }
    throw new Error(lastErr?.message || "Không thể kết nối với AI sau nhiều lần thử.");
  } catch (error: any) {
    console.error("Vercel API Error:", error);
    res.status(500).json({ error: error.message });
  }
}
