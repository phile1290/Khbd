import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { KhdhPlan, KhdhRow, KhdhSubjectData, PpctLesson } from "../types";
import { fileToBase64 } from "../utils";
import * as mammoth from "mammoth";

/**
 * Định dạng chuẩn tên bài dạy kèm số tiết: TÊN BÀI DẠY(T1), TÊN BÀI DẠY(T2)...
 * Không có khoảng cách trước ngoặc đơn theo đúng quy chuẩn sư phạm.
 */
export const formatLessonNameWithPeriod = (lessonName: string, defaultPeriodIndex: number = 1): string => {
    if (!lessonName) return '';
    let clean = lessonName.trim();

    // Nếu đã có sẵn (T1), (T2), (T3)... ở cuối chuỗi thì giữ nguyên
    if (/\(T\d+\)$/i.test(clean)) {
        return clean;
    }

    // Nếu có dạng (Tiết 1), (Tiết 2)... -> chuyển thành (T1), (T2)
    const tietParenMatch = clean.match(/\((?:Tiết|tiết)\s*(\d+)\)$/);
    if (tietParenMatch) {
        return clean.replace(/\((?:Tiết|tiết)\s*(\d+)\)$/, `(T${tietParenMatch[1]})`);
    }

    // Nếu có dạng - Tiết 1, : Tiết 2 ở cuối -> chuyển thành (T1), (T2)
    const tietDashMatch = clean.match(/[-:]\s*(?:Tiết|tiết)\s*(\d+)$/);
    if (tietDashMatch) {
        clean = clean.replace(/[-:]\s*(?:Tiết|tiết)\s*(\d+)$/, '').trim();
        return `${clean}(T${tietDashMatch[1]})`;
    }

    // Mặc định gắn (T{defaultPeriodIndex})
    return `${clean}(T${defaultPeriodIndex || 1})`;
};

/**
 * Tính toán động Thứ, Ngày và Khoảng thời gian cho BẤT KỲ TUẦN NÀO được chọn
 * Tham chiếu Tuần 1 bắt đầu từ đầu tháng 9 năm học
 */
export const getWeekDateRange = (weekNumber: number): {
    dateRange: string;
    dayDates: { [dayKey: string]: string };
} => {
    // Năm học bắt đầu từ Thứ Hai đầu tháng 9 (07/09/2026)
    const baseMonday = new Date(2026, 8, 7); // 07/09/2026 (Tuần 1)
    const diffWeeks = weekNumber - 1;
    const targetMonday = new Date(baseMonday);
    targetMonday.setDate(baseMonday.getDate() + diffWeeks * 7);

    const targetThursday = new Date(targetMonday);
    targetThursday.setDate(targetMonday.getDate() + 3);

    const pad = (n: number) => n < 10 ? `0${n}` : `${n}`;

    const mDay = pad(targetMonday.getDate());
    const mMonth = pad(targetMonday.getMonth() + 1);
    const mYear = targetMonday.getFullYear();

    const tDay = pad(targetThursday.getDate());
    const tMonth = pad(targetThursday.getMonth() + 1);
    const tYear = targetThursday.getFullYear();

    const dateRange = `(Từ ngày ${mDay}/${mMonth} đến ${tDay}/${tMonth}/${tYear})`;

    const d1 = new Date(targetMonday);
    const d2 = new Date(targetMonday); d2.setDate(targetMonday.getDate() + 1);
    const d3 = new Date(targetMonday); d3.setDate(targetMonday.getDate() + 2);
    const d4 = new Date(targetMonday); d4.setDate(targetMonday.getDate() + 3);

    return {
        dateRange,
        dayDates: {
            'Hai': `${pad(d1.getDate())}/${pad(d1.getMonth() + 1)}`,
            'Ba': `${pad(d2.getDate())}/${pad(d2.getMonth() + 1)}`,
            'Tư': `${pad(d3.getDate())}/${pad(d3.getMonth() + 1)}`,
            'Năm': `${pad(d4.getDate())}/${pad(d4.getMonth() + 1)}`
        }
    };
};

/**
 * Bản đồ từ viết tắt môn học thông dụng của giáo viên tiểu học
 */
