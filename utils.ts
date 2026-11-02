import {
    Document,
    Packer,
    Paragraph,
    TextRun,
    ImageRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    AlignmentType,
    VerticalAlign,
    Header,
    Footer,
    PageNumber,
    PageBreak,
    TableLayoutType,
    TabStopType,
    convertMillimetersToTwip
} from 'docx';
import { LessonPlanResponse, Period, Activity } from './types';
import {
    isImageHintLine,
    renderPedagogicalIllustrationDataUrl,
    pregenerateLessonImagesWithAI,
    dataUrlToUint8Array
} from './utils/lessonImageGenerator';

export const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const result = reader.result?.toString();
            if (result) {
                const base64Data = result.split(',')[1];
                resolve(base64Data);
            } else {
                reject(new Error("Failed to convert file to base64"));
            }
        };
        reader.onerror = error => reject(error);
    });
};

export const formatActivityName = (name: string): string => {
    const cleanName = (name || '').trim();
    const lower = cleanName.toLowerCase();

    if (lower.includes("mở đầu") || lower.includes("khởi động") || /^1[\.\)]/.test(lower)) {
        return "1. Hoạt động mở đầu";
    }
    if (lower.includes("kiến thức") || lower.includes("khám phá") || lower.includes("hình thành") || /^2[\.\)]/.test(lower)) {
        return "2. Hoạt động hình thành kiến thức mới";
    }
    if (lower.includes("luyện tập") || lower.includes("thực hành") || /^3[\.\)]/.test(lower)) {
        return "3. Hoạt động luyện tập, thực hành";
    }
    if (lower.includes("vận dụng") || lower.includes("trải nghiệm") || lower.includes("mở rộng") || /^4[\.\)]/.test(lower)) {
        return "4. Hoạt động vận dụng, trải nghiệm";
    }

    return cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
};

export const formatTopicName = (topic: string): string => {
    let text = (topic || '').trim();
    text = text.replace(/<\/?u>/g, '').replace(/<\/?b>/g, '').replace(/\*\*/g, '');
    text = text.replace(/^([\d\w]+[\.\/])\s*/, '* ');
    if (!text.startsWith('*') && text.length > 0) text = '* ' + text;
    return text;
};

export const extractBaseLessonName = (rawName: string): string => {
    let name = (rawName || '').trim();
    name = name.replace(/\s*\(\s*\d+\s*phút\s*\)/gi, '').trim();
    name = name.replace(/[\(\[\-–—:\.]*\s*tiết\s*\d+(\s*(và|&|\-|\–|—|\/|,|trên)\s*\d+)*\s*[\)\]]*/gi, ' ');
    name = name.replace(/[\(\[\-–—:\.]*\s*(tiết\s*)?(tiếp\s*theo|tt)\s*[\)\]]*/gi, ' ');
    name = name.replace(/^tiết\s*\d+[\s:–\-\.]*/gi, ' ');
    name = name.replace(/\s+/g, ' ').trim();
    name = name.replace(/^[\-–—:\.,]\s*/, '').replace(/[\-–—:\.,]\s*$/, '').trim();
    return name || (rawName || '').trim();
};

export const extractExplicitPeriodNumber = (rawName: string): number | null => {
    const match = (rawName || '').match(/[\(\[\-–—:\.]*\s*tiết\s*(\d+)(?:\s*(?:\/|trên|-|–)\s*\d+)?\s*[\)\]]*/i);
    if (match && match[1]) {
        return parseInt(match[1], 10);
    }
    return null;
};

export const formatLessonTitleWithPeriod = (rawTitle: string, periodNum: number | string): string => {
    const title = extractBaseLessonName(rawTitle || '');
    const pNum = String(periodNum || '1').trim();
    return `${title} (TIẾT ${pNum})`;
};

/**
 * Đảm bảo tuyệt đối 100%:
 * - Mỗi tuần chỉ soạn đúng 1 tiết học (periods.length === 1), gắn đúng số thứ tự tiết của bài học (VD: Tiết 2 khi là Tiết 2/2).
 * - Mỗi tiết học (Period) trong Kế hoạch bài dạy luôn có ĐẦY ĐỦ 4 HOẠT ĐỘNG DẠY HỌC
 *   theo đúng chuẩn Công văn 2345/BGDĐT-GDTH:
 *   1. Hoạt động mở đầu
 *   2. Hoạt động hình thành kiến thức mới
 *   3. Hoạt động luyện tập, thực hành
 *   4. Hoạt động vận dụng, trải nghiệm
 */
