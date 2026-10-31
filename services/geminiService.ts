import { GoogleGenAI, Part, ThinkingLevel, Type } from "@google/genai";
import { SYSTEM_PROMPT } from "../constants";
import { ImageFile, InputState, LessonPlanResponse, PpctLesson, SourceType } from "../types";
import {
    fileToBase64,
    sanitizeAndParseJSON,
    ensureFourActivitiesInAllPeriods,
    extractBaseLessonName,
    extractExplicitPeriodNumber,
    formatLessonTitleWithPeriod
} from "../utils";
import { pregenerateLessonImagesWithAI } from "../utils/lessonImageGenerator";
import * as mammoth from "mammoth";

// Bộ nhớ đệm Base64 để khi "Soạn tất cả các tuần" trên điện thoại / máy tính / Vercel không phải đọc lại tệp PDF nhiều lần
const inMemoryBase64Cache = new Map<string, string>();

const getCachedFileBase64 = async (file: File): Promise<string> => {
    const cacheKey = `${file.name}_${file.size}_${file.lastModified}`;
    if (inMemoryBase64Cache.has(cacheKey)) {
        return inMemoryBase64Cache.get(cacheKey)!;
    }
    const data = await fileToBase64(file);
    inMemoryBase64Cache.set(cacheKey, data);
    return data;
};

export const resolveGeminiApiKey = (apiKey?: string): string => {
    let key = (apiKey || "").trim();
    if (!key) {
        try {
            key = ((import.meta as any).env?.VITE_GEMINI_API_KEY || "").trim();
        } catch (e) {}
    }
    if (!key) {
        try {
            if (typeof process !== "undefined" && process.env) {
                key = (process.env.GEMINI_API_KEY || process.env.API_KEY || "").trim();
            }
        } catch (e) {}
    }
    return key;
};

const LESSON_PLAN_RESPONSE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        lesson_full_title: { type: Type.STRING },
        week: { type: Type.STRING },
        grade_class: { type: Type.STRING },
        subject: { type: Type.STRING },
        date_range: { type: Type.STRING },
        periods: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    period_number: { type: Type.INTEGER },
                    objectives: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING }
                    },
                    materials: {
                        type: Type.OBJECT,
                        properties: {
                            teacher: { type: Type.STRING },
                            student: { type: Type.STRING }
                        },
                        required: ["teacher", "student"]
                    },
                    activities: {
                        type: Type.ARRAY,
                        description: "BẮT BUỘC phải có đúng đủ 4 hoạt động dạy học theo thứ tự: 1. Hoạt động mở đầu, 2. Hoạt động hình thành kiến thức mới, 3. Hoạt động luyện tập, thực hành, 4. Hoạt động vận dụng, trải nghiệm.",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                time: { type: Type.STRING },
                                name: { type: Type.STRING },
                                topic: { type: Type.STRING },
                                rows: {
                                    type: Type.ARRAY,
                                    items: {
                                        type: Type.OBJECT,
                                        properties: {
                                            teacher: { type: Type.STRING },
                                            student: { type: Type.STRING }
                                        },
                                        required: ["teacher", "student"]
                                    }
                                }
                            },
                            required: ["time", "name", "topic", "rows"]
                        }
                    }
                },
                required: ["period_number", "objectives", "materials", "activities"]
            }
        }
    },
    required: ["lesson_full_title", "periods"]
};

interface GenerateParams {
    inputData: InputState;
    sourceType: SourceType;
    images: ImageFile[];
    pdfFile?: File | null;
    pdfFiles?: File[];
    referencePdfs: File[];
    ppctFile?: File | null;
    apiKey: string;
    uploadedFileCache?: Map<string, { uri: string; mimeType: string; name: string }>;
}

