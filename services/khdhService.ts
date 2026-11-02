import { KhdhPlan, KhdhRow, KhdhSubjectData, PpctLesson } from "../types";
import { fileToBase64 } from "../utils";
import { callServerGenerateContent, callServerUploadFile, callServerDeleteFiles } from "./geminiService";
import * as mammoth from "mammoth";

const ThinkingLevel = {
    LOW: "LOW"
} as const;

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
 * Bao gồm đầy đủ: Trí tuệ nhân tạo (TTNT / AI), Kỹ năng số / Kỹ năng sống (KNS), Công nghệ (CN), Tin học (TH)...
 */
const SUBJECT_SYNONYMS: Record<string, string[]> = {
    'ttnt': [
        'trí tuệ nhân tạo',
        'tri tue nhan tao',
        'trí tuệ nhân tạo (ai)',
        'tri tue nhan tao (ai)',
        'trí tuệ nhân tạo ai',
        'giáo dục trí tuệ nhân tạo',
        'giao duc tri tue nhan tao',
        'chuyên đề trí tuệ nhân tạo',
        'hoạt động giáo dục trí tuệ nhân tạo',
        'ttnt',
        'gdttnt',
        'gd ttnt',
        'ai'
    ],
    'kns': [
        'kỹ năng số',
        'kĩ năng số',
        'ky nang so',
        'ki nang so',
        'giáo dục kĩ năng công dân số',
        'giáo dục kỹ năng công dân số',
        'giao duc ki nang cong dan so',
        'giao duc ky nang cong dan so',
        'kỹ năng công dân số',
        'kĩ năng công dân số',
        'gdkncds',
        'kncds',
        'gdkns',
        'gdkn số',
        'kỹ năng sống',
        'kĩ năng sống',
        'ky nang song',
        'ki nang song',
        'gdkn sống',
        'kỹ năng sống rèn luyện',
        'kns'
    ],
    'cn': ['công nghệ', 'cong nghe', 'cn', 'môn công nghệ'],
    'th': ['tin học', 'tin hoc', 'th', 'tin', 'môn tin học', 'tin học và công nghệ'],
    'tv': ['tiếng việt', 'tieng viet', 'tv', 'môn tiếng việt'],
    't': ['toán', 'toan', 't', 'môn toán'],
    'kh': ['khoa học', 'khoa hoc', 'kh', 'môn khoa học'],
    'ls&đl': ['lịch sử và địa lí', 'lịch sử và địa lý', 'lich su va dia li', 'lich su va dia ly', 'ls&đl', 'ls-đl', 'lsđl', 'ls & đl', 'ls và đl', 'lsdl', 'ls&dl'],
    'tn&xh': ['tự nhiên và xã hội', 'tu nhien va xa hoi', 'tn&xh', 'tnxh', 'tn-xh', 'tn & xh', 'tn và xh'],
    'đđ': ['đạo đức', 'dao duc', 'đđ', 'dd', 'môn đạo đức'],
    'hđtn': ['hoạt động trải nghiệm', 'hoat dong trai nghiem', 'hđtn', 'hdtn', 'sinh hoạt dưới cờ', 'sinh hoạt lớp'],
    'mt': ['mĩ thuật', 'mỹ thuật', 'mi thuat', 'my thuat', 'mt'],
    'ân': ['âm nhạc', 'am nhac', 'ân', 'an'],
    'gdtc': ['giáo dục thể chất', 'giao duc the chat', 'gdtc', 'thể dục', 'the duc', 'td'],
    'ta': ['tiếng anh', 'tieng anh', 'ngoại ngữ', 'ngoai ngu', 'ta', 'nn', 'anh văn'],
    'stem': ['giáo dục stem', 'giao duc stem', 'bài học stem', 'hoạt động stem', 'stem']
};

/**
 * Loại bỏ dấu tiếng Việt (chuyển đ -> d) để so khớp tên môn và chữ viết tắt chính xác tuyệt đối
 */
