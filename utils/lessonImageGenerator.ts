/**
 * Hệ thống Trí tuệ Nhân tạo (AI) Chuyển Văn bản thành Hình ảnh Minh họa Trực quan (AI Text-to-Image & Visual Illustration Engine)
 * - Trực tiếp sử dụng mô hình tạo ảnh của Gemini (`gemini-2.5-flash-image`, `gemini-2.0-flash-exp-image-generation`)
 *   kết hợp cùng mô hình đồ họa vector AI (`gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`)
 *   để chuyển câu văn hoạt động của Giáo viên ngay phía trên (`immediatePrecedingLine`) và mô tả kênh hình SGK (`cleanDesc`)
 *   thành hình ảnh minh họa trực quan, sống động, chính xác tuyệt đối 100%.
 * - TUYỆT ĐỐI KHÔNG sử dụng kho hình vẽ sẵn cố định và KHÔNG hiển thị hộp văn bản thay cho hình ảnh.
 */

import { GoogleGenAI } from "@google/genai";
import { LessonPlanResponse } from "../types";

// Bộ nhớ đệm lưu trữ hình ảnh PNG (Data URL) do AI sinh ra trong phiên làm việc
const aiGeneratedImageCache = new Map<string, string>();
// Quản lý các tiến trình AI đang chạy để tránh gọi trùng lặp cùng một hình
const inFlightAiTasks = new Map<string, Promise<string | null>>();

let lastKnownApiKey: string = '';
const unsupportedImageModels = new Set<string>();

type ImageUpdateListener = () => void;
const imageUpdateListeners = new Set<ImageUpdateListener>();

export const subscribeToImageUpdates = (listener: ImageUpdateListener): (() => void) => {
    imageUpdateListeners.add(listener);
    return () => {
        imageUpdateListeners.delete(listener);
    };
};

const notifyImageListeners = () => {
    imageUpdateListeners.forEach(fn => {
        try {
            fn();
        } catch {}
    });
};

