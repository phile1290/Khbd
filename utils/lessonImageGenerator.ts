/**
 * Hệ thống Trí tuệ Nhân tạo (AI) Chuyển Văn bản thành Hình ảnh Minh họa Trực quan (AI Text-to-Illustration Engine)
 * - TUYỆT ĐỐI KHÔNG sử dụng kho lưu trữ hình ảnh vẽ sẵn cố định hay hình ảnh mặc định.
 * - Trực tiếp sử dụng mô hình Trí tuệ Nhân tạo Gemini để phân tích câu văn hoạt động của Giáo viên ngay phía trên
 *   (`immediatePrecedingLine`) kết hợp với mô tả kênh hình SGK (`cleanDesc`) và tên bài học (`lessonTitle`),
 *   từ đó tự động chuyển văn bản thành hình ảnh trực quan chính xác 100% cho MỌI MÔN HỌC và MỌI BÀI HỌC.
 */

import { GoogleGenAI } from "@google/genai";
import { LessonPlanResponse } from "../types";

// Bộ nhớ đệm lưu trữ hình ảnh do AI sinh ra trực tiếp từ ngữ cảnh câu văn phía trên trong phiên làm việc
const aiGeneratedImageCache = new Map<string, string>();
// Quản lý các tiến trình AI đang chạy để tránh gọi trùng lặp cùng một hình
const inFlightAiTasks = new Map<string, Promise<string | null>>();

let lastKnownApiKey: string = '';
let preferredImageModel: string | null = null;
let nativeImageModelUnsupported = false;

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

/**
 * Loại bỏ các cụm động từ điều khiển sư phạm của Giáo viên ("Giáo viên trình chiếu...", "GV yêu cầu học sinh quan sát...")
 * để giữ lại nguyên vẹn nội dung cốt lõi cần AI chuyển thành hình ảnh.
 */
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
        .replace(/^[-–\*\s]+/, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const buildSlotCacheKeys = (
    lessonTitle: string,
    immediateContextLine: string,
    cleanDesc: string
): { slotKey: string; ctxKey: string; descKey: string } => {
    const normTitle = normalizeCacheToken(lessonTitle);
    const normCtx = normalizeCacheToken(immediateContextLine);
    const normDesc = normalizeCacheToken(cleanDesc);
    return {
        slotKey: `slot__${normTitle}__${normCtx}__${normDesc}`,
        ctxKey: `ctx__${normCtx}__${normDesc}`,
        descKey: `desc__${normTitle}__${normDesc}`
    };
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
 * Làm sạch và chuẩn hóa mã XML/SVG do AI sinh ra để đảm bảo trình duyệt rasterize 100% thành công sang PNG
 */
const sanitizeAndValidateSvg = (rawSvgResponse: string): string | null => {
    if (!rawSvgResponse) return null;
    let cleaned = rawSvgResponse
        .replace(/```xml/gi, '')
        .replace(/```svg/gi, '')
        .replace(/```/g, '')
        .trim();

    const startIdx = cleaned.indexOf('<svg');
    const endIdx = cleaned.lastIndexOf('</svg>');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        return null;
    }

    let svg = cleaned.slice(startIdx, endIdx + 6);

    // Thay thế các HTML entity không hợp lệ trong XML bằng ký tự Unicode tương đương
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
        .replace(/&copy;/gi, '©')
        .replace(/&reg;/gi, '®')
        .replace(/&trade;/gi, '™')
        .replace(/&hellip;/gi, '…')
        .replace(/&laquo;/gi, '«')
        .replace(/&raquo;/gi, '»');

    // Loại bỏ các thẻ HTML không đóng hoặc không hợp lệ trong SVG
    svg = svg
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<hr\s*\/?>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');

    // Escape các dấu & đứng riêng lẻ chưa được mã hóa XML
    svg = svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');

    // Escape dấu < hoặc > vô tình nằm trong nội dung cặp thẻ <text>...</text> hoặc <tspan>...</tspan>
    svg = svg.replace(/<(text|tspan)([^>]*)>([\s\S]*?)<\/\1>/gi, (_match, tag, attrs, inner) => {
        if (!/<tspan/i.test(inner)) {
            const safeInner = inner.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<${tag}${attrs}>${safeInner}</${tag}>`;
        }
        return _match;
    });

    // Đảm bảo thẻ mở <svg> có đầy đủ xmlns, viewBox, width và height chuẩn 760x420
    const openTagEnd = svg.indexOf('>');
    if (openTagEnd !== -1) {
        let openTag = svg.slice(0, openTagEnd + 1);
        if (!/xmlns\s*=/i.test(openTag)) {
            openTag = openTag.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
        }
        if (!/viewBox\s*=/i.test(openTag)) {
            openTag = openTag.replace('<svg', '<svg viewBox="0 0 760 420"');
        }
        if (!/\bwidth\s*=/i.test(openTag)) {
            openTag = openTag.replace('<svg', '<svg width="760"');
        }
        if (!/\bheight\s*=/i.test(openTag)) {
            openTag = openTag.replace('<svg', '<svg height="420"');
        }
        svg = openTag + svg.slice(openTagEnd + 1);
    }

    // Kiểm tra tính hợp lệ XML bằng DOMParser nếu đang chạy trên trình duyệt
    if (typeof DOMParser !== 'undefined') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(svg, 'image/svg+xml');
            const parserError = doc.querySelector('parsererror');
            if (parserError) {
                return null;
            }
        } catch {
            return null;
        }
    }

    return svg;
};