export const removeVietnameseTones = (str: string): string => {
    return (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .trim();
};

/**
 * Sinh tập hợp mã nhận diện môn học và chữ viết tắt tự động từ tên môn học bất kỳ
 * Ví dụ:
 * - "TRÍ TUỆ NHÂN TẠO (AI) (Lớp 4)" -> {"trí tuệ nhân tạo", "tri tue nhan tao", "ttnt", "ai", "ttntai"}
 * - "Kỹ năng số (Lớp 5)" -> {"kỹ năng số", "ky nang so", "kns"}
 * - "TTNT" -> {"ttnt"}
 */
export const extractSubjectTokensAndAcronyms = (rawSubject: string): Set<string> => {
    const tokens = new Set<string>();
    if (!rawSubject) return tokens;

    const lowerRaw = rawSubject.toLowerCase().trim();
    tokens.add(lowerRaw);
    tokens.add(removeVietnameseTones(lowerRaw));

    // Trích các từ viết tắt nằm trong ngoặc đơn (ví dụ "(AI)", "(TTNT)", "(KNS)") nhưng bỏ qua "(Lớp 4)"
    const parenMatches = lowerRaw.match(/\(([^)]+)\)/g) || [];
    for (const pm of parenMatches) {
        const inner = pm.slice(1, -1).trim();
        if (!/^(lớp|lop|khối|khoi|\d+)/i.test(inner) && inner.length >= 2) {
            tokens.add(inner);
            tokens.add(removeVietnameseTones(inner));
        }
    }

    // Làm sạch phần thông tin khối lớp và từ tiền tố chung
    const cleaned = lowerRaw
        .replace(/\(\s*(?:lớp|lop|khối|khoi)\s*\d+\s*\)/gi, ' ')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/^(?:môn\s*học|môn|chuyên\s*đề|phân\s*phối\s*chương\s*trình|kế\s*hoạch\s*dạy\s*học|ppct|khdh)\s*[:\-–]?\s*/i, '')
        .replace(/[^\p{L}\p{N}&]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (cleaned) {
        tokens.add(cleaned);
        const unaccented = removeVietnameseTones(cleaned);
        tokens.add(unaccented);

        const words = cleaned.split(/\s+/).filter(Boolean);
        const unaccentedWords = unaccented.split(/\s+/).filter(Boolean);

        if (words.length >= 2) {
            const acronymAccented = words.map(w => w[0]).join('');
            const acronymUnaccented = unaccentedWords.map(w => w[0]).join('');
            tokens.add(acronymAccented);
            tokens.add(acronymUnaccented);

            // Nếu bắt đầu bằng "giáo dục ..." (như "giáo dục trí tuệ nhân tạo", "giáo dục kĩ năng công dân số"),
            // sinh thêm chữ viết tắt khi lược bỏ từ "giáo dục"
            if (unaccentedWords[0] === 'giao' && unaccentedWords[1] === 'duc' && unaccentedWords.length > 2) {
                const subWordsAcc = words.slice(2);
                const subWordsUnacc = unaccentedWords.slice(2);
                tokens.add(subWordsAcc.join(' '));
                tokens.add(subWordsUnacc.join(' '));
                tokens.add(subWordsAcc.map(w => w[0]).join(''));
                tokens.add(subWordsUnacc.map(w => w[0]).join(''));
            }
        }
    }

    // Mở rộng theo bảng từ đồng nghĩa chuẩn SUBJECT_SYNONYMS
    for (const [canonicalKey, aliasList] of Object.entries(SUBJECT_SYNONYMS)) {
        const allGroupForms = [canonicalKey, ...aliasList];
        const groupMatched = allGroupForms.some(form => {
            const normForm = form.toLowerCase().trim();
            const unaccForm = removeVietnameseTones(normForm);
            return tokens.has(normForm) || tokens.has(unaccForm);
        });
        if (groupMatched) {
            tokens.add(canonicalKey);
            tokens.add(removeVietnameseTones(canonicalKey));
            for (const alias of aliasList) {
                tokens.add(alias.toLowerCase().trim());
                tokens.add(removeVietnameseTones(alias));
            }
        }
    }

    return tokens;
};

/**
 * Kiểm tra xem mã môn học trong KHDH Mẫu (VD: "TTNT", "KNS", "CN", "TH") có khớp với tên môn trong PPCT hay không
 */