const SUBJECT_SYNONYMS: Record<string, string[]> = {
    'kns': ['kỹ năng sống', 'kns', 'kĩ năng sống', 'kỹ năng số', 'gdkn sống', 'kỹ năng sống rèn luyện'],
    'cn': ['công nghệ', 'cn'],
    'th': ['tin học', 'th', 'tin', 'tin hoc'],
    'tv': ['tiếng việt', 'tv'],
    't': ['toán', 't', 'toan'],
    'kh': ['khoa học', 'kh', 'khoa hoc'],
    'ls&đl': ['lịch sử và địa lí', 'lịch sử và địa lý', 'ls&đl', 'ls-đl', 'lsđl', 'ls & đl', 'ls và đl'],
    'đđ': ['đạo đức', 'đđ', 'dao duc'],
    'hđtn': ['hoạt động trải nghiệm', 'hđtn'],
    'mt': ['mĩ thuật', 'mỹ thuật', 'mt'],
    'ân': ['âm nhạc', 'ân', 'am nhac'],
    'gdtc': ['giáo dục thể chất', 'gdtc', 'thể dục']
};

/**
 * Trích xuất khối lớp từ tên lớp (ví dụ "5C" -> "5", "4A" -> "4", "3E" -> "3")
 */
export const extractGradeNumber = (className?: string): string => {
    if (!className) return '';
    const match = className.match(/([1-5])/);
    return match ? match[1] : '';
};

const generateKhdhJsonWithFallback = async (ai: GoogleGenAI, parts: any[]): Promise<string> => {
    const models = [
        'gemini-2.5-flash-lite',
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
        'gemini-3.1-flash-lite-preview',
        'gemini-2.0-flash',
        'gemini-2.5-pro',
        'gemini-2.0-flash-lite'
    ];
    let lastErr: any = null;
    const maxAttempts = 14;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const modelName = models[attempt % models.length];
        try {
            const config: any = {
                responseMimeType: "application/json",
                temperature: 0.1
            };
            if (modelName === 'gemini-2.5-flash') {
                config.thinkingConfig = { thinkingBudget: 0 };
            } else if (modelName === 'gemini-3-flash-preview') {
                config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
            }
            const response = await ai.models.generateContent({
                model: modelName,
                contents: { parts },
                config
            });
            if (response && response.text && response.text.includes('{')) {
                return response.text;
            }
        } catch (err: any) {
            lastErr = err;
            console.warn(`KHDH model ${modelName} attempt ${attempt + 1}/${maxAttempts} fallback:`, err?.message || err);
            const msg = String(err?.message || JSON.stringify(err || '')).toLowerCase();
            if (msg.includes('api_key_invalid') || msg.includes('api key not valid')) {
                throw new Error("Gemini API Key không hợp lệ. Vui lòng kiểm tra lại API Key.");
            }
            const waitMs = (attempt + 1) % models.length === 0 ? 1800 : 450;
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }
    }
    const lastMsg = String(lastErr?.message || JSON.stringify(lastErr || '')).toLowerCase();
    if (lastMsg.includes('503') || lastMsg.includes('unavailable') || lastMsg.includes('high demand')) {
        throw new Error("Máy chủ AI đang có lượng truy cập cao đột biến. Vui lòng thử lại sau vài giây.");
    }
    throw new Error("Không thể kết nối với AI lúc này. Vui lòng thử lại sau giây lát.");
};

/**
 * Trích xuất dữ liệu PPCT từ các tệp người dùng tải lên (PDF, Word .docx hoặc ảnh)
 * Bám sát dữ liệu thực tế trong tệp, giữ nguyên tuần và số tiết T1/T2
 */