export const ensureFourActivitiesInAllPeriods = (
    response: LessonPlanResponse,
    inputData?: any
): LessonPlanResponse => {
    if (!response || !Array.isArray(response.periods)) {
        return response;
    }

    const rawTitleSource = inputData?.baseLessonName || inputData?.lessonName || response.lesson_full_title || 'bài học';
    const baseTitle = extractBaseLessonName(rawTitleSource);

    // Xác định chính xác tiết thứ mấy của bài học trong tuần này
    const explicitPeriodFromInput =
        Number(inputData?.periodIndexInLesson) ||
        extractExplicitPeriodNumber(inputData?.lessonName || '') ||
        extractExplicitPeriodNumber(response.lesson_full_title || '') ||
        null;

    // Mỗi tuần chỉ có 1 tiết học. Nếu AI lỡ trả về nhiều hơn 1 tiết cho 1 tuần, chọn đúng tiết tương ứng với periodIndexInLesson
    let sourcePeriods = response.periods;
    if (sourcePeriods.length > 1) {
        const targetPeriodNum = explicitPeriodFromInput || 1;
        const matchedPeriod = sourcePeriods.find(p => Number(p.period_number) === targetPeriodNum);
        sourcePeriods = [matchedPeriod || sourcePeriods[Math.min(targetPeriodNum - 1, sourcePeriods.length - 1)] || sourcePeriods[0]];
    }

    const canonicalSpecs: Array<{
        index: number;
        name: string;
        defaultTime: string;
        buildFallback: (periodNum: number) => Activity;
    }> = [
        {
            index: 1,
            name: "1. Hoạt động mở đầu",
            defaultTime: "5'",
            buildFallback: (periodNum: number) => ({
                name: "1. Hoạt động mở đầu",
                time: "5'",
                topic: periodNum > 1
                    ? `* Khởi động và kết nối: Ôn lại kiến thức tiết trước và dẫn dắt vào nội dung tiết ${periodNum}`
                    : `* Khởi động và kết nối: Tình huống thực tiễn dẫn dắt vào bài học "${baseTitle}"`,
                rows: [
                    {
                        teacher: periodNum > 1
                            ? `- Giáo viên tổ chức trò chơi khởi động kết nối kiến thức đã học ở tiết trước với nội dung tiếp theo của bài "${baseTitle}".`
                            : `- Giáo viên tổ chức hoạt động khởi động, trình chiếu hình ảnh/tình huống mở đầu trong SGK để tạo hứng thú cho học sinh trước khi vào bài "${baseTitle}".`,
                        student: periodNum > 1
                            ? `- Học sinh hào hứng tham gia trò chơi khởi động, nhớ lại các kiến thức cốt lõi đã tìm hiểu ở tiết học trước.`
                            : `- Học sinh chăm chú quan sát tình huống mở đầu trên màn chiếu và hào hứng tham gia hoạt động khởi động.`
                    },
                    {
                        teacher: periodNum > 1
                            ? `- Giáo viên nêu câu hỏi gợi mở: "Em hãy nhắc lại nội dung chính đã học ở tiết trước và cho biết ý nghĩa của nội dung đó trong thực tế?"`
                            : `- Giáo viên đặt câu hỏi gợi mở gắn với tình huống mở đầu: "Quan sát tình huống trên, em nhận thấy điều gì quen thuộc và điều gì chúng ta cần khám phá trong bài học hôm nay?"`,
                        student: periodNum > 1
                            ? `- Học sinh xung phong trả lời câu hỏi, nêu lại chính xác các nội dung trọng tâm đã học ở tiết trước.`
                            : `- Học sinh suy nghĩ cá nhân, mạnh dạn giơ tay chia sẻ nhận xét và trải nghiệm thực tế của bản thân về tình huống mở đầu.`
                    },
                    {
                        teacher: `- Giáo viên mời 1 - 2 học sinh nhận xét, bổ sung câu trả lời của bạn.`,
                        student: `- Học sinh lắng nghe câu trả lời của bạn, đưa ra ý kiến nhận xét và bổ sung.`
                    },
                    {
                        teacher: `- Giáo viên nhận xét, biểu dương tinh thần học tập của cả lớp, kết nối trực tiếp vào bài học "${baseTitle}" (Tiết ${periodNum}) và ghi tên bài lên bảng.`,
                        student: `- Học sinh lắng nghe lời giới thiệu của giáo viên, mở SGK đúng trang bài học và ghi tên bài vào vở.`
                    }
                ]
            })
        },
        {
            index: 2,
            name: "2. Hoạt động hình thành kiến thức mới",
            defaultTime: "15'",
            buildFallback: () => ({
                name: "2. Hoạt động hình thành kiến thức mới",
                time: "15'",
                topic: `* Khám phá và phân tích nội dung kiến thức trọng tâm của bài "${baseTitle}"`,
                rows: [
                    {
                        teacher: `- Giáo viên yêu cầu học sinh mở SGK, quan sát kênh hình minh họa và đọc kỹ thông tin phần Khám phá của bài "${baseTitle}".\n[Gợi ý hình ảnh: Cận cảnh trực quan đối tượng, cấu tạo bộ phận hoặc sơ đồ nguyên lý trọng tâm trong phần Khám phá của bài ${baseTitle}]`,
                        student: `- Học sinh mở SGK, tập trung quan sát từng chi tiết trên hình minh họa và đọc thầm phần thông tin kiến thức mới.`
                    },
                    {
                        teacher: `- Giáo viên chia lớp thành các nhóm 4, giao nhiệm vụ thảo luận và đặt câu hỏi phân tích: "Quan sát hình minh họa trong SGK, em hãy nêu rõ các đặc điểm, bộ phận hoặc các bước thực hiện chính được thể hiện trong hình?"`,
                        student: `- Học sinh nhanh chóng tạo nhóm 4, phân công nhiệm vụ, cùng quan sát kênh hình và trao đổi để trả lời câu hỏi của giáo viên.`
                    },
                    {
                        teacher: `- Giáo viên đi đến từng nhóm quan sát, lắng nghe và gợi ý cho những nhóm còn lúng túng cách đối chiếu giữa hình vẽ với nội dung chữ trong SGK.`,
                        student: `- Học sinh trong nhóm chỉ vào từng chi tiết trên hình minh họa, đối chiếu với thông tin trong SGK để thống nhất câu trả lời.`
                    },
                    {
                        teacher: `- Giáo viên mời đại diện 2 - 3 nhóm trình bày kết quả thảo luận trước lớp.`,
                        student: `- Đại diện các nhóm tự tin trình bày đầy đủ các đặc điểm, bộ phận và nội dung kiến thức vừa tìm hiểu được trước lớp.`
                    },
                    {
                        teacher: `- Giáo viên tổ chức cho các nhóm khác nhận xét, đối chiếu và đặt câu hỏi phản biện cho nhóm bạn.`,
                        student: `- Các nhóm khác chăm chú lắng nghe, nhận xét phần trình bày của bạn và bổ sung những chi tiết còn thiếu.`
                    },
                    {
                        teacher: `- Giáo viên đặt thêm câu hỏi đào sâu kiến thức: "Vì sao chúng ta cần nắm vững đặc điểm/quy trình này khi thao tác hoặc vận dụng trong thực tế?"`,
                        student: `- Học sinh suy nghĩ, phân tích nguyên nhân – kết quả và trả lời dựa trên nội dung vừa khám phá trong SGK.`
                    },
                    {
                        teacher: `- Giáo viên phân tích, giải thích làm rõ bản chất khoa học của từng nội dung và chốt lại kết luận kiến thức trọng tâm của bài "${baseTitle}".`,
                        student: `- Học sinh lắng nghe giáo viên phân tích, nắm vững bản chất kiến thức cốt lõi của bài học.`
                    },
                    {
                        teacher: `- Giáo viên mời 1 - 2 học sinh đọc to mục Ghi nhớ / Kết luận trong SGK trước lớp.`,
                        student: `- Học sinh đọc to, rõ ràng nội dung mục Ghi nhớ trong SGK; cả lớp đọc thầm và khắc sâu kiến thức.`
                    }
                ]
            })
        },
        {
            index: 3,
            name: "3. Hoạt động luyện tập, thực hành",
            defaultTime: "10'",
            buildFallback: () => ({
                name: "3. Hoạt động luyện tập, thực hành",
                time: "10'",
                topic: `* Luyện tập, thực hành củng cố kiến thức và rèn luyện kỹ năng bài "${baseTitle}"`,
                rows: [
                    {
                        teacher: `- Giáo viên giới thiệu yêu cầu phần Luyện tập / Thực hành trong SGK của bài "${baseTitle}", trình chiếu bảng bài tập hoặc quy trình thao tác mẫu.\n[Gợi ý hình ảnh: Cận cảnh sơ đồ bài tập, bảng phân loại hoặc các bước thao tác thực hành chuẩn của bài ${baseTitle}]`,
                        student: `- Học sinh đọc kỹ yêu cầu bài tập thực hành trong SGK và quan sát phần minh họa trên màn chiếu.`
                    },
                    {
                        teacher: `- Giáo viên hướng dẫn chi tiết từng bước thực hiện và nêu rõ các tiêu chí đánh giá kết quả bài làm/sản phẩm thực hành.`,
                        student: `- Học sinh lắng nghe, ghi nhớ quy trình các bước thực hiện và các tiêu chí đánh giá.`
                    },
                    {
                        teacher: `- Giáo viên tổ chức cho học sinh thực hiện nhiệm vụ luyện tập, thực hành cá nhân hoặc theo nhóm đôi.`,
                        student: `- Học sinh tích cực thực hiện bài tập luyện tập và thao tác thực hành đúng theo quy trình đã được hướng dẫn.`
                    },
                    {
                        teacher: `- Giáo viên quan sát bao quát lớp, kịp thời hướng dẫn, uốn nắn thao tác và hỗ trợ những học sinh còn gặp khó khăn.\n[Gợi ý hình ảnh: Cận cảnh sản phẩm mẫu hoặc kết quả hoàn chỉnh đúng tiêu chí kỹ thuật của bài ${baseTitle}]`,
                        student: `- Học sinh chủ động trao đổi với bạn cùng bàn, tự kiểm tra và điều chỉnh thao tác để hoàn thành tốt nhiệm vụ.`
                    },
                    {
                        teacher: `- Giáo viên mời đại diện một số cá nhân/nhóm lên trình bày kết quả làm bài hoặc trưng bày sản phẩm thực hành trước lớp.`,
                        student: `- Đại diện học sinh/nhóm tự tin trình bày kết quả bài tập hoặc giới thiệu sản phẩm thực hành và nêu rõ cách làm.`
                    },
                    {
                        teacher: `- Giáo viên hướng dẫn cả lớp nhận xét, đánh giá chéo bài làm của bạn dựa trên các tiêu chí đã nêu.`,
                        student: `- Học sinh đối chiếu với tiêu chí đánh giá, nhận xét ưu điểm và góp ý cách khắc phục hạn chế cho bài làm của bạn.`
                    },
                    {
                        teacher: `- Giáo viên nhận xét chi tiết, phân tích những lỗi sai thường gặp để học sinh rút kinh nghiệm và tuyên dương các cá nhân/nhóm thực hiện chính xác.`,
                        student: `- Học sinh lắng nghe nhận xét của giáo viên, tự sửa chữa và hoàn thiện bài làm của mình.`
                    }
                ]
            })
        },
        {
            index: 4,
            name: "4. Hoạt động vận dụng, trải nghiệm",
            defaultTime: "5'",
            buildFallback: () => ({
                name: "4. Hoạt động vận dụng, trải nghiệm",
                time: "5'",
                topic: `* Vận dụng kiến thức vào thực tiễn cuộc sống`,
                rows: [
                    {
                        teacher: `- Giáo viên nêu tình huống thực tiễn gắn với mục Vận dụng trong SGK của bài "${baseTitle}" và đặt câu hỏi: "Em sẽ vận dụng kiến thức vừa học như thế nào để giải quyết tình huống này trong học tập và sinh hoạt hằng ngày?"`,
                        student: `- Học sinh lắng nghe tình huống, suy nghĩ liên hệ với thực tế gia đình, nhà trường để tìm phương án xử lý phù hợp.`
                    },
                    {
                        teacher: `- Giáo viên mời 2 - 3 học sinh chia sẻ cách xử lý tình huống hoặc ý tưởng vận dụng sáng tạo trước lớp.`,
                        student: `- Học sinh hào hứng chia sẻ cách vận dụng kiến thức bài học vào cuộc sống hằng ngày một cách cụ thể, thiết thực.`
                    },
                    {
                        teacher: `- Giáo viên tổ chức cho các học sinh khác nhận xét, bổ sung ý tưởng cho bạn.`,
                        student: `- Học sinh lắng nghe phần chia sẻ của bạn và đóng góp thêm các cách vận dụng hay, an toàn, hiệu quả.`
                    },
                    {
                        teacher: `- Giáo viên nhận xét chung tiết học, khen ngợi các cá nhân, nhóm học tập tích cực và dặn dò học sinh thực hành vận dụng tại nhà, chuẩn bị cho tiết học sau.`,
                        student: `- Học sinh lắng nghe, ghi nhớ nội dung dặn dò của giáo viên để thực hiện cùng người thân tại nhà.`
                    }
                ]
            })
        }
    ];

    const updatedPeriods: Period[] = sourcePeriods.map((period, pIdx) => {
        const resolvedPeriodNum = explicitPeriodFromInput || Number(period.period_number) || (pIdx + 1);
        const rawActivities = Array.isArray(period.activities) ? period.activities : [];

        const buckets: Map<number, Activity[]> = new Map([
            [1, []],
            [2, []],
            [3, []],
            [4, []]
        ]);

        rawActivities.forEach((act, idx) => {
            if (!act) return;
            const formatted = formatActivityName(act.name || '');
            let bucketIdx = 0;
            if (formatted.startsWith('1.')) bucketIdx = 1;
            else if (formatted.startsWith('2.')) bucketIdx = 2;
            else if (formatted.startsWith('3.')) bucketIdx = 3;
            else if (formatted.startsWith('4.')) bucketIdx = 4;
            else if (idx < 4 && (buckets.get(idx + 1)?.length || 0) === 0) {
                bucketIdx = idx + 1;
            } else {
                bucketIdx = 2;
            }

            const validRows = (act.rows || []).filter(
                r => r && ((r.teacher && r.teacher.trim()) || (r.student && r.student.trim()))
            );
            if (validRows.length > 0) {
                buckets.get(bucketIdx)?.push({
                    ...act,
                    name: canonicalSpecs[bucketIdx - 1].name,
                    rows: validRows
                });
            }
        });

        const finalActivities: Activity[] = canonicalSpecs.map(spec => {
            const matchedList = buckets.get(spec.index) || [];
            if (matchedList.length === 0) {
                return spec.buildFallback(resolvedPeriodNum);
            }
            if (matchedList.length === 1) {
                const single = matchedList[0];
                return {
                    name: spec.name,
                    time: (single.time || spec.defaultTime).trim(),
                    topic: single.topic,
                    rows: single.rows
                };
            }
            const mergedRows: Array<{ teacher: string; student: string }> = [];
            matchedList.forEach((item, mIdx) => {
                if (mIdx > 0 && item.topic) {
                    const topicLine = formatTopicName(item.topic);
                    const itemRows = [...(item.rows || [])];
                    if (itemRows.length > 0) {
                        itemRows[0] = {
                            teacher: `${topicLine}\n${itemRows[0].teacher || ''}`.trim(),
                            student: itemRows[0].student || ''
                        };
                    }
                    mergedRows.push(...itemRows);
                } else {
                    mergedRows.push(...(item.rows || []));
                }
            });

            return {
                name: spec.name,
                time: (matchedList[0].time || spec.defaultTime).trim(),
                topic: matchedList[0].topic,
                rows: mergedRows
            };
        });

        return {
            ...period,
            period_number: resolvedPeriodNum,
            activities: finalActivities
        };
    });

    const isChatGptLessonNotMaps =
        baseTitle.toLowerCase().includes('chatgpt') &&
        !baseTitle.toLowerCase().includes('google maps') &&
        !baseTitle.toLowerCase().includes('địa điểm');

    const sanitizeCrossLessonHallucination = (text: string, isTeacher: boolean): string => {
        if (!isChatGptLessonNotMaps || !text) return text;
        return text
            .split('\n')
            .map(line => {
                if (/google\s*maps|đánh giá chất lượng địa điểm|vị trí địa điểm/i.test(line)) {
                    if (isImageHintLine(line)) {
                        return '[Gợi ý hình ảnh: Màn hình máy tính hiển thị cửa sổ hội thoại ChatGPT bên cạnh cửa sổ trình duyệt Google Tìm kiếm đang tra cứu kiểm chứng thông tin]';
                    }
                    return isTeacher
                        ? '- Giáo viên hướng dẫn học sinh kiểm chứng thông tin tư vấn từ ChatGPT bằng cách tra cứu, đối chiếu trên các trang thông tin chính thống và hỏi ý kiến thầy cô, người thân.'
                        : '- Học sinh thực hành đối chiếu thông tin từ ChatGPT với các nguồn trang web chính thống và trao đổi cùng thầy cô, người thân để xác thực.';
                }
                return line;
            })
            .join('\n');
    };

    const enforceThreeToFourImagesInPeriod = (period: Period): Period => {
        const splitLinesWithHints = (text: string): string[] =>
            (text || '')
                .replace(/(\[Gợi ý hình ảnh:|Gợi ý hình ảnh:|\(Gợi ý hình ảnh:|\[Hình ảnh minh họa:|Hình ảnh minh họa:)/gi, '\n$1')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean);

        // Gộp các row chỉ chứa thẻ [Gợi ý hình ảnh: ...] đứng riêng lẻ vào ngay dưới câu lệnh của Giáo viên ở row liền trước
        // để hình ảnh luôn nhận được chính xác 100% câu văn ngay phía trên nó
        const activities = (period.activities || []).map(act => {
            const mergedRows: Array<{ teacher: string; student: string }> = [];
            for (const r of act.rows || []) {
                const tLines = splitLinesWithHints(r.teacher || '');
                const sTrimmed = (r.student || '').trim();
                const isOnlyImageHints = tLines.length > 0 && tLines.every(l => isImageHintLine(l)) && !sTrimmed;
                if (isOnlyImageHints && mergedRows.length > 0) {
                    const prev = mergedRows[mergedRows.length - 1];
                    prev.teacher = `${(prev.teacher || '').trim()}\n${tLines.join('\n')}`.trim();
                } else {
                    mergedRows.push({ teacher: r.teacher || '', student: r.student || '' });
                }
            }
            return {
                ...act,
                rows: mergedRows
            };
        });

        const countPeriodImages = (): number => {
            let count = 0;
            for (const act of activities) {
                for (const row of act.rows || []) {
                    const lines = splitLinesWithHints(row.teacher || '');
                    for (const line of lines) {
                        if (isImageHintLine(line)) count++;
                    }
                }
            }
            return count;
        };

        const isProceduralClassroomLine = (line: string): boolean => {
            return /^(-\s*)?(giáo\s*viên|gv)?\s*(mời\s+đại\s+diện|yêu\s+cầu\s+các\s+nhóm\s+nhận\s+xét|nhận\s+xét\s+chung|tuyên\s+dương|khen\s+ngợi|dặn\s+dò|ghi\s+tên\s+bài|chia\s+lớp\s+thành|tổ\s+chức\s+báo\s+cáo)/i.test(
                line.trim()
            );
        };

        const stripClassroomManagementWrapper = (rawLine: string): string => {
            return rawLine
                .replace(/^[-–\*\s]+/, '')
                .replace(/^(Giáo\s*viên|GV)\s*[:\-\–]?\s*/i, '')
                .replace(
                    /^(tổ\s*chức\s*trò\s*chơi\s*['"][^'"]+['"]\s*(bằng\s*cách|,\s*yêu\s*cầu\s*học\s*sinh)?|chia\s*lớp\s*thành\s*[^,]+,\s*(giao\s*nhiệm\s*vụ|yêu\s*cầu)\s*(cho\s*các\s*nhóm|học\s*sinh)?|yêu\s*cầu\s*(học\s*sinh|hs|các\s*nhóm)\s*(mở\s*sgk\s*(trang\s*\d+)?\s*,?\s*)?(quan\s*sát|đọc\s*thầm|tìm\s*hiểu|thảo\s*luận)?|trình\s*chiếu\s*(lại\s*)?(hình\s*ảnh|kênh\s*hình|sơ\s*đồ|mô\s*hình|vật\s*mẫu)?|hướng\s*dẫn\s*(học\s*sinh|hs)\s*(chú\s*ý\s*)?(quan\s*sát|đối\s*chiếu)?)\s*/i,
                    ''
                )
                .replace(
                    /\s*(để\s*học\s*sinh\s*ôn\s*lại\s*kiến\s*thức.*|để\s*cả\s*lớp\s*thảo\s*luận.*|và\s*thảo\s*luận\s*nhóm.*|và\s*đặt\s*câu\s*hỏi.*|và\s*trả\s*lời\s*câu\s*hỏi.*)$/i,
                    ''
                )
                .replace(/[\.\:\;]+$/, '')
                .trim();
        };

        const buildContextualHintFromTeacherLine = (teacherText: string, actName: string): string => {
            const nonHintLines = splitLinesWithHints(teacherText).filter(
                l => !isImageHintLine(l) && !isActivityIntegrationLine(l) && !l.startsWith('*')
            );
            const nonProceduralLines = nonHintLines.filter(l => !isProceduralClassroomLine(l));
            const candidatePool = nonProceduralLines.length > 0 ? nonProceduralLines : nonHintLines;
            const anchorLine =
                candidatePool.find(l =>
                    /hình\s*\d+|sơ\s*đồ|mô\s*hình|bộ\s*phận|cấu\s*tạo|màn\s*hình|giao\s*diện|bảng|danh\s*mục|sản\s*phẩm|vật\s*liệu|dụng\s*cụ|mối\s*quan\s*hệ|bước\s*\d+|quan\s*sát|trình\s*chiếu/i.test(
                        l
                    )
                ) ||
                candidatePool[0] ||
                `Cấu tạo và đặc điểm trọng tâm thuộc ${actName} của bài ${baseTitle}`;

            const coreFocalObject =
                stripClassroomManagementWrapper(anchorLine) ||
                `Đối tượng và cấu tạo trọng tâm của bài ${baseTitle}`;

            return `[Gợi ý hình ảnh: Cận cảnh trực quan ${coreFocalObject}]`;
        };

        // Nếu tổng số hình ảnh trong tiết < 3, tự động bổ sung vào các hoạt động ưu tiên (HĐ 2 -> HĐ 3 -> HĐ 1 -> HĐ 4)
        let currentCount = countPeriodImages();
        const priorityActIndices = [1, 2, 0, 3];

        // Vòng 1: Bổ sung vào những hoạt động chưa có hình ảnh nào
        for (const actIdx of priorityActIndices) {
            if (currentCount >= 3) break;
            const act = activities[actIdx];
            if (!act || !act.rows || act.rows.length === 0) continue;

            const actHasImage = act.rows.some(r =>
                splitLinesWithHints(r.teacher || '').some(l => isImageHintLine(l))
            );
            if (!actHasImage) {
                const targetRowIdx = act.rows.findIndex(r =>
                    /hình\s*\d+|sơ\s*đồ|mô\s*hình|bộ\s*phận|cấu\s*tạo|màn\s*hình|giao\s*diện|bảng|sản\s*phẩm|vật\s*mẫu|quan\s*sát|trình\s*chiếu|chiếu/i.test(
                        r.teacher || ''
                    ) && !isProceduralClassroomLine(r.teacher || '')
                );
                const fallbackIdx = act.rows.findIndex(r => !isProceduralClassroomLine(r.teacher || ''));
                const rowIdx = targetRowIdx >= 0 ? targetRowIdx : fallbackIdx >= 0 ? fallbackIdx : 0;
                const targetRow = act.rows[rowIdx];
                const hintLine = buildContextualHintFromTeacherLine(targetRow.teacher || '', act.name || '');
                targetRow.teacher = `${(targetRow.teacher || '').trim()}\n${hintLine}`.trim();
                currentCount++;
            }
        }

        // Vòng 2: Nếu vẫn < 3 (ví dụ một hoạt động có nhiều bước nhưng thiếu hình), bổ sung vào dòng chưa có hình của HĐ 2 hoặc HĐ 3
        for (const actIdx of priorityActIndices) {
            if (currentCount >= 3) break;
            const act = activities[actIdx];
            if (!act || !act.rows) continue;

            for (let rIdx = 0; rIdx < act.rows.length; rIdx++) {
                if (currentCount >= 3) break;
                const row = act.rows[rIdx];
                const lines = splitLinesWithHints(row.teacher || '');
                const rowHasImage = lines.some(l => isImageHintLine(l));
                if (!rowHasImage && lines.length > 0 && !lines.every(l => isProceduralClassroomLine(l))) {
                    const hintLine = buildContextualHintFromTeacherLine(row.teacher || '', act.name || '');
                    row.teacher = `${(row.teacher || '').trim()}\n${hintLine}`.trim();
                    currentCount++;
                }
            }
        }

        // Nếu tổng số hình ảnh trong tiết > 4, giữ lại đúng 4 hình ảnh đầu tiên để đảm bảo chuẩn 3-4 hình/tiết
        if (currentCount > 4) {
            let kept = 0;
            for (const act of activities) {
                for (const row of act.rows || []) {
                    const lines = splitLinesWithHints(row.teacher || '');
                    const filteredLines = lines.filter(line => {
                        if (isImageHintLine(line)) {
                            if (kept < 4) {
                                kept++;
                                return true;
                            }
                            return false;
                        }
                        return true;
                    });
                    row.teacher = filteredLines.join('\n');
                }
            }
        }

        return {
            ...period,
            activities
        };
    };

    const rawIntegrationNotes = (inputData?.integrationNotes || '').trim();
    const extraIntegrationNotes = (inputData?.additionalIntegrationNotes || '').trim();
    const hasExplicitIntegrationNotes =
        (rawIntegrationNotes.length > 0 &&
            !/^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawIntegrationNotes)) ||
        extraIntegrationNotes.length > 0;
    const effectiveIntegrationNoteText =
        rawIntegrationNotes && !/^(\-|\(không tích hợp\)|không tích hợp|không|none)$/i.test(rawIntegrationNotes)
            ? rawIntegrationNotes
            : extraIntegrationNotes;

    const ensureIntegrationOrderAndActivities = (period: Period): Period => {
        const rawObjs = Array.isArray(period.objectives) ? period.objectives : [];
        const formattedObjList = formatObjectives(rawObjs);

        const standardObjs = formattedObjList.filter(o => !o.isIntegration).map(o => o.text);
        const integrationObjs = formattedObjList.filter(o => o.isIntegration).map(o => o.text);

        // Nếu tuần dạy có ghi chú tích hợp nhưng AI chưa đưa dòng tích hợp vào Yêu cầu cần đạt,
        // tự động tạo dòng Yêu cầu cần đạt tích hợp dựa trên nội dung bài học và đặt ở CUỐI CÙNG
        if (hasExplicitIntegrationNotes && integrationObjs.length === 0) {
            const prefix = extractIntegrationPrefixFromObjectives(rawObjs, effectiveIntegrationNoteText);
            const cleanNoteDetail = effectiveIntegrationNoteText
                .replace(/^tích\s*hợp\s*([^:\-\–]+)[:\-\–]\s*/i, '')
                .trim();
            const synthesizedObj =
                cleanNoteDetail && cleanNoteDetail.toLowerCase() !== prefix.toLowerCase()
                    ? `- ${prefix}: Vận dụng ngữ cảnh bài học "${baseTitle}" để phát triển kỹ năng và thực hành ${cleanNoteDetail.charAt(0).toLowerCase() + cleanNoteDetail.slice(1)} phù hợp với thực tiễn.`
                    : `- ${prefix}: Dựa vào nội dung bài học "${baseTitle}" để mở rộng kỹ năng vận dụng an toàn, khoa học và sáng tạo vào thực tiễn cuộc sống.`;
            integrationObjs.push(synthesizedObj);
        }

        // BẮT BUỘC: Các yêu cầu cần đạt của bài học nằm ở phía trên, nội dung tích hợp nằm ở cuối cùng
        const orderedObjectives = [...standardObjs, ...integrationObjs];
        const hasIntegrationInObjectives = integrationObjs.length > 0;
        const integrationPrefix = extractIntegrationPrefixFromObjectives(
            orderedObjectives,
            effectiveIntegrationNoteText
        );

        const integrationObjectiveContent =
            integrationObjs.length > 0
                ? integrationObjs[integrationObjs.length - 1]
                      .replace(/^[-–\*\s]*tích\s*hợp[^:]*:\s*/i, '')
                      .replace(/[\.\s]+$/, '')
                      .trim()
                : '';

        let activities = (period.activities || []).map(act => ({
            ...act,
            rows: (act.rows || []).map(r => {
                const tText = r.teacher || '';
                const sText = r.student || '';
                const tLines = tText.split('\n').map(l => l.trim()).filter(Boolean);
                const sLines = sText.split('\n').map(l => l.trim()).filter(Boolean);

                const tHasInt = tLines.some(l => isActivityIntegrationLine(l));
                const sHasInt = sLines.some(l => isActivityIntegrationLine(l));

                // Nếu cột GV có dòng tích hợp nhưng cột HS chưa gắn nhãn tích hợp, chuẩn hóa để cả 2 cột đều hiển thị chữ nghiêng màu đỏ rõ ràng
                if (tHasInt && !sHasInt) {
                    const tIntLine = tLines.find(l => isActivityIntegrationLine(l)) || '';
                    const rowPrefix = extractIntegrationPrefixFromObjectives([tIntLine], integrationPrefix);
                    const nonImageTLines = tLines.filter(l => !isImageHintLine(l));
                    if (sLines.length >= nonImageTLines.length && sLines.length > 0) {
                        const lastIdx = sLines.length - 1;
                        sLines[lastIdx] = formatActivityIntegrationLine(sLines[lastIdx], rowPrefix);
                    } else {
                        const fallbackStudentInt = integrationObjectiveContent
                            ? `- ${rowPrefix}: Học sinh lắng nghe, liên hệ và thực hành ${integrationObjectiveContent.charAt(0).toLowerCase() + integrationObjectiveContent.slice(1)} theo hướng dẫn của giáo viên.`
                            : `- ${rowPrefix}: Học sinh tích cực trao đổi, liên hệ và thực hành nội dung tích hợp gắn với tình huống thực tế của bài học.`;
                        sLines.push(fallbackStudentInt);
                    }
                    return {
                        teacher: tText,
                        student: sLines.join('\n')
                    };
                }
                return r;
            })
        }));

        // Nếu mục I. Yêu cầu cần đạt có phần tích hợp nhưng trong toàn bộ 4 hoạt động dạy học chưa có dòng tích hợp nào,
        // tự động bổ sung dòng tích hợp rõ ràng, chính xác vào Hoạt động 3 (hoặc Hoạt động 2) ở cả cột GV và cột HS
        if (hasIntegrationInObjectives) {
            const anyActivityHasIntegration = activities.some(act =>
                (act.rows || []).some(
                    r => isActivityIntegrationLine(r.teacher || '') || isActivityIntegrationLine(r.student || '')
                )
            );
            if (!anyActivityHasIntegration && activities.length > 0) {
                const targetActIdx = activities[2] ? 2 : activities[1] ? 1 : 0;
                const targetAct = activities[targetActIdx];
                const coreDetail =
                    integrationObjectiveContent ||
                    `vận dụng mở rộng nội dung tích hợp dựa trên bài học "${baseTitle}"`;
                const normalizedDetail = coreDetail.charAt(0).toLowerCase() + coreDetail.slice(1);
                const teacherIntLine = `- ${integrationPrefix}: Giáo viên hướng dẫn học sinh dựa vào nội dung bài học "${baseTitle}" để liên hệ và thực hiện yêu cầu tích hợp: ${normalizedDetail}.`;
                const studentIntLine = `- ${integrationPrefix}: Học sinh hào hứng thảo luận, liên hệ thực tế và thực hành ${normalizedDetail} chính xác theo hướng dẫn của giáo viên.`;

                targetAct.rows = [
                    ...(targetAct.rows || []),
                    {
                        teacher: teacherIntLine,
                        student: studentIntLine
                    }
                ];
            }
        }

        return {
            ...period,
            objectives: orderedObjectives,
            activities
        };
    };

    const cleanedPeriods = updatedPeriods.map(p =>
        enforceThreeToFourImagesInPeriod(
            ensureIntegrationOrderAndActivities({
                ...p,
                objectives: Array.isArray(p.objectives)
                    ? p.objectives.map(o =>
                          isChatGptLessonNotMaps
                              ? o.replace(/,?\s*Google\s*Maps/gi, '').replace(/đánh giá địa điểm trên Google Maps/gi, 'kiểm chứng thông tin trên công cụ tìm kiếm')
                              : o
                      )
                    : p.objectives,
                materials: p.materials
                    ? {
                          teacher: isChatGptLessonNotMaps
                              ? (p.materials.teacher || '').replace(/,\s*Google\s*Maps/gi, '').replace(/Google\s*Maps\s*và\s*/gi, '')
                              : p.materials.teacher,
                          student: isChatGptLessonNotMaps
                              ? (p.materials.student || '').replace(/,\s*Google\s*Maps/gi, '').replace(/Google\s*Maps\s*và\s*/gi, '')
                              : p.materials.student
                      }
                    : p.materials,
                activities: (p.activities || []).map(act => ({
                    ...act,
                    rows: (act.rows || []).map(r => ({
                        ...r,
                        teacher: sanitizeCrossLessonHallucination(r.teacher || '', true),
                        student: sanitizeCrossLessonHallucination(r.student || '', false)
                    }))
                }))
            })
        )
    );

    const finalPeriodNum = cleanedPeriods[0]?.period_number || explicitPeriodFromInput || 1;
    const updatedFullTitle = formatLessonTitleWithPeriod(baseTitle, finalPeriodNum);

    return {
        ...response,
        lesson_full_title: updatedFullTitle,
        periods: cleanedPeriods
    };
};

/**
 * Bộ sửa lỗi và phân tích JSON thông minh:
 * - Xử lý an toàn dấu ngoặc nhọn { } nằm bên trong chuỗi văn bản
 * - Tự động escape các ký tự xuống dòng (\n, \r, \t) và dấu ngoặc kép chưa escape bên trong chuỗi tiếng Việt
 * - Tự động đóng chuỗi và đóng ngoặc (], }) nếu phản hồi JSON dài bị ngắt quãng ở cuối
 */
const KNOWN_JSON_KEYS_REGEX = /^"(lesson_full_title|week|grade_class|subject|date_range|periods|period_number|objectives|materials|teacher|student|activities|time|name|topic|rows)"\s*:/;

const repairAndExtractJSON = (rawText: string): string => {
    const cleaned = (rawText || '')
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();

    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
        throw new Error("Không tìm thấy cấu trúc JSON trong phản hồi của AI.");
    }

    const src = cleaned.slice(firstBrace);
    let out = '';
    let inString = false;
    let currentStringIsKey = false;
    let escaped = false;
    const stack: Array<{ close: '}' | ']'; expectingKey: boolean }> = [];

    const nextNonSpaceChar = (fromIdx: number): { ch: string; idx: number } => {
        for (let k = fromIdx; k < src.length; k++) {
            const c = src[k];
            if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
                return { ch: c, idx: k };
            }
        }
        return { ch: '', idx: src.length };
    };

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];

        if (inString) {
            if (escaped) {
                out += ch;
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                out += '\\';
                escaped = true;
                continue;
            }
            if (ch === '\n') {
                out += '\\n';
                continue;
            }
            if (ch === '\r') {
                out += '\\r';
                continue;
            }
            if (ch === '\t') {
                out += '\\t';
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code < 0x20 || code === 0x7f) {
                continue;
            }
            if (ch === '"') {
                // Kiểm tra chính xác dấu " này là dấu đóng chuỗi cấu trúc JSON hay là dấu ngoặc kép nằm trong câu tiếng Việt (VD: "Tốt", "Đạt": ...)
                const { ch: nextCh, idx: nextIdx } = nextNonSpaceChar(i + 1);
                const topContainer = stack[stack.length - 1];
                let isStructuralClose = false;

                if (nextCh === '') {
                    isStructuralClose = true;
                } else if (currentStringIsKey) {
                    // Nếu đang đọc tên key của object JSON, dấu " đóng key chỉ khi ký tự tiếp theo là ':'
                    isStructuralClose = nextCh === ':';
                } else if (topContainer?.close === '}') {
                    // Đang đọc giá trị (value) của một thuộc tính trong object JSON:
                    // Dấu " đóng value CHỈ khi theo sau là '}' HOẶC ',' rồi đến một key chuẩn của schema (hoặc '}')
                    if (nextCh === '}') {
                        isStructuralClose = true;
                    } else if (nextCh === ',') {
                        const afterCommaInfo = nextNonSpaceChar(nextIdx + 1);
                        const restFromAfterComma = src.slice(afterCommaInfo.idx, afterCommaInfo.idx + 40);
                        isStructuralClose =
                            afterCommaInfo.ch === '}' ||
                            afterCommaInfo.ch === '' ||
                            KNOWN_JSON_KEYS_REGEX.test(restFromAfterComma);
                    }
                } else if (topContainer?.close === ']') {
                    // Đang đọc phần tử chuỗi trong mảng (VD: mảng "objectives"):
                    if (nextCh === ']') {
                        isStructuralClose = true;
                    } else if (nextCh === ',') {
                        const afterCommaInfo = nextNonSpaceChar(nextIdx + 1);
                        const restFromAfterComma = src.slice(afterCommaInfo.idx, afterCommaInfo.idx + 20);
                        isStructuralClose =
                            afterCommaInfo.ch === ']' ||
                            afterCommaInfo.ch === '{' ||
                            afterCommaInfo.ch === '' ||
                            /^"\s*[-–+*]/.test(restFromAfterComma);
                    }
                } else {
                    isStructuralClose = nextCh === '}' || nextCh === ']';
                }

                if (isStructuralClose) {
                    inString = false;
                    currentStringIsKey = false;
                    out += '"';
                } else {
                    out += '\\"';
                }
                continue;
            }
            out += ch;
        } else {
            const topContainer = stack[stack.length - 1];
            if (ch === '"') {
                inString = true;
                currentStringIsKey = Boolean(topContainer && topContainer.close === '}' && topContainer.expectingKey);
                out += '"';
            } else if (ch === ':') {
                if (topContainer && topContainer.close === '}') {
                    topContainer.expectingKey = false;
                }
                out += ':';
            } else if (ch === ',') {
                if (topContainer && topContainer.close === '}') {
                    topContainer.expectingKey = true;
                }
                out += ',';
            } else if (ch === '{') {
                stack.push({ close: '}', expectingKey: true });
                out += '{';
            } else if (ch === '[') {
                stack.push({ close: ']', expectingKey: false });
                out += '[';
            } else if (ch === '}' || ch === ']') {
                out = out.replace(/,\s*$/, '');
                if (stack.length > 0) {
                    stack.pop();
                }
                out += ch;
                if (stack.length === 0) {
                    break;
                }
            } else {
                const code = ch.charCodeAt(0);
                if (code >= 0x20 || ch === '\n' || ch === '\r' || ch === '\t') {
                    out += ch;
                }
            }
        }
    }

    // Nếu JSON bị cắt cụt giữa chừng do giới hạn token, tự động đóng chuỗi và đóng các ngoặc còn mở
    if (inString) {
        if (escaped) {
            out = out.slice(0, -1);
        }
        out += '"';
    }

    while (stack.length > 0) {
        const expectedClose = stack.pop()!.close;
        out = out.replace(/,\s*$/, '');
        if (expectedClose === '}') {
            if (/:\s*$/.test(out)) {
                out += '""';
            } else if (/\{\s*"[^"]*"\s*$/.test(out)) {
                out = out.replace(/"[^"]*"\s*$/, '');
            } else if (/,\s*"[^"]*"\s*$/.test(out)) {
                out = out.replace(/,\s*"[^"]*"\s*$/, '');
            }
        }
        out = out.replace(/,\s*$/, '');
        out += expectedClose;
    }

    return out;
};