export const doesSubjectMatch = (templateSubject: string, ppctSubject: string): boolean => {
    if (!templateSubject || !ppctSubject) return false;
    const tokensA = extractSubjectTokensAndAcronyms(templateSubject);
    const tokensB = extractSubjectTokensAndAcronyms(ppctSubject);

    for (const tA of tokensA) {
        if (tA && tokensB.has(tA)) {
            return true;
        }
    }

    // Kiểm tra bao hàm an toàn cho tên môn đầy đủ (>= 4 ký tự)
    const cleanA = removeVietnameseTones(templateSubject.replace(/\([^)]*\)/g, '').trim());
    const cleanB = removeVietnameseTones(ppctSubject.replace(/\([^)]*\)/g, '').trim());
    if (cleanA.length >= 4 && cleanB.length >= 4) {
        if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) {
            return true;
        }
    }

    return false;
};

/**
 * Trích xuất khối lớp từ tên lớp, tên môn hoặc tên file (ví dụ "5C" -> "5", "Lớp 4" -> "4", "Lop_3.pdf" -> "3")
 */
export const extractGradeNumber = (text?: string): string => {
    if (!text) return '';
    const explicitGrade = text.match(/(?:lớp|lop|khối|khoi)[_\-\s]*([1-5])/i);
    if (explicitGrade && explicitGrade[1]) {
        return explicitGrade[1];
    }
    const classMatch = text.match(/\b([1-5])[A-Za-z]?\b/);
    if (classMatch && classMatch[1]) {
        return classMatch[1];
    }
    const anyDigit = text.match(/([1-5])/);
    return anyDigit ? anyDigit[1] : '';
};

/**
 * Trích xuất danh sách số tuần từ chuỗi tuần trong PPCT (hỗ trợ cả "Tuần 1", "Tuần 1 - 2", "Tuần 1, 2, 3")
 * Tuyệt đối không nối gộp các chữ số của khoảng tuần (tránh biến "Tuần 1 - 2" thành tuần 12).
 */
export const parseWeekNumbersFromText = (rawWeek: string | number | undefined): number[] => {
    if (typeof rawWeek === 'number' && !isNaN(rawWeek) && rawWeek >= 1 && rawWeek <= 52) {
        return [rawWeek];
    }
    const str = String(rawWeek || '').trim();
    if (!str) return [];

    // 1. Kiểm tra dạng khoảng tuần: "Tuần 1 - 3", "1 - 2", "Tuần 1 đến 2"
    const rangeMatch = str.match(/(\d{1,2})\s*(?:[-–—→]|đến|tới)\s*(\d{1,2})/i);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        if (!isNaN(start) && !isNaN(end) && start >= 1 && end >= start && end <= 52 && end - start <= 12) {
            const weeks: number[] = [];
            for (let w = start; w <= end; w++) weeks.push(w);
            return weeks;
        }
    }

    // 2. Kiểm tra dạng liệt kê tuần: "Tuần 1, 2", "1, 2, 3", "Tuần 1 & 2"
    if (/[,;&/]/.test(str)) {
        const nums = (str.match(/\d{1,2}/g) || [])
            .map(n => parseInt(n, 10))
            .filter(n => !isNaN(n) && n >= 1 && n <= 52);
        if (nums.length > 0) {
            return Array.from(new Set(nums));
        }
    }

    // 3. Lấy số nguyên đầu tiên (ví dụ "Tuần 1 (Tiết 1)" -> 1, tuyệt đối không gộp thành 11)
    const firstMatch = str.match(/(\d{1,2})/);
    if (firstMatch) {
        const num = parseInt(firstMatch[1], 10);
        if (!isNaN(num) && num >= 1 && num <= 52) {
            return [num];
        }
    }

    return [];
};