export const extractMultiplePpcts = async (
    files: File[],
    apiKey: string
): Promise<KhdhSubjectData[]> => {
    let finalApiKey = (apiKey || "").trim();
    if (!finalApiKey) {
        try {
            finalApiKey = ((import.meta as any).env?.VITE_GEMINI_API_KEY || "").trim();
        } catch (e) {}
    }

    if (!finalApiKey) {
        throw new Error("Vui lòng nhập Gemini API Key để phân tích file Phân phối chương trình.");
    }

    const ai = new GoogleGenAI({ apiKey: finalApiKey });
    const results: KhdhSubjectData[] = [];

    for (let fIdx = 0; fIdx < files.length; fIdx++) {
        const file = files[fIdx];
        const fileNameLower = file.name.toLowerCase();
        let mimeType = file.type;
        if (!mimeType) {
            if (fileNameLower.endsWith('.pdf')) mimeType = 'application/pdf';
            else if (fileNameLower.endsWith('.png')) mimeType = 'image/png';
            else if (fileNameLower.endsWith('.jpg') || fileNameLower.endsWith('.jpeg')) mimeType = 'image/jpeg';
            else mimeType = 'application/pdf';
        }

        const parts: any[] = [];
        let uploadedName: string | null = null;

        try {
            let docxHtml = "";
            if (fileNameLower.endsWith('.docx')) {
                try {
                    const arrayBuffer = await file.arrayBuffer();
                    const { value } = await mammoth.convertToHtml({ arrayBuffer });
                    docxHtml = value;
                } catch (e) {}
            }

            if (docxHtml) {
                parts.push({
                    text: `DƯỚI ĐÂY LÀ NỘI DUNG TỪ TỆP WORD PPCT (${file.name}):\n${docxHtml.slice(0, 50000)}`
                });
            } else if (file.size <= 19 * 1024 * 1024) {
                const base64Data = await fileToBase64(file);
                parts.push({
                    inlineData: { data: base64Data, mimeType }
                });
            } else {
                const uploaded = await ai.files.upload({ file, mimeType } as any);
                uploadedName = uploaded.name;
                parts.push({
                    fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType }
                });
            }

            const prompt = `
VAI TRÒ: CHUYÊN GIA ĐỌC VÀ TRÍCH XUẤT TÀI LIỆU PHÂN PHỐI CHƯƠNG TRÌNH (PPCT).
NHIỆM VỤ: Hãy đọc chính xác toàn bộ bảng biểu trong tệp đính kèm (${file.name}).
Trích xuất trung thực 100% bám sát văn bản, không tự ý bịa đặt hay đổi số tuần.

XÁC ĐỊNH:
1. TÊN MÔN HỌC (Ví dụ: "Tin học", "Công nghệ", "Kỹ năng sống", "Kỹ năng số", "Toán", "Tiếng Việt"...).
2. KHỐI LỚP (Ví dụ: "Lớp 3", "Lớp 4", "Lớp 5"... hoặc trích số 3, 4, 5 từ tiêu đề hoặc tên tệp).
3. DANH SÁCH BÀI HỌC TỪNG TUẦN:
   - week: GIỮ NGUYÊN TUẦN TRONG BẢNG (Ví dụ "Tuần 1", "Tuần 2", "Tuần 6", "Tuần 7", "Tuần 8"...).
   - weekNumber: Số nguyên của tuần (Ví dụ: 1, 2, 6, 7, 8...).
   - lessonName: Tên bài học gốc (Ví dụ: "Bài 1. Khám phá thế giới thông tin qua ChatGPT").
   - periodLabel: Chuỗi ghi trong cột Số tiết (Ví dụ: "Tiết 1", "Tiết 2", "1 tiết", "2 tiết"...).
   - periodIndex: Số thứ tự tiết trong bài (1 nếu là Tiết 1, 2 nếu là Tiết 2).
   - formattedLessonName: Định dạng tên bài kèm số tiết chuẩn:
     + Nếu Số tiết là "Tiết 1" hoặc tiết 1: "Tên bài(T1)" (Ví dụ: "Bài 1. Khám phá thế giới thông tin qua ChatGPT(T1)")
     + Nếu Số tiết là "Tiết 2" hoặc tiết 2: "Tên bài(T2)" (Ví dụ: "Bài 1. Khám phá thế giới thông tin qua ChatGPT(T2)")
     + Viết liền không có khoảng cách trước ngoặc đơn.
   - notes: Ghi chú tích hợp trong cột GHI CHÚ (nếu ô trống, ghi "-" hoặc "(không tích hợp)" thì trả về "").

TRẢ VỀ JSON HỢP LỆ DUY NHẤT:
{
  "subject": "Tên môn học",
  "grade": "Khối lớp",
  "lessons": [
    {
      "week": "Tuần 1",
      "weekNumber": 1,
      "lessonName": "Tên bài học",
      "periods": 1,
      "periodIndex": 1,
      "periodLabel": "Tiết 1",
      "formattedLessonName": "Tên bài học(T1)",
      "notes": ""
    }
  ]
}
BẮT BUỘC chỉ trả về JSON hợp lệ, không thêm văn bản ngoài JSON.
`;
            parts.push({ text: prompt });

            const text = await generateKhdhJsonWithFallback(ai, parts);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const subjectName = String(parsed.subject || '').trim() || file.name.replace(/\.[^/.]+$/, "");
                const gradeName = String(parsed.grade || '').trim();
                const lessonList: PpctLesson[] = Array.isArray(parsed.lessons)
                    ? parsed.lessons.map((l: any, i: number) => {
                        const rawNotes = (l.notes || '').trim();
                        const isNoNote = /^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawNotes);
                        const rawWeekStr = String(l.week || `Tuần ${i + 1}`).trim();
                        const weekNum = parseInt(String(l.weekNumber || rawWeekStr).replace(/\D/g, ''), 10) || (i + 1);
                        const pIdx = parseInt(String(l.periodIndex || 1), 10) || 1;
                        const originalName = String(l.lessonName || '').trim();
                        const formatted = l.formattedLessonName ? String(l.formattedLessonName).trim() : formatLessonNameWithPeriod(originalName, pIdx);

                        return {
                            week: rawWeekStr.startsWith('Tuần') ? rawWeekStr : `Tuần ${rawWeekStr}`,
                            weekNumber: weekNum,
                            lessonName: originalName,
                            periods: parseInt(l.periods, 10) || 1,
                            periodIndex: pIdx,
                            periodLabel: l.periodLabel || `Tiết ${pIdx}`,
                            formattedLessonName: formatted,
                            notes: isNoNote ? '' : rawNotes
                        };
                    }).filter((l: PpctLesson) => l.lessonName.length > 0)
                    : [];

                if (lessonList.length > 0) {
                    results.push({
                        subject: subjectName,
                        grade: gradeName,
                        fileName: file.name,
                        lessons: lessonList
                    });
                }
            }
        } catch (err: any) {
            console.warn(`Lỗi khi đọc file PPCT ${file.name}:`, err);
        } finally {
            if (uploadedName) {
                try {
                    await ai.files.delete({ name: uploadedName });
                } catch (e) {}
            }
        }
    }

    if (results.length === 0) {
        throw new Error("Không thể trích xuất được bảng bài học từ các tệp PPCT đã tải lên. Vui lòng kiểm tra lại file PDF/Word/ảnh.");
    }

    return results;
};