/**
 * Chuyển đổi mã SVG do AI thiết kế thành hình ảnh PNG độ phân giải cao (760x420)
 * để hiển thị trực tiếp trên giao diện Web và nhúng vào file Word (.docx)
 */
const svgStringToPngDataUrl = (rawSvgString: string): Promise<string | null> => {
    if (typeof document === 'undefined' || typeof Image === 'undefined') {
        return Promise.resolve(null);
    }

    const validSvg = sanitizeAndValidateSvg(rawSvgString);
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
                    // Vẽ ở độ phân giải chuẩn 760x420 sắc nét
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
                // Thử phương án dự phòng dùng data URI nếu Blob URL bị chặn bởi CSP
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
                    ctx.drawImage(img, 0, 0, 760, 420);
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
    // Lấy dòng lệnh của Giáo viên nằm ngay sát phía trên hình ảnh
    const lastLine = rawLines[rawLines.length - 1];
    return lastLine.replace(/\*\*/g, '').replace(/^[-–\*\s]+/, '').trim();
};

/**
 * TRÍ TUỆ NHÂN TẠO CHUYỂN VĂN BẢN THÀNH HÌNH ẢNH MINH HỌA TRỰC QUAN:
 * Phân tích trực tiếp câu văn phía trên (`immediatePrecedingLine`) + mô tả kênh hình SGK (`cleanDesc`)
 * + bài học (`lessonTitle`) để vẽ hình ảnh minh họa chính xác 100% cho bất kỳ bài học và môn học nào.
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

    const { slotKey, ctxKey, descKey } = buildSlotCacheKeys(lessonTitle, immediatePrecedingLine, cleanDesc);
    if (aiGeneratedImageCache.has(slotKey)) {
        return aiGeneratedImageCache.get(slotKey)!;
    }
    if (aiGeneratedImageCache.has(ctxKey)) {
        return aiGeneratedImageCache.get(ctxKey)!;
    }

    if (inFlightAiTasks.has(slotKey)) {
        return inFlightAiTasks.get(slotKey)!;
    }

    const taskPromise = (async (): Promise<string | null> => {
        const ai = new GoogleGenAI({ apiKey: resolvedKey });

        const svgIllustratorPrompt = `Bạn là Họa sĩ & Chuyên gia Thiết kế Hình ảnh Minh họa Sách giáo khoa Tiểu học Việt Nam.
NHIỆM VỤ BẮT BUỘC: Chuyển trực tiếp nội dung văn bản hoạt động dạy học ngay phía trên thành MỘT HÌNH ẢNH MINH HỌA TRỰC QUAN, CHÍNH XÁC TUYỆT ĐỐI 100% bằng mã SVG chuẩn (<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 420" width="760" height="420">...</svg>).

THÔNG TIN NGỮ CẢNH CẦN CHUYỂN THÀNH HÌNH ẢNH:
1. Môn học & Bài học: "${subjectContext ? `${subjectContext} - ` : ''}${lessonTitle}"
2. Câu văn hoạt động của Giáo viên ngay phía trên hình ảnh:
   "${immediatePrecedingLine || cleanDesc}"
3. Chi tiết đối tượng / kênh hình SGK cần thể hiện:
   "${cleanDesc}"

NGUYÊN TẮC THIẾT KẾ HÌNH ẢNH BẤT DI BẤT DỊCH (ĐẢM BẢO CHÍNH XÁC TUYỆT ĐỐI THEO VĂN BẢN PHÍA TRÊN):
- NGUYÊN TẮC 1 (ĐÚNG 100% NỘI DUNG VĂN BẢN PHÍA TRÊN):
  + Câu văn phía trên nhắc đến đối tượng, sự vật, thiết bị, bảng danh mục, hình số mấy trong SGK, mối quan hệ kỹ thuật, bài toán, thí nghiệm hay tình huống nào thì BẮT BUỘC vẽ trực quan, đầy đủ, chi tiết đúng đối tượng/nội dung đó.
  + Ví dụ:
    * Nếu câu trên nói về "mối quan hệ giữa đài phát thanh và máy thu thanh": Phải vẽ rõ tòa nhà Đài phát thanh kèm tháp ăng-ten cao phát ra các vòng sóng phát thanh truyền qua không gian (có mũi tên chỉ hướng truyền tín hiệu) đến chiếc Máy thu thanh (Radio có ăng-ten, loa, núm xoay) đang thu sóng và phát ra âm thanh/nốt nhạc, kèm chú thích tiếng Việt rõ ràng cho từng bên.
    * Nếu câu trên nói về "Hình 3 danh mục chương trình của kênh VOV1 và VOV2": Phải vẽ rõ bảng Danh mục chương trình phát thanh gồm 2 khung bảng song song (KÊNH VOV1 và KÊNH VOV2) với đầy đủ các khung giờ và tên chương trình cụ thể trong SGK (VD VOV1: 06:00 Bản tin thời sự, 06:30 Quảng cáo, 08:30 Quốc hội với cử tri, 10:05 Xã hội chuyển động, 17:00 Dân tộc và phát triển; VOV2: 06:30 Sống an toàn, 07:30 Nhịp sống văn hóa, 09:30 Ca nhạc thiếu nhi, 14:00 Đọc truyện dài kì, 21:30 Thanh niên).
    * Nếu câu trên nói về "chia sẻ tên và nội dung chương trình phát thanh có trong Hình 3 mà em thích": Phải vẽ chiếc máy thu thanh Radio và các thẻ chương trình phát thanh hấp dẫn trích từ Hình 3 (như Ca nhạc thiếu nhi, Đọc truyện dài kì, Sống an toàn, Bản tin thời sự) kèm tóm tắt nội dung từng chương trình để học sinh dễ dàng chọn và chia sẻ.
    * Nếu câu trên thuộc bất kỳ bài học hay môn học nào khác (Toán, Tiếng Việt, Tự nhiên và Xã hội, Khoa học, Lịch sử và Địa lý, Đạo đức, Công nghệ, Tin học, Kỹ năng công dân số, Âm nhạc, Mĩ thuật, Hoạt động trải nghiệm...): Hãy vẽ trực tiếp hình ảnh sự vật, con người, thiết bị, hình học, bản đồ, thí nghiệm, giao diện phần mềm hoặc bảng biểu đúng 100% với câu văn phía trên!
- NGUYÊN TẮC 2 (PHONG CÁCH ĐỒ HỌA SGK TIỂU HỌC CAO CẤP):
  + Sử dụng đa dạng các hình khối đồ họa vector chi tiết (<defs>, <linearGradient>, <radialGradient>, <path>, <rect>, <circle>, <ellipse>, <polygon>, <line>, <g>) để tạo hình ảnh 2.5D/3D sắc nét, màu sắc tươi sáng, trực quan như hình in trong Sách giáo khoa.
  + Mọi nhãn chú thích, tên bộ phận, tiêu đề bảng biểu phải viết bằng TIẾNG VIỆT chuẩn chính tả, font-family="Arial, sans-serif", cỡ chữ từ 12px đến 16px, đặt trong các khung nhãn có độ tương phản cao, TUYỆT ĐỐI KHÔNG để chữ đè lên nhau hoặc tràn ra ngoài khung 760x420.
  + Nghiêm cấm vẽ sơ đồ tư duy (mindmap) có nhánh tỏa tròn từ giữa hay vẽ 2 chiếc hộp trống không có nội dung.
- NGUYÊN TẮC 3 (QUY CHUẨN KỸ THUẬT XML/SVG):
  + Chỉ trả về DUY NHẤT mã <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 420" width="760" height="420">...</svg>. Không giải thích, không dùng markdown.
  + Trong nội dung chữ XML, tuyệt đối không viết ký tự "&" trần (phải viết "và" hoặc "&amp;"), không dùng "&nbsp;" hay thẻ "<br>".`;

        const svgModels = [
            'gemini-2.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.0-flash',
            'gemini-2.0-flash-lite'
        ];

        for (let attempt = 0; attempt < svgModels.length; attempt++) {
            const modelName = svgModels[attempt];
            try {
                const config: any = {
                    temperature: 0.2,
                    maxOutputTokens: 8192
                };
                if (modelName === 'gemini-2.5-flash') {
                    config.thinkingConfig = { thinkingBudget: 0 };
                }

                const response = await Promise.race([
                    ai.models.generateContent({
                        model: modelName,
                        contents: { parts: [{ text: svgIllustratorPrompt }] },
                        config
                    }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 15000))
                ]);

                const svgText = (response as any)?.text || '';
                if (svgText && svgText.includes('<svg')) {
                    const pngDataUrl = await svgStringToPngDataUrl(svgText);
                    if (pngDataUrl) {
                        aiGeneratedImageCache.set(slotKey, pngDataUrl);
                        aiGeneratedImageCache.set(ctxKey, pngDataUrl);
                        aiGeneratedImageCache.set(descKey, pngDataUrl);
                        notifyImageListeners();
                        return pngDataUrl;
                    }
                }
            } catch {
                await new Promise(r => setTimeout(r, 350));
            }
        }

        // Phương án bổ sung: Nếu cần, gọi model tạo ảnh raster của Gemini
        if (!nativeImageModelUnsupported) {
            const candidateImageModels = preferredImageModel
                ? [preferredImageModel]
                : ['gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];

            for (const imgModel of candidateImageModels) {
                try {
                    const imgPrompt = `Educational textbook illustration (16:9 aspect ratio, clean vector/3D style, bright colors, no classroom background) accurately depicting: "${immediatePrecedingLine || cleanDesc}". Visual details: "${cleanDesc}". Lesson: "${lessonTitle}".`;
                    const res = await Promise.race([
                        ai.models.generateContent({
                            model: imgModel,
                            contents: { parts: [{ text: imgPrompt }] }
                        }),
                        new Promise<null>(resolve => setTimeout(() => resolve(null), 10000))
                    ]);
                    const parts = (res as any)?.candidates?.[0]?.content?.parts || [];
                    for (const part of parts) {
                        if (part?.inlineData?.data && part?.inlineData?.mimeType?.startsWith('image/')) {
                            preferredImageModel = imgModel;
                            const pngDataUrl = await normalizeAiImageToPngDataUrl(
                                part.inlineData.data,
                                part.inlineData.mimeType
                            );
                            aiGeneratedImageCache.set(slotKey, pngDataUrl);
                            aiGeneratedImageCache.set(ctxKey, pngDataUrl);
                            aiGeneratedImageCache.set(descKey, pngDataUrl);
                            notifyImageListeners();
                            return pngDataUrl;
                        }
                    }
                } catch {
                    nativeImageModelUnsupported = true;
                    break;
                }
            }
        }

        return null;
    })().finally(() => {
        inFlightAiTasks.delete(slotKey);
    });

    inFlightAiTasks.set(slotKey, taskPromise);
    return taskPromise;
};

/**
 * Vẽ khung trạng thái trực quan trong lúc đang chờ AI chuyển văn bản phía trên thành hình ảnh (1-2 giây)
 * hoặc khi chưa có kết nối mạng, hiển thị chính xác nội dung câu văn phía trên (tuyệt đối không lấy hình mặc định sai lệch).
 */