const generateKhdhJsonWithFallback = async (parts: any[]): Promise<string> => {
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
            const response = await callServerGenerateContent({
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
                throw new Error("Gemini API Key không hợp lệ. Vui lòng kiểm tra lại cấu hình API Key.");
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
 * Chuẩn hóa và tự động bung các bài học kéo dài nhiều tuần / nhiều tiết trong PPCT:
 * - Nếu 1 dòng ghi khoảng tuần ("Tuần 1 - 2", "Tuần 1, 2, 3"), tự động tách thành từng tuần riêng với (T1), (T2), (T3).
 * - Nếu 1 dòng ghi số tiết > 1 (VD: 2 tiết, 3 tiết) và tuần của dòng kế tiếp nhảy cách tương ứng (VD: Dòng 1 ở Tuần 1 có 2 tiết, Dòng 2 ở Tuần 3),
 *   tự động bung thành Tuần 1 (T1), Tuần 2 (T2).
 * - Nếu cùng một tên bài học xuất hiện ở nhiều tuần liên tiếp nhưng chưa đánh số tiết (T1), (T2), tự động đánh số thứ tự tiết chính xác.
 */
const extractLessonBaseTitle = (rawName: string): string => {
    return (rawName || '')
        .replace(/\(\s*(?:Tiết|tiết|T|t)\s*\d+\s*\)$/i, '')
        .replace(/[-:–]\s*(?:Tiết|tiết|T|t)\s*\d+\s*$/i, '')
        .trim();
};

export const normalizeAndExpandPpctLessons = (rawLessons: PpctLesson[]): PpctLesson[] => {
    if (!Array.isArray(rawLessons) || rawLessons.length === 0) return [];

    const step1Expanded: PpctLesson[] = [];

    for (let i = 0; i < rawLessons.length; i++) {
        const item = rawLessons[i];
        const cleanOriginalName = extractLessonBaseTitle(item.lessonName || '');
        if (!cleanOriginalName) continue;

        const rawNotes = (item.notes || '').trim();
        const cleanNotes = /^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawNotes) ? '' : rawNotes;
        const explicitPeriodFromLabel = (() => {
            const m = String(item.periodLabel || item.formattedLessonName || item.lessonName || '').match(/(?:tiết|t)\s*(\d+)/i);
            return m && m[1] ? parseInt(m[1], 10) : null;
        })();

        const parsedWeeks = parseWeekNumbersFromText(item.week || item.weekNumber);
        const periodsCount = Math.max(1, parseInt(String(item.periods || 1), 10) || 1);

        // Trường hợp 1: Chuỗi tuần chứa nhiều tuần (VD: "Tuần 1 - 2", "Tuần 1, 2")
        if (parsedWeeks.length > 1) {
            parsedWeeks.forEach((wNum, idx) => {
                const pIdx = idx + 1;
                step1Expanded.push({
                    week: `Tuần ${wNum}`,
                    weekNumber: wNum,
                    lessonName: cleanOriginalName,
                    periods: 1,
                    periodIndex: pIdx,
                    periodLabel: `Tiết ${pIdx}`,
                    formattedLessonName: formatLessonNameWithPeriod(cleanOriginalName, pIdx),
                    notes: cleanNotes
                });
            });
            continue;
        }

        const singleWeek = parsedWeeks[0] || (typeof item.weekNumber === 'number' && item.weekNumber > 0 ? item.weekNumber : i + 1);

        // Kiểm tra xem dòng tiếp theo có nhảy tuần theo đúng số tiết `periodsCount` hay không
        const nextItem = rawLessons[i + 1];
        const nextWeeks = nextItem ? parseWeekNumbersFromText(nextItem.week || nextItem.weekNumber) : [];
        const nextStartWeek = nextWeeks[0] || (nextItem?.weekNumber && nextItem.weekNumber > 0 ? nextItem.weekNumber : 0);

        if (periodsCount > 1 && periodsCount <= 6 && nextStartWeek === singleWeek + periodsCount) {
            for (let p = 0; p < periodsCount; p++) {
                const wNum = singleWeek + p;
                const pIdx = p + 1;
                step1Expanded.push({
                    week: `Tuần ${wNum}`,
                    weekNumber: wNum,
                    lessonName: cleanOriginalName,
                    periods: 1,
                    periodIndex: pIdx,
                    periodLabel: `Tiết ${pIdx}`,
                    formattedLessonName: formatLessonNameWithPeriod(cleanOriginalName, pIdx),
                    notes: cleanNotes
                });
            }
            continue;
        }

        const initialPIdx = explicitPeriodFromLabel || item.periodIndex || 1;
        step1Expanded.push({
            week: `Tuần ${singleWeek}`,
            weekNumber: singleWeek,
            lessonName: cleanOriginalName,
            periods: periodsCount,
            periodIndex: initialPIdx,
            periodLabel: item.periodLabel || `Tiết ${initialPIdx}`,
            formattedLessonName: formatLessonNameWithPeriod(cleanOriginalName, initialPIdx),
            notes: cleanNotes
        });
    }

    // Trường hợp 2: Nếu bảng PPCT liệt kê theo danh sách bài học (VD: 12 bài hoặc 18 bài, không ghi tuần nhảy cách mà đánh STT 1..N)
    // nhưng mỗi bài có cột Số tiết > 1 (tổng số tiết > số dòng), tự động bung thành từng tiết theo tuần liên tiếp
    const allSequentialFromOne = step1Expanded.every((l, idx) => l.weekNumber === idx + 1);
    const totalPeriodsSum = step1Expanded.reduce((acc, cur) => acc + (cur.periods || 1), 0);
    if (allSequentialFromOne && step1Expanded.length <= 20 && totalPeriodsSum > step1Expanded.length && totalPeriodsSum <= 40) {
        const expandedByPeriod: PpctLesson[] = [];
        let runningWeek = 1;
        for (const item of step1Expanded) {
            const pCount = Math.max(1, item.periods || 1);
            for (let p = 1; p <= pCount; p++) {
                expandedByPeriod.push({
                    week: `Tuần ${runningWeek}`,
                    weekNumber: runningWeek,
                    lessonName: item.lessonName,
                    periods: 1,
                    periodIndex: p,
                    periodLabel: `Tiết ${p}`,
                    formattedLessonName: formatLessonNameWithPeriod(item.lessonName, p),
                    notes: item.notes || ''
                });
                runningWeek++;
            }
        }
        return expandedByPeriod;
    }

    // Bước 3: Tự động đánh số tiết (T1), (T2), (T3) chuẩn xác nếu cùng một bài học xuất hiện ở nhiều tuần
    const lessonOccurrenceCounter = new Map<string, number>();
    return step1Expanded.map(item => {
        const baseKey = removeVietnameseTones(extractLessonBaseTitle(item.lessonName));
        const prevCount = lessonOccurrenceCounter.get(baseKey) || 0;
        const nextCount = prevCount + 1;
        lessonOccurrenceCounter.set(baseKey, nextCount);

        const resolvedPeriodIndex = item.periodIndex && item.periodIndex > 1 ? item.periodIndex : nextCount;
        return {
            ...item,
            periodIndex: resolvedPeriodIndex,
            periodLabel: `Tiết ${resolvedPeriodIndex}`,
            formattedLessonName: formatLessonNameWithPeriod(item.lessonName, resolvedPeriodIndex)
        };
    });
};

/**
 * Trích xuất dữ liệu PPCT từ các tệp người dùng tải lên (PDF, Word .docx hoặc ảnh)
 * Bám sát dữ liệu thực tế trong tệp, giữ nguyên tuần và số tiết T1/T2
 */
export const extractMultiplePpcts = async (
    files: File[],
    _apiKey?: string
): Promise<KhdhSubjectData[]> => {
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
                const uploaded = await callServerUploadFile({ file, mimeType });
                uploadedName = uploaded.name;
                parts.push({
                    fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType }
                });
            }

            const prompt = `
VAI TRÒ: CHUYÊN GIA ĐỌC VÀ TRÍCH XUẤT TÀI LIỆU PHÂN PHỐI CHƯƠNG TRÌNH (PPCT).
NHIỆM VỤ: Hãy đọc chính xác toàn bộ bảng biểu trong tệp đính kèm (${file.name}).
Trích xuất trung thực 100% bám sát văn bản, không tự ý bịa đặt hay bỏ sót bất kỳ bài học nào.

XÁC ĐỊNH:
1. TÊN MÔN HỌC (Ví dụ: "Trí tuệ nhân tạo", "Kỹ năng số", "Tin học", "Công nghệ", "Kỹ năng sống", "Toán", "Tiếng Việt"...).
2. KHỐI LỚP (Ví dụ: "Lớp 3", "Lớp 4", "Lớp 5"... hoặc trích số 3, 4, 5 từ tiêu đề hoặc tên tệp "${file.name}").
3. DANH SÁCH BÀI HỌC TỪNG TUẦN:
   - Nếu một bài học kéo dài trong nhiều tuần (ví dụ cột Tuần ghi "Tuần 1, 2" hoặc "1 - 2" hoặc bài học có 2 tiết dạy trong 2 tuần liên tiếp), hãy tách thành từng dòng cho từng tuần tương ứng: dòng đầu ghi "Tuần 1" với periodIndex = 1 ("Tên bài(T1)"), dòng tiếp theo ghi "Tuần 2" với periodIndex = 2 ("Tên bài(T2)").
   - Nếu bảng không có cột Tuần mà chỉ có cột STT / Tiết thứ (1, 2, 3...), hãy đánh tuần tương ứng "Tuần 1", "Tuần 2", "Tuần 3"...
   - week: Chuỗi tuần chuẩn (Ví dụ "Tuần 1", "Tuần 2", "Tuần 3"...).
   - weekNumber: Số nguyên của tuần (Ví dụ: 1, 2, 3...).
   - lessonName: Tên bài học gốc đầy đủ (Ví dụ: "Bài 1. Khám phá thế giới thông tin qua ChatGPT").
   - periods: Số tiết của dòng đó (mặc định là 1 nếu đã tách theo từng tuần).
   - periodLabel: Chuỗi ghi trong cột Số tiết (Ví dụ: "Tiết 1", "Tiết 2"...).
   - periodIndex: Số thứ tự tiết trong bài (1 nếu là Tiết 1, 2 nếu là Tiết 2, 3 nếu là Tiết 3).
   - formattedLessonName: Định dạng tên bài kèm số tiết chuẩn:
     + Nếu là Tiết 1: "Tên bài(T1)"
     + Nếu là Tiết 2: "Tên bài(T2)"
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

            const text = await generateKhdhJsonWithFallback(parts);
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const subjectName = String(parsed.subject || '').trim() || file.name.replace(/\.[^/.]+$/, "");
                const detectedGradeNum = extractGradeNumber(String(parsed.grade || '')) || extractGradeNumber(subjectName) || extractGradeNumber(file.name);
                const gradeName = String(parsed.grade || '').trim() || (detectedGradeNum ? `Lớp ${detectedGradeNum}` : '');

                const rawLessonList: PpctLesson[] = Array.isArray(parsed.lessons)
                    ? parsed.lessons.map((l: any, i: number) => {
                        const rawNotes = (l.notes || '').trim();
                        const isNoNote = /^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawNotes);
                        const rawWeekStr = String(l.week || `Tuần ${i + 1}`).trim();
                        const parsedW = parseWeekNumbersFromText(l.weekNumber || rawWeekStr);
                        const weekNum = parsedW[0] || (i + 1);
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

                const lessonList = normalizeAndExpandPpctLessons(rawLessonList);

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
                await callServerDeleteFiles([uploadedName]);
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
    _apiKey?: string
): Promise<{
    templateTitle: string;
    weekNumber?: number | string;
    dateRange?: string;
    layoutOrientation: 'portrait' | 'landscape';
    rawRows: Partial<KhdhRow>[];
}> => {
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
                const uploaded = await callServerUploadFile({ file: templateFile, mimeType });
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
5. subject: MÔN (Ví dụ: "TTNT", "KNS", "CN", "TH", "Toán", "Tiếng Việt"...)
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
      "subject": "TTNT",
      "lessonName": "",
      "notes": ""
    }
  ]
}
BẮT BUỘC chỉ trả về JSON hợp lệ.
`;
        parts.push({ text: prompt });

        const resText = await generateKhdhJsonWithFallback(parts);
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
            await callServerDeleteFiles([uploadedName]);
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
 *   + Khớp Môn học (hỗ trợ đầy đủ chữ viết tắt: TTNT, AI, KNS, CN, TH, TV, T, KH, LS&ĐL, TN&XH, ĐĐ, HĐTN...)
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

    const parsedTargetWeeks = parseWeekNumbersFromText(meta.targetWeek);
    const weekNumInt = parsedTargetWeeks[0] || parseInt(String(meta.targetWeek).replace(/\D/g, ''), 10) || 1;
    const normWeekStr = `Tuần ${weekNumInt}`;

    // Tính toán ngày trong tuần tự động cho tuần được chọn
    const calculatedWeekDates = getWeekDateRange(weekNumInt);
    const dayDates = calculatedWeekDates.dayDates;
    const finalDateRange = meta.dateRange && meta.dateRange.trim().length > 0
        ? meta.dateRange
        : calculatedWeekDates.dateRange;

    // Chuẩn hóa trước danh sách bài học của từng môn trong PPCT để đảm bảo khớp tuyệt đối
    const normalizedPpctList: KhdhSubjectData[] = ppctList.map(p => ({
        ...p,
        grade: p.grade || extractGradeNumber(p.subject) || extractGradeNumber(p.fileName),
        lessons: normalizeAndExpandPpctLessons(p.lessons || [])
    }));

    // Hàm tra cứu bài học trong PPCT người dùng cung cấp
    const findLessonInPpct = (
        subjectCode: string,
        className: string,
        periodOccurrenceInWeek: number = 0
    ): { lessonName: string; notes: string; formattedLessonName: string } | undefined => {
        if (!subjectCode) return undefined;
        const gradeFromClass = extractGradeNumber(className);

        // Lọc PPCT khớp môn (hỗ trợ viết tắt như TTNT, KNS, CN, TH...) và khớp khối lớp
        const subjectMatchedPpcts = normalizedPpctList.filter(p =>
            doesSubjectMatch(subjectCode, p.subject) || doesSubjectMatch(subjectCode, p.fileName || '')
        );

        if (subjectMatchedPpcts.length === 0) {
            return undefined;
        }

        const gradeMatchedPpcts = subjectMatchedPpcts.filter(p => {
            if (!gradeFromClass) return true;
            const pGrade = extractGradeNumber(p.grade) || extractGradeNumber(p.subject) || extractGradeNumber(p.fileName);
            return !pGrade || pGrade === gradeFromClass;
        });

        const chosenPpct = gradeMatchedPpcts[0] || subjectMatchedPpcts[0];
        if (!chosenPpct || !chosenPpct.lessons || chosenPpct.lessons.length === 0) {
            return undefined;
        }

        const lessons = chosenPpct.lessons;

        // 1. Tìm bài học của đúng tuần được chọn
        const weekLessons = lessons.filter(l => {
            if (l.weekNumber && l.weekNumber === weekNumInt) return true;
            const parsedW = parseWeekNumbersFromText(l.week);
            return parsedW.includes(weekNumInt) || l.week.trim().toLowerCase() === normWeekStr.toLowerCase();
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

        // 2. Trường hợp môn học có tổng số tiết/bài trong PPCT ít hơn 35 tuần (ví dụ: Trí tuệ nhân tạo • 12 tiết, Kỹ năng số • 18 tiết)
        // hoặc bảng PPCT đánh số theo chủ đề/tiết thứ mà không khớp trực tiếp số tuần hiện tại:
        // Phân bổ / ánh xạ thông minh theo tuần để không bao giờ bị bỏ trống Tên bài dạy trong bảng KHDH
        if (lessons.length > 0) {
            if (lessons.length < 35 && weekNumInt >= 1 && weekNumInt <= 35) {
                // Nếu PPCT có 12 tiết hoặc 18 tiết nhưng thời khóa biểu dạy xuyên suốt 35 tuần,
                // ưu tiên lấy đúng chỉ số nếu weekNumInt <= lessons.length, hoặc ánh xạ theo tiến độ năm học
                if (weekNumInt <= lessons.length) {
                    const directItem = lessons[weekNumInt - 1];
                    const pIdx = directItem.periodIndex || 1;
                    return {
                        lessonName: directItem.lessonName,
                        formattedLessonName: directItem.formattedLessonName || formatLessonNameWithPeriod(directItem.lessonName, pIdx),
                        notes: directItem.notes || ""
                    };
                }
                // Với các tuần vượt quá số tiết của PPCT (VD: tuần 13..35 của môn 12 tiết hoặc tuần 19..35 của môn 18 tiết),
                // ánh xạ đều theo tỉ lệ 35 tuần hoặc xoay vòng bài học kèm số tiết tương ứng
                const mappedIdx = Math.min(
                    lessons.length - 1,
                    Math.floor(((weekNumInt - 1) / 35) * lessons.length)
                );
                const item = lessons[mappedIdx];
                const startWeekOfBucket = Math.floor((mappedIdx * 35) / lessons.length) + 1;
                const periodInBucket = Math.max(1, weekNumInt - startWeekOfBucket + 1);
                return {
                    lessonName: item.lessonName,
                    formattedLessonName: formatLessonNameWithPeriod(item.lessonName, periodInBucket),
                    notes: item.notes || ""
                };
            }

            const fallbackItem = lessons[(weekNumInt - 1 + periodOccurrenceInWeek) % lessons.length];
            const pIdx = fallbackItem.periodIndex || 1;
            return {
                lessonName: fallbackItem.lessonName,
                formattedLessonName: fallbackItem.formattedLessonName || formatLessonNameWithPeriod(fallbackItem.lessonName, pIdx),
                notes: fallbackItem.notes || ""
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