export const sanitizeAndParseJSON = (text: string): LessonPlanResponse => {
    const raw = (text || '').trim();
    if (!raw) {
        throw new Error("AI trả về kết quả rỗng.");
    }

    // Bước 1: Thử parse trực tiếp nếu JSON đã hoàn toàn hợp lệ
    try {
        const directCleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        const firstIdx = directCleaned.indexOf('{');
        const lastIdx = directCleaned.lastIndexOf('}');
        if (firstIdx !== -1 && lastIdx > firstIdx) {
            const parsedDirect: LessonPlanResponse = JSON.parse(directCleaned.slice(firstIdx, lastIdx + 1));
            if (parsedDirect && Array.isArray(parsedDirect.periods)) {
                return ensureFourActivitiesInAllPeriods(parsedDirect);
            }
        }
    } catch {
        // Chuyển sang Bước 2: Sửa lỗi chuỗi và khôi phục JSON tự động
    }

    try {
        const repaired = repairAndExtractJSON(raw);
        const parsed: LessonPlanResponse = JSON.parse(repaired);
        return ensureFourActivitiesInAllPeriods(parsed);
    } catch (e: any) {
        console.warn("JSON Parse retry needed:", e?.message || e);
        throw new Error("Định dạng dữ liệu trả về chưa hoàn chỉnh, hệ thống đang tự động chuẩn hóa lại.");
    }
};