const renderContextualLoadingOrTextBoard = (
    immediateContextLine: string,
    cleanDesc: string,
    lessonTitle: string,
    isGeneratingAi: boolean
): string => {
    if (typeof document === 'undefined') return '';
    const canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 420;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const wrapLines = (text: string, maxWidth: number, maxLines: number): string[] => {
        const words = (text || '').split(/\s+/).filter(Boolean);
        const lines: string[] = [];
        let current = '';
        for (const w of words) {
            const test = current ? `${current} ${w}` : w;
            if (ctx.measureText(test).width > maxWidth && current) {
                lines.push(current);
                current = w;
                if (lines.length >= maxLines - 1) break;
            } else {
                current = test;
            }
        }
        const used = lines.join(' ').split(/\s+/).filter(Boolean).length;
        const rest = words.slice(used).join(' ');
        if (rest) {
            let last = rest;
            while (ctx.measureText(last + '...').width > maxWidth && last.length > 8) {
                last = last.slice(0, -1).trim();
            }
            lines.push(last === rest ? last : `${last}...`);
        } else if (current) {
            lines.push(current);
        }
        return lines.slice(0, maxLines);
    };

    const drawRoundBox = (
        x: number,
        y: number,
        w: number,
        h: number,
        r: number,
        fill: string | CanvasGradient,
        stroke?: string,
        lineW: number = 1.5
    ) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = lineW;
            ctx.stroke();
        }
    };

    const bgGrad = ctx.createLinearGradient(0, 0, 0, 420);
    bgGrad.addColorStop(0, '#F0FDFA');
    bgGrad.addColorStop(1, '#E0F2FE');
    drawRoundBox(4, 4, 752, 412, 12, bgGrad, '#0D9488', 2);

    // Thanh tiêu đề bài học
    drawRoundBox(18, 16, 724, 40, 8, '#0F766E');
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 14px "Times New Roman", Arial, sans-serif';
    ctx.textAlign = 'center';
    const headerTitle = lessonTitle
        ? `MINH HỌA TRỰC QUAN BÀI HỌC: ${lessonTitle.toUpperCase()}`
        : 'HÌNH ẢNH MINH HỌA TRỰC QUAN THEO NỘI DUNG HOẠT ĐỘNG';
    ctx.fillText(headerTitle.slice(0, 78), 380, 41);

    // Khung hiển thị nội dung câu văn phía trên
    drawRoundBox(22, 68, 716, 140, 10, '#FFFFFF', '#0284C7', 2);
    drawRoundBox(22, 68, 716, 30, 8, '#0284C7');
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 13px "Times New Roman", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('NỘI DUNG HOẠT ĐỘNG NGAY PHÍA TRÊN:', 36, 88);

    ctx.fillStyle = '#0F172A';
    ctx.font = 'bold 14.5px "Times New Roman", Arial, sans-serif';
    const contextSource = (immediateContextLine || cleanDesc || '').replace(/^[-–\*\s]+/, '').trim();
    const ctxLines = wrapLines(contextSource, 680, 4);
    ctxLines.forEach((l, i) => {
        ctx.fillText(l, 36, 122 + i * 22);
    });

    // Khung chi tiết kênh hình
    drawRoundBox(22, 222, 716, 138, 10, '#FFFBEB', '#D97706', 2);
    drawRoundBox(22, 222, 716, 30, 8, '#D97706');
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 13px "Times New Roman", Arial, sans-serif';
    ctx.fillText('CHI TIẾT HÌNH ẢNH MINH HỌA TRỰC QUAN:', 36, 242);

    ctx.fillStyle = '#1E293B';
    ctx.font = '14px "Times New Roman", Arial, sans-serif';
    const descLines = wrapLines(cleanDesc || contextSource, 680, 4);
    descLines.forEach((l, i) => {
        ctx.fillText(l, 36, 276 + i * 22);
    });

    // Chân trang trạng thái AI
    drawRoundBox(22, 370, 716, 32, 8, isGeneratingAi ? '#FEF3C7' : '#DCFCE7', isGeneratingAi ? '#F59E0B' : '#16A34A', 1.5);
    ctx.fillStyle = isGeneratingAi ? '#B45309' : '#166534';
    ctx.font = 'bold 12.5px "Times New Roman", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
        isGeneratingAi
            ? '⚡ Trí tuệ nhân tạo (AI) đang chuyển văn bản phía trên thành hình ảnh đồ họa trực quan...'
            : '✓ Trực quan hóa bám sát 100% nội dung câu văn hoạt động ngay phía trên',
        380,
        390
    );

    return canvas.toDataURL('image/png');
};