/**
 * Đọc cấu trúc Mẫu Kế hoạch dạy học do người dùng tải lên (hỗ trợ .docx, .doc, .pdf, ảnh)
 * Trích xuất trung thực các cột mà người dùng cung cấp: Thứ/ngày, Buổi, Tiết, LỚP, MÔN
 */
export const parseKhdhTemplateFile = async (
    templateFile: File,
    apiKey: string
): Promise<{
    templateTitle: string;
    weekNumber?: number | string;
    dateRange?: string;
    layoutOrientation: 'portrait' | 'landscape';
    rawRows: Partial<KhdhRow>[];
}> => {
    let finalApiKey = (apiKey || "").trim();
    if (!finalApiKey) {
        try {
            finalApiKey = ((import.meta as any).env?.VITE_GEMINI_API_KEY || "").trim();
        } catch (e) {}
    }

    const fileNameLower = templateFile.name.toLowerCase();

    // 1. Nếu là file .docx, dùng mammoth để trích xuất HTML trước
    let docxHtmlContent = "";
    if (fileNameLower.endsWith('.docx')) {
        try {
            const arrayBuffer = await templateFile.arrayBuffer();
            const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
            docxHtmlContent = html;
        } catch (docxErr) {
            console.warn("Lỗi khi đọc file .docx bằng mammoth, sẽ dùng File API:", docxErr);
        }
    }

    if (!finalApiKey) {
        throw new Error("Vui lòng cung cấp Gemini API Key để phân tích file mẫu KHDH.");
    }

    const ai = new GoogleGenAI({ apiKey: finalApiKey });
    const parts: any[] = [];
    let uploadedName: string | null = null;

    try {
        if (docxHtmlContent) {
            parts.push({
                text: `DƯỚI ĐÂY LÀ NỘI DUNG TỪ TỆP WORD MẪU KẾ HOẠCH DẠY HỌC DO NGƯỜI DÙNG TẢI LÊN:\n${docxHtmlContent.slice(0, 50000)}`
            });
        } else {
            let mimeType = templateFile.type;
            if (!mimeType) {
                if (fileNameLower.endsWith('.pdf')) mimeType = 'application/pdf';
                else if (fileNameLower.endsWith('.png')) mimeType = 'image/png';
                else if (fileNameLower.endsWith('.jpg') || fileNameLower.endsWith('.jpeg')) mimeType = 'image/jpeg';
                else mimeType = 'application/pdf';
            }

            if (templateFile.size <= 19 * 1024 * 1024) {
                const base64Data = await fileToBase64(templateFile);
                parts.push({ inlineData: { data: base64Data, mimeType } });
            } else {
                const uploaded = await ai.files.upload({ file: templateFile, mimeType } as any);
                uploadedName = uploaded.name;
                parts.push({ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } });
            }
        }

        const prompt = `
VAI TRÒ: CHUYÊN GIA ĐỌC VÀ TRÍCH XUẤT MẪU KẾ HOẠCH DẠY HỌC DO GIÁO VIÊN CUNG CẤP.
NHIỆM VỤ: Hãy đọc toàn bộ các dòng trong bảng mẫu đính kèm (${templateFile.name}).
Trích xuất chính xác từng dòng theo bảng của người dùng:
1. dayAndDate: Thứ/ngày (Ví dụ: "Hai 19/10", "Hai", "Ba 20/10", "Thứ Hai"...)
2. session: Buổi ("Sáng" hoặc "Chiều")
3. period: Tiết (1, 2, 3, 4, 5...)
4. className: LỚP (Ví dụ: "5C", "5A", "4A", "3E"...)
5. subject: MÔN (Ví dụ: "KNS", "CN", "TH", "Toán", "Tiếng Việt"...)
6. lessonName: Tên bài dạy nếu trong mẫu đã có, nếu chưa có thì để ""
7. notes: Ghi chú nếu trong mẫu đã có, nếu chưa có thì để ""

CŨNG XÁC ĐỊNH:
- templateTitle: Tiêu đề nếu có
- weekNumber: Số tuần nếu có trong tiêu đề
- dateRange: Khoảng ngày nếu có trong tiêu đề

TRẢ VỀ JSON HỢP LỆ DUY NHẤT:
{
  "templateTitle": "KẾ HOẠCH DẠY HỌC",
  "weekNumber": 1,
  "dateRange": "",
  "layoutOrientation": "portrait",
  "rows": [
    {
      "dayAndDate": "Hai",
      "session": "Sáng",
      "period": 1,
      "className": "5C",
      "subject": "KNS",
      "lessonName": "",
      "notes": ""
    }
  ]
}
BẮT BUỘC chỉ trả về JSON hợp lệ.
`;
        parts.push({ text: prompt });

        const resText = await generateKhdhJsonWithFallback(ai, parts);
        const jsonMatch = resText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                templateTitle: parsed.templateTitle || 'KẾ HOẠCH DẠY HỌC',
                weekNumber: parsed.weekNumber,
                dateRange: parsed.dateRange,
                layoutOrientation: parsed.layoutOrientation === 'landscape' ? 'landscape' : 'portrait',
                rawRows: Array.isArray(parsed.rows) ? parsed.rows : []
            };
        }
    } finally {
        if (uploadedName) {
            try { await ai.files.delete({ name: uploadedName }); } catch (e) {}
        }
    }

    return {
        templateTitle: 'KẾ HOẠCH DẠY HỌC',
        layoutOrientation: 'portrait',
        rawRows: []
    };
};