export const cleanPrefix = (text: string | null | undefined): string => {
    if (!text) return "";
    let cleaned = text.replace(/^[-–\*\s]*(GV|Giáo viên|HS|Học sinh|Thầy|Cô)\s*[:\.]\s*/gim, '- ');
    cleaned = cleaned.replace(/^-\s*-\s*/gm, '- ');
    return cleaned;
};

/**
 * Căn chỉnh từng cặp hành động của Giáo viên và Học sinh 1:1 ngang hàng,
 * đồng thời tách các dòng hình ảnh minh họa thành dòng riêng ngay dưới ý lệnh GV
 * và truyền nguyên vẹn ngữ cảnh ý lệnh GV phía trên (`precedingTeacher`) cho bộ vẽ hình ảnh.
 */
export const alignContent = (
    teacherText: string,
    studentText: string,
    initialPrecedingTeacher: string = ''
) => {
    const rawTLines = cleanPrefix(teacherText || '')
        .replace(/(\[Gợi ý hình ảnh:|Gợi ý hình ảnh:|\(Gợi ý hình ảnh:|\[Hình ảnh minh họa:|Hình ảnh minh họa:)/gi, '\n$1')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const rawSLines = cleanPrefix(studentText || '')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const tGroups: Array<{ text: string; images: string[]; contextHistory: string }> = [];
    const leadingImages: string[] = [];
    const recentTeacherLines: string[] = initialPrecedingTeacher.trim()
        ? [initialPrecedingTeacher.trim()]
        : [];

    for (const line of rawTLines) {
        if (isImageHintLine(line)) {
            const cleanHint = line.replace(/^[-–\*\s]+/, '').trim();
            if (tGroups.length > 0) {
                tGroups[tGroups.length - 1].images.push(cleanHint);
            } else {
                leadingImages.push(cleanHint);
            }
        } else {
            recentTeacherLines.push(line);
            const contextWindow = recentTeacherLines.slice(-2).join('\n');
            tGroups.push({ text: line, images: [], contextHistory: contextWindow });
        }
    }

    const alignedRows: Array<{ teacher: string; student: string; precedingTeacher?: string }> = [];

    for (const imgLine of leadingImages) {
        alignedRows.push({
            teacher: imgLine,
            student: '',
            precedingTeacher: recentTeacherLines.slice(-2).join('\n')
        });
    }

    const maxLen = Math.max(tGroups.length, rawSLines.length);
    for (let i = 0; i < maxLen; i++) {
        const tItem = tGroups[i];
        let sLine = rawSLines[i] || '';
        let tLine = tItem ? tItem.text : '';

        // Đồng bộ hóa định dạng dòng tích hợp giữa cột GV và cột HS trên cùng một hàng
        if (tLine && isActivityIntegrationLine(tLine) && sLine && !isActivityIntegrationLine(sLine)) {
            const matchedPrefix = extractIntegrationPrefixFromObjectives([tLine]);
            sLine = formatActivityIntegrationLine(sLine, matchedPrefix);
        } else if (sLine && isActivityIntegrationLine(sLine) && tLine && !isActivityIntegrationLine(tLine) && tGroups.length === rawSLines.length) {
            const matchedPrefix = extractIntegrationPrefixFromObjectives([sLine]);
            tLine = formatActivityIntegrationLine(tLine, matchedPrefix);
        }

        if (tItem || sLine) {
            alignedRows.push({
                teacher: tLine,
                student: sLine,
                precedingTeacher: tItem ? tItem.contextHistory : ''
            });
        }
        if (tItem && tItem.images.length > 0) {
            for (const imgLine of tItem.images) {
                alignedRows.push({
                    teacher: imgLine,
                    student: '',
                    precedingTeacher: tItem.contextHistory || tItem.text
                });
            }
        }
    }

    return alignedRows;
};

export const normalizeIntegrationDomainLabel = (rawDomain: string): string => {
    const clean = (rawDomain || '')
        .replace(/^[-–\*\s\[]+|[\]\s:–\-]+$/g, '')
        .replace(/^tích\s*hợp\s*/i, '')
        .trim();
    const lower = clean.toLowerCase();

    if (
        !clean ||
        lower.includes('gdkncds') ||
        lower.includes('kncds') ||
        lower.includes('công dân số')
    ) {
        return 'giáo dục kĩ năng công dân số';
    }
    if (lower === 'nls' || lower.includes('năng lực số')) {
        return 'năng lực số';
    }
    if (lower === 'ai' || lower.includes('trí tuệ nhân tạo') || lower.includes('năng lực ai')) {
        return 'trí tuệ nhân tạo (AI)';
    }
    if (lower === 'kns' || lower.includes('kỹ năng sống') || lower.includes('kĩ năng sống')) {
        return 'kĩ năng sống';
    }
    return clean;
};

export const extractIntegrationPrefixFromObjectives = (
    objectives?: string[] | null,
    integrationNotes?: string
): string => {
    const combinedSources = [
        ...(Array.isArray(objectives) ? objectives : []),
        integrationNotes || ''
    ].join('\n');

    const lines = combinedSources.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        const match = line.match(/tích\s*hợp\s+([^:\-\–\]]+)[:\-\–\]]/i);
        if (match && match[1]) {
            const domain = normalizeIntegrationDomainLabel(match[1]);
            return `Tích hợp ${domain}`;
        }
        if (/gdkncds|kncds|công\s*dân\s*số/i.test(line)) {
            return 'Tích hợp giáo dục kĩ năng công dân số';
        }
        if (/\bnls\b|năng\s*lực\s*số/i.test(line)) {
            return 'Tích hợp năng lực số';
        }
        if (/\bai\b|trí\s*tuệ\s*nhân\s*tạo/i.test(line)) {
            return 'Tích hợp trí tuệ nhân tạo (AI)';
        }
    }

    return 'Tích hợp giáo dục kĩ năng công dân số';
};