export const generateLessonPlan = async ({
    inputData,
    sourceType,
    images,
    pdfFile,
    pdfFiles = [],
    referencePdfs,
    ppctFile,
    apiKey,
    uploadedFileCache
}: GenerateParams): Promise<LessonPlanResponse> => {
    // Mỗi tuần luôn chỉ dạy 1 tiết học; một bài học có thể kéo dài qua nhiều tuần (Tiết 1, Tiết 2...)
    const numPeriods = 1;
    const totalDuration = parseInt(inputData.duration, 10) || 35;

    // XÁC ĐỊNH SỐ TIẾT VÀ TÊN BÀI HỌC GỐC NGAY TỪ ĐẦU (TRÁNH LỖI TEMPORAL DEAD ZONE)
    const currentPeriodInLesson =
        Number(inputData.periodIndexInLesson) ||
        extractExplicitPeriodNumber(inputData.lessonName || '') ||
        1;
    const totalLessonPeriods = Math.max(Number(inputData.totalPeriodsInLesson) || 1, currentPeriodInLesson);
    const baseLessonName = extractBaseLessonName(inputData.baseLessonName || inputData.lessonName || "Bài học");
    const exactLessonTitleWithPeriod = formatLessonTitleWithPeriod(baseLessonName, currentPeriodInLesson);

    const hasUploadedPdfSgk = (pdfFiles && pdfFiles.length > 0) || Boolean(pdfFile);
    const hasUploadedImageSgk = images && images.length > 0;

    let contentInstruction = "";
    if (hasUploadedImageSgk && (sourceType === 'image' || !hasUploadedPdfSgk)) {
        contentInstruction = `NGUỒN DỮ LIỆU GỐC BẮT BUỘC (THAM CHIẾU CHÍNH XÁC TUYỆT ĐỐI 100%): Sử dụng duy nhất nội dung từ các hình ảnh Sách giáo khoa (SGK) đính kèm của bài "${baseLessonName}" (Môn ${inputData.subject} - Lớp ${inputData.grade}).
- BẮT BUỘC đọc kỹ từng mục, từng hình ảnh, tình huống, nhân vật, hộp kiến thức/ghi nhớ và bài tập thực hành có trên trang ảnh SGK đính kèm.
- NGHIÊM CẤM TUYỆT ĐỐI tự ý suy diễn, bịa đặt thêm bất kỳ cách làm, phương pháp, tiêu chí đánh giá, công cụ hay nội dung nào KHÔNG CÓ trong trang ảnh SGK đính kèm!`;
    } else if (hasUploadedPdfSgk) {
        contentInstruction = `NGUỒN DỮ LIỆU GỐC BẮT BUỘC (THAM CHIẾU CHÍNH XÁC TUYỆT ĐỐI 100%): File PDF Sách giáo khoa (SGK) môn ${inputData.subject} lớp ${inputData.grade} đính kèm.
- NHIỆM VỤ SỐ 1 CỦA BẠN: Tìm đúng trang có tiêu đề chính xác là "${baseLessonName}" thuộc môn ${inputData.subject} lớp ${inputData.grade} trong file PDF SGK đính kèm, đọc và trích xuất chính xác tuyệt đối 100% các mục, tình huống khởi động, nhân vật, hội thoại, kênh hình, các cách thực hiện, hộp kiến thức/ghi nhớ và các câu hỏi/bài tập Luyện tập - Thực hành - Vận dụng có thật trong đúng bài học đó.
- CẢNH BÁO NGHIÊM NGẶT: Nếu có nhiều bài cùng mang số thứ tự (ví dụ nhiều bài cùng ghi "Bài 2") ở các chủ đề hoặc lớp khác nhau, BẮT BUỘC chỉ đọc đúng bài có tên "${baseLessonName}" của Lớp ${inputData.grade}. NGHIÊM CẤM lấy nội dung của bài khác (như đánh giá địa điểm trên Google Maps của bài khác) ghép vào bài "${baseLessonName}"!`;
    } else {
        contentInstruction = `NGUỒN DỮ LIỆU GỐC BẮT BUỘC (THAM CHIẾU CHÍNH XÁC TUYỆT ĐỐI 100%): Bám sát 100% nội dung bài học "${baseLessonName}" của môn ${inputData.subject} lớp ${inputData.grade} theo chương trình Sách giáo khoa GDPT 2018 hiện hành. Tuyệt đối không bịa đặt các khái niệm hay ví dụ của bài học khác nằm ngoài phạm vi bài học "${baseLessonName}".`;
    }

    const rawNotes = (inputData.integrationNotes || '').trim();
    const hasNotes = rawNotes.length > 0 && !/^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawNotes);
    const extraIntegrationDesc = (inputData.additionalIntegrationNotes || '').trim();

    let integrationInstruction = "";
    if (hasNotes) {
        const notesLower = rawNotes.toLowerCase();
        const notesMentionAI = notesLower.includes('ai') || notesLower.includes('trí tuệ nhân tạo');
        const notesMentionDigitalSkills = notesLower.includes('năng lực số') || notesLower.includes('công nghệ số') || notesLower.includes('chuyển đổi số');

        let integrationComponents: string[] = [];
        integrationComponents.push(`TÍCH HỢP CHÍNH XÁC THEO CỘT GHI CHÚ PPCT: "${rawNotes}"`);

        if (inputData.integrateAI && notesMentionAI) {
            integrationComponents.push("Tích hợp Trí tuệ nhân tạo (AI): Ứng dụng công cụ AI phù hợp, nhận diện vai trò AI hỗ trợ học tập");
        }

        if (inputData.integrateDigitalSkills && notesMentionDigitalSkills) {
            integrationComponents.push("Tích hợp Năng lực số: Khai thác thiết bị số an toàn, bảo mật thông tin và tạo sản phẩm số");
        }

        if (extraIntegrationDesc) {
            integrationComponents.push(`Nội dung & môn học cụ thể bổ sung: "${extraIntegrationDesc}"`);
        }

        integrationInstruction = `- TUẦN NÀY CÓ GHI CHÚ TÍCH HỢP TRONG PHÂN PHỐI CHƯƠNG TRÌNH:
  NỘI DUNG TÍCH HỢP CHÍNH XÁC THEO PPCT: "${rawNotes}"
  ${integrationComponents.map(c => `+ ${c}`).join('\n  ')}

  QUY TẮC THÔNG MINH VÀ CHÍNH XÁC TUYỆT ĐỐI THEO CHỈ ĐẠO CỦA GIÁO VIÊN:
  + BẢN CHẤT & TÍNH LOGIC CỦA NỘI DUNG TÍCH HỢP (TUYỆT ĐỐI KHÔNG NHẦM LẪN VỚI KIẾN THỨC GỐC TRONG SGK):
    * Nội dung tích hợp là những kiến thức mở rộng, có tính thực tiễn và tính ứng dụng cao mà trong bài học gốc của sách giáo khoa chưa đề cập tới, được lồng ghép từ khung năng lực bổ trợ (theo ghi chú "${rawNotes}" hoặc Tài liệu tham khảo) VÀO trong bài học.
    * CẤM TUYỆT ĐỐI lấy nội dung kiến thức vốn đã có sẵn trong bài học SGK để cho là "Tích hợp"!
    * Nội dung tích hợp phải có sự liên kết mạch lạc, xuyên suốt và hợp lý từ phần "I. YÊU CẦU CẦN ĐẠT" xuống đến các "III. CÁC HOẠT ĐỘNG DẠY HỌC" cụ thể, giúp mở rộng tư duy thực tiễn cho học sinh dựa trên nền tảng kiến thức của bài học chính, tránh đưa thông tin tích hợp khiên cưỡng, chắp vá.
    * Toàn bộ nội dung mang tính chất "Tích hợp" được định dạng in nghiêng và TUYỆT ĐỐI KHÔNG IN ĐẬM (không dùng ký tự **).
  + MỤC I. YÊU CẦU CẦN ĐẠT (objectives):
    * KHÔNG dùng số thứ tự 1, 2, 3, 4. KHÔNG dùng nhãn "kiến thức", "năng lực", "phẩm chất". Dùng thuần túy gạch đầu dòng (- ).
    * Dòng tích hợp BẮT BUỘC ghi rõ tên miền tích hợp (nếu ghi chú là GDKNCDS / kỹ năng công dân số thì ghi chuẩn là "Tích hợp giáo dục kĩ năng công dân số"):
      "- Tích hợp giáo dục kĩ năng công dân số: [Nội dung kiến thức/kĩ năng mở rộng thực tiễn được lồng ghép vào bài học]" (hoặc "- Tích hợp [Tên miền theo ghi chú '${rawNotes}']: [Nội dung tích hợp cụ thể]").
  + MỤC III. CÁC HOẠT ĐỘNG DẠY HỌC (activities):
    * CẤM TUYỆT ĐỐI chỉ ghi cụt lủn "[Tích hợp]: - ...".
    * BẮT BUỘC phải ghi đầy đủ tên lĩnh vực tích hợp GIỐNG HỆT NHƯ TRÊN YÊU CẦU CẦN ĐẠT, bắt đầu bằng dấu gạch ngang "- ":
      "- Tích hợp giáo dục kĩ năng công dân số: [Liệt kê rõ ràng, cụ thể nội dung tích hợp mở rộng thực hiện trong hoạt động đó, liên kết chặt chẽ với Yêu cầu cần đạt]" (hoặc tên lĩnh vực tích hợp tương ứng trên Yêu cầu cần đạt).
    * Trong hoạt động đó tích hợp nội dung gì thì liệt kê trực tiếp, rõ ràng nội dung đó ở cả cột Giáo viên và cột Học sinh (định dạng in nghiêng, tuyệt đối không in đậm).`;
    } else {
        integrationInstruction = `- TUẦN NÀY KHÔNG CÓ GHI CHÚ TÍCH HỢP TRONG PHÂN PHỐI CHƯƠNG TRÌNH:
  + NGUYÊN TẮC SƯ PHẠM TUYỆT ĐỐI: Dù ở giao diện có tích chọn AI hay Năng lực số, nhưng bài này trong PPCT KHÔNG CÓ GHI CHÚ thì TUYỆT ĐỐI KHÔNG TÍCH HỢP.
  + TUYỆT ĐỐI KHÔNG xuất hiện bất kỳ dòng Tích hợp nào trong toàn bộ 4 hoạt động của bài học.
  + TRONG MỤC YÊU CẦU CẦN ĐẠT (objectives): CHỈ CÓ các gạch đầu dòng (- ) về kiến thức, kỹ năng, năng lực, phẩm chất chuẩn của bài học SGK. TUYỆT ĐỐI KHÔNG CÓ dòng "- Tích hợp...".
  + Bài dạy này là bài học chuẩn kiến thức, kỹ năng theo chương trình.`;
    }

    const userPrompt = `
        THÔNG TIN CHUNG: Tuần ${inputData.week || '...'}, Môn ${inputData.subject || '...'}, Lớp ${inputData.grade || '...'}.
        THÔNG TIN BÀI DẠY THEO PHÂN PHỐI CHƯƠNG TRÌNH (PPCT):
        - TÊN BÀI HỌC GỐC: "${baseLessonName}"
        - TÊN ĐẦY ĐỦ CỦA TIẾT HỌC TRONG TUẦN NÀY: "${exactLessonTitleWithPeriod}"
        - SỐ TIẾT DẠY TRONG TUẦN NÀY: ĐÚNG 1 TIẾT DUY NHẤT (Tiết ${currentPeriodInLesson}/${totalLessonPeriods} của bài "${baseLessonName}"). THỜI LƯỢNG: ${totalDuration} phút.
        
        **NGUYÊN TẮC SỐ 1 — BÁM SÁT SÁCH GIÁO KHOA (SGK) CHÍNH XÁC TUYỆT ĐỐI 100% (CẤM BỊA ĐẶT NỘI DUNG NGOÀI SGK):**
        - Bắt buộc đối chiếu từng chữ, từng mục, từng hình minh họa và bài tập của bài "${baseLessonName}" trong Sách giáo khoa đính kèm.
        - Chỉ dạy đúng các khái niệm, các bước, các cách thực hiện, tình huống và bài tập CÓ TRONG SÁCH GIÁO KHOA của bài "${baseLessonName}".
        - NGHIÊM CẤM TUYỆT ĐỐI việc tự ý bịa đặt thêm các cách làm, công cụ, tiêu chí đánh giá hay nội dung nằm ngoài Sách giáo khoa!
        - Để đạt đủ số lượng gạch đầu dòng quy định cho mỗi hoạt động, hãy chia nhỏ và mô tả thật chi tiết các bước tổ chức sư phạm của Giáo viên và Học sinh (giao nhiệm vụ quan sát hình/đọc mục nào trong SGK -> thảo luận nhóm trả lời câu hỏi nào của SGK -> đại diện trình bày -> nhận xét chéo -> kết luận theo hộp ghi nhớ SGK) trên chính nội dung thật của SGK.

        **QUY TẮC BẮT BUỘC TUYỆT ĐỐI VỀ ĐỦ 4 HOẠT ĐỘNG DẠY HỌC TRONG TIẾT HỌC (KHÔNG ĐƯỢC BỎ SÓT BẤT KỲ HOẠT ĐỘNG NÀO):**
        Trong phần tử duy nhất của mảng "periods", mảng "activities" BẮT BUỘC PHẢI CÓ ĐẦY ĐỦ 4 HOẠT ĐỘNG DẠY HỌC theo đúng thứ tự sau:
        1. "1. Hoạt động mở đầu"
        2. "2. Hoạt động hình thành kiến thức mới"
        3. "3. Hoạt động luyện tập, thực hành"
        4. "4. Hoạt động vận dụng, trải nghiệm"
        TUYỆT ĐỐI KHÔNG ĐƯỢC BỎ SÓT bất kỳ hoạt động nào trong 4 hoạt động trên!

        **QUY TẮC PHÂN BỔ TIẾN TRÌNH SƯ PHẠM VÀ NỘI DUNG SGK THEO TIẾT HỌC (TUÂN THỦ TUYỆT ĐỐI - CẤM TRÙNG LẶP NỘI DUNG GIỮA CÁC TIẾT):**
        Bài học "${baseLessonName}" có tổng thời lượng là ${totalLessonPeriods} tiết theo Phân phối chương trình (mỗi tuần dạy 1 tiết).
        ${totalLessonPeriods > 1 ? `
        - VỊ TRÍ TIẾT DẠY HIỆN TẠI: ĐÂY LÀ TIẾT ${currentPeriodInLesson} / TỔNG SỐ ${totalLessonPeriods} TIẾT CỦA BÀI HỌC (Tuần ${inputData.week || '...'}).
        - CHỈ SOẠN DUY NHẤT 1 TIẾT NÀY (TIẾT ${currentPeriodInLesson}), TUYỆT ĐỐI KHÔNG SOẠN GỘP CÁC TIẾT KHÁC TRONG CÙNG 1 TUẦN!
        - BẮT BUỘC CHIA BÀI HỌC "${baseLessonName}" TRONG SGK THÀNH ${totalLessonPeriods} PHẦN TƯƠNG ỨNG VỚI ${totalLessonPeriods} TIẾT DẠY VÀ PHÂN BỔ CHÍNH XÁC (ĐỦ 4 HOẠT ĐỘNG):
          ${currentPeriodInLesson === 1 ? `
          + BẠN ĐANG SOẠN RIÊNG TIẾT 1 / ${totalLessonPeriods} (${totalDuration} phút - ĐỦ 4 HOẠT ĐỘNG):
            * Mục I. Yêu cầu cần đạt: Chỉ ghi mục tiêu kiến thức, kỹ năng của PHẦN 1 / MỤC 1 (Phần đầu của bài học trong SGK).
            * Mục II. Đồ dùng dạy học: Thiết bị, học liệu cần cho Phần 1 / Mục 1.
            * 1. Hoạt động mở đầu: Tạo tâm thế hào hứng, dẫn nhập vào bài học bám sát tình huống mở đầu trong SGK.
            * 2. Hoạt động hình thành kiến thức mới: Khám phá sâu sắc kiến thức trọng tâm của PHẦN 1 / MỤC 1 trong SGK (đúng 100% các ý, tình huống, hình ảnh có trong SGK).
            * 3. Hoạt động luyện tập, thực hành: Thực hành câu hỏi/bài tập thuộc phạm vi PHẦN 1 / MỤC 1 trong SGK.
            * 4. Hoạt động vận dụng, trải nghiệm: Vận dụng kiến thức vừa học ở Tiết 1 vào thực tế, củng cố và dặn dò chuẩn bị cho Tiết 2.
            * CẤM TUYỆT ĐỐI: Không được dồn toàn bộ bài vào tiết 1, không dạy trước nội dung của các tiết sau, không bịa nội dung ngoài SGK và KHÔNG ĐƯỢC bỏ sót Hoạt động 4!
          ` : `
          + BẠN ĐANG SOẠN RIÊNG TIẾT ${currentPeriodInLesson} / ${totalLessonPeriods} (${totalDuration} phút - ĐỦ 4 HOẠT ĐỘNG):
            * ĐÂY LÀ TIẾT ${currentPeriodInLesson} (TIẾT NỐI TIẾP) CỦA BÀI HỌC. HỌC SINH ĐÃ HỌC TIẾT ${currentPeriodInLesson - 1} TRƯỚC ĐÓ RỒI.
            * Mục I. Yêu cầu cần đạt: Ghi mục tiêu của PHẦN THỨ ${currentPeriodInLesson} / MỤC TIẾP THEO tương ứng trong SGK.
            * Mục II. Đồ dùng dạy học: Thiết bị, học liệu cần cho phần nội dung của Tiết ${currentPeriodInLesson}.
            * 1. Hoạt động mở đầu: BẮT BUỘC KHỞI ĐỘNG KẾT NỐI: Tổ chức trò chơi / câu hỏi để Học sinh NHẮC LẠI KIẾN THỨC ĐÃ HỌC Ở TIẾT ${currentPeriodInLesson - 1}, tạo cầu nối tự nhiên sang kiến thức mới của Tiết ${currentPeriodInLesson}.
            * 2. Hoạt động hình thành kiến thức mới: Khám phá sâu sắc kiến thức PHẦN THỨ ${currentPeriodInLesson} / MỤC TIẾP THEO trong SGK (đúng 100% nội dung SGK). CẤM TUYỆT ĐỐI KHÔNG DẠY LẠI NỘI DUNG ĐÃ HỌC Ở CÁC TIẾT TRƯỚC!
            * 3. Hoạt động luyện tập, thực hành: Thực hành các câu hỏi/bài tập thuộc đúng phạm vi phần nội dung của Tiết ${currentPeriodInLesson} trong SGK. CẤM TUYỆT ĐỐI KHÔNG LẶP LẠI bài tập của các tiết trước!
            * 4. Hoạt động vận dụng, trải nghiệm: Tổ chức hoạt động Vận dụng theo đúng SGK cho phần nội dung Tiết ${currentPeriodInLesson}, liên hệ thực tiễn đời sống và dặn dò.
          `}
        ` : `
        - Bài học trọn vẹn 1 tiết (${totalDuration} phút): Bắt buộc phân bổ sâu sắc, đầy đủ cả 4 hoạt động (1. Hoạt động mở đầu, 2. Hoạt động hình thành kiến thức mới, 3. Hoạt động luyện tập, thực hành, 4. Hoạt động vận dụng, trải nghiệm) bám sát 100% nội dung bài học trong SGK.
        `}

        - QUY ĐỊNH CẤU TRÚC JSON BẮT BUỘC:
          + Trường "lesson_full_title" BẮT BUỘC ghi chính xác: "${exactLessonTitleWithPeriod}".
          + Mảng "periods" trong JSON kết quả BẮT BUỘC CHỈ CÓ ĐÚNG 1 PHẦN TỬ DUY NHẤT (periods.length === 1) với "period_number": ${currentPeriodInLesson}.
          + Phần tử duy nhất trong "periods" PHẢI CÓ mảng "activities" gồm ĐÚNG 4 HOẠT ĐỘNG:
            * activities[0].name = "1. Hoạt động mở đầu"
            * activities[1].name = "2. Hoạt động hình thành kiến thức mới"
            * activities[2].name = "3. Hoạt động luyện tập, thực hành"
            * activities[3].name = "4. Hoạt động vận dụng, trải nghiệm"

        GHI CHÚ THÊM: ${inputData.context || ''}
        
        ${contentInstruction}
        **YÊU CẦU TÍCH HỢP:**
        ${integrationInstruction}
        - Nếu có Tài liệu tham khảo, hãy dùng nó làm nguồn đối chiếu chuẩn xác cho nội dung tích hợp (không lấy kiến thức sẵn có trong bài học SGK làm nội dung tích hợp).
        
        **NHẮC LẠI YÊU CẦU BẮT BUỘC:**
        1. **CẤU TRÚC BẮT BUỘC & BÁM SÁT SGK 100%:** Đủ 4 hoạt động dạy học cho tiết học. Mọi kiến thức, cách làm, tình huống và bài tập phải nằm trong đúng bài "${baseLessonName}" của SGK đính kèm, tuyệt đối không bịa đặt nội dung ngoài SGK.
        2. **YÊU CẦU CẦN ĐẠT & TÍCH HỢP (QUY CHUẨN BẮT BUỘC):**
           - TUYỆT ĐỐI KHÔNG sử dụng đánh số 1, 2, 3, 4.
           - TUYỆT ĐỐI KHÔNG ghi "kiến thức", "năng lực", "phẩm chất", "Kiến thức, kỹ năng:", "Về năng lực:",...
           - Thể hiện thuần túy bằng các GẠCH ĐẦU DÒNG NỘI DUNG. Mỗi phần tử trong mảng "objectives" BẮT ĐẦU bằng dấu gạch ngang "- ".
           - NẾU CÓ TÍCH HỢP: Không lấy nội dung kiến thức vốn có sẵn của bài học cho là tích hợp. Phải tích hợp kỹ năng/vấn đề bổ trợ (như Giáo dục kĩ năng công dân số) vào bài học. Ghi rõ trên Yêu cầu cần đạt: "- Tích hợp giáo dục kĩ năng công dân số: [Nội dung...]" (hoặc lĩnh vực tích hợp tương ứng). Và trong Các hoạt động dạy học cũng phải ghi rõ đúng tên đó: "- Tích hợp giáo dục kĩ năng công dân số: [Liệt kê nội dung tích hợp cụ thể trong hoạt động đó]".
        3. **CHIỀU SÂU SƯ PHẠM, KPI GẠCH ĐẦU DÒNG VÀ NGUYÊN TẮC 1:1 NGANG HÀNG (Không tính hình ảnh và tích hợp):**
            - Nội dung phải có chiều sâu chuyên môn, mô tả rõ câu hỏi gợi mở của GV, cách thức tổ chức hoạt động (nhóm đôi, nhóm 4, trò chơi, thảo luận...) và câu trả lời/thao tác cụ thể của HS bám sát 100% bài học trong SGK.
            - 1. Hoạt động mở đầu >= 4 gạch đầu dòng.
            - 2. Hoạt động hình thành kiến thức mới >= 8 gạch đầu dòng.
            - 3. Hoạt động luyện tập, thực hành >= 10 gạch đầu dòng.
            - 4. Hoạt động vận dụng, trải nghiệm >= 4 gạch đầu dòng.
            - BẮT BUỘC NGUYÊN TẮC 1:1 NGANG HÀNG: Cột "Hoạt động của Giáo viên" có bao nhiêu gạch đầu dòng thì cột "Hoạt động của Học sinh" BẮT BUỘC có đúng bấy nhiêu gạch đầu dòng đáp lại tương ứng (Tỷ lệ 1:1 tuyệt đối).
        4. **HÌNH ẢNH TRỰC QUAN BÁM SÁT NỘI DUNG CÂU VĂN NGAY PHÍA TRÊN & KÊNH HÌNH SGK (BẮT BUỘC TỪ 3 ĐẾN 4 HÌNH / TIẾT):**
            - BẮT BUỘC có đúng **từ 3 đến 4 hình ảnh minh họa trực quan** trong tiết học này (phân bổ vào Hoạt động 1: 1 hình, Hoạt động 2: 1-2 hình, Hoạt động 3: 1 hình), CHỈ CÓ Ở CỘT GIÁO VIÊN, không dùng gạch đầu dòng trước thẻ hình ảnh.
            - NGUYÊN TẮC BẤT DI BẤT DỊCH: Hình ảnh phải trực quan hóa chính xác VẬT THỂ, CÁC BỘ PHẬN CẤU TẠO, MỐI QUAN HỆ KỸ THUẬT, BẢNG DANH MỤC CHƯƠNG TRÌNH, HỌC CỤ, MÔ HÌNH hoặc MÀN HÌNH GIAO DIỆN cụ thể được nhắc đến ở câu văn ngay phía trên nó và trong bài học "${baseLessonName}" của SGK. Nếu câu văn trên nhắc đến Hình số mấy trong SGK (VD: Hình 1 về mối quan hệ giữa đài phát thanh và máy thu thanh; Hình 3 về danh mục chương trình kênh VOV1 và VOV2; hoặc các chương trình phát thanh có trong Hình 3 mà em thích), thẻ gợi ý hình ảnh bắt buộc phải ghi rõ chi tiết nội dung cụ thể của chính Hình đó trong SGK!
            - TUYỆT ĐỐI KHÔNG mô tả theo kiểu sơ đồ tư duy (mindmap), đồ họa thông tin (infographic), sơ đồ khối chữ chung chung, phiếu học tập hay cảnh lớp học!
            - Cú pháp: \`[Gợi ý hình ảnh: Mô tả trực quan, chi tiết, rõ nét các thành phần và nội dung cụ thể của chính vật thể, bảng danh mục, mối quan hệ kỹ thuật hoặc hình SGK vừa nêu ở câu văn ngay phía trên]\`.
        5. **THỜI GIAN LINH HOẠT VÀ CHÍNH XÁC:**
            - Phân bổ thời gian linh hoạt, bám sát nội dung thực tế của 4 hoạt động (ví dụ đối với tiết ${totalDuration} phút: Mở đầu 4-5 phút, KT mới 12-15 phút, Luyện tập 11-14 phút, Vận dụng 4-5 phút).
            - BẮT BUỘC: Tổng số phút của cả 4 hoạt động cộng lại PHẢI BẰNG ĐÚNG CHÍNH XÁC ${totalDuration} phút.
    `;

    const finalApiKey = resolveGeminiApiKey(apiKey);
    if (!finalApiKey) {
        throw new Error("Vui lòng nhập Gemini API Key ở thanh công cụ phía trên để tạo giáo án.");
    }

    const parts: any[] = [];
    let uploadedFileNames: string[] = [];

    const uploadAndPush = async (file: File) => {
        if (file.size > 100 * 1024 * 1024) {
            throw new Error(`Kích thước file ${file.name} vượt quá 100MB.`);
        }

        const lowerName = file.name.toLowerCase();
        if (
            lowerName.endsWith('.docx') ||
            lowerName.endsWith('.doc') ||
            file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const result = await mammoth.extractRawText({ arrayBuffer });
                if (result.value && result.value.trim()) {
                    parts.push({
                        text: `[NỘI DUNG VĂN BẢN TRÍCH XUẤT TỪ FILE WORD "${file.name}"]:\n${result.value.trim()}`
                    });
                    return;
                }
            } catch (docErr) {
                console.warn(`Không thể đọc văn bản từ file Word ${file.name}:`, docErr);
                return;
            }
        }

        let mimeType = file.type;
        if (!mimeType) {
            if (lowerName.endsWith('.pdf')) mimeType = 'application/pdf';
            else if (lowerName.endsWith('.png')) mimeType = 'image/png';
            else if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) mimeType = 'image/jpeg';
            else if (lowerName.endsWith('.webp')) mimeType = 'image/webp';
            else mimeType = 'application/pdf';
        }

        if (file.size <= 19 * 1024 * 1024) {
            const base64Data = await getCachedFileBase64(file);
            parts.push({
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            });
        } else {
            const cacheKey = `${finalApiKey.slice(-6)}-${file.name}-${file.size}-${file.lastModified}`;
            if (uploadedFileCache && uploadedFileCache.has(cacheKey)) {
                const cached = uploadedFileCache.get(cacheKey)!;
                parts.push({
                    fileData: { fileUri: cached.uri, mimeType: cached.mimeType }
                });
                return;
            }

            try {
                const ai = new GoogleGenAI({ apiKey: finalApiKey });
                const uploaded = await ai.files.upload({ file: file, mimeType: mimeType } as any);
                
                if (uploadedFileCache) {
                    uploadedFileCache.set(cacheKey, { uri: uploaded.uri, mimeType: uploaded.mimeType, name: uploaded.name });
                } else {
                    uploadedFileNames.push(uploaded.name);
                }

                parts.push({
                    fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType }
                });
            } catch (uploadErr) {
                console.warn("File API upload fallback to inline base64:", uploadErr);
                const base64Data = await getCachedFileBase64(file);
                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: mimeType
                    }
                });
            }
        }
    };
    
    const allPdfCandidates = pdfFiles.length > 0 ? pdfFiles : (pdfFile ? [pdfFile] : []);
    // Nếu giáo viên tải lên nhiều file PDF SGK của nhiều khối lớp khác nhau (VD: Lớp 3, Lớp 4, Lớp 5), ưu tiên lọc đúng file của khối lớp đang chọn
    const targetGradeNum = String(inputData.grade || '').replace(/\D+/g, '').trim();
    let effectivePdfFiles = allPdfCandidates;
    if (allPdfCandidates.length > 1 && targetGradeNum) {
        const gradeRegex = new RegExp(`(lớp|lop|khối|khoi|[\\s_\\-\\.])${targetGradeNum}([\\s_\\-\\.]|\\.pdf|$)`, 'i');
        const otherGradeRegex = new RegExp(`(lớp|lop|khối|khoi|[\\s_\\-\\.])${['1','2','3','4','5'].filter(g => g !== targetGradeNum).join('|')}([\\s_\\-\\.]|\\.pdf|$)`, 'i');
        const matchingGradeFiles = allPdfCandidates.filter(f => gradeRegex.test(f.name) || !otherGradeRegex.test(f.name));
        if (matchingGradeFiles.length > 0) {
            effectivePdfFiles = matchingGradeFiles;
        }
    }

    if (effectivePdfFiles.length > 0 && (sourceType === 'pdf' || images.length === 0)) {
        parts.push({ text: `DƯỚI ĐÂY LÀ (CÁC) FILE PDF SÁCH GIÁO KHOA CHÍNH THỨC CỦA MÔN ${inputData.subject.toUpperCase()} LỚP ${inputData.grade} (CHỈ TRA CỨU ĐÚNG BÀI "${baseLessonName}"):` });
        for (const f of effectivePdfFiles) {
            parts.push({ text: `[Tệp SGK đính kèm: "${f.name}"]` });
            await uploadAndPush(f);
        }
    }
    if (images.length > 0 && (sourceType === 'image' || effectivePdfFiles.length === 0)) {
        parts.push({ text: "DƯỚI ĐÂY LÀ CÁC HÌNH ẢNH TRANG SÁCH GIÁO KHOA CHÍNH THỨC CỦA BÀI HỌC (ĐỌC KỸ VÀ TRÍCH XUẤT CHÍNH XÁC NỘI DUNG):" });
        for (const img of images) {
            await uploadAndPush(img.file);
        }
    }

    if (hasNotes && referencePdfs && referencePdfs.length > 0) {
        parts.push({ text: "DƯỚI ĐÂY LÀ (CÁC) FILE PDF TÀI LIỆU THAM KHẢO (SỬ DỤNG LÀM KHUNG CƠ SỞ CHO NỘI DUNG TÍCH HỢP):" });
        for (const ref of referencePdfs) {
            await uploadAndPush(ref);
        }
    }

    if (ppctFile) {
        parts.push({ text: "DƯỚI ĐÂY LÀ FILE PHÂN PHỐI CHƯƠNG TRÌNH (PPCT) CỦA MÔN HỌC (BẮT BUỘC ĐỐI CHIẾU CHÍNH XÁC TÊN BÀI VÀ SỐ TIẾT QUY ĐỊNH):" });
        await uploadAndPush(ppctFile);
    }

    parts.push({ text: userPrompt });

    try {
        // Danh sách 7 pool model độc lập để tự động chuyển đổi tức thì khi một model bị quá tải (503 High Demand)
        const modelsToTry = [
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.0-flash',
            'gemini-2.5-pro',
            'gemini-2.0-flash-lite'
        ];
        let delay = 1200;
        const maxAttempts = 14;

        for (let i = 0; i < maxAttempts; i++) {
            const currentModel = modelsToTry[i % modelsToTry.length];
            try {
                const ai = new GoogleGenAI({
                    apiKey: finalApiKey
                });

                const config: any = {
                    systemInstruction: SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseSchema: LESSON_PLAN_RESPONSE_SCHEMA,
                    temperature: 0.15,
                    maxOutputTokens: 32768,
                };
                if (currentModel === 'gemini-3-flash-preview') {
                    config.thinkingConfig = {
                        thinkingLevel: ThinkingLevel.LOW
                    };
                } else if (currentModel === 'gemini-2.5-flash') {
                    config.thinkingConfig = {
                        thinkingBudget: 512
                    };
                }

                const response = await ai.models.generateContent({
                    model: currentModel,
                    contents: { parts },
                    config
                });
                const text = response.text;

                if (!text) throw new Error("AI trả về kết quả rỗng.");
                const parsed = sanitizeAndParseJSON(text);

                // Kiểm tra nghiêm ngặt: Mỗi tiết học có đủ 4 hoạt động hay chưa
                const hasMissingActivities = (parsed.periods || []).some(
                    p => !Array.isArray(p.activities) || p.activities.length < 4
                );
                if (hasMissingActivities && i < maxAttempts - 2) {
                    throw new Error("Thiếu hoạt động dạy học: kết quả chưa đủ 4 hoạt động bắt buộc, đang tự động yêu cầu tạo lại đầy đủ.");
                }

                // Chuẩn hóa và đảm bảo tuyệt đối 100% mỗi tiết đều có đầy đủ 4 hoạt động theo đúng thứ tự
                const finalPlan = ensureFourActivitiesInAllPeriods(parsed, inputData);
                return finalPlan;
            } catch (err: any) {
                console.warn(`Gemini API retry warning (attempt ${i + 1}/${maxAttempts}, model ${currentModel}):`, err?.message || err);

                const errMsg = err?.message ? String(err.message).toLowerCase() : JSON.stringify(err || '').toLowerCase();
                const isInvalidApiKey =
                    errMsg.includes('api_key_invalid') ||
                    errMsg.includes('api key not valid') ||
                    errMsg.includes('permission_denied');

                if (isInvalidApiKey) {
                    throw new Error("Gemini API Key không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại API Key ở góc trên cùng.");
                }

                const isFastSwitchError =
                    errMsg.includes('503') ||
                    errMsg.includes('unavailable') ||
                    errMsg.includes('high demand') ||
                    errMsg.includes('overloaded') ||
                    errMsg.includes('404') ||
                    errMsg.includes('not found') ||
                    errMsg.includes('not_found') ||
                    errMsg.includes('400') ||
                    errMsg.includes('invalid_argument');

                const isRetryable = (
                    isFastSwitchError ||
                    errMsg.includes('quota') ||
                    errMsg.includes('500') ||
                    errMsg.includes('internal') ||
                    errMsg.includes('429') ||
                    errMsg.includes('resource_exhausted') ||
                    errMsg.includes('resource exhausted') ||
                    errMsg.includes('fetch') ||
                    errMsg.includes('network') ||
                    errMsg.includes('json') ||
                    errMsg.includes('parse') ||
                    errMsg.includes('định dạng') ||
                    errMsg.includes('thiếu hoạt động') ||
                    errMsg.includes('rỗng')
                );

                if (i === maxAttempts - 1 || !isRetryable) {
                    if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('resource_exhausted')) {
                        throw new Error("API Key đã vượt giới hạn lượt gọi (Quota/429) sau nhiều lần thử lại. Vui lòng dùng API Key mới hoặc đợi vài phút.");
                    }
                    if (errMsg.includes('503') || errMsg.includes('unavailable') || errMsg.includes('high demand')) {
                        throw new Error("Máy chủ AI của Google đang có lượng truy cập cao đột biến. Vui lòng bấm thực hiện lại sau vài giây.");
                    }
                    throw new Error("Không thể xử lý yêu cầu lúc này. Vui lòng thử lại.");
                }

                // Nếu gặp lỗi 503 (High demand) hoặc 404/400 trên model hiện tại, chuyển ngay sang pool model kế tiếp sau 400ms
                if (isFastSwitchError && (i + 1) % modelsToTry.length !== 0) {
                    await new Promise(resolve => setTimeout(resolve, 400));
                    continue;
                }

                if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('resource_exhausted')) {
                    delay = Math.max(delay, 2500);
                }

                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 1.3, 5000);
            }
        }
        throw new Error("Không thể kết nối với AI sau nhiều lần thử.");
    } finally {
        if (uploadedFileNames.length > 0 && finalApiKey) {
            try {
                const ai = new GoogleGenAI({ apiKey: finalApiKey });
                for (const name of uploadedFileNames) {
                    await ai.files.delete({ name }).catch(() => {});
                }
            } catch(e) {
                console.warn("Lỗi khi xoá file tạm:", e);
            }
        }
    }
};