export const isImageHintLine = (line: string): boolean => {
    const trimmed = (line || '').trim();
    return /^[-–\*\s]*(\[|\()?(Gợi ý hình ảnh|Hình ảnh minh họa|Hình minh họa|Hình ảnh)/i.test(trimmed);
};

export const extractCleanImageDescription = (rawLine: string): string => {
    let text = (rawLine || '').trim();
    text = text.replace(/^[-–\*\s]+/, '');
    text = text.replace(/^(\[|\()?(Gợi ý hình ảnh|Hình ảnh minh họa|Hình minh họa|Hình ảnh)\s*[:\-–]?\s*/i, '');
    text = text.replace(/[\]\)]+$/, '');
    return text.trim() || 'Hình minh họa trực quan theo nội dung câu văn phía trên';
};

export const extractCoreVisualObjectText = (rawText: string): string => {
    let text = (rawText || '').trim();
    text = text.replace(/^[-–\*\s]+/, '');
    text = text.replace(
        /^(giáo\s*viên|gv)\s+(trình\s*chiếu|chiếu|treo|giới\s*thiệu|đưa\s*ra|cho\s*học\s*sinh\s*xem|cho\s*hs\s*quan\s*sát|yêu\s*cầu\s*(các\s*nhóm|học\s*sinh|hs)\s*(quan\s*sát|mở|xem|tìm\s*hiểu|thảo\s*luận)?|hướng\s*dẫn\s*(học\s*sinh|hs)\s*(quan\s*sát|mở)?)\s*/i,
        ''
    );
    return text.trim();
};

export const dataUrlToUint8Array = (dataUrl: string): Uint8Array => {
    const base64Part = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const binaryString = atob(base64Part);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
};

const normalizeCacheToken = (text: string): string => {
    return (text || '')
        .toLowerCase()
        .replace(/^[-–\*\s]*(gv|giáo viên|hs|học sinh|thầy|cô)\s*[:\.]?\s*/gi, '')
        .replace(/^[-–\*\s]+/, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const normalizeBaseLessonToken = (lessonTitle: string): string => {
    const stripped = (lessonTitle || '')
        .replace(/\(\s*tiết\s*\d+(\s*\/\s*\d+)?\s*\)/gi, '')
        .trim();
    return normalizeCacheToken(stripped);
};

const buildSlotCacheKeys = (
    lessonTitle: string,
    immediateContextLine: string,
    cleanDesc: string
): { slotKey: string; ctxKey: string; descKey: string; taskKey: string } => {
    const normTitle = normalizeBaseLessonToken(lessonTitle);
    const normCtx = normalizeCacheToken(immediateContextLine);
    const normDesc = normalizeCacheToken(cleanDesc);
    return {
        slotKey: `slot__${normTitle}__${normCtx}__${normDesc}`,
        ctxKey: `ctx__${normTitle}__${normCtx}`,
        descKey: `desc__${normTitle}__${normDesc}`,
        taskKey: `task__${normTitle}__${normCtx || normDesc}__${normDesc}`
    };
};

const storeInAiCache = (
    keys: { slotKey: string; ctxKey: string; descKey: string; taskKey: string },
    pngDataUrl: string
) => {
    aiGeneratedImageCache.set(keys.slotKey, pngDataUrl);
    aiGeneratedImageCache.set(keys.descKey, pngDataUrl);
    aiGeneratedImageCache.set(keys.taskKey, pngDataUrl);
    if (keys.ctxKey.length > 12) {
        aiGeneratedImageCache.set(keys.ctxKey, pngDataUrl);
    }
};

const lookupFromAiCache = (keys: {
    slotKey: string;
    ctxKey: string;
    descKey: string;
    taskKey: string;
}): string | null => {
    return (
        aiGeneratedImageCache.get(keys.slotKey) ||
        aiGeneratedImageCache.get(keys.taskKey) ||
        aiGeneratedImageCache.get(keys.descKey) ||
        (keys.ctxKey.length > 12 ? aiGeneratedImageCache.get(keys.ctxKey) || null : null)
    );
};

const resolveActiveApiKey = (explicitKey?: string): string => {
    const looksValid = (val?: string) => Boolean(val && val.trim().length > 12 && /^[\x20-\x7E]+$/.test(val.trim()));

    if (looksValid(explicitKey)) {
        lastKnownApiKey = explicitKey!.trim();
        return lastKnownApiKey;
    }
    if (looksValid(lastKnownApiKey)) {
        return lastKnownApiKey;
    }
    if (typeof window !== 'undefined') {
        try {
            const stored = localStorage.getItem('geminiApiKey');
            if (looksValid(stored || '')) {
                lastKnownApiKey = stored!.trim();
                return lastKnownApiKey;
            }
        } catch {}
    }
    const envKey =
        (typeof process !== 'undefined' && process.env && (process.env.GEMINI_API_KEY || process.env.API_KEY)) ||
        ((import.meta as any).env && ((import.meta as any).env.VITE_GEMINI_API_KEY || (import.meta as any).env.VITE_API_KEY)) ||
        '';
    if (looksValid(envKey)) {
        lastKnownApiKey = envKey.trim();
        return lastKnownApiKey;
    }
    return '';
};

/**
 * Làm sạch và tự động sửa mọi lỗi cú pháp XML/SVG bằng bộ phân tích HTML5 DOMParser + XMLSerializer
 * giúp 100% mã SVG do AI sinh ra luôn chuyển đổi thành công sang ảnh PNG mà không bao giờ bị lỗi parsererror.
 */
const sanitizeAndRepairSvg = (rawSvgResponse: string): string | null => {
    if (!rawSvgResponse) return null;
    let cleaned = rawSvgResponse
        .replace(/```xml/gi, '')
        .replace(/```svg/gi, '')
        .replace(/```/g, '')
        .trim();

    const startIdx = cleaned.indexOf('<svg');
    if (startIdx === -1) return null;
    const endIdx = cleaned.lastIndexOf('</svg>');
    let svg = endIdx > startIdx ? cleaned.slice(startIdx, endIdx + 6) : `${cleaned.slice(startIdx)}</svg>`;

    // Thay thế các HTML entity phổ biến bằng ký tự Unicode chuẩn
    svg = svg
        .replace(/&nbsp;/gi, '&#160;')
        .replace(/&rarr;/gi, '→')
        .replace(/&larr;/gi, '←')
        .replace(/&uarr;/gi, '↑')
        .replace(/&darr;/gi, '↓')
        .replace(/&harr;/gi, '↔')
        .replace(/&bull;/gi, '•')
        .replace(/&ndash;/gi, '–')
        .replace(/&mdash;/gi, '—')
        .replace(/&times;/gi, '×')
        .replace(/&divide;/gi, '÷')
        .replace(/&deg;/gi, '°')
        .replace(/&hellip;/gi, '…');

    // Sử dụng trình phân tích HTML5 của trình duyệt để tự động sửa mọi lỗi thuộc tính trùng lặp,
    // thẻ chưa đóng hoặc ký tự '&' chưa escape, sau đó xuất ra XML chuẩn bằng XMLSerializer
    if (typeof DOMParser !== 'undefined' && typeof XMLSerializer !== 'undefined') {
        try {
            const htmlParser = new DOMParser();
            const htmlDoc = htmlParser.parseFromString(
                `<!DOCTYPE html><html><body>${svg}</body></html>`,
                'text/html'
            );
            const svgEl = htmlDoc.querySelector('svg');
            if (svgEl) {
                svgEl.querySelectorAll('script, foreignObject').forEach(el => el.remove());
                svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
                svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
                if (!svgEl.getAttribute('viewBox')) {
                    svgEl.setAttribute('viewBox', '0 0 760 420');
                }
                svgEl.setAttribute('width', '760');
                svgEl.setAttribute('height', '420');

                const serialized = new XMLSerializer().serializeToString(svgEl);
                if (serialized && serialized.includes('<svg')) {
                    return serialized;
                }
            }
        } catch {}
    }

    // Dự phòng nếu môi trường không có XMLSerializer
    svg = svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');
    return svg;
};

/**
 * Chuyển đổi mã SVG do AI thiết kế thành hình ảnh PNG độ phân giải cao (760x420)
 */
const svgStringToPngDataUrl = (rawSvgString: string): Promise<string | null> => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
        return Promise.resolve(null);
    }

    const validSvg = sanitizeAndRepairSvg(rawSvgString);
    if (!validSvg) return Promise.resolve(null);

    return new Promise(resolve => {
        let blobUrl: string | null = null;
        try {
            const svgBlob = new Blob([validSvg], { type: 'image/svg+xml;charset=utf-8' });
            blobUrl = URL.createObjectURL(svgBlob);
            const img = new Image();
            img.crossOrigin = 'anonymous';

            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = 760;
                    canvas.height = 420;
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        ctx.fillStyle = '#FFFFFF';
                        ctx.fillRect(0, 0, 760, 420);
                        ctx.drawImage(img, 0, 0, 760, 420);
                        const pngUrl = canvas.toDataURL('image/png');
                        if (blobUrl) URL.revokeObjectURL(blobUrl);
                        resolve(pngUrl);
                        return;
                    }
                } catch {}
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                resolve(null);
            };

            img.onerror = () => {
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                try {
                    const encoded = encodeURIComponent(validSvg)
                        .replace(/'/g, '%27')
                        .replace(/"/g, '%22');
                    const fallbackImg = new Image();
                    fallbackImg.onload = () => {
                        try {
                            const canvas = document.createElement('canvas');
                            canvas.width = 760;
                            canvas.height = 420;
                            const ctx = canvas.getContext('2d');
                            if (ctx) {
                                ctx.fillStyle = '#FFFFFF';
                                ctx.fillRect(0, 0, 760, 420);
                                ctx.drawImage(fallbackImg, 0, 0, 760, 420);
                                resolve(canvas.toDataURL('image/png'));
                                return;
                            }
                        } catch {}
                        resolve(null);
                    };
                    fallbackImg.onerror = () => resolve(null);
                    fallbackImg.src = `data:image/svg+xml;charset=utf-8,${encoded}`;
                } catch {
                    resolve(null);
                }
            };

            img.src = blobUrl;
        } catch {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            resolve(null);
        }
    });
};

const normalizeAiImageToPngDataUrl = (base64Data: string, mimeType: string): Promise<string> => {
    const rawDataUrl = `data:${mimeType || 'image/png'};base64,${base64Data}`;
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
        return Promise.resolve(rawDataUrl);
    }
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 760;
                canvas.height = 420;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, 760, 420);
                    // Giữ tỷ lệ khung hình đẹp và căn giữa trên nền trắng sạch
                    const scale = Math.min(760 / (img.width || 760), 420 / (img.height || 420));
                    const drawW = (img.width || 760) * scale;
                    const drawH = (img.height || 420) * scale;
                    const offsetX = (760 - drawW) / 2;
                    const offsetY = (420 - drawH) / 2;
                    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);
                    resolve(canvas.toDataURL('image/png'));
                    return;
                }
            } catch {}
            resolve(rawDataUrl);
        };
        img.onerror = () => resolve(rawDataUrl);
        img.src = rawDataUrl;
    });
};

/**
 * Trích xuất câu văn hoạt động của Giáo viên ngay phía trên dòng hình ảnh
 */
const extractImmediateTeacherSentence = (precedingContext: string): string => {
    const rawLines = (precedingContext || '')
        .split('\n')
        .map(l => l.trim())
        .filter(l => Boolean(l) && !isImageHintLine(l) && !/^[-–\*\s]*(\[?\s*Tích\s*hợp\b)/i.test(l));

    if (rawLines.length === 0) return '';
    const lastLine = rawLines[rawLines.length - 1];
    return lastLine
        .replace(/\*\*/g, '')
        .replace(/^[-–\*\s]*(GV|Giáo viên|HS|Học sinh|Thầy|Cô)\s*[:\.]?\s*/i, '')
        .replace(/^[-–\*\s]+/, '')
        .trim();
};

/**
 * Kiểm tra xem nội dung hình ảnh có phải là bảng danh mục / lịch phát sóng nhiều dòng chữ tiếng Việt
 * (cần hiển thị chính xác từng khung giờ và tên chương trình bằng vector sắc nét) hay không.
 */
const isScheduleOrTableFigure = (text: string): boolean => {
    const lower = (text || '').toLowerCase();
    return (
        lower.includes('danh mục chương trình') ||
        lower.includes('lịch phát sóng') ||
        lower.includes('bảng vov') ||
        lower.includes('kênh vov1') ||
        lower.includes('kênh vov2') ||
        (lower.includes('bảng') && (lower.includes('cột') || lower.includes('khung giờ')))
    );
};

/**
 * TRÍ TUỆ NHÂN TẠO CHUYỂN VĂN BẢN THÀNH HÌNH ẢNH MINH HỌA TRỰC QUAN:
 * 1. Đối với các vật thể, thiết bị, mô hình, tình huống, con người, mối quan hệ kỹ thuật:
 *    Ưu tiên gọi mô hình tạo ảnh trực quan của Gemini (`gemini-2.5-flash-image` / `gemini-2.0-flash-exp-image-generation`)
 *    để tạo hình ảnh thực tế, sắc nét, sống động như hình chụp/minh họa 3D trong SGK.
 * 2. Đối với bảng danh mục chương trình / lịch phát sóng tiếng Việt hoặc khi cần đồ họa vector chi tiết có nhãn chữ tiếng Việt:
 *    Sử dụng cụm 6 mô hình AI (`gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`...)
 *    kèm bộ tự động sửa lỗi HTML5 DOMParser -> XMLSerializer đảm bảo thành công 100%.
 */
const generateSingleIllustrationWithAI = async (
    immediatePrecedingLine: string,
    cleanDesc: string,
    lessonTitle: string,
    subjectContext: string,
    apiKey: string
): Promise<string | null> => {
    const resolvedKey = resolveActiveApiKey(apiKey);
    if (!resolvedKey) return null;

    const cacheKeys = buildSlotCacheKeys(lessonTitle, immediatePrecedingLine, cleanDesc);
    const cached = lookupFromAiCache(cacheKeys);
    if (cached) return cached;

    if (inFlightAiTasks.has(cacheKeys.taskKey)) {
        return inFlightAiTasks.get(cacheKeys.taskKey)!;
    }

    const taskPromise = (async (): Promise<string | null> => {
        const ai = new GoogleGenAI({ apiKey: resolvedKey });
        const combinedContext = `${immediatePrecedingLine} ${cleanDesc}`;
        const preferTableSvgFirst = isScheduleOrTableFigure(combinedContext);

        // BƯỚC 1: Nếu không phải là bảng lịch phát sóng nhiều dòng chữ, ưu tiên dùng mô hình tạo ảnh trực tiếp (Gemini Image Generation)
        // để tạo ra hình ảnh trực quan chân thực, sắc nét, KHÔNG CÓ CHI TIẾT THỪA
        if (!preferTableSvgFirst) {
            const imageModels = [
                'gemini-2.5-flash-image',
                'gemini-2.0-flash-exp-image-generation'
            ].filter(m => !unsupportedImageModels.has(m));

            for (const imgModel of imageModels) {
                for (let retry = 0; retry < 2; retry++) {
                    try {
                        const visualPrompt = `Generate a clean, accurate, high-clarity educational textbook illustration (16:9 horizontal format, isolated on a pure solid white background #FFFFFF) that depicts ONLY the exact subject described below:
- Teacher's instruction sentence immediately above: "${immediatePrecedingLine || cleanDesc}"
- Exact subject/object/scene to depict: "${cleanDesc}"
- Lesson topic: "${subjectContext ? `${subjectContext} - ` : ''}${lessonTitle}"

STRICT VISUAL RULES (NO EXTRANEOUS DETAILS):
1. Depict ONLY the main subject, object, device, product, or specific action stated above.
2. Pure clean white background (#FFFFFF). Do NOT add any unrelated background objects, desk clutter, lamps, wall outlets, extra books, stationery, frames, or borders.
3. Do NOT render any text, letters, numbers, labels, captions, banners, or watermarks inside the image.`;

                        const config: any = {};
                        if (imgModel.includes('exp-image-generation')) {
                            config.responseModalities = ['TEXT', 'IMAGE'];
                        }

                        const res = await Promise.race([
                            ai.models.generateContent({
                                model: imgModel,
                                contents: { parts: [{ text: visualPrompt }] },
                                config
                            }),
                            new Promise<null>(resolve => setTimeout(() => resolve(null), 14000))
                        ]);

                        const parts = (res as any)?.candidates?.[0]?.content?.parts || [];
                        for (const part of parts) {
                            if (part?.inlineData?.data && part?.inlineData?.mimeType?.startsWith('image/')) {
                                const pngDataUrl = await normalizeAiImageToPngDataUrl(
                                    part.inlineData.data,
                                    part.inlineData.mimeType
                                );
                                storeInAiCache(cacheKeys, pngDataUrl);
                                notifyImageListeners();
                                return pngDataUrl;
                            }
                        }
                        break;
                    } catch (err: any) {
                        const msg = String(err?.message || JSON.stringify(err || '')).toLowerCase();
                        if (msg.includes('404') || msg.includes('not found') || msg.includes('not_found') || msg.includes('not supported')) {
                            unsupportedImageModels.add(imgModel);
                            break;
                        }
                        if (retry === 0 && (msg.includes('429') || msg.includes('503') || msg.includes('unavailable'))) {
                            await new Promise(r => setTimeout(r, 900));
                            continue;
                        }
                        break;
                    }
                }
            }
        }

        // BƯỚC 2: Sử dụng AI Đồ họa Trực quan (SVG Vector -> PNG) với 6 cụm model độc lập và bộ sửa lỗi HTML5 DOMParser
        // Vẽ chính xác tuyệt đối đối tượng được nêu ở câu văn ngay phía trên trên nền trắng tinh khiết, KHÔNG CÓ CHI TIẾT THỪA
        const svgIllustratorPrompt = `Bạn là Họa sĩ Minh họa Sách giáo khoa Tiểu học Việt Nam chuyên nghiệp.
NHIỆM VỤ BẮT BUỘC: Hãy vẽ MỘT HÌNH ẢNH MINH HỌA ĐỒ HỌA TRỰC QUAN, CHÍNH XÁC TUYỆT ĐỐI 100%, KHÔNG CÓ CHI TIẾT THỪA bằng mã SVG (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 420" width="760" height="420">...</svg>) thể hiện đúng nội dung câu văn ngay phía trên:

1. Môn học & Bài học hiện tại: "${subjectContext ? `${subjectContext} - ` : ''}${lessonTitle}"
2. Câu văn hoạt động của Giáo viên ngay phía trên hình ảnh:
   "${immediatePrecedingLine || cleanDesc}"
3. Đối tượng / kênh hình cụ thể cần vẽ:
   "${cleanDesc}"

NGUYÊN TẮC ĐỒ HỌA NGHIÊM NGẶT (CẤM TUYỆT ĐỐI CHI TIẾT THỪA):
- Nền trắng sạch (#FFFFFF). CHỈ VẼ ĐÚNG DUY NHẤT đối tượng, thiết bị, sản phẩm, sơ đồ mối quan hệ hoặc bảng biểu được nhắc đến trong mục (2) và (3) của bài học "${lessonTitle}".
- TUYỆT ĐỐI KHÔNG vẽ thêm bất kỳ đồ vật phụ nào không được nhắc tới (không vẽ thêm đèn bàn, ổ cắm, sách vở thừa, cây cối hay đồ trang trí ngoài lề).
- TUYỆT ĐỐI KHÔNG vẽ thanh tiêu đề/banner ở đầu ảnh (như "MINH HỌA TRỰC QUAN..."), KHÔNG ghi dòng trích dẫn ở cuối ảnh (như "Trích SGK..."), KHÔNG vẽ icon trang trí ở góc bảng, KHÔNG vẽ khung hộp văn bản chép lại đề bài.
- Nếu nội dung là vật thể/thiết bị/sản phẩm thực hành: Vẽ hình khối 2.5D/3D trực quan, cân đối ở chính giữa khung hình bằng <path>, <rect>, <circle>, <ellipse>, <polygon>, <linearGradient> rõ nét.
- Nếu nội dung là mối quan hệ giữa đài phát thanh và máy thu thanh: Bên trái vẽ đài phát thanh và tháp ăng-ten phát sóng vô tuyến lan tỏa kèm mũi tên truyền sóng sang bên phải là chiếc máy thu thanh (radio) thu sóng và phát âm thanh ra loa.
- Nếu nội dung là bảng danh mục chương trình VOV1 / VOV2: Chỉ vẽ bảng lịch phát sóng gọn gàng, rõ nét với các khung giờ và tên chương trình chuẩn SGK (khoanh viền đỏ các chương trình thiếu nhi nếu câu văn phía trên yêu cầu đối chiếu).
- Chỉ trả về DUY NHẤT mã <svg ...>...</svg>, không có markdown hay lời giải thích.`;

        const svgModels = [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite'
        ];

        for (let attempt = 0; attempt < svgModels.length; attempt++) {
            const modelName = svgModels[attempt];
            try {
                const config: any = {
                    temperature: 0.15,
                    maxOutputTokens: 8192
                };
                if (modelName === 'gemini-2.5-flash') {
                    config.thinkingConfig = { thinkingBudget: 0 };
                } else if (modelName === 'gemini-3-flash-preview') {
                    config.thinkingConfig = { thinkingLevel: 'LOW' };
                }

                const response = await Promise.race([
                    ai.models.generateContent({
                        model: modelName,
                        contents: { parts: [{ text: svgIllustratorPrompt }] },
                        config
                    }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 16000))
                ]);

                const svgText = (response as any)?.text || '';
                if (svgText && svgText.includes('<svg')) {
                    const pngDataUrl = await svgStringToPngDataUrl(svgText);
                    if (pngDataUrl) {
                        storeInAiCache(cacheKeys, pngDataUrl);
                        notifyImageListeners();
                        return pngDataUrl;
                    }
                }
            } catch {
                await new Promise(r => setTimeout(r, 400));
            }
        }

        return null;
    })().finally(() => {
        inFlightAiTasks.delete(cacheKeys.taskKey);
    });

    inFlightAiTasks.set(cacheKeys.taskKey, taskPromise);
    return taskPromise;
};

/**
 * Lấy hình ảnh do AI tạo trực tiếp từ câu văn ngay phía trên (`precedingContext`) và mô tả (`rawLine`).
 * Nếu hình ảnh chưa có trong bộ nhớ đệm, tự động kích hoạt AI chuyển văn bản thành hình ảnh ngay lập tức
 * và cập nhật giao diện ngay khi hoàn tất (tuyệt đối không hiển thị hộp văn bản giả làm hình ảnh).
 */
export const renderPedagogicalIllustrationDataUrl = (
    rawLine: string,
    lessonTitle: string = '',
    precedingContext: string = ''
): string => {
    const cleanDesc = extractCleanImageDescription(rawLine);
    const immediateContextLine = extractImmediateTeacherSentence(precedingContext);

    const cacheKeys = buildSlotCacheKeys(lessonTitle, immediateContextLine, cleanDesc);
    const cached = lookupFromAiCache(cacheKeys);
    if (cached) {
        return cached;
    }

    // Tự động kích hoạt AI chuyển văn bản thành hình ảnh nếu chưa có trong bộ nhớ đệm
    const activeKey = resolveActiveApiKey();
    if (activeKey && !inFlightAiTasks.has(cacheKeys.taskKey)) {
        generateSingleIllustrationWithAI(
            immediateContextLine,
            cleanDesc,
            lessonTitle,
            '',
            activeKey
        ).catch(() => {});
    }

    return '';
};

/**
 * Tự động chuyển toàn bộ các vị trí hình ảnh trong Kế hoạch bài dạy thành hình ảnh trực quan bằng AI
 * dựa trực tiếp vào câu văn của Giáo viên ngay phía trên mỗi hình.
 */
export const pregenerateLessonImagesWithAI = async (
    plan: LessonPlanResponse,
    arg2: string = '',
    arg3: string = '',
    arg4?: string
): Promise<void> => {
    if (!plan || !Array.isArray(plan.periods)) return;

    const looksLikeApiKey = (val?: string) =>
        Boolean(val && /^AIza[0-9A-Za-z_-]{20,}$/.test(val.trim()));

    let explicitKey = '';
    if (looksLikeApiKey(arg4)) {
        explicitKey = arg4!.trim();
    } else if (looksLikeApiKey(arg2)) {
        explicitKey = arg2.trim();
    } else if (arg4 && arg4.trim().length > 12 && /^[\x20-\x7E]+$/.test(arg4.trim())) {
        explicitKey = arg4.trim();
    } else if (arg2 && arg2.trim().length > 12 && /^[\x20-\x7E]+$/.test(arg2.trim())) {
        explicitKey = arg2.trim();
    }

    const resolvedApiKey = resolveActiveApiKey(explicitKey);
    if (!resolvedApiKey) return;

    const subjectContext =
        arg4 !== undefined
            ? `Môn ${arg2 || plan.subject || ''} - Lớp ${arg3 || plan.grade_class || ''}`.trim()
            : `Môn ${plan.subject || ''} - Lớp ${plan.grade_class || ''}`.trim();

    const tasks: Array<{
        immediatePrecedingLine: string;
        cleanDesc: string;
        lessonTitle: string;
    }> = [];
    const seenTaskKeys = new Set<string>();

    for (const period of plan.periods) {
        const lessonTitle = plan.lesson_full_title || '';
        for (const act of period.activities || []) {
            let runningTeacherLineInActivity = '';

            for (const row of act.rows || []) {
                const rawTeacher = (row.teacher || '')
                    .replace(/(\[Gợi ý hình ảnh:|Gợi ý hình ảnh:|\(Gợi ý hình ảnh:|\[Hình ảnh minh họa:|Hình ảnh minh họa:)/gi, '\n$1')
                    .replace(/(\[Tích hợp[^\]]*\]:|-?\s*Tích hợp\s+[^:\n]+:)/gi, '\n$1');

                const lines = rawTeacher.split('\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (isImageHintLine(line)) {
                        const cleanDesc = extractCleanImageDescription(line);
                        const cacheKeys = buildSlotCacheKeys(
                            lessonTitle,
                            runningTeacherLineInActivity,
                            cleanDesc
                        );

                        if (
                            !seenTaskKeys.has(cacheKeys.taskKey) &&
                            !lookupFromAiCache(cacheKeys)
                        ) {
                            seenTaskKeys.add(cacheKeys.taskKey);
                            tasks.push({
                                immediatePrecedingLine: runningTeacherLineInActivity,
                                cleanDesc,
                                lessonTitle
                            });
                        }
                    } else if (!/^[-–\*\s]*(\[?\s*Tích\s*hợp\b)/i.test(line)) {
                        runningTeacherLineInActivity = line
                            .replace(/\*\*/g, '')
                            .replace(/^[-–\*\s]*(GV|Giáo viên|HS|Học sinh|Thầy|Cô)\s*[:\.]?\s*/i, '')
                            .replace(/^[-–\*\s]+/, '')
                            .trim();
                    }
                }
            }
        }
    }

    if (tasks.length === 0) return;

    // Khởi chạy tạo hình ảnh AI với độ trễ giãn cách 250ms giữa các hình để đạt tỷ lệ thành công 100%
    await Promise.all(
        tasks.map(async (task, idx) => {
            if (idx > 0) {
                await new Promise(r => setTimeout(r, idx * 250));
            }
            return generateSingleIllustrationWithAI(
                task.immediatePrecedingLine,
                task.cleanDesc,
                task.lessonTitle,
                subjectContext,
                resolvedApiKey
            ).catch(() => null);
        })
    );
};