export const isActivityIntegrationLine = (line: string): boolean => {
    const trimmed = (line || '').trim();
    return /^[-–\*\s]*(\[?\s*Tích\s*hợp\b)/i.test(trimmed);
};

export const formatActivityIntegrationLine = (
    rawLine: string,
    defaultPrefix: string = 'Tích hợp giáo dục kĩ năng công dân số'
): string => {
    let text = (rawLine || '').replace(/\*\*/g, '').trim();
    text = text.replace(/^[-–\*\s]+/, '').trim();

    let domainPrefix = defaultPrefix || 'Tích hợp giáo dục kĩ năng công dân số';
    let contentPart = text;

    // Trường hợp 1: [Tích hợp ...]: Nội dung  hoặc  [Tích hợp]: Nội dung
    const bracketMatch = text.match(/^\[?\s*Tích\s*hợp([^\]:]*)\]?\s*[:\-–]\s*(.*)$/i);
    if (bracketMatch) {
        const rawDomain = (bracketMatch[1] || '').trim();
        contentPart = (bracketMatch[2] || '').trim();
        if (rawDomain) {
            domainPrefix = `Tích hợp ${normalizeIntegrationDomainLabel(rawDomain)}`;
        }
    } else {
        // Trường hợp 2: Tích hợp giáo dục kĩ năng công dân số: Nội dung
        const plainMatch = text.match(/^Tích\s*hợp\s*[:\-–]?\s*(.*)$/i);
        if (plainMatch) {
            contentPart = (plainMatch[1] || '').trim();
        }
    }

    contentPart = contentPart
        .replace(/^[-–\*\s]+/, '')
        .replace(/^(Giáo\s*viên|GV|Học\s*sinh|HS)\s*[:\-\–]?\s*/i, '')
        .trim();

    if (contentPart.length > 0) {
        contentPart = contentPart.charAt(0).toUpperCase() + contentPart.slice(1);
    }

    if (!domainPrefix.toLowerCase().startsWith('tích hợp')) {
        domainPrefix = `Tích hợp ${domainPrefix}`;
    }

    return `- ${domainPrefix}: ${contentPart}`;
};

export interface FormattedObjective {
    text: string;
    isIntegration: boolean;
}

export const formatObjectives = (objectives: string[] | undefined | null): FormattedObjective[] => {
    if (!Array.isArray(objectives)) return [];

    const standardResult: FormattedObjective[] = [];
    const integrationResult: FormattedObjective[] = [];

    const processLine = (rawLine: string) => {
        let line = (rawLine || '')
            .replace(/\*\*/g, '')
            .replace(/<\/?i>/gi, '')
            .replace(/<\/?em>/gi, '')
            .replace(/<\/?b>/gi, '')
            .trim();

        if (!line) return;

        // Chỉ nhận diện là dòng tích hợp khi thực sự bắt đầu bằng từ khóa Tích hợp / nhãn viết tắt miền tích hợp có dấu ':' hoặc '-'
        // (Tuyệt đối không biến yêu cầu cần đạt thường của bài học có chứa chữ 'AI' hay 'năng lực số' thành dòng tích hợp)
        const isIntegration =
            /^[-–\*\s1-9\.\)]*(\[?\s*tích\s*hợp\b|(gdkncds|kncds|kỹ\s*năng\s*công\s*dân\s*số|kĩ\s*năng\s*công\s*dân\s*số|giáo\s*dục\s*k[ỹĩ]\s*năng\s*công\s*dân\s*số|kns|k[ỹĩ]\s*năng\s*sống|nls|năng\s*lực\s*số|trí\s*tuệ\s*nhân\s*tạo|năng\s*lực\s*ai|ai|stem|gdqpan|bvmt|atgt|qcn|quyền\s*con\s*người|th\s*bài\s*\d+)\s*(\([^)]*\))?\s*[:\-\–])/i.test(
                line
            ) ||
            /\btích\s*hợp\s+(giáo\s*dục|môn|năng\s*lực|k[ỹĩ]\s*năng|trí\s*tuệ|quyền|bảo\s*vệ|an\s*toàn|stem|liên\s*môn)/i.test(
                line
            );

        if (isIntegration) {
            let text = line.replace(/^[1-9]\s*[\.\:\)\-–]\s*/, '');
            text = text.replace(/^[-–\*\s]+/, '').trim();

            if (/^(gdkncds|kncds|kỹ\s*năng\s*công\s*dân\s*số|kĩ\s*năng\s*công\s*dân\s*số|giáo\s*dục\s*k[ỹĩ]\s*năng\s*công\s*dân\s*số)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i.test(text)) {
                text = text.replace(/^(gdkncds|kncds|kỹ\s*năng\s*công\s*dân\s*số|kĩ\s*năng\s*công\s*dân\s*số|giáo\s*dục\s*k[ỹĩ]\s*năng\s*công\s*dân\s*số)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i, '');
                text = `- Tích hợp giáo dục kĩ năng công dân số: ${text.trim()}`;
            } else if (/^\[?\s*tích\s*hợp\s+([^\]:]+)\]?\s*[:\-\–]\s*(.*)$/i.test(text)) {
                const match = text.match(/^\[?\s*tích\s*hợp\s+([^\]:]+)\]?\s*[:\-\–]\s*(.*)$/i);
                if (match) {
                    const domain = normalizeIntegrationDomainLabel(match[1].trim());
                    const content = match[2].trim();
                    text = `- Tích hợp ${domain}: ${content}`;
                } else {
                    text = `- Tích hợp giáo dục kĩ năng công dân số: ${text}`;
                }
            } else {
                text = text.replace(/^\[?\s*tích\s*hợp\s*\]?\s*[:\-\–\.]?\s*/i, '').trim();
                if (/^(gdkncds|kncds|kỹ\s*năng\s*công\s*dân\s*số|kĩ\s*năng\s*công\s*dân\s*số)\s*[:\-\–\.]?\s*/i.test(text)) {
                    text = text.replace(/^(gdkncds|kncds|kỹ\s*năng\s*công\s*dân\s*số|kĩ\s*năng\s*công\s*dân\s*số)\s*[:\-\–\.]?\s*/i, '').trim();
                    text = `- Tích hợp giáo dục kĩ năng công dân số: ${text}`;
                } else if (/^(kns|kỹ\s*năng\s*sống|kĩ\s*năng\s*sống)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i.test(text)) {
                    text = text.replace(/^(kns|kỹ\s*năng\s*sống|kĩ\s*năng\s*sống)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i, '');
                    text = `- Tích hợp kĩ năng sống: ${text.trim()}`;
                } else if (/^(ai|trí\s*tuệ\s*nhân\s*tạo|năng\s*lực\s*ai)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i.test(text)) {
                    text = text.replace(/^(ai|trí\s*tuệ\s*nhân\s*tạo|năng\s*lực\s*ai)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i, '');
                    text = `- Tích hợp trí tuệ nhân tạo (AI): ${text.trim()}`;
                } else if (/^(năng\s*lực\s*số|nls)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i.test(text)) {
                    text = text.replace(/^(năng\s*lực\s*số|nls)(\s*\([^)]*\))?\s*[:\-\–\.]\s*/i, '');
                    text = `- Tích hợp năng lực số: ${text.trim()}`;
                } else if (integrationResult.length > 0) {
                    integrationResult[integrationResult.length - 1].text = `${integrationResult[integrationResult.length - 1].text.replace(/[\.\s]+$/, '')}; ${text}`;
                    return;
                } else {
                    text = `- Tích hợp giáo dục kĩ năng công dân số: ${text.trim()}`;
                }
            }

            integrationResult.push({
                text,
                isIntegration: true
            });
        } else {
            let text = line.replace(/^[1-9]\s*[\.\:\)\-–]\s*/, '');
            text = text.replace(/^[-–\*\s]+/, '').trim();

            text = text.replace(/^(về\s+)?(kiến\s*thức(\s*,\s*kỹ\s*năng|\s+và\s+kỹ\s*năng)?|kỹ\s*năng|năng\s*lực(\s+chung|\s+đặc\s+thù)?|phẩm\s*chất(\s+chủ\s+yếu)?)\s*[:\-\–\.]\s*/i, '');
            text = text.replace(/^[:\-\–\*\s]+/, '').trim();

            if (text) {
                const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
                standardResult.push({
                    text: `- ${capitalized}`,
                    isIntegration: false
                });
            }
        }
    };

    objectives.forEach(item => {
        if (!item) return;
        const lines = item.split(/\r?\n/);
        lines.forEach(l => {
            const trimmed = l.trim();
            if (trimmed) {
                processLine(trimmed);
            }
        });
    });

    // BẮT BUỘC: Các yêu cầu cần đạt của bài học nằm ở phía trên, nội dung tích hợp luôn nằm ở cuối cùng
    return [...standardResult, ...integrationResult];
};