/**
 * Thuật toán ghép Kế hoạch dạy học hoàn toàn linh động theo dữ liệu người dùng cung cấp:
 * - Dựa vào đúng TUẦN ĐƯỢC CHỌN (targetWeek: Tuần 1, Tuần 2, Tuần 3...).
 * - Cập nhật tự động Thứ, Ngày theo tuần tương ứng để đảm bảo chính xác thời gian.
 * - Tham chiếu 100% vào PPCT người dùng tải lên:
 *   + Khớp Môn học (hỗ trợ viết tắt KNS, CN, TH...)
 *   + Khớp Khối lớp trích từ tên lớp (5C -> Khối 5, 4A -> Khối 4, 3E -> Khối 3...)
 *   + Lấy bài dạy của ĐÚNG TUẦN ĐƯỢC CHỌN.
 *   + ĐỊNH DẠNG TÊN BÀI KÈM SỐ TIẾT CHUẨN: "TÊN BÀI(T1)" hoặc "TÊN BÀI(T2)".
 *   + ĐIỀN GHI CHÚ: Chỉ điền nếu trong PPCT có ghi chú; nếu không có thì để trống "".
 */
export const matchAndBuildKhdhPlan = (
    templateRows: Partial<KhdhRow>[],
    ppctList: KhdhSubjectData[],
    meta: {
        targetWeek: number | string;
        dateRange?: string;
        schoolName: string;
        teacherName: string;
        title?: string;
        academicYear?: string;
        gradeClass?: string;
        layoutOrientation?: 'portrait' | 'landscape';
    }
): KhdhPlan => {
    if (!templateRows || templateRows.length === 0) {
        throw new Error("Chưa có mẫu Kế hoạch dạy học. Vui lòng tải lên file mẫu KHDH của Thầy/Cô ở Bước 2.");
    }

    if (!ppctList || ppctList.length === 0) {
        throw new Error("Chưa có dữ liệu Phân phối chương trình. Vui lòng tải lên các file PPCT ở Bước 1.");
    }

    const rawWeekNum = String(meta.targetWeek).replace(/\D/g, '') || '1';
    const normWeekStr = `Tuần ${rawWeekNum}`;
    const weekNumInt = parseInt(rawWeekNum, 10);

    // Tính toán ngày trong tuần tự động cho tuần được chọn
    const calculatedWeekDates = getWeekDateRange(weekNumInt);
    const dayDates = calculatedWeekDates.dayDates;
    const finalDateRange = meta.dateRange && meta.dateRange.trim().length > 0
        ? meta.dateRange
        : calculatedWeekDates.dateRange;

    // Hàm tra cứu bài học trong PPCT người dùng cung cấp
    const findLessonInPpct = (
        subjectCode: string,
        className: string,
        periodOccurrenceInWeek: number = 0
    ): { lessonName: string; notes: string; formattedLessonName: string } | undefined => {
        if (!subjectCode) return undefined;
        const normCode = subjectCode.trim().toLowerCase();
        const gradeFromClass = extractGradeNumber(className);

        // Tìm danh sách từ đồng nghĩa của môn
        let matchAliases = [normCode];
        for (const [key, aliases] of Object.entries(SUBJECT_SYNONYMS)) {
            if (key === normCode || aliases.includes(normCode)) {
                matchAliases = [key, ...aliases];
                break;
            }
        }

        // Lọc PPCT khớp môn và khớp khối lớp
        const candidates = ppctList.filter(p => {
            const pSubjLower = p.subject.toLowerCase();
            const subjectMatches = matchAliases.some(alias => pSubjLower.includes(alias) || alias.includes(pSubjLower));
            if (!subjectMatches) return false;

            if (gradeFromClass && p.grade) {
                const pGrade = extractGradeNumber(p.grade);
                if (pGrade && pGrade !== gradeFromClass) {
                    return false;
                }
            }
            return true;
        });

        const chosenPpct = candidates[0] || ppctList.find(p => {
            const pSubjLower = p.subject.toLowerCase();
            return matchAliases.some(alias => pSubjLower.includes(alias) || alias.includes(pSubjLower));
        });

        if (!chosenPpct || !chosenPpct.lessons || chosenPpct.lessons.length === 0) {
            return undefined;
        }

        // Tìm bài học của đúng tuần được chọn
        const weekLessons = chosenPpct.lessons.filter(l => {
            if (l.weekNumber && l.weekNumber === weekNumInt) return true;
            const lWeekNorm = l.week.trim();
            const lWeekNum = parseInt(String(lWeekNorm).replace(/\D/g, ''), 10);
            return lWeekNum === weekNumInt || lWeekNorm.toLowerCase() === normWeekStr.toLowerCase();
        });

        if (weekLessons.length > 0) {
            const idx = periodOccurrenceInWeek % weekLessons.length;
            const item = weekLessons[idx];
            const pIdx = item.periodIndex || (idx + 1);
            const formatted = item.formattedLessonName || formatLessonNameWithPeriod(item.lessonName, pIdx);
            return {
                lessonName: item.lessonName,
                formattedLessonName: formatted,
                notes: item.notes || ""
            };
        }

        return undefined;
    };

    // Theo dõi số tiết của cùng một môn và lớp trong tuần
    const classSubjectPeriodCount = new Map<string, number>();

    const completedRows: KhdhRow[] = templateRows.map((tRow, idx) => {
        const cls = (tRow.className || '').trim();
        const subj = (tRow.subject || '').trim();
        const trackerKey = `${cls}_${subj}`.toLowerCase();
        const pCount = classSubjectPeriodCount.get(trackerKey) || 0;
        classSubjectPeriodCount.set(trackerKey, pCount + 1);

        const matched = findLessonInPpct(subj, cls, pCount);

        // Quy tắc vàng về Ghi chú:
        // CHỈ ĐIỀN NẾU PPCT CÓ GHI CHÚ! Nếu không có thì để trống "".
        let finalNote = "";
        if (matched && matched.notes && matched.notes.trim().length > 0) {
            const noteClean = matched.notes.trim();
            if (!/^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(noteClean)) {
                finalNote = noteClean;
            }
        } else if (tRow.notes && tRow.notes.trim().length > 0) {
            finalNote = tRow.notes.trim();
        }

        // TÊN BÀI DẠY: Bắt buộc kèm số tiết (T1)/(T2)
        let finalLessonName = "";
        if (matched && matched.formattedLessonName) {
            finalLessonName = matched.formattedLessonName;
        } else if (tRow.lessonName && tRow.lessonName.trim().length > 0) {
            finalLessonName = formatLessonNameWithPeriod(tRow.lessonName.trim(), 1);
        }

        // Cập nhật ngày cho đúng tuần được chọn
        let rawDay = (tRow.dayAndDate || tRow.dayOfWeek || '').trim();
        let updatedDayAndDate = rawDay;
        for (const [dayKey, dateVal] of Object.entries(dayDates)) {
            if (rawDay.includes(dayKey)) {
                updatedDayAndDate = `${dayKey} ${dateVal}`;
                break;
            }
        }
        if (!updatedDayAndDate) {
            const defaultDays = ["Hai", "Ba", "Tư", "Năm"];
            const dKey = defaultDays[Math.floor(idx / 6) % defaultDays.length];
            updatedDayAndDate = `${dKey} ${dayDates[dKey] || ''}`;
        }

        return {
            id: `khdh-row-${idx + 1}`,
            week: normWeekStr,
            dayAndDate: updatedDayAndDate,
            session: tRow.session || (idx % 7 < 4 ? "Sáng" : "Chiều"),
            period: tRow.period || tRow.periodNumber || ((idx % 4) + 1),
            className: cls,
            subject: subj,
            lessonName: finalLessonName,
            notes: finalNote,

            grade: tRow.grade || (cls ? `Lớp ${cls}` : meta.gradeClass || ""),
            dayOfWeek: updatedDayAndDate,
            periodNumber: tRow.period || tRow.periodNumber || ((idx % 4) + 1),
            duration: tRow.duration || 1,
            equipment: tRow.equipment || "Thiết bị dạy học chuẩn"
        };
    });

    const fullTitle = meta.title || `KẾ HOẠCH DẠY HỌC - ${normWeekStr.toUpperCase()} ${finalDateRange}`;

    return {
        title: fullTitle,
        weekNumber: weekNumInt,
        dateRange: finalDateRange,
        schoolName: meta.schoolName || 'Trường Tiểu học Mỹ An',
        teacherName: meta.teacherName || 'GV: Lê Văn Phi',
        academicYear: meta.academicYear || 'NĂM HỌC 2026 - 2027',
        gradeClass: meta.gradeClass || '',
        layoutOrientation: meta.layoutOrientation || 'portrait',
        rows: completedRows
    };
};
