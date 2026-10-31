import React, { useState, useRef, useEffect } from 'react';
import { 
    BookOpen, FileText, Download, Send, Settings, 
    CheckCircle, AlertTriangle, Plus, X, 
    Link2, FileUp, Image as ImageIcon, Paperclip, Key,
    Trash2, Eye, Play, Archive, Check, Sparkles, RefreshCw, 
    Square, Layers, Calendar
} from 'lucide-react';
import JSZip from 'jszip';
import { InputState, SourceType, ImageFile, LessonPlanResponse, PpctLesson, WeekPlanItem } from './types';
import { generateLessonPlan, extractLessonsFromPpct } from './services/geminiService';
import { downloadPpctWordTemplate, downloadSingleLessonWord, generateLessonPlanDocxBlob, enrichWeekPlansWithPedagogy } from './utils';
import { pregenerateLessonImagesWithAI } from './utils/lessonImageGenerator';
import LessonPreview from './components/LessonPreview';
import TeachingPlanTab from './components/TeachingPlanTab';

const getEnvGeminiKey = (): string => {
    const procKey =
        typeof process !== 'undefined' && process.env
            ? process.env.GEMINI_API_KEY || process.env.API_KEY || ''
            : '';
    const viteKey =
        typeof import.meta !== 'undefined' && (import.meta as any).env
            ? (import.meta as any).env.VITE_GEMINI_API_KEY || (import.meta as any).env.VITE_API_KEY || ''
            : '';
    return (procKey || viteKey || '').trim();
};