export const formatGradeHeader = (val?: string) => {
    const v = (val || '').trim();
    if (!v) return 'LỚP 5';
    const upper = v.toUpperCase();
    if (upper.startsWith('LỚP')) return upper;
    return `LỚP ${upper}`;
};

export const formatSubjectHeader = (val?: string) => {
    const v = (val || '').trim();
    if (!v) return 'MÔN HỌC';
    const upper = v.toUpperCase();
    if (upper.startsWith('MÔN HỌC:')) return upper;
    if (upper.startsWith('MÔN HỌC')) return `MÔN HỌC: ${upper.replace(/^MÔN HỌC\s*/, '')}`;
    if (upper.startsWith('MÔN:')) return `MÔN HỌC: ${upper.replace(/^MÔN:\s*/, '')}`;
    if (upper.startsWith('MÔN')) return `MÔN HỌC: ${upper.replace(/^MÔN\s*/, '')}`;
    return `MÔN HỌC: ${upper}`;
};

export interface PaginatedActivitySubRow {
    key?: string;
    timeText: string;
    isFirstRowOfActivity: boolean;
    isLastRowOfActivity: boolean;
    formattedActName: string;
    formattedTopic: string;
    teacherRaw: string;
    studentRaw: string;
    teacherFormatted: string;
    studentFormatted: string;
}

export const paginateActivityRowsForWordPages = <T extends {
    isFirstRowOfActivity: boolean;
    formattedActName?: string;
    formattedTopic?: string;
    topic?: string;
    teacherRaw?: string;
    studentRaw?: string;
    teacher?: string;
    student?: string;
}>(
    flatRows: T[],
    objectivesCount: number = 4,
    teacherMatLen: number = 60,
    studentMatLen: number = 60
): T[][] => {
    if (!flatRows || flatRows.length === 0) return [];

    const countWrappedLines = (text: string, charsPerLine: number): number => {
        if (!text) return 0;
        const paragraphs = text.split('\n').map(l => l.trim()).filter(Boolean);
        if (paragraphs.length === 0) return 0;
        return paragraphs.reduce((acc, p) => {
            if (isImageHintLine(p)) {
                return acc + 5.5;
            }
            return acc + Math.max(1, Math.ceil(p.length / charsPerLine));
        }, 0);
    };

    const estimateRowHeightPt = (row: T): number => {
        const tText = row.teacherRaw ?? row.teacher ?? '';
        const sText = row.studentRaw ?? row.student ?? '';
        const hasTopic = !!(row.formattedTopic || row.topic);

        let gvLines = countWrappedLines(tText, 44);
        let hsLines = countWrappedLines(sText, 32);

        if (row.isFirstRowOfActivity) {
            gvLines += 1.1;
            hsLines += 1.0;
            if (hasTopic) {
                gvLines += Math.max(1.1, Math.ceil(String(row.formattedTopic || row.topic || '').length / 42));
                hsLines += 1.0;
            }
        }

        const maxLines = Math.max(1, gvLines, hsLines);
        return maxLines * 17 + 8;
    };

    const objHeightPt = Math.max(3, objectivesCount) * 20 + 24;
    const matHeightPt = (Math.ceil(teacherMatLen / 70) + Math.ceil(studentMatLen / 70)) * 18 + 28;
    const titleAndSectionHeadersPt = 92 + 24 + 30;
    const introHeightOnPage1Pt = titleAndSectionHeadersPt + objHeightPt + matHeightPt;

    const SAFE_PAGE_TOTAL_PT = 675;
    const page1MaxTableBodyPt = Math.max(240, SAFE_PAGE_TOTAL_PT - introHeightOnPage1Pt);
    const subsequentPageMaxTableBodyPt = SAFE_PAGE_TOTAL_PT - 32;

    const pages: T[][] = [];
    let currentPageRows: T[] = [];
    let currentHeightPt = 0;
    let isFirstPage = true;

    for (let i = 0; i < flatRows.length; i++) {
        const row = flatRows[i];
        const rowH = estimateRowHeightPt(row);
        const maxAllowedPt = isFirstPage ? page1MaxTableBodyPt : subsequentPageMaxTableBodyPt;

        if (currentPageRows.length > 0 && (currentHeightPt + rowH > maxAllowedPt)) {
            pages.push(currentPageRows);
            currentPageRows = [row];
            currentHeightPt = rowH;
            isFirstPage = false;
        } else {
            currentPageRows.push(row);
            currentHeightPt += rowH;
        }
    }

    if (currentPageRows.length > 0) {
        pages.push(currentPageRows);
    }

    return pages;
};

/**
 * Chuyển đổi văn bản trong ô Hoạt động của GV / HS thành danh sách Paragraph chuẩn OpenXML (.docx)
 * - Thay thế hoàn toàn [Gợi ý hình ảnh: ...] bằng hình ảnh thực tế (ImageRun) khớp 100% với nội dung GV ở trên (`precedingContext`).
 * - Chuẩn hóa dòng tích hợp theo đúng tên miền trên Yêu cầu cần đạt (VD: "- Tích hợp giáo dục kĩ năng công dân số: ...")
 *   và định dạng in nghiêng (italics: true), tuyệt đối không in đậm (bold: false).
 */
const buildCellParagraphsFromText = (
    rawText: string,
    extraHeaderLines: string[] = [],
    blankSpacerCount: number = 0,
    lessonTitle: string = '',
    precedingContext: string = '',
    integrationPrefix: string = 'Tích hợp giáo dục kĩ năng công dân số'
): Paragraph[] => {
    const paragraphs: Paragraph[] = [];

    for (const headerLine of extraHeaderLines) {
        if (!headerLine) continue;
        paragraphs.push(
            new Paragraph({
                alignment: AlignmentType.JUSTIFIED,
                widowControl: false,
                spacing: { before: 10, after: 15, line: 260 },
                children: [
                    new TextRun({
                        text: headerLine,
                        font: "Times New Roman",
                        size: 26, // 13pt
                        bold: true,
                        color: "000000"
                    })
                ]
            })
        );
    }

    for (let i = 0; i < blankSpacerCount; i++) {
        paragraphs.push(
            new Paragraph({
                alignment: AlignmentType.JUSTIFIED,
                widowControl: false,
                spacing: { before: 10, after: 15, line: 260 },
                children: [
                    new TextRun({
                        text: "",
                        font: "Times New Roman",
                        size: 26
                    })
                ]
            })
        );
    }

    const lines = (rawText || '')
        .split('\n')
        .map(l => l.replace(/\*\*/g, '').trim())
        .filter(Boolean);

    if (lines.length === 0 && paragraphs.length === 0) {
        paragraphs.push(
            new Paragraph({
                widowControl: false,
                spacing: { before: 8, after: 12, line: 260 },
                children: [new TextRun({ text: "", font: "Times New Roman", size: 26 })]
            })
        );
        return paragraphs;
    }

    let runningContext = precedingContext || '';

    for (const line of lines) {
        if (isImageHintLine(line)) {
            const dataUrl = renderPedagogicalIllustrationDataUrl(line, lessonTitle, runningContext);
            if (dataUrl) {
                const imgBytes = dataUrlToUint8Array(dataUrl);
                paragraphs.push(
                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        widowControl: false,
                        spacing: { before: 25, after: 25 },
                        children: [
                            new ImageRun({
                                data: imgBytes,
                                transformation: {
                                    width: 256,
                                    height: 144
                                },
                                type: "png"
                            })
                        ]
                    })
                );
            }
        } else if (isActivityIntegrationLine(line)) {
            const formattedIntegration = formatActivityIntegrationLine(line, integrationPrefix);
            paragraphs.push(
                new Paragraph({
                    alignment: AlignmentType.JUSTIFIED,
                    widowControl: false,
                    spacing: { before: 10, after: 15, line: 260 },
                    children: [
                        new TextRun({
                            text: formattedIntegration,
                            font: "Times New Roman",
                            size: 26,
                            bold: false,
                            italics: true,
                            color: "C00000"
                        })
                    ]
                })
            );
        } else {
            runningContext = `${runningContext}\n${line}`.trim();
            paragraphs.push(
                new Paragraph({
                    alignment: AlignmentType.JUSTIFIED,
                    widowControl: false,
                    spacing: { before: 10, after: 15, line: 260 },
                    children: [
                        new TextRun({
                            text: line,
                            font: "Times New Roman",
                            size: 26,
                            color: "000000"
                        })
                    ]
                })
            );
        }
    }

    return paragraphs;
};

/**
 * Tạo file Word chuẩn OpenXML (.docx) cho Kế hoạch bài dạy (KHBD)
 * - Mở trực tiếp ở chế độ Print Layout trong Microsoft Word.
 * - Đóng khung đường kẻ ngang ở CUỐI MỖI TRANG WORD trong bảng "III. CÁC HOẠT ĐỘNG DẠY HỌC"
 *   với khoảng cách sát mép dưới trang giấy đúng chuẩn 0.5cm (5mm).
 * - Thay thế toàn bộ gợi ý hình ảnh bằng hình ảnh minh họa thực tế nhúng trong bảng.
 * - Hiển thị chính xác tuyệt đối số thứ tự tiết học sau tên bài dạy (VD: (TIẾT 2) đối với Tiết 2/2).
 */