export const extractLessonsFromPpct = async (
    ppctFile: File,
    apiKey: string
): Promise<PpctLesson[]> => {
    const finalApiKey = resolveGeminiApiKey(apiKey);
    
    if (!finalApiKey) {
        throw new Error("Vui lòng nhập Gemini API Key ở thanh công cụ phía trên để phân tích file Phân phối chương trình.");
    }

    const ai = new GoogleGenAI({ apiKey: finalApiKey });
    const fileNameLower = ppctFile.name.toLowerCase();

    let filePart: any;
    let uploadedName: string | null = null;

    if (fileNameLower.endsWith('.docx')) {
        try {
            const arrayBuffer = await ppctFile.arrayBuffer();
            const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
            if (html && html.trim().length > 0) {
                filePart = {
                    text: `DƯỚI ĐÂY LÀ NỘI DUNG BẢNG PHÂN PHỐI CHƯƠNG TRÌNH TRÍCH XUẤT TỪ TỆP WORD (${ppctFile.name}):\n${html.slice(0, 60000)}`
                };
            }
        } catch (docxErr) {
            console.warn("Mammoth docx parse fallback:", docxErr);
        }
    }

    if (!filePart) {
        let mimeType = ppctFile.type;
        if (!mimeType) {
            if (fileNameLower.endsWith('.pdf')) mimeType = 'application/pdf';
            else if (fileNameLower.endsWith('.png')) mimeType = 'image/png';
            else if (fileNameLower.endsWith('.jpg') || fileNameLower.endsWith('.jpeg')) mimeType = 'image/jpeg';
            else mimeType = 'application/pdf';
        }

        if (ppctFile.size <= 19 * 1024 * 1024) {
            const base64Data = await getCachedFileBase64(ppctFile);
            filePart = {
                inlineData: { data: base64Data, mimeType }
            };
        } else {
            try {
                const uploaded = await ai.files.upload({ file: ppctFile, mimeType } as any);
                uploadedName = uploaded.name;
                filePart = {
                    fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType }
                };
            } catch (uploadErr) {
                const base64Data = await getCachedFileBase64(ppctFile);
                filePart = {
                    inlineData: { data: base64Data, mimeType }
                };
            }
        }
    }

    const prompt = `
VAI TRÒ: CHUYÊN GIA ĐỌC VÀ TRÍCH XUẤT TÀI LIỆU SƯ PHẠM.
NHIỆM VỤ: Đọc tài liệu đính kèm (đây là file Phân phối chương trình - PPCT chứa bảng phân phối chương trình môn học).
Bảng có thể gồm 4 cột chính theo quy chuẩn mới:
1. Cột 1: TUẦN (để đầu tiên, ví dụ: "Tuần 1", "Tuần 2", ... hoặc "1", "2", ...)
2. Cột 2: TÊN BÀI (ví dụ: "Bài 1: Thông tin và quyết định", "Bài 2: Xử lý thông tin",...)
3. Cột 3: SỐ TIẾT (số tiết của bài học đó, ví dụ: 3, 4, 2,...)
4. Cột 4: GHI CHÚ (mục đích nhập các nội dung tích hợp cũng như môn học tích hợp, ví dụ "Tích hợp môn Tiếng Việt và AI", nếu để trống hoặc không tích hợp thì ghi "")
(Hoặc bảng 2 cột dạng cũ: Cột Tên bài và Cột Số tiết - nếu không có cột tuần, hãy tự đánh số Tuần 1, Tuần 2,...).

Hãy trích xuất danh sách TẤT CẢ các tuần/bài học trong bảng từ đầu đến cuối một cách chính xác tuyệt đối theo đúng file tải lên.

QUY TẮC BẮT BUỘC:
1. Đọc đúng toàn bộ danh sách từng hàng từ trên xuống dưới theo thứ tự trong bảng.
2. Tuần (week): Trích xuất chuỗi tuần, chuẩn hoá thành "Tuần 1", "Tuần 2", ... theo đúng dữ liệu của file.
3. Tên bài (lessonName): Giữ nguyên tên bài đầy đủ. Bỏ qua các hàng tiêu đề cột hoặc hàng chú thích chung của tài liệu.
4. Số tiết (periods): Phải là một số nguyên dương (Ví dụ: 3, 4, 2, 1,...).
5. Ghi chú (notes): Trích xuất chính xác nội dung cột ghi chú nếu có (ví dụ: các nội dung tích hợp, môn học tích hợp). Nếu cột ghi chú trống, hoặc ghi "-", "(Không tích hợp)", "Không" thì trả về chuỗi rỗng "".
6. Định dạng trả về: BẮT BUỘC chỉ trả về duy nhất chuỗi JSON hợp lệ theo cấu trúc sau:
{
  "lessons": [
    {
      "week": "Tuần 1",
      "lessonName": "Bài 1: Thông tin và quyết định",
      "periods": 3,
      "notes": ""
    },
    {
      "week": "Tuần 20",
      "lessonName": "Bài 10: Thực hành tạo sản phẩm số",
      "periods": 2,
      "notes": "Tích hợp môn Tiếng Việt: Luyện viết đoạn văn; Tích hợp AI tạo sản phẩm số"
    },
    {
      "week": "Tuần 21",
      "lessonName": "Bài 11: Em tìm kiếm thông tin trên Internet",
      "periods": 2,
      "notes": "Tích hợp môn Khoa học: Khám phá tự nhiên; Tích hợp Năng lực số"
    }
  ]
}
TUYỆT ĐỐI KHÔNG thêm văn bản giải thích hay markdown bên ngoài chuỗi JSON.
`;

    try {
        let responseText = '';
        // Sử dụng 7 pool model độc lập để đảm bảo khi 1 model bị quá tải (503 UNAVAILABLE) hệ thống chuyển sang model khác ngay lập tức
        const ppctModels = [
            'gemini-2.5-flash-lite',
            'gemini-2.5-flash',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.0-flash',
            'gemini-2.5-pro',
            'gemini-2.0-flash-lite'
        ];
        let lastError: any = null;
        const maxPpctAttempts = 14;

        for (let attempt = 0; attempt < maxPpctAttempts; attempt++) {
            const ppctModel = ppctModels[attempt % ppctModels.length];
            try {
                const config: any = {
                    responseMimeType: "application/json",
                    temperature: 0.1
                };
                if (ppctModel === 'gemini-2.5-flash') {
                    config.thinkingConfig = { thinkingBudget: 0 };
                } else if (ppctModel === 'gemini-3-flash-preview') {
                    config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
                }

                const response = await ai.models.generateContent({
                    model: ppctModel,
                    contents: [
                        filePart,
                        { text: prompt }
                    ],
                    config
                });
                responseText = (response.text || '').trim();
                if (responseText && responseText.includes('{')) break;
            } catch (e: any) {
                lastError = e;
                console.warn(`PPCT extraction attempt ${attempt + 1}/${maxPpctAttempts} with ${ppctModel} failed:`, e?.message || e);
                const msg = String(e?.message || JSON.stringify(e || '')).toLowerCase();
                if (msg.includes('api_key_invalid') || msg.includes('api key not valid') || msg.includes('permission_denied')) {
                    throw new Error("Gemini API Key không hợp lệ. Vui lòng kiểm tra lại API Key.");
                }
                // Chờ ngắn khi đổi sang pool model tiếp theo, hoặc chờ lâu hơn nếu đã hết 1 vòng các model
                const waitMs = (attempt + 1) % ppctModels.length === 0 ? 1800 : 450;
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }
        }

        if (!responseText) {
            const errStr = String(lastError?.message || JSON.stringify(lastError || '')).toLowerCase();
            if (errStr.includes('503') || errStr.includes('unavailable') || errStr.includes('high demand')) {
                throw new Error("Máy chủ AI đang có lượng truy cập cao đột biến. Vui lòng bấm 'Phân tích lại file PPCT' sau vài giây.");
            }
            if (errStr.includes('429') || errStr.includes('quota') || errStr.includes('resource_exhausted')) {
                throw new Error("API Key đang tạm thời chạm giới hạn lượt gọi (Quota/429). Vui lòng đợi khoảng 30 giây rồi bấm 'Phân tích lại file PPCT' hoặc nhập API Key khác.");
            }
            throw new Error("Không thể phân tích file PPCT lúc này. Vui lòng bấm 'Phân tích lại file PPCT' để thử lại.");
        }

        const cleanedJsonText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const jsonMatch = cleanedJsonText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Không tìm thấy cấu trúc dữ liệu hợp lệ trong phản hồi. Vui lòng bấm 'Phân tích lại file PPCT'.");
        }
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.lessons) && parsed.lessons.length > 0) {
            return parsed.lessons.map((l: any, index: number) => {
                const weekStr = l.week ? String(l.week).trim() : `Tuần ${index + 1}`;
                const rawNotes = l.notes ? String(l.notes).trim() : '';
                const cleanNotes = /^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawNotes) ? '' : rawNotes;
                return {
                    week: weekStr.startsWith('Tuần') ? weekStr : `Tuần ${weekStr}`,
                    lessonName: String(l.lessonName || '').trim(),
                    periods: 1,
                    notes: cleanNotes
                };
            }).filter((l: PpctLesson) => l.lessonName.length > 0);
        }
        throw new Error("Không tìm thấy bài học nào trong bảng phân phối chương trình.");
    } finally {
        if (uploadedName) {
            try {
                await ai.files.delete({ name: uploadedName });
            } catch(e) {}
        }
    }
};