const App: React.FC = () => {
    // Top-Level Main Tab: 'khbd' (Kế hoạch bài dạy) | 'khdh' (Kế hoạch dạy học)
    const [mainFeatureTab, setMainFeatureTab] = useState<'khbd' | 'khdh'>('khbd');

    // API Key State
    const [userApiKey, setUserApiKey] = useState<string>(() => {
        if (typeof window !== 'undefined') {
            return localStorage.getItem('geminiApiKey') || getEnvGeminiKey() || '';
        }
        return getEnvGeminiKey();
    });

    const getEffectiveApiKey = (): string => {
        return (userApiKey.trim() || getEnvGeminiKey() || '').trim();
    };

    // Load API Key on mount
    useEffect(() => {
        const storedKey = localStorage.getItem('geminiApiKey');
        if (storedKey) {
            setUserApiKey(storedKey);
        } else {
            const envKey = getEnvGeminiKey();
            if (envKey) setUserApiKey(envKey);
        }
    }, []);

    // Active View Tab inside KHBD: 'list' (Danh sách các tuần tải về) | 'preview' (Xem chi tiết giáo án)
    const [activeTab, setActiveTab] = useState<'list' | 'preview'>('list');

    // UI & Generation State
    const [sourceType, setSourceType] = useState<SourceType>('image');
    const [loadingSingle, setLoadingSingle] = useState<boolean>(false);
    const [isBatchGenerating, setIsBatchGenerating] = useState<boolean>(false);
    const [batchCurrentIndex, setBatchCurrentIndex] = useState<number>(-1);
    const [isDownloadingZip, setIsDownloadingZip] = useState<boolean>(false);
    const [zipProgress, setZipProgress] = useState<string>('');
    const abortBatchRef = useRef<boolean>(false);
    const [error, setError] = useState<string>('');
    const rightPanelRef = useRef<HTMLDivElement | null>(null);

    // Hiển thị bảng KHBD: Mặc định ẩn đường viền (Chuẩn KHBD theo yêu cầu giáo viên)
    const [hideTableBorders, setHideTableBorders] = useState<boolean>(true);

    // File Inputs
    const [images, setImages] = useState<ImageFile[]>([]);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [pdfFiles, setPdfFiles] = useState<File[]>([]);
    const [referencePdfs, setReferencePdfs] = useState<File[]>([]);
    const [ppctPdfFile, setPpctPdfFile] = useState<File | null>(null);
    const [parsingPpct, setParsingPpct] = useState<boolean>(false);
    const [ppctError, setPpctError] = useState<string>('');

    // Shared upload cache across batch calls to avoid re-uploading large PDF files every week
    const uploadedFileCacheRef = useRef<Map<string, { uri: string; mimeType: string; name: string }>>(new Map());

    // PPCT Lessons & Week Plans
    const [ppctLessons, setPpctLessons] = useState<PpctLesson[]>([]);
    const [weekPlans, setWeekPlans] = useState<WeekPlanItem[]>([]);
    const weekPlansRef = useRef<WeekPlanItem[]>([]);
    const [selectedWeekIndex, setSelectedWeekIndex] = useState<number>(0);

    // Sync weekPlansRef with weekPlans state so async batch/single loops never read stale closures
    const updateWeekPlansState = (updater: WeekPlanItem[] | ((prev: WeekPlanItem[]) => WeekPlanItem[])) => {
        setWeekPlans(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            weekPlansRef.current = next;
            return next;
        });
    };

    // Form Data
    const [inputData, setInputData] = useState<InputState>({
        week: '1',
        subject: 'Tin học',        
        grade: '4',          
        periods: '1',       
        duration: '35',
        lessonName: '',     
        context: '',
        integrateDigitalSkills: false, 
        integrateAI: false,
        integrationNotes: '',
        additionalIntegrationNotes: '',
        schoolName: 'Trường Tiểu học Mỹ An',
        teacherName: 'GV: Lê Văn Phi'
    });

    // Populate weekPlans when PPCT file is parsed
    const updatePpctLessonsAndPlans = (lessons: PpctLesson[]) => {
        setPpctLessons(lessons);
        const enriched = enrichWeekPlansWithPedagogy(lessons);
        updateWeekPlansState(enriched);
        if (enriched.length > 0) {
            setSelectedWeekIndex(0);
            setInputData(prev => ({
                ...prev,
                week: enriched[0].week.replace(/Tuần\s*/gi, '').trim() || '1',
                lessonName: enriched[0].lessonName,
                periods: String(enriched[0].periods),
                integrationNotes: enriched[0].notes || '',
                periodIndexInLesson: enriched[0].periodIndexInLesson,
                totalPeriodsInLesson: enriched[0].totalPeriodsInLesson,
                baseLessonName: enriched[0].baseLessonName,
                pedagogicalNote: enriched[0].pedagogicalNote
            }));
        }
    };

    // --- Handlers ---
    const handlePpctFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            if (file.size > 100 * 1024 * 1024) {
                setError(`Cảnh báo: Tệp "${file.name}" quá lớn. Vui lòng tải lên tệp dưới 100MB.`);
                return;
            }
            setPpctPdfFile(file);
            setPpctError('');
            setError('');

            // Tự động nhận diện Môn học và Khối lớp từ tên tệp PPCT nếu có (VD: KHDH_Mon_Cong_Nghe_Lop_3.pdf)
            const normName = file.name
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/đ/g, 'd')
                .replace(/Đ/g, 'D')
                .toLowerCase();
            const gradeMatch = normName.match(/(?:lop|khoi)[\s_\-]*([1-5])/i);
            let detectedSubject = '';
            if (normName.includes('cong_nghe') || normName.includes('cong nghe')) detectedSubject = 'Công nghệ';
            else if (normName.includes('tin_hoc') || normName.includes('tin hoc')) detectedSubject = 'Tin học';
            else if (normName.includes('ky_nang_so') || normName.includes('ki_nang_so') || normName.includes('ky nang so') || normName.includes('ki nang so')) detectedSubject = 'Giáo dục kĩ năng công dân số';
            else if (normName.includes('tieng_viet') || normName.includes('tieng viet')) detectedSubject = 'Tiếng Việt';
            else if (normName.includes('toan')) detectedSubject = 'Toán';
            else if (normName.includes('khoa_hoc') || normName.includes('khoa hoc')) detectedSubject = 'Khoa học';
            else if (normName.includes('lich_su') || normName.includes('dia_li') || normName.includes('dia_ly')) detectedSubject = 'Lịch sử và Địa lý';
            else if (normName.includes('dao_duc') || normName.includes('dao duc')) detectedSubject = 'Đạo đức';
            else if (normName.includes('tu_nhien') || normName.includes('xa_hoi')) detectedSubject = 'Tự nhiên và Xã hội';
            else if (normName.includes('trai_nghiem') || normName.includes('hdtn')) detectedSubject = 'Hoạt động trải nghiệm';

            if (detectedSubject || gradeMatch) {
                setInputData(prev => ({
                    ...prev,
                    subject: detectedSubject || prev.subject,
                    grade: gradeMatch ? gradeMatch[1] : prev.grade
                }));
            }
            
            const effectiveKey = getEffectiveApiKey();
            if (effectiveKey) {
                await parsePpct(file, effectiveKey);
            } else {
                setPpctError('Vui lòng nhập Gemini API Key phía trên rồi bấm "Phân tích file PPCT" để trích xuất danh sách bài học.');
            }
            e.target.value = '';
        }
    };

    const parsePpct = async (file: File, key?: string) => {
        const effectiveKey = (key || getEffectiveApiKey()).trim();
        if (!effectiveKey) {
            setPpctError('Vui lòng nhập Gemini API Key phía trên để tự động phân tích file Phân phối chương trình.');
            return;
        }
        setParsingPpct(true);
        setPpctError('');
        setError('');
        try {
            const lessons = await extractLessonsFromPpct(file, effectiveKey);
            if (lessons.length > 0) {
                updatePpctLessonsAndPlans(lessons);
            } else {
                setPpctError('Không tìm thấy dữ liệu bảng bài học trong file Phân phối chương trình.');
            }
        } catch (err: any) {
            console.warn(err);
            const rawMsg = String(err?.message || 'Không thể trích xuất danh sách bài học từ file PPCT.');
            const cleanMsg =
                rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE') || rawMsg.includes('high demand')
                    ? 'Máy chủ AI đang có lượng truy cập cao đột biến. Vui lòng bấm "Phân tích lại file PPCT" sau vài giây.'
                    : rawMsg;
            setPpctError(cleanMsg);
        } finally {
            setParsingPpct(false);
        }
    };

    const handleSelectWeekIndex = (idx: number) => {
        setSelectedWeekIndex(idx);
        const item = weekPlansRef.current[idx] || weekPlans[idx];
        if (item) {
            setInputData(prev => ({
                ...prev,
                week: item.week.replace(/Tuần\s*/gi, '').trim() || String(idx + 1),
                lessonName: item.lessonName,
                periods: String(item.periods),
                integrationNotes: item.notes || '',
                periodIndexInLesson: item.periodIndexInLesson,
                totalPeriodsInLesson: item.totalPeriodsInLesson,
                baseLessonName: item.baseLessonName,
                pedagogicalNote: item.pedagogicalNote
            }));
            if (item.result) {
                setActiveTab('preview');
            }
        }
    };

    const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const filesArray = Array.from(e.target.files);
            const newImages = filesArray.map((file) => ({
                file: file as File,
                previewUrl: URL.createObjectURL(file as File)
            }));
            setImages(prev => [...prev, ...newImages]);
            setSourceType('image');
            setError('');
        }
    };

    const handlePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const newFiles = Array.from(e.target.files) as File[];
            const oversized = newFiles.filter(f => f.size > 100 * 1024 * 1024);
            if (oversized.length > 0) {
                setError(`Cảnh báo: Tệp "${oversized[0].name}" quá lớn. Vui lòng tải lên tệp dưới 100MB.`);
            }
            const validFiles = newFiles.filter(f => f.size <= 100 * 1024 * 1024);
            setPdfFiles(prev => [...prev, ...validFiles]);
            if (validFiles.length > 0 && !pdfFile) {
                setPdfFile(validFiles[0]);
            }
            if (validFiles.length > 0) {
                setSourceType('pdf');
                setError('');
            }
            e.target.value = '';
        }
    };

    const removePdfFile = (index: number) => {
        setPdfFiles(prev => {
            const next = prev.filter((_, i) => i !== index);
            setPdfFile(next.length > 0 ? next[0] : null);
            return next;
        });
    };
    
    const handleReferencePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const newFiles = Array.from(e.target.files) as File[];
            const oversized = newFiles.filter(f => f.size > 100 * 1024 * 1024);
            if (oversized.length > 0) {
                setError(`Cảnh báo: Tệp "${oversized[0].name}" quá lớn. Vui lòng tải lên tệp dưới 100MB.`);
            }
            const validFiles = newFiles.filter(f => f.size <= 100 * 1024 * 1024);
            setReferencePdfs(prev => [...prev, ...validFiles]);
            e.target.value = '';
        }
    };
    
    const removeReferencePdf = (index: number) => {
        setReferencePdfs(prev => prev.filter((_, i) => i !== index));
    };

    const removeImage = (index: number) => {
        setImages(prev => {
            const newImages = [...prev];
            URL.revokeObjectURL(newImages[index].previewUrl);
            newImages.splice(index, 1);
            return newImages;
        });
    };

    // --- Validation Helper ---
    const validateBeforeRun = (): boolean => {
        const effectiveKey = getEffectiveApiKey();
        if (!effectiveKey) {
            setError('Vui lòng nhập Gemini API Key ở mục Thiết lập phía trên để tiến hành soạn bài.');
            return false;
        }
        if (weekPlansRef.current.length === 0) {
            setError('Vui lòng tải lên file Phân phối chương trình để có danh sách bài dạy trước khi soạn.');
            return false;
        }
        // Tự động đồng bộ nguồn SGK nếu người dùng đã tải PDF hoặc Ảnh lên ở tab bên kia
        if (sourceType === 'image' && images.length === 0 && (pdfFiles.length > 0 || pdfFile)) {
            setSourceType('pdf');
        } else if (sourceType === 'pdf' && pdfFiles.length === 0 && !pdfFile && images.length > 0) {
            setSourceType('image');
        }
        setError('');
        return true;
    };

    // --- Generate a Single Week Plan ---
    const generateForWeekIndex = async (idx: number, isBatchMode: boolean = false): Promise<boolean> => {
        const currentPlans = weekPlansRef.current;
        const item = currentPlans[idx];
        if (!item) return false;

        const effectiveKey = getEffectiveApiKey();
        if (!effectiveKey) {
            setError('Vui lòng nhập Gemini API Key để tiến hành soạn bài.');
            return false;
        }

        updateWeekPlansState(prev =>
            prev.map((w, i) => (i === idx ? { ...w, status: 'generating', error: undefined } : w))
        );

        const effectiveNotes = (item.notes || '').trim();
        const effectiveSourceType: SourceType =
            sourceType === 'image' && images.length === 0 && (pdfFiles.length > 0 || pdfFile)
                ? 'pdf'
                : sourceType === 'pdf' && pdfFiles.length === 0 && !pdfFile && images.length > 0
                    ? 'image'
                    : sourceType;

        try {
            const resultData = await generateLessonPlan({
                inputData: {
                    ...inputData,
                    week: item.week.replace(/Tuần\s*/gi, '').trim() || String(idx + 1),
                    lessonName: item.lessonName,
                    periods: String(item.periods),
                    integrationNotes: effectiveNotes,
                    periodIndexInLesson: item.periodIndexInLesson,
                    totalPeriodsInLesson: item.totalPeriodsInLesson,
                    baseLessonName: item.baseLessonName,
                    pedagogicalNote: item.pedagogicalNote
                },
                sourceType: effectiveSourceType,
                images,
                pdfFile: pdfFiles.length > 0 ? pdfFiles[0] : pdfFile,
                pdfFiles: pdfFiles.length > 0 ? pdfFiles : (pdfFile ? [pdfFile] : []),
                referencePdfs,
                ppctFile: ppctPdfFile,
                apiKey: effectiveKey,
                uploadedFileCache: uploadedFileCacheRef.current
            });

            // Sử dụng Trí tuệ nhân tạo (AI) chuyển trực tiếp câu văn phía trên thành hình ảnh minh họa cho tiết học
            if (isBatchMode) {
                pregenerateLessonImagesWithAI(resultData, inputData.subject, inputData.grade, effectiveKey).catch(() => {});
            } else {
                try {
                    await pregenerateLessonImagesWithAI(resultData, inputData.subject, inputData.grade, effectiveKey);
                } catch {
                    // Nếu mạng gián đoạn tạm thời, trình xem sẽ tự động gọi AI bổ sung khi hiển thị
                }
            }

            updateWeekPlansState(prev =>
                prev.map((w, i) => (i === idx ? { ...w, status: 'completed', result: resultData, error: undefined } : w))
            );
            return true;
        } catch (err: any) {
            console.warn(`Lỗi khi soạn ${item.week}:`, err);
            const errMsg = err?.message || 'Lỗi tạo Kế hoạch bài dạy. Vui lòng kiểm tra kết nối hoặc thử lại.';
            updateWeekPlansState(prev =>
                prev.map((w, i) => (i === idx ? { ...w, status: 'error', error: errMsg } : w))
            );
            if (!isBatchMode) {
                setError(`Lỗi khi soạn ${item.week} (${item.lessonName}): ${errMsg}`);
            }
            return false;
        }
    };

    // --- Action: Generate Single Selected Week ---
    const handleGenerateSingle = async (idxToGen = selectedWeekIndex) => {
        if (!validateBeforeRun()) return;
        const targetIdx = idxToGen >= 0 && idxToGen < weekPlansRef.current.length ? idxToGen : 0;
        const targetItem = weekPlansRef.current[targetIdx];
        if (!targetItem) return;

        setLoadingSingle(true);
        setSelectedWeekIndex(targetIdx);
        setInputData(prev => ({
            ...prev,
            week: targetItem.week.replace(/Tuần\s*/gi, '').trim() || String(targetIdx + 1),
            lessonName: targetItem.lessonName,
            periods: '1',
            integrationNotes: targetItem.notes || '',
            periodIndexInLesson: targetItem.periodIndexInLesson,
            totalPeriodsInLesson: targetItem.totalPeriodsInLesson,
            baseLessonName: targetItem.baseLessonName,
            pedagogicalNote: targetItem.pedagogicalNote
        }));

        const success = await generateForWeekIndex(targetIdx, false);
        setLoadingSingle(false);
        if (success) {
            setActiveTab('preview');
            if (typeof window !== 'undefined' && window.innerWidth < 1024 && rightPanelRef.current) {
                rightPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }
    };

    // --- Action: Batch Generate All Weeks ---
    const handleGenerateAllWeeks = async () => {
        if (!validateBeforeRun()) return;
        const totalWeeks = weekPlansRef.current.length;
        if (totalWeeks === 0) {
            setError('Chưa có danh sách tuần trong Phân phối chương trình. Vui lòng tải file PPCT lên trước.');
            return;
        }

        const allAlreadyCompleted = weekPlansRef.current.every(w => w.status === 'completed' && !!w.result);

        setIsBatchGenerating(true);
        abortBatchRef.current = false;
        setActiveTab('list');

        if (typeof window !== 'undefined' && window.innerWidth < 1024 && rightPanelRef.current) {
            rightPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        // Vòng 1: Soạn tuần tự tất cả các tuần chưa hoàn thành
        for (let i = 0; i < totalWeeks; i++) {
            if (abortBatchRef.current) break;

            const currentItem = weekPlansRef.current[i];
            if (!currentItem) continue;

            if (!allAlreadyCompleted && currentItem.status === 'completed' && currentItem.result) {
                continue;
            }

            setBatchCurrentIndex(i);
            setSelectedWeekIndex(i);
            const ok = await generateForWeekIndex(i, true);
            if (!ok && !abortBatchRef.current) {
                await new Promise(r => setTimeout(r, 800));
                if (!abortBatchRef.current) {
                    await generateForWeekIndex(i, true);
                }
            }
        }

        // Vòng 2: Rà soát tự động lần cuối các tuần còn sót (nếu có) để đảm bảo hoàn thành đủ 100% số tuần (35/35 tuần)
        for (let i = 0; i < totalWeeks; i++) {
            if (abortBatchRef.current) break;
            const itemAfterPass1 = weekPlansRef.current[i];
            if (itemAfterPass1 && (itemAfterPass1.status !== 'completed' || !itemAfterPass1.result)) {
                setBatchCurrentIndex(i);
                setSelectedWeekIndex(i);
                await new Promise(r => setTimeout(r, 600));
                if (!abortBatchRef.current) {
                    await generateForWeekIndex(i, true);
                }
            }
        }

        setIsBatchGenerating(false);
        setBatchCurrentIndex(-1);
    };

    const handleStopBatch = () => {
        abortBatchRef.current = true;
        setIsBatchGenerating(false);
        setBatchCurrentIndex(-1);
    };

    // --- Download Actions ---
    const handleDownloadWeekDoc = async (item: WeekPlanItem) => {
        if (!item.result) {
            setError(`Tuần ${item.week} chưa có kết quả soạn bài để tải về.`);
            return;
        }
        try {
            const periodTag =
                item.totalPeriodsInLesson && item.totalPeriodsInLesson > 1
                    ? `_Tiet_${item.periodIndexInLesson}`
                    : '';
            const fileName = `KHBD_${item.week.replace(/\s+/g, '_')}_${item.lessonName.replace(/[\/\\?%*:|"<>]/g, '_')}${periodTag}`;
            await downloadSingleLessonWord(
                item.result,
                {
                    ...inputData,
                    apiKey: getEffectiveApiKey(),
                    week: item.week,
                    lessonName: item.lessonName,
                    baseLessonName: item.baseLessonName,
                    periods: '1',
                    periodIndexInLesson: item.periodIndexInLesson,
                    totalPeriodsInLesson: item.totalPeriodsInLesson,
                    pedagogicalNote: item.pedagogicalNote
                },
                fileName,
                hideTableBorders
            );
        } catch (err: any) {
            console.warn('Lỗi tải file Word:', err);
            setError('Có lỗi xảy ra khi xuất file Word: ' + (err?.message || ''));
        }
    };

    const handleDownloadAllZip = async () => {
        const completedPlans = weekPlansRef.current
            .map((w, idx) => ({ item: w, idx }))
            .filter(entry => entry.item.status === 'completed' && !!entry.item.result);

        if (completedPlans.length === 0) {
            setError('Chưa có tuần nào được soạn hoàn thành để nén và tải về.');
            return;
        }

        setIsDownloadingZip(true);
        setError('');
        try {
            const zip = new JSZip();
            const effectiveKey = getEffectiveApiKey();
            for (let k = 0; k < completedPlans.length; k++) {
                const { item, idx } = completedPlans[k];
                setZipProgress(`${k + 1}/${completedPlans.length}`);
                if (item.result) {
                    const docxBlob = await generateLessonPlanDocxBlob(
                        item.result,
                        {
                            ...inputData,
                            apiKey: effectiveKey,
                            week: item.week,
                            lessonName: item.lessonName,
                            baseLessonName: item.baseLessonName,
                            periods: '1',
                            periodIndexInLesson: item.periodIndexInLesson,
                            totalPeriodsInLesson: item.totalPeriodsInLesson,
                            pedagogicalNote: item.pedagogicalNote
                        },
                        false
                    );
                    const orderPrefix = String(idx + 1).padStart(2, '0');
                    const safeWeek = item.week.replace(/[\/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_').trim();
                    const safeLessonName = item.lessonName.replace(/[\/\\?%*:|"<>]/g, '_').trim();
                    const periodSuffix =
                        item.totalPeriodsInLesson && item.totalPeriodsInLesson > 1
                            ? `_Tiet_${item.periodIndexInLesson}`
                            : '';
                    const fileName = `${orderPrefix}_KHBD_${safeWeek}_${safeLessonName}${periodSuffix}.docx`;
                    zip.file(fileName, docxBlob);
                }
            }

            setZipProgress('Đang nén...');
            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            const link = document.createElement('a');
            link.href = url;
            const safeSubj = (inputData.subject || 'Mon_Hoc').replace(/[\/\\?%*:|"<>]/g, '_').replace(/\s+/g, '_');
            link.download = `Tron_Bo_KHBD_${safeSubj}_Lop_${inputData.grade || ''}_${completedPlans.length}_Tuan.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (err: any) {
            console.warn('Lỗi khi nén file zip:', err);
            setError('Có lỗi xảy ra khi tạo file nén ZIP: ' + (err?.message || ''));
        } finally {
            setIsDownloadingZip(false);
            setZipProgress('');
        }
    };

    const completedCount = weekPlans.filter(w => w.status === 'completed').length;
    const currentSelectedPlan = weekPlans[selectedWeekIndex];
    const integratedWeeksCount = weekPlans.filter(w => w.notes && w.notes.trim().length > 0).length;

    return (
        <div className="min-h-screen relative font-sans p-2 md:p-6 text-slate-800">
            {/* Background elements */}
            <div 
                className="fixed inset-0 z-0 bg-cover bg-center bg-no-repeat blur-md scale-105"
                style={{ backgroundImage: 'url("/background.jpg")' }}
            />
            <div className="fixed inset-0 z-0 bg-slate-100/75" />
            
            <div className="relative z-10 max-w-7xl mx-auto space-y-5">
                {/* Header */}
                <header className="flex flex-col md:flex-row items-center justify-between bg-white/95 backdrop-blur-md p-4 rounded-xl shadow-md border border-teal-100">
                    <div className="flex items-center gap-3 mb-3 md:mb-0">
                        <div className="bg-teal-600 p-2.5 rounded-lg text-white shadow-sm">
                            <BookOpen size={24} />
                        </div>
                        <div>
                            <h1 className="text-lg md:text-xl font-bold text-gray-800 uppercase tracking-wide">
                                KẾ HOẠCH DẠY HỌC VÀ KẾ HOẠCH BÀI DẠY THMA
                            </h1>
                            <p className="text-xs text-teal-700 font-medium">
                                Ứng dụng phát triển bởi thầy giáo Lê Văn Phi
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={downloadPpctWordTemplate}
                            className="flex items-center gap-1.5 px-3 py-2 bg-amber-50 hover:bg-amber-100 text-amber-800 text-xs font-bold rounded-lg border border-amber-300 shadow-xs transition-colors cursor-pointer"
                            title="Tải file mẫu Word gồm 4 cột (Tuần, Tên bài, Số tiết, Ghi chú tích hợp)"
                        >
                            <Download size={14} className="text-amber-700" /> Tải file mẫu Word PPCT (4 cột)
                        </button>
                    </div>
                </header>

                {/* THANH ĐIỀU HƯỚNG 2 CHỨC NĂNG CHÍNH: KẾ HOẠCH BÀI DẠY vs. KẾ HOẠCH DẠY HỌC */}
                <div className="flex bg-white/95 backdrop-blur-md p-1.5 rounded-xl shadow-md border border-teal-100 gap-2">
                    <button
                        type="button"
                        onClick={() => setMainFeatureTab('khbd')}
                        className={`flex-1 py-3 px-4 rounded-lg font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
                            mainFeatureTab === 'khbd'
                                ? 'bg-teal-700 text-white shadow-md'
                                : 'text-gray-700 hover:bg-teal-50 hover:text-teal-900'
                        }`}
                    >
                        <BookOpen size={18} />
                        <span>KẾ HOẠCH BÀI DẠY (KHBD)</span>
                    </button>

                    <button
                        type="button"
                        onClick={() => setMainFeatureTab('khdh')}
                        className={`flex-1 py-3 px-4 rounded-lg font-bold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all cursor-pointer ${
                            mainFeatureTab === 'khdh'
                                ? 'bg-teal-700 text-white shadow-md'
                                : 'text-gray-700 hover:bg-teal-50 hover:text-teal-900'
                        }`}
                    >
                        <Calendar size={18} />
                        <span>KẾ HOẠCH DẠY HỌC (KHDH)</span>
                        <span className="text-[10px] bg-amber-400 text-amber-950 font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider ml-1">
                            Mới
                        </span>
                    </button>
                </div>

                {mainFeatureTab === 'khbd' ? (
                    <main className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                        {/* LEFT COLUMN: SETUP & PPCT */}
                        <div className="lg:col-span-5 space-y-5">
                            <div className="bg-white/95 backdrop-blur-md p-4 md:p-5 rounded-xl shadow-md border border-teal-100 space-y-4">
                                <h2 className="flex items-center gap-2 font-bold text-gray-800 text-sm border-b pb-2">
                                    <Settings size={18} className="text-teal-600" /> THIẾT LẬP VÀ PHÂN PHỐI CHƯƠNG TRÌNH
                                </h2>

                            {/* API Key */}
                            <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-lg">
                                <label className="block text-xs font-bold text-blue-900 mb-1 flex items-center justify-between">
                                    <span className="flex items-center gap-1"><Key size={14} /> Gemini API Key</span>
                                    {userApiKey && <span className="text-green-600 font-normal flex items-center gap-1"><CheckCircle size={12} /> Đã lưu</span>}
                                </label>
                                <input 
                                    type="password" 
                                    placeholder="Nhập Gemini API Key của bạn..." 
                                    className="w-full p-2 bg-white border border-blue-300 rounded-md text-xs outline-none focus:ring-1 focus:ring-blue-500 font-mono" 
                                    value={userApiKey} 
                                    onChange={(e) => {
                                        setUserApiKey(e.target.value);
                                        localStorage.setItem('geminiApiKey', e.target.value);
                                    }} 
                                />
                                <p className="text-[11px] text-blue-700 mt-1.5 italic">API Key đã được lưu bảo mật trong trình duyệt của bạn.</p>
                            </div>

                            {/* Môn học, Lớp, Thời lượng */}
                            <div className="grid grid-cols-3 gap-2">
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 mb-1">Môn học</label>
                                    <input 
                                        type="text" 
                                        placeholder="VD: Tin học" 
                                        className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                        value={inputData.subject} 
                                        onChange={(e) => setInputData({...inputData, subject: e.target.value})} 
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 mb-1">Khối Lớp</label>
                                    <input 
                                        type="text" 
                                        placeholder="VD: 4" 
                                        className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                        value={inputData.grade} 
                                        onChange={(e) => setInputData({...inputData, grade: e.target.value.toUpperCase()})} 
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 mb-1">Thời lượng (Phút)</label>
                                    <input 
                                        type="number" 
                                        placeholder="VD: 35" 
                                        className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                        value={inputData.duration} 
                                        onChange={(e) => setInputData({...inputData, duration: e.target.value})} 
                                    />
                                </div>
                            </div>

                            {/* Trường học và Giáo viên theo mẫu KHBD */}
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 mb-1">Đơn vị / Trường học</label>
                                    <input 
                                        type="text" 
                                        placeholder="VD: Trường Tiểu học Mỹ An" 
                                        className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                        value={inputData.schoolName || ''} 
                                        onChange={(e) => setInputData({...inputData, schoolName: e.target.value})} 
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 mb-1">Giáo viên giảng dạy</label>
                                    <input 
                                        type="text" 
                                        placeholder="VD: GV: Lê Văn Phi" 
                                        className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                        value={inputData.teacherName || ''} 
                                        onChange={(e) => setInputData({...inputData, teacherName: e.target.value})} 
                                    />
                                </div>
                            </div>

                            {/* PHÂN PHỐI CHƯƠNG TRÌNH (PPCT) */}
                            <div className="pt-3 border-t border-gray-200 space-y-3">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-bold text-teal-900 uppercase flex items-center gap-1.5">
                                        <Layers size={16} className="text-teal-600" /> Bảng PPCT {weekPlans.length > 0 ? `(${weekPlans.length} tuần)` : ''}
                                    </label>
                                </div>

                                <div className="text-[11px] text-gray-600 bg-amber-50/70 p-2.5 rounded-lg border border-amber-200 leading-relaxed">
                                    💡 <b>Quy chuẩn 4 cột:</b> Cột 1: <b>Tuần</b> | Cột 2: <b>Tên bài</b> | Cột 3: <b>Số tiết</b> | Cột 4: <b>Ghi chú (Tích hợp môn &amp; nội dung)</b>.<br/>
                                    Hệ thống sẽ dựa vào file tải lên để hiển thị danh sách tuần chính xác tuyệt đối. Các tuần có ghi chú sẽ được tích hợp đúng môn học và nội dung theo yêu cầu.
                                </div>

                                {/* Upload PPCT PDF/Word/Image button */}
                                <div className="p-3 border-2 border-dashed border-teal-300 rounded-lg bg-teal-50/70 text-center hover:bg-teal-100/60 transition-colors">
                                    <input 
                                        type="file" 
                                        accept=".pdf,.docx,.doc,image/*" 
                                        onChange={handlePpctFileChange} 
                                        className="hidden" 
                                        id="ppct-upload" 
                                    />
                                    <label htmlFor="ppct-upload" className="cursor-pointer block">
                                        <FileUp size={24} className="mx-auto text-teal-600 mb-1.5" />
                                        <span className="block text-xs font-bold text-teal-900">
                                            {ppctPdfFile ? `Tệp đã chọn: ${ppctPdfFile.name}` : 'Tải lên file Phân phối chương trình (PDF, Word .docx hoặc Ảnh)'}
                                        </span>
                                        <span className="block text-[10px] text-teal-700 mt-0.5">
                                            {ppctPdfFile ? 'Bấm để đổi tệp khác' : 'Chứa bảng 4 cột: Cột 1 Tuần, Cột 2 Tên bài, Cột 3 Số tiết, Cột 4 Ghi chú'}
                                        </span>
                                    </label>
                                    {ppctPdfFile && !parsingPpct && (
                                        <button
                                            type="button"
                                            onClick={() => parsePpct(ppctPdfFile)}
                                            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 bg-teal-700 hover:bg-teal-800 text-white rounded-md text-[11px] font-bold shadow-2xs cursor-pointer"
                                        >
                                            <RefreshCw size={12} /> Phân tích lại file PPCT
                                        </button>
                                    )}
                                </div>

                                {parsingPpct && (
                                    <div className="p-2.5 bg-blue-50 border border-blue-200 rounded-md flex items-center gap-2 text-xs text-blue-800 animate-pulse">
                                        <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                                        <span>Đang trích xuất chính xác danh sách các tuần và ghi chú từ file PPCT vừa tải lên...</span>
                                    </div>
                                )}

                                {ppctError && (
                                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-start gap-1.5">
                                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                                        <div>{ppctError}</div>
                                    </div>
                                )}

                                {/* BẢNG HIỂN THỊ DANH SÁCH TUẦN: HIỂN THỊ ĐỦ 4 CỘT CHUẨN KHI ĐÃ TẢI FILE PPCT LÊN */}
                                {weekPlans.length > 0 ? (
                                    <div className="border border-teal-300 rounded-lg overflow-hidden bg-white shadow-xs">
                                        <div className="p-2.5 bg-gradient-to-r from-teal-50 to-teal-100/70 border-b border-teal-200 flex items-center justify-between text-xs font-bold text-teal-950">
                                            <span className="flex items-center gap-1.5">
                                                <Layers size={14} className="text-teal-700" />
                                                BẢNG PHÂN PHỐI CHƯƠNG TRÌNH ({weekPlans.length} tuần):
                                            </span>
                                            <span className="text-[10px] bg-teal-200/90 text-teal-900 px-2 py-0.5 rounded font-bold">
                                                Đang chọn: {weekPlans[selectedWeekIndex]?.week || '...'}
                                            </span>
                                        </div>

                                        <div className="overflow-x-auto max-h-72 overflow-y-auto">
                                            <table className="w-full text-left border-collapse text-xs">
                                                <thead className="bg-teal-50/95 text-teal-900 sticky top-0 border-b border-teal-200 z-10 shadow-xs">
                                                    <tr>
                                                        <th className="p-2 text-center font-bold border-r border-teal-200/60 w-[15%]">
                                                            Tuần
                                                        </th>
                                                        <th className="p-2 text-left font-bold border-r border-teal-200/60 w-[38%]">
                                                            Tên bài dạy
                                                        </th>
                                                        <th className="p-2 text-center font-bold border-r border-teal-200/60 w-[15%]">
                                                            Số tiết
                                                        </th>
                                                        <th className="p-2 text-left font-bold w-[32%]">
                                                            Ghi chú (Tích hợp)
                                                        </th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-100">
                                                    {weekPlans.map((item, idx) => {
                                                        const isSelected = idx === selectedWeekIndex;
                                                        const hasNotes = !!(item.notes && item.notes.trim().length > 0);
                                                        return (
                                                            <tr
                                                                key={idx}
                                                                onClick={() => handleSelectWeekIndex(idx)}
                                                                className={`cursor-pointer transition-colors ${
                                                                    isSelected 
                                                                        ? 'bg-teal-100/90 font-bold border-l-4 border-l-teal-600' 
                                                                        : 'hover:bg-teal-50/50 odd:bg-white even:bg-slate-50/60'
                                                                }`}
                                                                title="Bấm vào hàng này để chọn tuần soạn bài"
                                                            >
                                                                {/* CỘT 1: TUẦN */}
                                                                <td className="p-2 text-center font-bold text-teal-950 border-r border-gray-100 whitespace-nowrap">
                                                                    <div className="flex items-center justify-center gap-1">
                                                                        {item.status === 'completed' && (
                                                                            <span title="Đã hoàn thành" className="inline-flex items-center">
                                                                                <CheckCircle size={12} className="text-green-600 shrink-0" />
                                                                            </span>
                                                                        )}
                                                                        {item.status === 'generating' && (
                                                                            <div className="w-3 h-3 border-2 border-blue-600 border-t-transparent rounded-full animate-spin shrink-0" />
                                                                        )}
                                                                        {item.status === 'error' && (
                                                                            <span title={item.error || 'Lỗi'} className="inline-flex items-center">
                                                                                <AlertTriangle size={12} className="text-red-500 shrink-0" />
                                                                            </span>
                                                                        )}
                                                                        <span>{item.week}</span>
                                                                    </div>
                                                                </td>

                                                                {/* CỘT 2: TÊN BÀI */}
                                                                <td className="p-2 text-gray-900 border-r border-gray-100">
                                                                    <div className="line-clamp-2 font-medium" title={item.lessonName}>
                                                                        {item.lessonName}
                                                                    </div>
                                                                    {item.totalPeriodsInLesson && item.totalPeriodsInLesson > 1 && (
                                                                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                                                            <span className="text-[10px] bg-blue-100 text-blue-900 font-bold px-1.5 py-0.5 rounded border border-blue-300">
                                                                                Tiết {item.periodIndexInLesson}/{item.totalPeriodsInLesson}
                                                                            </span>
                                                                            {item.pedagogicalNote && (
                                                                                <span className="text-[10px] text-gray-600 truncate max-w-[200px]" title={item.pedagogicalNote}>
                                                                                    {item.pedagogicalNote}
                                                                                </span>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </td>

                                                                {/* CỘT 3: SỐ TIẾT */}
                                                                <td className="p-2 text-center font-bold text-slate-700 border-r border-gray-100 whitespace-nowrap">
                                                                    <span className="bg-slate-100 px-1.5 py-0.5 rounded text-[10px] border border-slate-200">
                                                                        {item.periods} tiết
                                                                    </span>
                                                                </td>

                                                                {/* CỘT 4: GHI CHÚ (TÍCH HỢP) */}
                                                                <td className="p-2">
                                                                    {hasNotes ? (
                                                                        <span className="inline-block text-[10px] text-purple-900 bg-purple-50 px-2 py-0.5 rounded font-semibold border border-purple-200 line-clamp-2" title={item.notes}>
                                                                            ⚡ {item.notes}
                                                                        </span>
                                                                    ) : (
                                                                        <span className="text-[10px] text-gray-400 italic">
                                                                            — (Không tích hợp)
                                                                        </span>
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-center text-xs text-gray-500">
                                        <p className="font-semibold text-gray-700 mb-1">Chưa có dữ liệu Phân phối chương trình</p>
                                        <p className="text-[11px]">Vui lòng tải lên file PPCT (PDF / Word / Ảnh) hoặc thêm nhanh tuần học ở trên để bắt đầu soạn bài.</p>
                                    </div>
                                )}
                            </div>

                            {/* SGK Source Selection */}
                            <div className="pt-3 border-t border-gray-200">
                                <label className="block text-xs font-bold text-gray-700 mb-2 uppercase">Nguồn Sách Giáo Khoa (SGK)</label>
                                <div className="flex gap-2 mb-3">
                                    <button 
                                        type="button"
                                        onClick={() => setSourceType('image')}
                                        className={`flex-1 py-1.5 text-xs font-bold rounded-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${sourceType === 'image' ? 'bg-teal-100 text-teal-800 border border-teal-300' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                                    >
                                        <ImageIcon size={14} /> Dùng Ảnh ({images.length})
                                    </button>
                                    <button 
                                        type="button"
                                        onClick={() => setSourceType('pdf')}
                                        className={`flex-1 py-1.5 text-xs font-bold rounded-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${sourceType === 'pdf' ? 'bg-red-100 text-red-800 border border-red-300' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                                    >
                                        <FileUp size={14} /> Dùng PDF SGK ({pdfFiles.length})
                                    </button>
                                </div>

                                {sourceType === 'image' ? (
                                    <div>
                                        <div className="grid grid-cols-4 gap-2 mb-2">
                                            {images.map((img, idx) => (
                                                <div key={idx} className="relative group aspect-[3/4] rounded-lg overflow-hidden border">
                                                    <img src={img.previewUrl} className="w-full h-full object-cover" alt={`SGK ${idx}`} />
                                                    <button onClick={() => removeImage(idx)} className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-0.5 shadow hover:bg-red-600 cursor-pointer">
                                                        <X size={12} />
                                                    </button>
                                                </div>
                                            ))}
                                            <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-lg aspect-[3/4] cursor-pointer hover:bg-gray-50 transition-colors">
                                                <input type="file" multiple accept="image/*" onChange={handleImageChange} className="hidden" />
                                                <Plus size={20} className="text-gray-400" />
                                                <span className="text-[10px] text-gray-500 mt-1">Thêm ảnh</span>
                                            </label>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <div className="p-3 border-2 border-dashed border-red-300 rounded-lg bg-red-50/70 text-center hover:bg-red-100/60 transition-colors">
                                            <input type="file" accept=".pdf" multiple onChange={handlePdfChange} className="hidden" id="pdf-upload" />
                                            <label htmlFor="pdf-upload" className="cursor-pointer block">
                                                <FileUp size={24} className="mx-auto text-red-500 mb-1" />
                                                <div>
                                                    <span className="block text-xs font-bold text-red-800">
                                                        {pdfFiles.length > 0 ? `Đã tải lên ${pdfFiles.length} file PDF SGK (Nhấn để thêm file)` : 'Tải lên Sách Giáo Khoa PDF (Hỗ trợ nhiều file)'}
                                                    </span>
                                                    <span className="block text-[10px] text-gray-500 mt-0.5">
                                                        Chọn được nhiều tập/chuyên đề PDF cùng lúc - AI tự động tra cứu đúng bài học
                                                    </span>
                                                </div>
                                            </label>
                                        </div>

                                        {pdfFiles.length > 0 && (
                                            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                                                {pdfFiles.map((f, idx) => (
                                                    <div key={idx} className="flex items-center justify-between p-2 bg-red-50/80 border border-red-200 rounded-md text-xs">
                                                        <div className="flex items-center gap-1.5 min-w-0">
                                                            <FileText size={14} className="text-red-600 shrink-0" />
                                                            <span className="truncate font-medium text-slate-800" title={f.name}>{f.name}</span>
                                                            <span className="text-[10px] text-slate-400 shrink-0">({(f.size / (1024 * 1024)).toFixed(1)} MB)</span>
                                                        </div>
                                                        <button 
                                                            type="button"
                                                            onClick={() => removePdfFile(idx)}
                                                            className="text-red-500 hover:text-red-700 p-1 hover:bg-red-100 rounded cursor-pointer shrink-0"
                                                            title="Xoá file này"
                                                        >
                                                            <X size={14} />
                                                        </button>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Integrations */}
                            <div className="pt-3 border-t border-dashed space-y-3">
                                <h3 className="text-xs font-bold text-teal-900 flex items-center gap-1 uppercase tracking-wide">
                                    <Link2 size={14} className="text-teal-600" /> LĨNH VỰC TÍCH HỢP BỔ SUNG
                                </h3>

                                <div className="flex gap-4">
                                    <label className="flex items-center gap-1.5 text-xs text-gray-800 font-medium cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            className="w-4 h-4 text-teal-600 rounded focus:ring-teal-500" 
                                            checked={inputData.integrateDigitalSkills}
                                            onChange={(e) => setInputData({...inputData, integrateDigitalSkills: e.target.checked})}
                                        />
                                        Năng lực số
                                    </label>
                                    <label className="flex items-center gap-1.5 text-xs text-gray-800 font-medium cursor-pointer">
                                        <input 
                                            type="checkbox" 
                                            className="w-4 h-4 text-teal-600 rounded focus:ring-teal-500" 
                                            checked={inputData.integrateAI}
                                            onChange={(e) => setInputData({...inputData, integrateAI: e.target.checked})}
                                        />
                                        Trí tuệ nhân tạo (AI)
                                    </label>
                                </div>

                                {/* Ô nhập văn bản mô tả nội dung và môn học cần tích hợp */}
                                <div>
                                    <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                        Mô tả nội dung &amp; môn học cần tích hợp:
                                    </label>
                                    <textarea
                                        rows={2}
                                        placeholder="Ví dụ: Tích hợp môn Tiếng Việt (rèn luyện kỹ năng diễn đạt), môn Mĩ thuật (vẽ tranh), ứng dụng AI tạo hình ảnh minh họa..."
                                        className="w-full p-2 bg-white border border-gray-300 rounded-md text-xs outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 leading-relaxed font-sans"
                                        value={inputData.additionalIntegrationNotes}
                                        onChange={(e) => setInputData({...inputData, additionalIntegrationNotes: e.target.value})}
                                    />
                                </div>

                                {/* Lưu ý quan trọng theo đúng chỉ đạo của người dùng */}
                                <div className="p-2.5 bg-amber-50 border border-amber-300 rounded-lg text-[11px] text-amber-950 leading-relaxed flex items-start gap-2 shadow-xs">
                                    <AlertTriangle size={15} className="text-amber-600 shrink-0 mt-0.5" />
                                    <div>
                                        <span className="font-bold text-amber-900">Quy tắc tích hợp thông minh &amp; chính xác tuyệt đối:</span>
                                        <ul className="list-disc pl-4 mt-1 space-y-0.5 text-slate-800">
                                            <li>Ứng dụng tuân thủ <b>chính xác 100% nội dung cột Ghi chú</b> của từng bài học trong Phân phối chương trình.</li>
                                            <li><b>Ví dụ thực tế:</b> Nếu trong PPCT tiết thứ 15 có ghi chú <i>"Tích hợp kỹ năng công dân số"</i>, kể cả Thầy/Cô có lỡ tích chọn AI hay Năng lực số ở trên thì tiết 15 <b>chỉ soạn tích hợp kỹ năng công dân số</b> (tuyệt đối không bị chèn AI hay Năng lực số).</li>
                                            <li>Đối với các tiết/tuần <b>không có ghi chú</b>: Hệ thống soạn bài dạy chuẩn kiến thức, <b>tuyệt đối không chèn bất kỳ nội dung tích hợp nào</b>.</li>
                                        </ul>
                                    </div>
                                </div>
                                
                                <div>
                                    <label className="block text-[11px] font-bold text-gray-700 mb-1 flex items-center gap-1">
                                        <Paperclip size={12} /> Tài liệu tham khảo tích hợp PDF (Nếu có)
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <label className="px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded text-xs font-semibold cursor-pointer flex items-center gap-1">
                                            <FileUp size={13} /> Thêm file PDF tham khảo
                                            <input type="file" accept=".pdf" multiple onChange={handleReferencePdfChange} className="hidden" />
                                        </label>
                                        <span className="text-[11px] text-gray-500">Đã chọn {referencePdfs.length} file</span>
                                    </div>
                                </div>
                            </div>

                            {/* PRIMARY ACTIONS: SOẠN TOÀN BỘ THEO PPCT HOẶC SOẠN TUẦN ĐANG CHỌN */}
                            <div className="pt-2 space-y-2">
                                <button 
                                    type="button"
                                    onClick={handleGenerateAllWeeks}
                                    disabled={isBatchGenerating || loadingSingle || weekPlans.length === 0}
                                    className={`w-full py-3 px-4 rounded-lg flex items-center justify-center gap-2 font-bold text-white shadow-md transition-all cursor-pointer ${weekPlans.length === 0 ? 'bg-gray-400 cursor-not-allowed' : isBatchGenerating ? 'bg-amber-600 hover:bg-amber-700' : 'bg-teal-700 hover:bg-teal-800'}`}
                                >
                                    <Sparkles size={18} />
                                    {isBatchGenerating 
                                        ? `Đang soạn toàn bộ (${completedCount}/${weekPlans.length} tuần)...` 
                                        : weekPlans.length > 0 
                                            ? `SOẠN TOÀN BỘ ${weekPlans.length} TUẦN THEO PPCT`
                                            : 'VUI LÒNG TẢI FILE PPCT HOẶC THÊM TUẦN ĐỂ BẮT ĐẦU'
                                    }
                                </button>

                                {isBatchGenerating && (
                                    <button 
                                        type="button"
                                        onClick={handleStopBatch}
                                        className="w-full py-1.5 px-3 rounded-lg border border-red-300 bg-red-50 text-red-700 text-xs font-bold hover:bg-red-100 flex items-center justify-center gap-1 cursor-pointer"
                                    >
                                        <Square size={13} /> Dừng soạn tự động
                                    </button>
                                )}

                                {weekPlans.length > 0 && (
                                    <button 
                                        type="button"
                                        onClick={() => handleGenerateSingle(selectedWeekIndex)}
                                        disabled={loadingSingle || isBatchGenerating}
                                        className="w-full py-2.5 px-3 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 hover:bg-teal-100 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                    >
                                        <Send size={14} />
                                        {loadingSingle 
                                            ? `Đang soạn ${weekPlans[selectedWeekIndex]?.week || ''}...` 
                                            : `Chỉ soạn riêng ${weekPlans[selectedWeekIndex]?.week || 'tuần đang chọn'}: ${weekPlans[selectedWeekIndex]?.lessonName || ''}${weekPlans[selectedWeekIndex]?.totalPeriodsInLesson && weekPlans[selectedWeekIndex]?.totalPeriodsInLesson! > 1 ? ` (Tiết ${weekPlans[selectedWeekIndex]?.periodIndexInLesson}/${weekPlans[selectedWeekIndex]?.totalPeriodsInLesson})` : ''}`
                                        }
                                    </button>
                                )}

                                {completedCount > 0 && (
                                    <button
                                        type="button"
                                        onClick={handleDownloadAllZip}
                                        disabled={isDownloadingZip}
                                        className="w-full py-2.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm transition-colors cursor-pointer"
                                    >
                                        <Archive size={15} />
                                        {isDownloadingZip
                                            ? `Đang xuất file ZIP (${zipProgress})...`
                                            : `TẢI VỀ TẤT CẢ CÁC TUẦN ĐÃ SOẠN (${completedCount} TUẦN - .ZIP)`}
                                    </button>
                                )}
                            </div>

                            {error && (
                                <div className="p-3 bg-red-50 text-red-700 text-xs rounded-md border border-red-200 flex items-start justify-between gap-2">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-600" />
                                        <div>{error}</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setError('')}
                                        className="text-red-500 hover:text-red-700 p-0.5 cursor-pointer shrink-0"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* RIGHT COLUMN: DOWNLOAD CENTER & PREVIEW */}
                    <div ref={rightPanelRef} className="lg:col-span-7 space-y-4">
                        <div className="bg-white/95 backdrop-blur-md rounded-xl shadow-md border border-teal-100 overflow-hidden flex flex-col min-h-[640px]">
                            {/* Tab Switcher */}
                            <div className="flex flex-wrap border-b border-teal-100 bg-teal-50/60 p-2 gap-2">
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('list')}
                                    className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${activeTab === 'list' ? 'bg-white text-teal-900 shadow-sm border border-teal-200' : 'text-gray-600 hover:text-gray-900'}`}
                                >
                                    <Layers size={16} className="text-teal-600 shrink-0" />
                                    <span>DANH SÁCH CÁC TUẦN &amp; TẢI VỀ RIÊNG BIỆT</span>
                                    {weekPlans.length > 0 && (
                                        <span className="ml-1 px-1.5 py-0.2 bg-teal-100 text-teal-800 rounded-full text-[10px]">
                                            {completedCount}/{weekPlans.length}
                                        </span>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setActiveTab('preview')}
                                    className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${activeTab === 'preview' ? 'bg-white text-teal-900 shadow-sm border border-teal-200' : 'text-gray-600 hover:text-gray-900'}`}
                                >
                                    <Eye size={16} className="text-teal-600 shrink-0" />
                                    <span>XEM CHI TIẾT GIÁO ÁN</span>
                                    {currentSelectedPlan?.status === 'completed' && (
                                        <span className="w-2 h-2 rounded-full bg-green-500" />
                                    )}
                                </button>
                            </div>

                            {error && (
                                <div className="mx-4 mt-3 p-3 bg-red-50 text-red-700 text-xs rounded-lg border border-red-200 flex items-start justify-between gap-2">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-600" />
                                        <div>{error}</div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setError('')}
                                        className="text-red-500 hover:text-red-700 p-0.5 cursor-pointer shrink-0"
                                    >
                                        <X size={14} />
                                    </button>
                                </div>
                            )}

                            {/* TAB 1: DANH SÁCH CÁC TUẦN RIÊNG BIỆT ĐỂ TẢI VỀ */}
                            {activeTab === 'list' && (
                                <div className="p-4 md:p-6 space-y-4 flex-1 flex flex-col">
                                    {weekPlans.length === 0 ? (
                                        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-500">
                                            <Layers size={64} className="text-gray-300 mb-3" />
                                            <h3 className="text-base font-bold text-gray-700 mb-1">Chưa có dữ liệu Phân phối chương trình</h3>
                                            <p className="text-xs text-gray-500 max-w-md">
                                                Vui lòng tải lên file Phân phối chương trình (PDF, Word hoặc Ảnh) hoặc thêm nhanh tuần học ở cột bên trái để hiển thị danh sách các tuần học và tiến hành soạn bài.
                                            </p>
                                        </div>
                                    ) : (
                                        <>
                                            {/* Action Bar */}
                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-gradient-to-r from-teal-50 to-emerald-50 rounded-lg border border-teal-200">
                                                <div>
                                                    <div className="text-xs font-bold text-teal-950 flex items-center gap-2">
                                                        <span>Tiến độ hoàn thành: {completedCount} / {weekPlans.length} tuần</span>
                                                        {completedCount === weekPlans.length && weekPlans.length > 0 && (
                                                            <span className="bg-green-100 text-green-800 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1">
                                                                <Check size={12} /> Đã đủ {weekPlans.length} tuần
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-[11px] text-gray-600 mt-0.5">
                                                        {integratedWeeksCount > 0 
                                                            ? `Có ${integratedWeeksCount} tuần được ghi chú tích hợp môn học & nội dung.` 
                                                            : 'Mỗi tuần là 1 file Word riêng biệt. Thầy/Cô có thể soạn từng tuần hoặc soạn trọn bộ.'
                                                        }
                                                    </div>
                                                </div>

                                                <div className="flex flex-wrap items-center gap-2">
                                                    {!isBatchGenerating ? (
                                                        <button
                                                            type="button"
                                                            onClick={handleGenerateAllWeeks}
                                                            disabled={loadingSingle}
                                                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-sm cursor-pointer transition-colors bg-teal-700 hover:bg-teal-800 text-white"
                                                        >
                                                            <Sparkles size={14} /> Soạn tất cả ({weekPlans.length} tuần)
                                                        </button>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={handleStopBatch}
                                                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-sm cursor-pointer transition-colors bg-red-600 hover:bg-red-700 text-white"
                                                        >
                                                            <Square size={13} /> Dừng soạn
                                                        </button>
                                                    )}

                                                    <button
                                                        type="button"
                                                        onClick={handleDownloadAllZip}
                                                        disabled={completedCount === 0 || isDownloadingZip}
                                                        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-sm cursor-pointer transition-colors ${completedCount > 0 ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                                                        title="Nén tất cả các tuần đã soạn thành một file ZIP"
                                                    >
                                                        <Archive size={14} />{' '}
                                                        {isDownloadingZip
                                                            ? `Đang nén (${zipProgress})...`
                                                            : `Tải tất cả các tuần (${completedCount} tuần .ZIP)`}
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Batch Progress Bar if generating */}
                                            {isBatchGenerating && (
                                                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1.5 animate-in fade-in">
                                                    <div className="flex items-center justify-between text-xs font-bold text-blue-900">
                                                        <span>Đang tự động soạn: Tuần {batchCurrentIndex + 1} / {weekPlans.length}...</span>
                                                        <span>{Math.round((completedCount / weekPlans.length) * 100)}%</span>
                                                    </div>
                                                    <div className="w-full bg-blue-200 h-2 rounded-full overflow-hidden">
                                                        <div 
                                                            className="bg-blue-600 h-full transition-all duration-300"
                                                            style={{ width: `${(completedCount / weekPlans.length) * 100}%` }}
                                                        />
                                                    </div>
                                                </div>
                                            )}

                                            {/* WEEKS LIST */}
                                            <div className="space-y-2.5 overflow-y-auto max-h-[580px] pr-1">
                                                {weekPlans.map((item, idx) => {
                                                    const isSelected = idx === selectedWeekIndex;
                                                    const isDone = item.status === 'completed' && !!item.result;
                                                    const isGenerating = item.status === 'generating';
                                                    const isError = item.status === 'error';
                                                    const hasNotes = !!(item.notes && item.notes.trim().length > 0);

                                                    return (
                                                        <div 
                                                            key={item.id || idx}
                                                            className={`p-3 rounded-lg border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${isSelected ? 'border-teal-500 bg-teal-50/50 shadow-xs ring-1 ring-teal-400' : 'border-gray-200 bg-white hover:border-teal-300'}`}
                                                        >
                                                            {/* Left: Week badge, Lesson Name, Periods */}
                                                            <div className="flex items-start gap-3 min-w-0">
                                                                <div className="px-2.5 py-1.5 bg-teal-700 text-white rounded text-xs font-bold shrink-0 text-center min-w-[70px]">
                                                                    {item.week}
                                                                </div>

                                                                <div className="min-w-0">
                                                                    <div className="text-sm font-bold text-gray-900 break-words">
                                                                        {item.lessonName}
                                                                    </div>
                                                                    <div className="flex flex-wrap items-center gap-2 mt-1">
                                                                        <span className="text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded font-semibold border border-teal-200">
                                                                            {item.periods} tiết
                                                                        </span>

                                                                        {item.totalPeriodsInLesson && item.totalPeriodsInLesson > 1 && (
                                                                            <span className="text-[11px] text-blue-900 bg-blue-100/90 px-2 py-0.5 rounded font-bold border border-blue-300">
                                                                                Tiết {item.periodIndexInLesson}/{item.totalPeriodsInLesson}
                                                                            </span>
                                                                        )}

                                                                        {item.pedagogicalNote && (
                                                                            <span className="text-[10px] text-indigo-900 bg-indigo-50/80 px-2 py-0.5 rounded font-medium border border-indigo-200">
                                                                                📌 {item.pedagogicalNote}
                                                                            </span>
                                                                        )}

                                                                        {hasNotes ? (
                                                                            <span className="text-[11px] text-purple-800 bg-purple-50 px-2 py-0.5 rounded font-semibold border border-purple-200 flex items-center gap-1">
                                                                                <Sparkles size={11} className="text-purple-600" />
                                                                                Ghi chú: {item.notes}
                                                                                {inputData.integrateAI ? ' • Có AI' : ''}
                                                                                {inputData.integrateDigitalSkills ? ' • Có NL số' : ''}
                                                                            </span>
                                                                        ) : (
                                                                            <span className="text-[10px] text-gray-500 italic">
                                                                                (Chuẩn bài dạy - không có ghi chú nên không tích hợp)
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                    {isError && item.error && (
                                                                        <div className="mt-1.5 text-[11px] text-red-600 font-medium flex items-center gap-1">
                                                                            <AlertTriangle size={12} className="shrink-0" />
                                                                            <span>{item.error}</span>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Right: Actions */}
                                                            <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                                                                {isDone ? (
                                                                    <>
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => {
                                                                                handleSelectWeekIndex(idx);
                                                                                setActiveTab('preview');
                                                                            }}
                                                                            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded border border-teal-200 cursor-pointer"
                                                                            title="Xem chi tiết kế hoạch bài dạy tuần này"
                                                                        >
                                                                            <Eye size={13} /> Xem
                                                                        </button>
                                                                        
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleDownloadWeekDoc(item)}
                                                                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-green-600 hover:bg-green-700 rounded shadow-xs cursor-pointer transition-colors"
                                                                            title={`Tải file Word (.docx) cho ${item.week}`}
                                                                        >
                                                                            <Download size={13} /> Tải {item.week} (.docx)
                                                                        </button>

                                                                        <button
                                                                            type="button"
                                                                            onClick={() => handleGenerateSingle(idx)}
                                                                            disabled={isBatchGenerating || loadingSingle}
                                                                            className="p-1.5 text-gray-400 hover:text-teal-700 rounded hover:bg-gray-100 cursor-pointer"
                                                                            title="Soạn lại tuần này"
                                                                        >
                                                                            <RefreshCw size={13} />
                                                                        </button>
                                                                    </>
                                                                ) : isGenerating ? (
                                                                    <div className="flex items-center gap-1.5 text-xs font-bold text-blue-700 px-3 py-1.5 bg-blue-50 rounded border border-blue-200">
                                                                        <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                                                                        <span>Đang soạn...</span>
                                                                    </div>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleGenerateSingle(idx)}
                                                                        disabled={isBatchGenerating || loadingSingle}
                                                                        className={`flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded border cursor-pointer transition-colors ${
                                                                            isError
                                                                                ? 'text-red-700 bg-red-50 hover:bg-red-100 border-red-300'
                                                                                : 'text-teal-700 bg-teal-50 hover:bg-teal-100 border-teal-300'
                                                                        }`}
                                                                    >
                                                                        <Play size={13} />{' '}
                                                                        {isError
                                                                            ? 'Thử soạn lại'
                                                                            : item.totalPeriodsInLesson && item.totalPeriodsInLesson > 1
                                                                                ? `Soạn Tiết ${item.periodIndexInLesson}`
                                                                                : 'Soạn tuần này'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}

                            {/* TAB 2: XEM CHI TIẾT GIÁO ÁN */}
                            {activeTab === 'preview' && (
                                <div className="flex-1 flex flex-col">
                                    <div className="p-3 border-b border-teal-100 flex flex-wrap items-center justify-between gap-2 bg-teal-50/50">
                                        <div className="text-xs font-bold text-teal-900 flex items-center gap-2">
                                            <span>Đang xem: {currentSelectedPlan?.week || '...'}</span>
                                            <span className="text-gray-500 font-normal">• {currentSelectedPlan?.lessonName}</span>
                                        </div>

                                        <div className="flex items-center gap-2">
                                            {/* Nút tuỳ chỉnh: Kiểu viền bảng theo mẫu chuẩn KHBD */}
                                            <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-teal-50 border border-teal-200 text-teal-900 shadow-2xs">
                                                <Layers size={13} className="text-teal-700" />
                                                <span>Chuẩn khung: Ẩn đường kẻ giữa các nội dung • Đóng viền ngang cuối trang Word (cách mép dưới 2.2cm)</span>
                                            </div>

                                            {currentSelectedPlan?.result && (
                                                <button 
                                                    type="button"
                                                    onClick={() => handleDownloadWeekDoc(currentSelectedPlan)} 
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-xs font-bold transition-colors shadow-xs cursor-pointer"
                                                >
                                                    <Download size={14} /> Tải {currentSelectedPlan.week} (.docx)
                                                </button>
                                            )}

                                            {completedCount > 0 && (
                                                <button
                                                    type="button"
                                                    onClick={handleDownloadAllZip}
                                                    disabled={isDownloadingZip}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 text-white rounded hover:bg-emerald-800 text-xs font-bold transition-colors shadow-xs cursor-pointer"
                                                    title="Tải về tất cả các tuần đã soạn trong 1 file nén .ZIP"
                                                >
                                                    <Archive size={14} />{' '}
                                                    {isDownloadingZip
                                                        ? `Đang nén (${zipProgress})...`
                                                        : `Tải tất cả (${completedCount} tuần .ZIP)`}
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="p-4 md:p-8 overflow-auto flex-1 bg-white/95">
                                        {!currentSelectedPlan?.result ? (
                                            <div className="h-full min-h-[300px] flex flex-col items-center justify-center text-gray-400">
                                                <FileText size={56} className="mb-3 text-gray-300" />
                                                <p className="font-semibold text-gray-600">
                                                    {weekPlans.length === 0 
                                                        ? 'Chưa có dữ liệu Phân phối chương trình để xem.' 
                                                        : currentSelectedPlan?.status === 'generating'
                                                            ? `Đang soạn ${currentSelectedPlan?.week}... Vui lòng đợi trong giây lát.`
                                                            : 'Tuần này chưa được soạn.'
                                                    }
                                                </p>
                                                {weekPlans.length > 0 && currentSelectedPlan?.status !== 'generating' && (
                                                    <button
                                                        type="button"
                                                        onClick={() => handleGenerateSingle(selectedWeekIndex)}
                                                        disabled={loadingSingle || isBatchGenerating}
                                                        className="mt-3 px-4 py-2 bg-teal-600 text-white rounded-lg text-xs font-bold hover:bg-teal-700 cursor-pointer flex items-center gap-1.5 shadow"
                                                    >
                                                        <Play size={14} /> Soạn ngay {currentSelectedPlan?.week || ''}
                                                    </button>
                                                )}
                                            </div>
                                        ) : (
                                            <LessonPreview 
                                                id="lesson-preview-content" 
                                                result={currentSelectedPlan.result} 
                                                inputData={{
                                                    ...inputData,
                                                    week: currentSelectedPlan.week,
                                                    lessonName: currentSelectedPlan.lessonName,
                                                    baseLessonName: currentSelectedPlan.baseLessonName,
                                                    periods: '1',
                                                    periodIndexInLesson: currentSelectedPlan.periodIndexInLesson,
                                                    totalPeriodsInLesson: currentSelectedPlan.totalPeriodsInLesson,
                                                    pedagogicalNote: currentSelectedPlan.pedagogicalNote
                                                }} 
                                                hideTableBorders={hideTableBorders}
                                            />
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
                ) : (
                    <TeachingPlanTab 
                        apiKey={getEffectiveApiKey()}
                        initialSchoolName={inputData.schoolName}
                        initialTeacherName={inputData.teacherName}
                    />
                )}
            </div>
        </div>
    );
};

export default App;