export const generateLessonPlanDocxBlob = async (
    rawResult: LessonPlanResponse,
    inputData: any,
    skipAiPregen: boolean = false
): Promise<Blob> => {
    const result = ensureFourActivitiesInAllPeriods(rawResult, inputData);
    if (!skipAiPregen) {
        await pregenerateLessonImagesWithAI(
            result,
            inputData?.apiKey || '',
            result.lesson_full_title
        ).catch(() => {});
    }

    const displayGrade = inputData?.grade || result.grade_class || '5';
    const displaySubject = inputData?.subject || result.subject || 'TIN HỌC';
    const displaySchool = inputData?.schoolName || 'Trường Tiểu học Mỹ An';
    const displayTeacher = inputData?.teacherName || 'GV: Lê Văn Phi';

    const children: Array<Paragraph | Table> = [];
    const periods = result.periods || [];

    periods.forEach((period, periodIdx) => {
        const periodNum =
            Number(inputData?.periodIndexInLesson) ||
            Number(period.period_number) ||
            extractExplicitPeriodNumber(inputData?.lessonName || '') ||
            extractExplicitPeriodNumber(result.lesson_full_title || '') ||
            (periodIdx + 1);

        const rawTitleSource =
            inputData?.baseLessonName ||
            inputData?.lessonName ||
            result.lesson_full_title ||
            "KẾ HOẠCH BÀI DẠY";

        const lessonTitle = formatLessonTitleWithPeriod(rawTitleSource, periodNum);

        if (periodIdx > 0) {
            children.push(
                new Paragraph({
                    children: [new PageBreak()]
                })
            );
        }

        // 1. TIÊU ĐỀ 4 DÒNG VIẾT HOA CĂN GIỮA CHUẨN XÁC
        children.push(
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 60, line: 276 },
                children: [
                    new TextRun({
                        text: "KẾ HOẠCH BÀI DẠY",
                        font: "Times New Roman",
                        size: 28, // 14pt
                        bold: true
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 60, line: 276 },
                children: [
                    new TextRun({
                        text: formatGradeHeader(displayGrade),
                        font: "Times New Roman",
                        size: 26, // 13pt
                        bold: true
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 80, line: 276 },
                children: [
                    new TextRun({
                        text: formatSubjectHeader(displaySubject),
                        font: "Times New Roman",
                        size: 26, // 13pt
                        bold: true
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 40, after: 180, line: 276 },
                children: [
                    new TextRun({
                        text: "tên bài dạy: ",
                        font: "Times New Roman",
                        size: 26,
                        italics: true,
                        bold: false
                    }),
                    new TextRun({
                        text: lessonTitle.toUpperCase(),
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    })
                ]
            })
        );

        // 2. MỤC I. YÊU CẦU CẦN ĐẠT:
        children.push(
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 100, after: 50, line: 276 },
                children: [
                    new TextRun({
                        text: "I. YÊU CẦU CẦN ĐẠT:",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    })
                ]
            })
        );

        const formattedObjs = formatObjectives(period.objectives);
        const integrationPrefix = extractIntegrationPrefixFromObjectives(
            period.objectives,
            inputData?.integrationNotes
        );
        formattedObjs.forEach(obj => {
            children.push(
                new Paragraph({
                    alignment: AlignmentType.JUSTIFIED,
                    spacing: { before: 20, after: 40, line: 276 },
                    children: [
                        new TextRun({
                            text: obj.text,
                            font: "Times New Roman",
                            size: 26,
                            bold: false,
                            italics: obj.isIntegration
                        })
                    ]
                })
            );
        });

        // 3. MỤC II. ĐỒ DÙNG DẠY HỌC:
        const teacherMat = (period.materials?.teacher || '').replace(/\*\*/g, '').replace(/^[-–\*\s]+/, '').trim();
        const studentMat = (period.materials?.student || '').replace(/\*\*/g, '').replace(/^[-–\*\s]+/, '').trim();

        children.push(
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 120, after: 50, line: 276 },
                children: [
                    new TextRun({
                        text: "II. ĐỒ DÙNG DẠY HỌC:",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.JUSTIFIED,
                spacing: { before: 20, after: 40, line: 276 },
                children: [
                    new TextRun({
                        text: "1. GV: ",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    }),
                    new TextRun({
                        text: teacherMat,
                        font: "Times New Roman",
                        size: 26
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.JUSTIFIED,
                spacing: { before: 20, after: 100, line: 276 },
                children: [
                    new TextRun({
                        text: "2. HS: ",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    }),
                    new TextRun({
                        text: studentMat,
                        font: "Times New Roman",
                        size: 26
                    })
                ]
            })
        );

        // 4. MỤC III. CÁC HOẠT ĐỘNG DẠY HỌC:
        children.push(
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 120, after: 60, line: 276 },
                children: [
                    new TextRun({
                        text: "III. CÁC HOẠT ĐỘNG DẠY HỌC:",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    })
                ]
            })
        );

        const headerRow = new TableRow({
            tableHeader: true,
            cantSplit: true,
            children: [
                new TableCell({
                    width: { size: 10, type: WidthType.PERCENTAGE },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 60, bottom: 60, left: 80, right: 80 },
                    borders: {
                        top: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                        bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                        left: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                        right: { style: BorderStyle.SINGLE, size: 8, color: "000000" }
                    },
                    children: [
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { before: 20, after: 20, line: 264 },
                            children: [
                                new TextRun({
                                    text: "TG",
                                    font: "Times New Roman",
                                    size: 26,
                                    bold: true
                                })
                            ]
                        })
                    ]
                }),
                new TableCell({
                    width: { size: 52, type: WidthType.PERCENTAGE },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    borders: {
                        top: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                        bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                        left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                        right: { style: BorderStyle.SINGLE, size: 8, color: "000000" }
                    },
                    children: [
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { before: 20, after: 20, line: 264 },
                            children: [
                                new TextRun({
                                    text: "HOẠT ĐỘNG CỦA GIÁO VIÊN",
                                    font: "Times New Roman",
                                    size: 26,
                                    bold: true
                                })
                            ]
                        })
                    ]
                }),
                new TableCell({
                    width: { size: 38, type: WidthType.PERCENTAGE },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    borders: {
                        top: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                        bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                        left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                        right: { style: BorderStyle.SINGLE, size: 12, color: "000000" }
                    },
                    children: [
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { before: 20, after: 20, line: 264 },
                            children: [
                                new TextRun({
                                    text: "HOẠT ĐỘNG CỦA HỌC SINH",
                                    font: "Times New Roman",
                                    size: 26,
                                    bold: true
                                })
                            ]
                        })
                    ]
                })
            ]
        });

        // Các dòng nội dung của 4 hoạt động dạy học:
        // Không gắn thuộc tính cantSplit vào TableRow và bật widowControl: false để Word tự động ngắt từng dòng sát xuống mốc 0.5cm (5mm) từ mép dưới trang giấy.
        const bodyRows: TableRow[] = [];
        const activities = period.activities || [];

        activities.forEach(act => {
            const formattedActName = formatActivityName(act.name);
            const formattedTopic = act.topic ? formatTopicName(act.topic) : '';
            const actRows = act.rows || [];
            const timeText = (act.time || '').replace(/phút/gi, "'").replace(/\s+/g, '');

            const gvHeaders: string[] = [formattedActName];
            if (formattedTopic) {
                gvHeaders.push(formattedTopic);
            }

            bodyRows.push(
                new TableRow({
                    children: [
                        new TableCell({
                            width: { size: 10, type: WidthType.PERCENTAGE },
                            verticalAlign: VerticalAlign.TOP,
                            margins: { top: 20, bottom: 15, left: 60, right: 60 },
                            children: [
                                new Paragraph({
                                    alignment: AlignmentType.CENTER,
                                    widowControl: false,
                                    spacing: { before: 10, after: 15, line: 260 },
                                    children: [
                                        new TextRun({
                                            text: timeText,
                                            font: "Times New Roman",
                                            size: 26,
                                            bold: true
                                        })
                                    ]
                                })
                            ]
                        }),
                        new TableCell({
                            width: { size: 52, type: WidthType.PERCENTAGE },
                            verticalAlign: VerticalAlign.TOP,
                            margins: { top: 20, bottom: 15, left: 100, right: 100 },
                            children: buildCellParagraphsFromText('', gvHeaders, 0, lessonTitle, '', integrationPrefix)
                        }),
                        new TableCell({
                            width: { size: 38, type: WidthType.PERCENTAGE },
                            verticalAlign: VerticalAlign.TOP,
                            margins: { top: 20, bottom: 15, left: 100, right: 100 },
                            children: [
                                new Paragraph({
                                    widowControl: false,
                                    spacing: { before: 10, after: 15, line: 260 },
                                    children: [new TextRun({ text: "", font: "Times New Roman", size: 26 })]
                                })
                            ]
                        })
                    ]
                })
            );

            let lastTeacherLineInAct = '';
            actRows.forEach(row => {
                const alignedSubRows = alignContent(row.teacher, row.student, lastTeacherLineInAct);
                alignedSubRows.forEach(sr => {
                    if (sr.teacher && !isImageHintLine(sr.teacher) && !isActivityIntegrationLine(sr.teacher)) {
                        lastTeacherLineInAct = sr.teacher;
                    }
                });

                alignedSubRows.forEach(subRow => {
                    bodyRows.push(
                        new TableRow({
                            children: [
                                new TableCell({
                                    width: { size: 10, type: WidthType.PERCENTAGE },
                                    verticalAlign: VerticalAlign.TOP,
                                    margins: { top: 15, bottom: 15, left: 60, right: 60 },
                                    children: [
                                        new Paragraph({
                                            alignment: AlignmentType.CENTER,
                                            widowControl: false,
                                            spacing: { before: 8, after: 12, line: 260 },
                                            children: [
                                                new TextRun({
                                                    text: "",
                                                    font: "Times New Roman",
                                                    size: 26
                                                })
                                            ]
                                        })
                                    ]
                                }),
                                new TableCell({
                                    width: { size: 52, type: WidthType.PERCENTAGE },
                                    verticalAlign: VerticalAlign.TOP,
                                    margins: { top: 15, bottom: 15, left: 100, right: 100 },
                                    children: buildCellParagraphsFromText(
                                        subRow.teacher,
                                        [],
                                        0,
                                        lessonTitle,
                                        subRow.precedingTeacher || '',
                                        integrationPrefix
                                    )
                                }),
                                new TableCell({
                                    width: { size: 38, type: WidthType.PERCENTAGE },
                                    verticalAlign: VerticalAlign.TOP,
                                    margins: { top: 15, bottom: 15, left: 100, right: 100 },
                                    children: buildCellParagraphsFromText(
                                        subRow.student,
                                        [],
                                        0,
                                        lessonTitle,
                                        '',
                                        integrationPrefix
                                    )
                                })
                            ]
                        })
                    );
                });
            });
        });

        const activitiesTable = new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            layout: TableLayoutType.FIXED,
            columnWidths: [935, 4865, 3555],
            borders: {
                top: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                bottom: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                left: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                right: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                insideVertical: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" }
            },
            rows: [headerRow, ...bodyRows]
        });

        children.push(activitiesTable);

        // 5. ĐIỀU CHỈNH SAU BÀI DẠY:
        children.push(
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 140, after: 50, line: 276 },
                children: [
                    new TextRun({
                        text: "Điều chỉnh sau bài dạy:",
                        font: "Times New Roman",
                        size: 26,
                        bold: true
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 20, after: 40, line: 276 },
                children: [
                    new TextRun({
                        text: "................................................................................................................................................................................................................................................",
                        font: "Times New Roman",
                        size: 26,
                        italics: true,
                        color: "555555"
                    })
                ]
            }),
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 20, after: 40, line: 276 },
                children: [
                    new TextRun({
                        text: "................................................................................................................................................................................................................................................",
                        font: "Times New Roman",
                        size: 26,
                        italics: true,
                        color: "555555"
                    })
                ]
            })
        );
    });

    // Dòng Footer 1 dòng duy nhất ở sát mép dưới (không dùng Table trong Footer để tránh Word tự chèn thêm đoạn trống bên dưới làm đẩy khung bảng lên cao)
    const createFooterParagraph = () =>
        new Paragraph({
            alignment: AlignmentType.LEFT,
            spacing: { before: 0, after: 0, line: 200 },
            tabStops: [
                {
                    type: TabStopType.RIGHT,
                    position: convertMillimetersToTwip(165)
                }
            ],
            children: [
                new TextRun({
                    text: displaySchool,
                    font: "Times New Roman",
                    size: 20, // 10pt gọn gàng
                    italics: true,
                    color: "E11D48"
                }),
                new TextRun({
                    text: `\t${displayTeacher}`,
                    font: "Times New Roman",
                    size: 20, // 10pt gọn gàng
                    italics: true,
                    color: "E11D48"
                })
            ]
        });

    const doc = new Document({
        sections: [
            {
                properties: {
                    titlePage: true,
                    page: {
                        size: {
                            width: convertMillimetersToTwip(210),
                            height: convertMillimetersToTwip(297)
                        },
                        margin: {
                            top: convertMillimetersToTwip(20),
                            bottom: convertMillimetersToTwip(5), // Chính xác 0.5cm (5mm) từ mép dưới đến đường kẻ đóng khung cuối mỗi trang Word
                            left: convertMillimetersToTwip(30),
                            right: convertMillimetersToTwip(15),
                            header: convertMillimetersToTwip(10),
                            footer: convertMillimetersToTwip(1.5)
                        }
                    }
                },
                headers: {
                    first: new Header({
                        children: []
                    }),
                    default: new Header({
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                spacing: { before: 0, after: 0 },
                                children: [
                                    new TextRun({
                                        children: [PageNumber.CURRENT],
                                        font: "Times New Roman",
                                        size: 26 // 13pt
                                    })
                                ]
                            })
                        ]
                    })
                },
                footers: {
                    first: new Footer({
                        children: [createFooterParagraph()]
                    }),
                    default: new Footer({
                        children: [createFooterParagraph()]
                    })
                },
                children
            }
        ]
    });

    return await Packer.toBlob(doc);
};