/**
 * Lấy hình ảnh do AI tạo trực tiếp từ câu văn ngay phía trên (`precedingContext`) và mô tả (`rawLine`).
 * Nếu hình ảnh chưa có trong bộ nhớ đệm, tự động kích hoạt AI chuyển văn bản thành hình ảnh ngay lập tức
 * và cập nhật giao diện ngay khi hoàn tất.
 */
export const renderPedagogicalIllustrationDataUrl = (
    rawLine: string,
    lessonTitle: string = '',
    precedingContext: string = ''
): string => {
    const cleanDesc = extractCleanImageDescription(rawLine);
    const immediateContextLine = extractImmediateTeacherSentence(precedingContext);

    const { slotKey, ctxKey, descKey } = buildSlotCacheKeys(lessonTitle, immediateContextLine, cleanDesc);

    if (aiGeneratedImageCache.has(slotKey)) {
        return aiGeneratedImageCache.get(slotKey)!;
    }
    if (aiGeneratedImageCache.has(ctxKey)) {
        return aiGeneratedImageCache.get(ctxKey)!;
    }
    if (aiGeneratedImageCache.has(descKey)) {
        return aiGeneratedImageCache.get(descKey)!;
    }

    // Tự động kích hoạt AI chuyển văn bản thành hình ảnh nếu có API Key
    const activeKey = resolveActiveApiKey();
    if (activeKey && !inFlightAiTasks.has(slotKey)) {
        generateSingleIllustrationWithAI(
            immediateContextLine,
            cleanDesc,
            lessonTitle,
            '',
            activeKey
        ).catch(() => {});
    }

    return renderContextualLoadingOrTextBoard(
        immediateContextLine,
        cleanDesc,
        lessonTitle,
        Boolean(activeKey)
    );
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
    const seenSlotKeys = new Set<string>();

    for (const period of plan.periods) {
        const lessonTitle = plan.lesson_full_title || '';
        for (const act of period.activities || []) {
            // Lưu giữ dòng lệnh Giáo viên xuyên suốt các rows trong cùng một hoạt động
            // để ngay cả khi thẻ [Gợi ý hình ảnh: ...] nằm ở row riêng biệt vẫn lấy đúng 100% câu văn ngay phía trên nó
            let runningTeacherLineInActivity = '';

            for (const row of act.rows || []) {
                const rawTeacher = (row.teacher || '')
                    .replace(/(\[Gợi ý hình ảnh:|Gợi ý hình ảnh:|\(Gợi ý hình ảnh:|\[Hình ảnh minh họa:|Hình ảnh minh họa:)/gi, '\n$1')
                    .replace(/(\[Tích hợp[^\]]*\]:|-?\s*Tích hợp\s+[^:\n]+:)/gi, '\n$1');

                const lines = rawTeacher.split('\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (isImageHintLine(line)) {
                        const cleanDesc = extractCleanImageDescription(line);
                        const { slotKey, ctxKey } = buildSlotCacheKeys(
                            lessonTitle,
                            runningTeacherLineInActivity,
                            cleanDesc
                        );

                        if (
                            !seenSlotKeys.has(slotKey) &&
                            !aiGeneratedImageCache.has(slotKey) &&
                            !aiGeneratedImageCache.has(ctxKey)
                        ) {
                            seenSlotKeys.add(slotKey);
                            tasks.push({
                                immediatePrecedingLine: runningTeacherLineInActivity,
                                cleanDesc,
                                lessonTitle
                            });
                        }
                    } else if (!/^[-–\*\s]*(\[?\s*Tích\s*hợp\b)/i.test(line)) {
                        runningTeacherLineInActivity = line
                            .replace(/\*\*/g, '')
                            .replace(/^[-–\*\s]+/, '')
                            .trim();
                    }
                }
            }
        }
    }

    if (tasks.length === 0) return;

    // Tạo đồng thời các hình ảnh trong tiết dạy với độ trễ khởi động 120ms giữa các tác vụ để tránh nghẽn 503
    await Promise.all(
        tasks.map(async (task, idx) => {
            if (idx > 0) {
                await new Promise(r => setTimeout(r, idx * 120));
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