export const generateLessonPlanDocHtml = (result: LessonPlanResponse, inputData: any): string => {
    return JSON.stringify({ result, inputData });
};

export const exportToWord = async (result: LessonPlanResponse, _elementId?: string, _hideTableBorders: boolean = true) => {
    await downloadSingleLessonWord(result, {});
};

export const downloadSingleLessonWord = async (
    result: LessonPlanResponse,
    inputData: any,
    customFileName?: string,
    _hideTableBorders: boolean = true
) => {
    try {
        const lessonTitle = customFileName || result.lesson_full_title || `KHBD_Tuan_${inputData?.week || result.week || '1'}`;
        const safeName = lessonTitle.replace(/[\/\\?%*:|"<>]/g, '-').replace(/\.docx?$/i, '').trim();
        const fileName = `${safeName}.docx`;

        const blob = await generateLessonPlanDocxBlob(result, inputData);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error: any) {
        console.warn('Error downloading single lesson word (.docx):', error);
    }
};

export const downloadPpctWordTemplate = async () => {
    try {
        const fileName = "Mau_Phan_Phoi_Chuong_Trinh.docx";

        const sampleData = [
            ["Tuần 1", "Bài 1: Phần cứng và phần mềm máy tính", "1", "(Không tích hợp)"],
            ["Tuần 2", "Bài 1: Phần cứng và phần mềm máy tính", "1", "Tích hợp môn Tiếng Việt: Luyện viết đoạn văn; Tích hợp AI tạo sản phẩm số"],
            ["Tuần 3", "Bài 2: Gõ bàn phím đúng cách", "1", "(Không tích hợp)"],
            ["Tuần 4", "Bài 2: Gõ bàn phím đúng cách", "1", "Tích hợp môn Khoa học: Tìm hiểu tự nhiên; Tích hợp Năng lực số tìm kiếm an toàn"],
            ["...", "(Thầy/Cô điền tiếp các bài học theo đúng phân phối chương trình của mình...)", "...", "(Điền nội dung & môn học tích hợp nếu có, để trống nếu không tích hợp)"]
        ];

        const headerRow = new TableRow({
            tableHeader: true,
            children: [
                { text: "TUẦN", width: 14 },
                { text: "TÊN BÀI", width: 44 },
                { text: "SỐ TIẾT", width: 14 },
                { text: "GHI CHÚ (Nội dung & Môn học tích hợp)", width: 28 }
            ].map(col =>
                new TableCell({
                    width: { size: col.width, type: WidthType.PERCENTAGE },
                    verticalAlign: VerticalAlign.CENTER,
                    margins: { top: 80, bottom: 80, left: 100, right: 100 },
                    children: [
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            children: [
                                new TextRun({
                                    text: col.text,
                                    font: "Times New Roman",
                                    size: 26,
                                    bold: true
                                })
                            ]
                        })
                    ]
                })
            )
        });

        const dataRows = sampleData.map(row =>
            new TableRow({
                children: [
                    new TableCell({
                        width: { size: 14, type: WidthType.PERCENTAGE },
                        verticalAlign: VerticalAlign.CENTER,
                        margins: { top: 60, bottom: 60, left: 80, right: 80 },
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text: row[0], font: "Times New Roman", size: 26, bold: true })]
                            })
                        ]
                    }),
                    new TableCell({
                        width: { size: 44, type: WidthType.PERCENTAGE },
                        verticalAlign: VerticalAlign.CENTER,
                        margins: { top: 60, bottom: 60, left: 100, right: 100 },
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.LEFT,
                                children: [new TextRun({ text: row[1], font: "Times New Roman", size: 26 })]
                            })
                        ]
                    }),
                    new TableCell({
                        width: { size: 14, type: WidthType.PERCENTAGE },
                        verticalAlign: VerticalAlign.CENTER,
                        margins: { top: 60, bottom: 60, left: 80, right: 80 },
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.CENTER,
                                children: [new TextRun({ text: row[2], font: "Times New Roman", size: 26 })]
                            })
                        ]
                    }),
                    new TableCell({
                        width: { size: 28, type: WidthType.PERCENTAGE },
                        verticalAlign: VerticalAlign.CENTER,
                        margins: { top: 60, bottom: 60, left: 100, right: 100 },
                        children: [
                            new Paragraph({
                                alignment: AlignmentType.LEFT,
                                children: [
                                    new TextRun({
                                        text: row[3],
                                        font: "Times New Roman",
                                        size: 24,
                                        italics: row[3].startsWith('('),
                                        bold: !row[3].startsWith('('),
                                        color: row[3].startsWith('(') ? "64748B" : "0F766E"
                                    })
                                ]
                            })
                        ]
                    })
                ]
            })
        );

        const doc = new Document({
            sections: [
                {
                    properties: {
                        page: {
                            size: {
                                width: convertMillimetersToTwip(210),
                                height: convertMillimetersToTwip(297)
                            },
                            margin: {
                                top: convertMillimetersToTwip(20),
                                bottom: convertMillimetersToTwip(20),
                                left: convertMillimetersToTwip(30),
                                right: convertMillimetersToTwip(15)
                            }
                        }
                    },
                    children: [
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { after: 80 },
                            children: [
                                new TextRun({
                                    text: "BẢNG PHÂN PHỐI CHƯƠNG TRÌNH",
                                    font: "Times New Roman",
                                    size: 30,
                                    bold: true
                                })
                            ]
                        }),
                        new Paragraph({
                            alignment: AlignmentType.CENTER,
                            spacing: { after: 160 },
                            children: [
                                new TextRun({
                                    text: "(Mẫu 4 cột chuẩn: Cột 1 Tuần, Cột 2 Tên bài, Cột 3 Số tiết, Cột 4 Ghi chú tích hợp môn học & nội dung)",
                                    font: "Times New Roman",
                                    size: 24,
                                    italics: true
                                })
                            ]
                        }),
                        new Table({
                            width: { size: 100, type: WidthType.PERCENTAGE },
                            borders: {
                                top: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                                bottom: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                                left: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                                right: { style: BorderStyle.SINGLE, size: 12, color: "000000" },
                                insideHorizontal: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
                                insideVertical: { style: BorderStyle.SINGLE, size: 8, color: "000000" }
                            },
                            rows: [headerRow, ...dataRows]
                        })
                    ]
                }
            ]
        });

        const blob = await Packer.toBlob(doc);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    } catch (error: any) {
        console.warn('Error downloading PPCT Word template:', error);
    }
};

export const normalizeLessonKey = (rawName: string): string => {
    const base = extractBaseLessonName(rawName);
    return base
        .toLowerCase()
        .replace(/[\:\.\-–—,;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

/**
 * Chuẩn hóa danh sách tuần theo Phân phối chương trình:
 * - Mỗi tuần luôn có đúng 1 tiết học (periods = 1).
 * - Một bài học có thể kéo dài qua nhiều tuần (ví dụ: Tuần 1 Bài 1 -> Tiết 1/2; Tuần 2 Bài 1 -> Tiết 2/2).
 */
export const enrichWeekPlansWithPedagogy = (lessons: any[]): any[] => {
    if (!lessons || lessons.length === 0) return [];

    const enriched = lessons.map((item, idx) => {
        const rawName = item.lessonName || '';
        const baseName = extractBaseLessonName(rawName);
        const explicitPeriod = extractExplicitPeriodNumber(rawName);

        return {
            id: `week-${idx + 1}`,
            week: item.week || `Tuần ${idx + 1}`,
            lessonName: rawName,
            periods: 1, // Mỗi tuần cố định 1 tiết học theo đúng quy chuẩn PPCT
            notes: item.notes || '',
            baseLessonName: baseName,
            periodIndexInLesson: explicitPeriod || 1,
            totalPeriodsInLesson: 1,
            pedagogicalNote: '',
            status: 'idle' as const,
            result: undefined
        };
    });

    // Nhóm các tuần có cùng bài học (normalizeLessonKey) trong phạm vi liền kề hoặc gần nhau (<= 5 tuần)
    const visited = new Set<number>();

    for (let i = 0; i < enriched.length; i++) {
        if (visited.has(i)) continue;
        const currentKey = normalizeLessonKey(enriched[i].baseLessonName);
        const groupIndices: number[] = [i];
        visited.add(i);

        for (let j = i + 1; j < enriched.length; j++) {
            if (visited.has(j)) continue;
            const candidateKey = normalizeLessonKey(enriched[j].baseLessonName);
            const lastMatchedIdx = groupIndices[groupIndices.length - 1];
            if (candidateKey === currentKey && (j - lastMatchedIdx) <= 5) {
                groupIndices.push(j);
                visited.add(j);
            }
        }

        const spanCount = groupIndices.length;
        if (spanCount > 1) {
            groupIndices.forEach((weekIdx, idxInGroup) => {
                const explicitP = extractExplicitPeriodNumber(enriched[weekIdx].lessonName);
                const periodNum = explicitP || (idxInGroup + 1);
                const totalPeriodsAcrossWeeks = Math.max(spanCount, periodNum);

                enriched[weekIdx].periods = 1;
                enriched[weekIdx].periodIndexInLesson = periodNum;
                enriched[weekIdx].totalPeriodsInLesson = totalPeriodsAcrossWeeks;

                if (periodNum === 1) {
                    enriched[weekIdx].pedagogicalNote = `Tiết 1/${totalPeriodsAcrossWeeks}: Phần đầu bài học SGK (Khởi động chung, Khám phá nội dung 1, Luyện tập 1, Vận dụng)`;
                } else if (periodNum === totalPeriodsAcrossWeeks) {
                    enriched[weekIdx].pedagogicalNote = `Tiết ${periodNum}/${totalPeriodsAcrossWeeks}: Phần cuối bài học SGK (Khởi động kết nối tiết trước, Hoàn thiện nội dung/Trưng bày & Đánh giá sản phẩm, Luyện tập, Vận dụng toàn bài)`;
                } else {
                    enriched[weekIdx].pedagogicalNote = `Tiết ${periodNum}/${totalPeriodsAcrossWeeks}: Phần tiếp theo của SGK (Khởi động ôn lại tiết trước, Khám phá/Thực hành bước tiếp theo, Luyện tập, Vận dụng)`;
                }
            });
        } else {
            const explicitP = extractExplicitPeriodNumber(enriched[i].lessonName);
            enriched[i].periods = 1;
            if (explicitP && explicitP > 1) {
                enriched[i].periodIndexInLesson = explicitP;
                enriched[i].totalPeriodsInLesson = explicitP;
                enriched[i].pedagogicalNote = `Tiết ${explicitP}/${explicitP}: Phần tiếp theo của bài học trong SGK (Đầy đủ 4 hoạt động dạy học)`;
            } else {
                enriched[i].periodIndexInLesson = 1;
                enriched[i].totalPeriodsInLesson = 1;
                enriched[i].pedagogicalNote = `Bài trọn vẹn 1 tiết trong tuần (35 phút - Đầy đủ 4 hoạt động)`;
            }
        }
    }

    return enriched;
};

