import React, { useState, useMemo } from 'react';
import { 
    Calendar, FileUp, Download, Sparkles, CheckCircle2, 
    AlertTriangle, Layers, Trash2, Plus, 
    FileText, Filter, Info, BookOpen, X, Check, Lock,
    Eye, Archive, RefreshCw, Play, ChevronLeft, ChevronRight
} from 'lucide-react';
import JSZip from 'jszip';
import { KhdhPlan, KhdhRow, KhdhSubjectData } from '../types';
import { 
    extractMultiplePpcts, 
    parseKhdhTemplateFile, 
    matchAndBuildKhdhPlan,
    getWeekDateRange,
    formatLessonNameWithPeriod,
    parseWeekNumbersFromText
} from '../services/khdhService';
import { 
    exportKhdhToWord, 
    generateKhdhDocxBlob, 
    exportAllKhdhToSingleWord 
} from '../utils/khdhWordExport';

interface TeachingPlanTabProps {
    apiKey: string;
    initialSchoolName?: string;
    initialTeacherName?: string;
}

export const TeachingPlanTab: React.FC<TeachingPlanTabProps> = ({
    apiKey,
    initialSchoolName = 'Trường Tiểu học Mỹ An',
    initialTeacherName = 'GV: Lê Văn Phi'
}) => {
    // BƯỚC 1: File PPCT (Khởi tạo rỗng hoàn toàn, không nạp dữ liệu tĩnh)
    const [ppctFiles, setPpctFiles] = useState<File[]>([]);
    const [isExtractingPpct, setIsExtractingPpct] = useState<boolean>(false);
    const [extractedPpcts, setExtractedPpcts] = useState<KhdhSubjectData[]>([]);
    const [ppctStatusMessage, setPpctStatusMessage] = useState<string>('');

    // BƯỚC 2: File Mẫu KHDH của người dùng (Khởi tạo rỗng hoàn toàn)
    const [templateFile, setTemplateFile] = useState<File | null>(null);
    const [isParsingTemplate, setIsParsingTemplate] = useState<boolean>(false);
    const [parsedTemplateRows, setParsedTemplateRows] = useState<Partial<KhdhRow>[]>([]);

    // BƯỚC 3: Lựa chọn tuần ('all' = Tất cả các tuần, hoặc số tuần cụ thể 1..35)
    const [selectedWeekOption, setSelectedWeekOption] = useState<'all' | number>('all');
    const [targetWeek, setTargetWeek] = useState<number>(1);
    const [dateRange, setDateRange] = useState<string>(() => getWeekDateRange(1).dateRange);

    // Thông tin văn bản theo Nghị định 30
    const [schoolName, setSchoolName] = useState<string>(initialSchoolName);
    const [teacherName, setTeacherName] = useState<string>(initialTeacherName);
    const [academicYear, setAcademicYear] = useState<string>('NĂM HỌC 2026 - 2027');
    const [layoutOrientation, setLayoutOrientation] = useState<'portrait' | 'landscape'>('portrait');

    // Kết quả Kế hoạch dạy học: Hỗ trợ lưu trữ trọn bộ tất cả các tuần và tuần đang xem chi tiết
    const [allGeneratedPlans, setAllGeneratedPlans] = useState<KhdhPlan[]>([]);
    const [generatedPlan, setGeneratedPlan] = useState<KhdhPlan | null>(null);
    const [activeRightTab, setActiveRightTab] = useState<'list' | 'preview'>('list');

    const [isGeneratingPlan, setIsGeneratingPlan] = useState<boolean>(false);
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [successMessage, setSuccessMessage] = useState<string>('');

    // Bộ lọc hiển thị kết quả ở tab Xem chi tiết
    const [selectedClassFilter, setSelectedClassFilter] = useState<string>('all');
    const [selectedSubjectFilter, setSelectedSubjectFilter] = useState<string>('all');

    // Danh sách các tuần có trong PPCT đã tải lên (hoặc mặc định 1..35)
    const detectedWeeksFromPpct = useMemo<number[]>(() => {
        if (extractedPpcts.length === 0) {
            return Array.from({ length: 35 }, (_, i) => i + 1);
        }
        const weekSet = new Set<number>();
        extractedPpcts.forEach(subj => {
            (subj.lessons || []).forEach(lesson => {
                const parsedWeeks = parseWeekNumbersFromText(lesson.week || lesson.weekNumber);
                parsedWeeks.forEach(wNum => {
                    if (!isNaN(wNum) && wNum >= 1 && wNum <= 52) {
                        weekSet.add(wNum);
                    }
                });
            });
        });
        if (weekSet.size === 0) {
            return Array.from({ length: 35 }, (_, i) => i + 1);
        }
        // Nếu người dùng tải lên cả môn 12 tiết, 18 tiết và môn 35 tiết, đảm bảo danh sách tuần đầy đủ 1..maxWeek
        const maxWeek = Math.max(...Array.from(weekSet), 35);
        for (let w = 1; w <= Math.min(maxWeek, 35); w++) {
            weekSet.add(w);
        }
        return Array.from(weekSet).sort((a, b) => a - b);
    }, [extractedPpcts]);

    // Danh sách tuần chuẩn từ 1 đến 35 (kết hợp với các tuần trong PPCT nếu có tuần > 35)
    const weeksDropdownList = useMemo<number[]>(() => {
        const base = new Set<number>(Array.from({ length: 35 }, (_, i) => i + 1));
        detectedWeeksFromPpct.forEach(w => base.add(w));
        return Array.from(base).sort((a, b) => a - b);
    }, [detectedWeeksFromPpct]);

    // Tự động tính khoảng ngày khi đổi lựa chọn tuần
    const handleWeekOptionChange = (val: string) => {
        if (val === 'all') {
            setSelectedWeekOption('all');
        } else {
            const num = parseInt(val, 10) || 1;
            setSelectedWeekOption(num);
            setTargetWeek(num);
            const calculated = getWeekDateRange(num);
            setDateRange(calculated.dateRange);

            // Nếu tuần này đã được tạo trước đó trong allGeneratedPlans thì hiển thị luôn
            const existing = allGeneratedPlans.find(p => Number(p.weekNumber) === num);
            if (existing) {
                setGeneratedPlan(existing);
            }
        }
    };

    // Đồng bộ chỉnh sửa trên generatedPlan vào danh sách allGeneratedPlans
    const updateCurrentPlanAndSync = (updater: (prev: KhdhPlan) => KhdhPlan) => {
        setGeneratedPlan(prev => {
            if (!prev) return null;
            const updated = updater(prev);
            setAllGeneratedPlans(list => {
                const exists = list.some(item => Number(item.weekNumber) === Number(updated.weekNumber));
                if (!exists) return [...list, updated].sort((a, b) => Number(a.weekNumber) - Number(b.weekNumber));
                return list.map(item => Number(item.weekNumber) === Number(updated.weekNumber) ? updated : item);
            });
            return updated;
        });
    };

    // --- BƯỚC 1: Xử lý tệp PPCT ---
    const handlePpctFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files) {
            const newFiles = Array.from(e.target.files) as File[];
            const valid = newFiles.filter(f => f.size <= 100 * 1024 * 1024);
            setPpctFiles(prev => [...prev, ...valid]);
            setErrorMessage('');
            e.target.value = '';
        }
    };

    const removePpctFile = (index: number) => {
        setPpctFiles(prev => prev.filter((_, i) => i !== index));
    };

    const handleExtractAllPpcts = async () => {
        if (ppctFiles.length === 0) {
            setErrorMessage('Vui lòng chọn ít nhất một file Phân phối chương trình (PDF hoặc ảnh).');
            return;
        }

        setIsExtractingPpct(true);
        setErrorMessage('');
        setPpctStatusMessage('Đang đọc dữ liệu từ các file PPCT...');

        try {
            const data = await extractMultiplePpcts(ppctFiles, apiKey);
            setExtractedPpcts(data);
            const totalLessons = data.reduce((acc, cur) => acc + cur.lessons.length, 0);
            setPpctStatusMessage(`Đã đọc thành công ${data.length} môn học (${totalLessons} bài học). Sẵn sàng chuyển sang Bước 2.`);
            setSuccessMessage(`Đã phân tích xong dữ liệu từ ${data.length} môn học.`);
        } catch (err: any) {
            console.warn(err);
            setErrorMessage(err.message || 'Lỗi khi phân tích các file PPCT.');
            setPpctStatusMessage('');
        } finally {
            setIsExtractingPpct(false);
        }
    };

    // --- BƯỚC 2: Xử lý Mẫu KHDH của người dùng ---
    const handleTemplateFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            setTemplateFile(file);
            setErrorMessage('');

            setIsParsingTemplate(true);
            try {
                const parsed = await parseKhdhTemplateFile(file, apiKey);
                if (parsed.rawRows && parsed.rawRows.length > 0) {
                    setParsedTemplateRows(parsed.rawRows);
                    if (parsed.weekNumber) {
                        const parsedNum = parseInt(String(parsed.weekNumber).replace(/\D/g, ''), 10);
                        if (parsedNum) {
                            setTargetWeek(parsedNum);
                            setDateRange(parsed.dateRange || getWeekDateRange(parsedNum).dateRange);
                        }
                    }
                    if (parsed.layoutOrientation) setLayoutOrientation(parsed.layoutOrientation);
                    setSuccessMessage(`Đã đọc thành công khung mẫu KHDH gồm ${parsed.rawRows.length} tiết từ file "${file.name}". Sẵn sàng sang Bước 3.`);
                } else {
                    setErrorMessage('Không nhận diện được bảng biểu trong file mẫu đã tải lên. Vui lòng kiểm tra lại file Word/PDF/Ảnh.');
                }
            } catch (err: any) {
                console.warn(err);
                setErrorMessage('Lỗi khi đọc file mẫu: ' + (err.message || 'Không thể trích xuất'));
            } finally {
                setIsParsingTemplate(false);
            }
        }
    };

    // --- BƯỚC 3: Tạo Kế hoạch dạy học cho 1 tuần cụ thể ---
    const handleGenerateSingleWeekPlan = (weekNum: number, switchToPreview: boolean = true) => {
        if (extractedPpcts.length === 0) {
            setErrorMessage('Vui lòng tải lên và phân tích các file PPCT ở Bước 1.');
            return;
        }
        if (parsedTemplateRows.length === 0) {
            setErrorMessage('Vui lòng tải lên file Mẫu Kế hoạch dạy học ở Bước 2.');
            return;
        }

        setIsGeneratingPlan(true);
        setErrorMessage('');

        try {
            const weekDateInfo = getWeekDateRange(weekNum);
            const customDateRange = (selectedWeekOption !== 'all' && targetWeek === weekNum && dateRange.trim())
                ? dateRange.trim()
                : weekDateInfo.dateRange;

            const plan = matchAndBuildKhdhPlan(parsedTemplateRows, extractedPpcts, {
                targetWeek: weekNum,
                dateRange: customDateRange,
                schoolName,
                teacherName,
                academicYear,
                layoutOrientation
            });

            setGeneratedPlan(plan);
            setTargetWeek(weekNum);
            setAllGeneratedPlans(prev => {
                const exists = prev.some(p => Number(p.weekNumber) === weekNum);
                if (!exists) {
                    return [...prev, plan].sort((a, b) => Number(a.weekNumber) - Number(b.weekNumber));
                }
                return prev.map(p => Number(p.weekNumber) === weekNum ? plan : p);
            });

            if (switchToPreview) {
                setActiveRightTab('preview');
            }

            const notesCount = plan.rows.filter(r => r.notes && r.notes.trim().length > 0).length;
            setSuccessMessage(`Đã soạn xong Kế hoạch dạy học Tuần ${weekNum} gồm ${plan.rows.length} tiết dạy (${notesCount} tiết có ghi chú từ PPCT).`);
        } catch (err: any) {
            console.warn(err);
            setErrorMessage(err.message || 'Lỗi khi tạo Kế hoạch dạy học.');
        } finally {
            setIsGeneratingPlan(false);
        }
    };

    // --- BƯỚC 3: Tạo Kế hoạch dạy học cho TẤT CẢ CÁC TUẦN ---
    const handleGenerateAllWeeksPlans = () => {
        if (extractedPpcts.length === 0) {
            setErrorMessage('Vui lòng tải lên và phân tích các file PPCT ở Bước 1.');
            return;
        }
        if (parsedTemplateRows.length === 0) {
            setErrorMessage('Vui lòng tải lên file Mẫu Kế hoạch dạy học ở Bước 2.');
            return;
        }

        setIsGeneratingPlan(true);
        setErrorMessage('');

        try {
            const weeksToBuild = detectedWeeksFromPpct.length > 0
                ? detectedWeeksFromPpct
                : Array.from({ length: 35 }, (_, i) => i + 1);

            const builtPlans: KhdhPlan[] = weeksToBuild.map(wNum => {
                const weekDateInfo = getWeekDateRange(wNum);
                return matchAndBuildKhdhPlan(parsedTemplateRows, extractedPpcts, {
                    targetWeek: wNum,
                    dateRange: weekDateInfo.dateRange,
                    schoolName,
                    teacherName,
                    academicYear,
                    layoutOrientation
                });
            });

            setAllGeneratedPlans(builtPlans);
            if (builtPlans.length > 0) {
                setGeneratedPlan(builtPlans[0]);
                setTargetWeek(Number(builtPlans[0].weekNumber));
            }
            setActiveRightTab('list');

            const totalPeriodsAllWeeks = builtPlans.reduce((acc, p) => acc + p.rows.length, 0);
            const totalNotesAllWeeks = builtPlans.reduce(
                (acc, p) => acc + p.rows.filter(r => r.notes && r.notes.trim().length > 0).length,
                0
            );

            setSuccessMessage(
                `Đã soạn hoàn tất Kế hoạch dạy học của TẤT CẢ ${builtPlans.length} TUẦN (Tổng cộng ${totalPeriodsAllWeeks} tiết dạy • ${totalNotesAllWeeks} tiết có ghi chú tích hợp từ PPCT).`
            );
        } catch (err: any) {
            console.warn(err);
            setErrorMessage(err.message || 'Lỗi khi soạn Kế hoạch dạy học cho tất cả các tuần.');
        } finally {
            setIsGeneratingPlan(false);
        }
    };

    // Nút hành động chính ở Bước 3
    const handleMainGenerateAction = () => {
        if (selectedWeekOption === 'all') {
            handleGenerateAllWeeksPlans();
        } else {
            handleGenerateSingleWeekPlan(selectedWeekOption, true);
        }
    };

    // Tải trọn bộ các tuần đã soạn dưới dạng file nén .ZIP (mỗi tuần 1 file Word .docx riêng biệt giống KHBD)
    const handleDownloadAllWeeksZip = async () => {
        if (allGeneratedPlans.length === 0) {
            setErrorMessage('Chưa có tuần nào được soạn để tải về.');
            return;
        }

        try {
            const zip = new JSZip();
            for (const plan of allGeneratedPlans) {
                const weekNum = String(plan.weekNumber).replace(/\D/g, '') || '1';
                const docxBlob = await generateKhdhDocxBlob(plan);
                const fileName = `Ke_Hoach_Day_Hoc_Tuan_${weekNum}.docx`;
                zip.file(fileName, docxBlob);
            }

            const content = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(content);
            const link = document.createElement('a');
            link.href = url;
            link.download = `Ke_Hoach_Day_Hoc_${allGeneratedPlans.length}_Tuan.zip`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err: any) {
            console.warn('Lỗi khi nén ZIP KHDH:', err);
            setErrorMessage('Có lỗi xảy ra khi nén file ZIP: ' + err.message);
        }
    };

    // Tải tất cả các tuần trong 1 file Word (.docx) duy nhất (có ngắt trang giữa các tuần)
    const handleDownloadAllWeeksSingleWord = async () => {
        if (allGeneratedPlans.length === 0) {
            setErrorMessage('Chưa có tuần nào được soạn để tải về.');
            return;
        }
        await exportAllKhdhToSingleWord(allGeneratedPlans);
    };

    // Đổi nhanh (T1) <-> (T2)
    const togglePeriodTag = (rowId: string) => {
        if (!generatedPlan) return;
        updateCurrentPlanAndSync(prev => ({
            ...prev,
            rows: prev.rows.map(r => {
                if (r.id !== rowId) return r;
                let current = r.lessonName;
                if (current.includes('(T1)')) {
                    current = current.replace('(T1)', '(T2)');
                } else if (current.includes('(T2)')) {
                    current = current.replace('(T2)', '(T1)');
                } else {
                    current = formatLessonNameWithPeriod(current, 2);
                }
                return { ...r, lessonName: current };
            })
        }));
    };

    // Inline Editing (tự động tra cứu lại bài học từ PPCT nếu người dùng sửa cột MÔN hoặc LỚP)
    const handleUpdateRow = (id: string, field: keyof KhdhRow, value: any) => {
        if (!generatedPlan) return;
        updateCurrentPlanAndSync(prev => {
            const updatedRows = prev.rows.map(r => r.id === id ? { ...r, [field]: value } : r);
            if ((field === 'subject' || field === 'className') && extractedPpcts.length > 0) {
                try {
                    const reMatched = matchAndBuildKhdhPlan(
                        updatedRows.map(r => r.id === id ? { ...r, lessonName: '', notes: '' } : r),
                        extractedPpcts,
                        {
                            targetWeek: prev.weekNumber,
                            dateRange: prev.dateRange,
                            schoolName: prev.schoolName,
                            teacherName: prev.teacherName,
                            academicYear: prev.academicYear,
                            layoutOrientation: prev.layoutOrientation
                        }
                    );
                    const matchedTarget = reMatched.rows.find((_, idx) => updatedRows[idx]?.id === id);
                    if (matchedTarget && matchedTarget.lessonName) {
                        return {
                            ...prev,
                            rows: updatedRows.map(r =>
                                r.id === id
                                    ? { ...r, lessonName: matchedTarget.lessonName, notes: matchedTarget.notes }
                                    : r
                            )
                        };
                    }
                } catch {}
            }
            return {
                ...prev,
                rows: updatedRows
            };
        });
    };

    const handleDeleteRow = (id: string) => {
        if (!generatedPlan) return;
        updateCurrentPlanAndSync(prev => ({
            ...prev,
            rows: prev.rows.filter(r => r.id !== id)
        }));
    };

    const handleAddNewRow = () => {
        if (!generatedPlan) return;
        const currentWeekNum = Number(generatedPlan.weekNumber) || targetWeek;
        const newId = `khdh-custom-${Date.now()}`;
        const calculated = getWeekDateRange(currentWeekNum);
        const newRow: KhdhRow = {
            id: newId,
            week: `Tuần ${currentWeekNum}`,
            dayAndDate: `Hai ${calculated.dayDates['Hai'] || ''}`,
            session: 'Sáng',
            period: 1,
            className: '',
            subject: '',
            lessonName: '',
            notes: ''
        };
        updateCurrentPlanAndSync(prev => ({
            ...prev,
            rows: [...prev.rows, newRow]
        }));
    };

    // Xuất file Word (.doc) theo Nghị định 30 cho tuần đang xem
    const handleExportWord = () => {
        if (!generatedPlan || generatedPlan.rows.length === 0) {
            alert('Chưa có dữ liệu Kế hoạch dạy học để xuất.');
            return;
        }
        exportKhdhToWord(generatedPlan);
    };

    // Danh sách lớp và môn để lọc
    const uniqueClasses = Array.from(new Set((generatedPlan?.rows || []).map(r => r.className))).filter(Boolean);
    const uniqueSubjects = Array.from(new Set((generatedPlan?.rows || []).map(r => r.subject))).filter(Boolean);

    // Lọc danh sách hàng
    const filteredRows = (generatedPlan?.rows || []).filter(row => {
        const matchClass = selectedClassFilter === 'all' || row.className === selectedClassFilter;
        const matchSubj = selectedSubjectFilter === 'all' || row.subject.toLowerCase() === selectedSubjectFilter.toLowerCase();
        return matchClass && matchSubj;
    });

    const totalNotesInPlan = (generatedPlan?.rows || []).filter(r => r.notes && r.notes.trim().length > 0).length;

    // Kiểm tra trạng thái từng bước (Progressive Disclosure)
    const isStep1Completed = extractedPpcts.length > 0;
    const isStep2Completed = parsedTemplateRows.length > 0;

    const totalWeeksCount = detectedWeeksFromPpct.length;
    const completedWeeksCount = allGeneratedPlans.length;
    const totalIntegratedWeeksInAll = allGeneratedPlans.filter(
        p => p.rows.some(r => r.notes && r.notes.trim().length > 0)
    ).length;

    return (
        <div className="space-y-6">

            {/* Layout 2 cột: Cột trái Nhập liệu từng bước - Cột phải Danh sách các tuần & Bảng xem trước */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                {/* CỘT TRÁI: TIẾN TRÌNH 3 BƯỚC LINH HOẠT */}
                <div className="lg:col-span-5 space-y-5">
                    <div className="bg-white/95 backdrop-blur-md p-4 md:p-5 rounded-xl shadow-md border border-teal-100 space-y-5">
                        
                        {/* BƯỚC 1: TẢI LÊN CÁC FILE PHÂN PHỐI CHƯƠNG TRÌNH */}
                        <div className="space-y-3">
                            <h3 className="font-bold text-gray-800 text-xs uppercase flex items-center justify-between border-b pb-2">
                                <span className="flex items-center gap-1.5">
                                    <span className="w-5 h-5 rounded-full bg-teal-700 text-white flex items-center justify-center text-[11px] font-bold">1</span>
                                    BƯỚC 1: TẢI LÊN CÁC FILE PPCT
                                </span>
                                {isStep1Completed && (
                                    <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded-full border border-emerald-300 flex items-center gap-1">
                                        <Check size={12} /> Đã nhận diện {extractedPpcts.length} môn ({totalWeeksCount} tuần)
                                    </span>
                                )}
                            </h3>

                            <div className="text-[11px] text-gray-600 bg-teal-50/70 p-2.5 rounded-lg border border-teal-200 leading-relaxed">
                                💡 Tải lên <b>các file Phân phối chương trình</b> (PDF hoặc ảnh) của các môn học. AI sẽ phân tích tên môn, tuần học, số tiết (Tiết 1, Tiết 2) và nội dung ghi chú.
                            </div>

                            {/* Dropzone Upload PPCT */}
                            <div className="p-3 border-2 border-dashed border-teal-300 rounded-lg bg-teal-50/60 text-center hover:bg-teal-100/50 transition-colors">
                                <input 
                                    type="file" 
                                    accept=".pdf,image/*" 
                                    multiple 
                                    onChange={handlePpctFilesChange} 
                                    className="hidden" 
                                    id="multi-ppct-upload" 
                                />
                                <label htmlFor="multi-ppct-upload" className="cursor-pointer block">
                                    <FileUp size={22} className="mx-auto text-teal-600 mb-1" />
                                    <span className="block text-xs font-bold text-teal-950">
                                        {ppctFiles.length > 0 ? `Đã chọn ${ppctFiles.length} file PPCT (Bấm để thêm file)` : 'Chọn các file PPCT (PDF hoặc Ảnh)'}
                                    </span>
                                    <span className="block text-[10px] text-teal-700 mt-0.5">
                                        Hỗ trợ nhiều môn học cùng lúc • PDF hoặc ảnh chụp
                                    </span>
                                </label>
                            </div>

                            {/* Danh sách file PPCT đã chọn */}
                            {ppctFiles.length > 0 && (
                                <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                                    {ppctFiles.map((file, idx) => (
                                        <div key={idx} className="flex items-center justify-between p-2 bg-slate-50 border border-slate-200 rounded-md text-xs">
                                            <div className="flex items-center gap-1.5 min-w-0">
                                                <FileText size={14} className="text-teal-600 shrink-0" />
                                                <span className="truncate font-medium text-slate-800" title={file.name}>{file.name}</span>
                                                <span className="text-[10px] text-slate-400 shrink-0">({(file.size / 1024).toFixed(0)} KB)</span>
                                            </div>
                                            <button 
                                                type="button" 
                                                onClick={() => removePpctFile(idx)}
                                                className="text-red-500 hover:text-red-700 p-1 hover:bg-red-50 rounded cursor-pointer shrink-0"
                                                title="Xoá file này"
                                            >
                                                <X size={14} />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Nút bấm phân tích PPCT */}
                            {ppctFiles.length > 0 && (
                                <button
                                    type="button"
                                    onClick={handleExtractAllPpcts}
                                    disabled={isExtractingPpct}
                                    className={`w-full py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-xs ${isExtractingPpct ? 'bg-blue-600 text-white' : 'bg-teal-700 hover:bg-teal-800 text-white'}`}
                                >
                                    {isExtractingPpct ? (
                                        <>
                                            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                            <span>Đang đọc dữ liệu từ các file PPCT...</span>
                                        </>
                                    ) : (
                                        <>
                                            <Sparkles size={14} /> Phân tích dữ liệu {ppctFiles.length} file PPCT
                                        </>
                                    )}
                                </button>
                            )}

                            {ppctStatusMessage && (
                                <div className="p-2 bg-blue-50 border border-blue-200 rounded text-[11px] text-blue-900 flex items-center gap-1.5">
                                    <Info size={14} className="text-blue-600 shrink-0" />
                                    <span>{ppctStatusMessage}</span>
                                </div>
                            )}

                            {/* Thống kê các môn học đã trích xuất */}
                            {isStep1Completed && (
                                <div className="p-2.5 bg-emerald-50 border border-emerald-300 rounded-lg space-y-1">
                                    <div className="text-xs font-bold text-emerald-950 flex items-center justify-between">
                                        <span>Dữ liệu PPCT đã trích xuất:</span>
                                        <span className="text-[10px] bg-emerald-200 text-emerald-900 px-2 py-0.5 rounded font-bold">
                                            {extractedPpcts.length} môn • {totalWeeksCount} tuần
                                        </span>
                                    </div>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {extractedPpcts.map((subj, idx) => (
                                            <span key={idx} className="text-[10px] bg-white border border-emerald-300 text-emerald-900 px-2 py-0.5 rounded-md font-medium shadow-2xs">
                                                {subj.subject} {subj.grade ? `(${subj.grade})` : ''} • {subj.lessons.length} tiết
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* BƯỚC 2: TẢI LÊN MẪU KHDH CỦA THẦY/CÔ */}
                        <div className="pt-3 border-t border-gray-200 space-y-3">
                            <h3 className="font-bold text-gray-800 text-xs uppercase flex items-center justify-between border-b pb-2">
                                <span className="flex items-center gap-1.5">
                                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${isStep1Completed ? 'bg-teal-700 text-white' : 'bg-gray-300 text-gray-600'}`}>2</span>
                                    BƯỚC 2: TẢI LÊN MẪU KHDH CỦA THẦY/CÔ
                                </span>
                                {isStep2Completed && (
                                    <span className="text-[10px] bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded-full border border-emerald-300 flex items-center gap-1">
                                        <Check size={12} /> Đã có {parsedTemplateRows.length} tiết/tuần
                                    </span>
                                )}
                            </h3>

                            {!isStep1Completed ? (
                                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500 flex items-center gap-2">
                                    <Lock size={15} className="text-gray-400 shrink-0" />
                                    <span>Vui lòng tải lên và phân tích file PPCT ở Bước 1 để mở Bước 2.</span>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className="text-[11px] text-gray-600 bg-amber-50/70 p-2.5 rounded-lg border border-amber-200 leading-relaxed">
                                        📌 <b>Tải lên file Mẫu Kế hoạch dạy học</b> của Thầy/Cô (.docx, .doc, .pdf hoặc ảnh). Mẫu đã điền sẵn các cột: <i>Thứ/ngày, Buổi, Tiết, LỚP, MÔN</i> — chỉ còn thiếu <b>Tên bài dạy</b> và <b>Ghi chú</b>.
                                    </div>

                                    {/* Upload file mẫu KHDH */}
                                    <div className="p-3 border-2 border-dashed border-amber-300 rounded-lg bg-amber-50/60 text-center hover:bg-amber-100/50 transition-colors">
                                        <input 
                                            type="file" 
                                            accept=".docx,.doc,.pdf,image/*" 
                                            onChange={handleTemplateFileChange} 
                                            className="hidden" 
                                            id="template-upload" 
                                        />
                                        <label htmlFor="template-upload" className="cursor-pointer block">
                                            <FileUp size={22} className="mx-auto text-amber-700 mb-1" />
                                            <span className="block text-xs font-bold text-amber-950">
                                                {templateFile ? `File mẫu: ${templateFile.name}` : 'Tải lên Mẫu KHDH (.docx, .doc, .pdf, ảnh)'}
                                            </span>
                                            <span className="block text-[10px] text-amber-800 mt-0.5">
                                                {templateFile ? 'Nhấp để thay file mẫu khác' : 'Chỉ còn thiếu cột Tên bài dạy và Ghi chú'}
                                            </span>
                                        </label>
                                    </div>

                                    {isParsingTemplate && (
                                        <div className="p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800 flex items-center gap-2 animate-pulse">
                                            <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin shrink-0" />
                                            <span>Đang đọc cấu trúc các hàng trong file mẫu...</span>
                                        </div>
                                    )}

                                    {isStep2Completed && (
                                        <div className="p-2 bg-emerald-50 border border-emerald-300 rounded text-xs text-emerald-900 font-medium">
                                            ✓ Đã đọc được khung thời khóa biểu gồm <b>{parsedTemplateRows.length} tiết dạy/tuần</b>.
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* BƯỚC 3: LỰA CHỌN TUẦN (CÓ TÙY CHỌN "TẤT CẢ") VÀ TẠO KẾ HOẠCH */}
                        <div className="pt-3 border-t border-gray-200 space-y-3">
                            <h3 className="font-bold text-gray-800 text-xs uppercase flex items-center justify-between border-b pb-2">
                                <span className="flex items-center gap-1.5">
                                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${isStep2Completed ? 'bg-emerald-700 text-white' : 'bg-gray-300 text-gray-600'}`}>3</span>
                                    BƯỚC 3: LỰA CHỌN TUẦN VÀ TẠO KẾ HOẠCH
                                </span>
                                {isStep2Completed && (
                                    <span className="text-xs bg-emerald-600 text-white font-bold px-2.5 py-0.5 rounded-full">
                                        {selectedWeekOption === 'all' ? `Tất cả (${totalWeeksCount} tuần)` : `Tuần ${selectedWeekOption}`}
                                    </span>
                                )}
                            </h3>

                            {!isStep2Completed ? (
                                <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-500 flex items-center gap-2">
                                    <Lock size={15} className="text-gray-400 shrink-0" />
                                    <span>Vui lòng tải lên Mẫu KHDH ở Bước 2 để mở Bước 3.</span>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="text-[11px] text-gray-600 bg-emerald-50/70 p-2.5 rounded-lg border border-emerald-200 leading-relaxed">
                                        🎯 Chọn <b>Tất cả các tuần</b> để hệ thống tự động soạn kế hoạch dạy học của toàn bộ các tuần theo PPCT (giống Kế hoạch bài dạy), hoặc chọn từng tuần riêng lẻ.
                                    </div>

                                    {/* Bộ chọn Tuần học (Có lựa chọn "Tất cả" ở đầu danh sách) */}
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                Lựa chọn Tuần học:
                                            </label>
                                            <select
                                                value={String(selectedWeekOption)}
                                                onChange={(e) => handleWeekOptionChange(e.target.value)}
                                                className="w-full p-2 border border-teal-400 rounded-lg text-xs font-bold text-teal-950 bg-white focus:ring-2 focus:ring-teal-500 outline-none shadow-2xs"
                                            >
                                                <option value="all">
                                                    Tất cả các tuần ({totalWeeksCount} tuần theo PPCT)
                                                </option>
                                                {weeksDropdownList.map((w) => (
                                                    <option key={w} value={String(w)}>
                                                        Tuần {w}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>

                                        <div>
                                            <label className="block text-[11px] font-bold text-gray-700 mb-1">
                                                Khoảng ngày trong tuần:
                                            </label>
                                            {selectedWeekOption === 'all' ? (
                                                <div className="w-full p-2 border border-teal-200 bg-teal-50/60 rounded-lg text-[11px] font-semibold text-teal-900 truncate" title="Tự động cập nhật ngày tương ứng cho từng tuần từ Tuần 1 đến Tuần 35">
                                                    Tự động tính theo từng tuần (1 - {totalWeeksCount})
                                                </div>
                                            ) : (
                                                <input 
                                                    type="text" 
                                                    className="w-full p-2 border rounded-lg text-xs outline-none focus:border-teal-500 font-medium" 
                                                    value={dateRange} 
                                                    placeholder="(Từ ngày ... đến ...)"
                                                    onChange={(e) => setDateRange(e.target.value)} 
                                                />
                                            )}
                                        </div>
                                    </div>

                                    {/* THÔNG TIN VĂN BẢN (NGHỊ ĐỊNH 30) */}
                                    <div className="pt-2 border-t border-gray-100 space-y-2.5">
                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="block text-[11px] font-bold text-gray-700 mb-1">Đơn vị / Trường học</label>
                                                <input 
                                                    type="text" 
                                                    className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                                    value={schoolName} 
                                                    onChange={(e) => setSchoolName(e.target.value)} 
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[11px] font-bold text-gray-700 mb-1">Giáo viên thực hiện</label>
                                                <input 
                                                    type="text" 
                                                    className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                                    value={teacherName} 
                                                    onChange={(e) => setTeacherName(e.target.value)} 
                                                />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-2">
                                            <div>
                                                <label className="block text-[11px] font-bold text-gray-700 mb-1">Năm học</label>
                                                <input 
                                                    type="text" 
                                                    className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium" 
                                                    value={academicYear} 
                                                    onChange={(e) => setAcademicYear(e.target.value)} 
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[11px] font-bold text-gray-700 mb-1">Khổ giấy xuất Word</label>
                                                <select
                                                    value={layoutOrientation}
                                                    onChange={(e) => setLayoutOrientation(e.target.value as any)}
                                                    className="w-full p-2 border rounded-md text-xs outline-none focus:border-teal-500 font-medium bg-white"
                                                >
                                                    <option value="portrait">Khổ đứng (A4 Portrait - 7 cột)</option>
                                                    <option value="landscape">Khổ ngang (A4 Landscape)</option>
                                                </select>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Nút hành động tạo kế hoạch (Giống bên Kế hoạch bài dạy) */}
                                    <div className="pt-2 space-y-2">
                                        <button
                                            type="button"
                                            onClick={handleMainGenerateAction}
                                            disabled={isGeneratingPlan}
                                            className={`w-full py-3 px-4 rounded-xl flex items-center justify-center gap-2 font-bold text-white shadow-md transition-all cursor-pointer ${isGeneratingPlan ? 'bg-amber-600' : 'bg-teal-700 hover:bg-teal-800 active:scale-[0.99]'}`}
                                        >
                                            <Sparkles size={18} />
                                            {isGeneratingPlan 
                                                ? 'Đang tạo Kế hoạch dạy học...' 
                                                : selectedWeekOption === 'all'
                                                    ? `SOẠN TOÀN BỘ ${totalWeeksCount} TUẦN THEO PPCT`
                                                    : `TẠO KẾ HOẠCH DẠY HỌC TUẦN ${selectedWeekOption}`
                                            }
                                        </button>

                                        {selectedWeekOption !== 'all' && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setSelectedWeekOption('all');
                                                    handleGenerateAllWeeksPlans();
                                                }}
                                                disabled={isGeneratingPlan}
                                                className="w-full py-2 px-3 rounded-lg border border-teal-600 bg-teal-50 text-teal-800 hover:bg-teal-100 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                            >
                                                <Layers size={14} />
                                                Soạn luôn tất cả {totalWeeksCount} tuần theo PPCT
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        {errorMessage && (
                            <div className="p-3 bg-red-50 text-red-600 text-xs rounded-md border border-red-200 flex items-start gap-2">
                                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                                <div>{errorMessage}</div>
                            </div>
                        )}

                        {successMessage && (
                            <div className="p-3 bg-emerald-50 text-emerald-800 text-xs rounded-md border border-emerald-200 flex items-start gap-2">
                                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600" />
                                <div>{successMessage}</div>
                            </div>
                        )}
                    </div>
                </div>

                {/* CỘT PHẢI: HIỂN THỊ GIỐNG KẾ HOẠCH BÀI DẠY (TAB DANH SÁCH CÁC TUẦN & TAB XEM CHI TIẾT) */}
                <div className="lg:col-span-7 space-y-4">
                    <div className="bg-white/95 backdrop-blur-md rounded-xl shadow-md border border-teal-100 overflow-hidden flex flex-col min-h-[660px]">
                        
                        {/* Thanh chuyển đổi 2 Tab giống hệt bên Kế hoạch bài dạy */}
                        <div className="flex border-b border-teal-100 bg-teal-50/60 p-2 gap-2">
                            <button
                                type="button"
                                onClick={() => setActiveRightTab('list')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${activeRightTab === 'list' ? 'bg-white text-teal-900 shadow-sm border border-teal-200' : 'text-gray-600 hover:text-gray-900'}`}
                            >
                                <Layers size={16} className="text-teal-600" />
                                DANH SÁCH CÁC TUẦN &amp; TẢI VỀ RIÊNG BIỆT
                                {completedWeeksCount > 0 && (
                                    <span className="ml-1 px-1.5 py-0.2 bg-teal-100 text-teal-800 rounded-full text-[10px]">
                                        {completedWeeksCount}/{totalWeeksCount}
                                    </span>
                                )}
                            </button>

                            <button
                                type="button"
                                onClick={() => setActiveRightTab('preview')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-colors cursor-pointer ${activeRightTab === 'preview' ? 'bg-white text-teal-900 shadow-sm border border-teal-200' : 'text-gray-600 hover:text-gray-900'}`}
                            >
                                <Eye size={16} className="text-teal-600" />
                                XEM CHI TIẾT &amp; CHỈNH SỬA KHDH
                                {generatedPlan && (
                                    <span className="ml-1 px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded-full text-[10px]">
                                        Tuần {generatedPlan.weekNumber}
                                    </span>
                                )}
                            </button>
                        </div>

                        {/* TAB 1: DANH SÁCH CÁC TUẦN & TẢI VỀ RIÊNG BIỆT (GIỐNG BÊN KẾ HOẠCH BÀI DẠY) */}
                        {activeRightTab === 'list' && (
                            <div className="p-4 md:p-6 space-y-4 flex-1 flex flex-col">
                                {!isStep1Completed || !isStep2Completed ? (
                                    <div className="flex-1 min-h-[460px] flex flex-col items-center justify-center p-8 text-center text-gray-500 space-y-4">
                                        <div className="w-16 h-16 rounded-2xl bg-teal-50 border border-teal-200 flex items-center justify-center text-teal-600">
                                            <Layers size={36} />
                                        </div>
                                        <div className="space-y-1.5 max-w-md">
                                            <h4 className="text-base font-bold text-gray-800">Chưa có dữ liệu Kế hoạch dạy học các tuần</h4>
                                            <p className="text-xs text-gray-500 leading-relaxed">
                                                Danh sách toàn bộ các tuần học sẽ hiển thị tại đây để Thầy/Cô soạn tất cả các tuần và tải về riêng biệt từng tuần hoặc trọn bộ sau khi hoàn thành các bước ở cột bên trái:
                                            </p>
                                        </div>
                                        <div className="text-[11px] text-left text-gray-600 bg-slate-50 border border-slate-200 p-3.5 rounded-xl space-y-2 max-w-sm">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center ${isStep1Completed ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700'}`}>1</span>
                                                <span>Tải lên và phân tích các file PPCT</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center ${isStep2Completed ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-700'}`}>2</span>
                                                <span>Tải lên file Mẫu KHDH của Thầy/Cô</span>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="w-4 h-4 rounded-full text-[10px] font-bold flex items-center justify-center bg-gray-200 text-gray-700">3</span>
                                                <span>Chọn <b>"Tất cả các tuần"</b> và bấm Soạn toàn bộ</span>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        {/* Thanh công cụ tổng hợp & tải trọn bộ (Giống KHBD) */}
                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-gradient-to-r from-teal-50 to-emerald-50 rounded-xl border border-teal-200">
                                            <div>
                                                <div className="text-xs font-bold text-teal-950 flex items-center gap-2">
                                                    <span>Tiến độ hoàn thành: {completedWeeksCount} / {totalWeeksCount} tuần</span>
                                                    {completedWeeksCount === totalWeeksCount && totalWeeksCount > 0 && (
                                                        <span className="bg-green-100 text-green-800 text-[10px] px-2 py-0.5 rounded-full font-bold flex items-center gap-1 border border-green-300">
                                                            <Check size={12} /> Đã đủ {totalWeeksCount} tuần
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-[11px] text-gray-600 mt-0.5">
                                                    {completedWeeksCount > 0
                                                        ? `Đã soạn ${completedWeeksCount} tuần (${totalIntegratedWeeksInAll} tuần có ghi chú tích hợp từ PPCT). Có thể tải từng tuần hoặc tải trọn bộ.`
                                                        : `Bấm "SOẠN TOÀN BỘ ${totalWeeksCount} TUẦN THEO PPCT" để lập kế hoạch dạy học cho tất cả các tuần cùng lúc.`
                                                    }
                                                </div>
                                            </div>

                                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                                                {completedWeeksCount < totalWeeksCount && (
                                                    <button
                                                        type="button"
                                                        onClick={handleGenerateAllWeeksPlans}
                                                        disabled={isGeneratingPlan}
                                                        className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-colors bg-teal-700 hover:bg-teal-800 text-white"
                                                    >
                                                        <Sparkles size={14} /> Soạn tất cả {totalWeeksCount} tuần
                                                    </button>
                                                )}

                                                <button
                                                    type="button"
                                                    onClick={handleDownloadAllWeeksSingleWord}
                                                    disabled={completedWeeksCount === 0}
                                                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-colors ${completedWeeksCount > 0 ? 'bg-teal-600 hover:bg-teal-700 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                                                    title="Tải 1 file Word (.docx) tổng hợp chứa tất cả các tuần đã soạn"
                                                >
                                                    <Download size={14} /> Tải gộp 1 file (.DOCX)
                                                </button>

                                                <button
                                                    type="button"
                                                    onClick={handleDownloadAllWeeksZip}
                                                    disabled={completedWeeksCount === 0}
                                                    className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold shadow-xs cursor-pointer transition-colors ${completedWeeksCount > 0 ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
                                                    title="Nén tất cả các tuần đã soạn thành một file ZIP (mỗi tuần 1 file Word riêng biệt)"
                                                >
                                                    <Archive size={14} /> Tải trọn bộ {completedWeeksCount > 0 ? completedWeeksCount : totalWeeksCount} tuần (.ZIP)
                                                </button>
                                            </div>
                                        </div>

                                        {/* Danh sách tất cả các tuần (Giống hệt danh sách tuần bên Kế hoạch bài dạy) */}
                                        <div className="space-y-2.5 overflow-y-auto max-h-[560px] pr-1">
                                            {detectedWeeksFromPpct.map((weekNum) => {
                                                const planForWeek = allGeneratedPlans.find(p => Number(p.weekNumber) === weekNum);
                                                const isDone = !!planForWeek;
                                                const isSelected = Number(generatedPlan?.weekNumber) === weekNum;
                                                const weekDateInfo = getWeekDateRange(weekNum);
                                                const notesInWeek = planForWeek
                                                    ? planForWeek.rows.filter(r => r.notes && r.notes.trim().length > 0)
                                                    : [];
                                                const sampleLessons = planForWeek
                                                    ? Array.from(new Set(planForWeek.rows.map(r => r.lessonName).filter(Boolean))).slice(0, 2)
                                                    : [];

                                                return (
                                                    <div
                                                        key={weekNum}
                                                        className={`p-3 rounded-lg border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${isSelected ? 'border-teal-500 bg-teal-50/50 shadow-xs ring-1 ring-teal-400' : 'border-gray-200 bg-white hover:border-teal-300'}`}
                                                    >
                                                        {/* Trái: Badge Tuần, Khoảng ngày, Số tiết & Ghi chú */}
                                                        <div className="flex items-start gap-3 min-w-0">
                                                            <div className="px-2.5 py-1.5 bg-teal-700 text-white rounded text-xs font-bold shrink-0 text-center min-w-[70px]">
                                                                Tuần {weekNum}
                                                            </div>

                                                            <div className="min-w-0">
                                                                <div className="text-sm font-bold text-gray-900 flex flex-wrap items-center gap-2">
                                                                    <span>KẾ HOẠCH DẠY HỌC – TUẦN {weekNum}</span>
                                                                    <span className="text-[11px] font-normal text-gray-500 italic">
                                                                        {planForWeek?.dateRange || weekDateInfo.dateRange}
                                                                    </span>
                                                                </div>

                                                                {sampleLessons.length > 0 && (
                                                                    <div className="text-xs text-slate-700 truncate mt-0.5 font-medium">
                                                                        📚 {sampleLessons.join(' • ')}
                                                                        {planForWeek && planForWeek.rows.length > 2 ? ' ...' : ''}
                                                                    </div>
                                                                )}

                                                                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                                                                    <span className="text-[11px] text-teal-800 bg-teal-50 px-2 py-0.5 rounded font-semibold border border-teal-200">
                                                                        {planForWeek ? `${planForWeek.rows.length} tiết dạy` : `${parsedTemplateRows.length} tiết theo mẫu`}
                                                                    </span>

                                                                    {isDone && notesInWeek.length > 0 ? (
                                                                        <span className="text-[11px] text-purple-800 bg-purple-50 px-2 py-0.5 rounded font-semibold border border-purple-200 flex items-center gap-1">
                                                                            <Sparkles size={11} className="text-purple-600" />
                                                                            Có {notesInWeek.length} tiết ghi chú tích hợp
                                                                        </span>
                                                                    ) : isDone ? (
                                                                        <span className="text-[10px] text-gray-500 italic">
                                                                            (Chuẩn PPCT - không có ghi chú tích hợp)
                                                                        </span>
                                                                    ) : (
                                                                        <span className="text-[10px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 font-medium">
                                                                            Chưa soạn • Bấm "Soạn tuần này" hoặc "Soạn tất cả"
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Phải: Nút hành động Xem / Tải .doc / Soạn lại (Giống hệt KHBD) */}
                                                        <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                                                            {isDone && planForWeek ? (
                                                                <>
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => {
                                                                            setGeneratedPlan(planForWeek);
                                                                            setTargetWeek(weekNum);
                                                                            setActiveRightTab('preview');
                                                                        }}
                                                                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded border border-teal-200 cursor-pointer"
                                                                        title={`Xem và chỉnh sửa chi tiết KHDH Tuần ${weekNum}`}
                                                                    >
                                                                        <Eye size={13} /> Xem
                                                                    </button>

                                                                    <button
                                                                        type="button"
                                                                        onClick={() => exportKhdhToWord(planForWeek)}
                                                                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-white bg-green-600 hover:bg-green-700 rounded shadow-xs cursor-pointer transition-colors"
                                                                        title={`Tải file Word (.docx) cho Tuần ${weekNum}`}
                                                                    >
                                                                        <Download size={13} /> Tải Tuần {weekNum} (.docx)
                                                                    </button>

                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleGenerateSingleWeekPlan(weekNum, false)}
                                                                        className="p-1.5 text-gray-400 hover:text-teal-700 rounded hover:bg-gray-100 cursor-pointer"
                                                                        title={`Soạn lại Tuần ${weekNum}`}
                                                                    >
                                                                        <RefreshCw size={13} />
                                                                    </button>
                                                                </>
                                                            ) : (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleGenerateSingleWeekPlan(weekNum, false)}
                                                                    disabled={isGeneratingPlan}
                                                                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold text-teal-700 bg-teal-50 hover:bg-teal-100 rounded border border-teal-300 cursor-pointer transition-colors"
                                                                >
                                                                    <Play size={13} /> Soạn tuần này
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

                        {/* TAB 2: XEM CHI TIẾT & CHỈNH SỬA BẢNG KHDH */}
                        {activeRightTab === 'preview' && (
                            <div className="flex-1 flex flex-col">
                                {/* Thanh công cụ bảng KHDH */}
                                <div className="p-3.5 bg-gradient-to-r from-teal-50 via-emerald-50 to-teal-50 border-b border-teal-200 flex flex-wrap items-center justify-between gap-3">
                                    <div className="space-y-0.5">
                                        <div className="text-xs font-bold text-teal-950 flex flex-wrap items-center gap-2">
                                            <BookOpen size={17} className="text-teal-700" />
                                            <span>BẢNG KẾ HOẠCH DẠY HỌC</span>
                                            {generatedPlan && (
                                                <span className="bg-emerald-100 text-emerald-900 px-2 py-0.5 rounded-full text-[10px] font-bold border border-emerald-300">
                                                    Tuần {generatedPlan.weekNumber} • {generatedPlan.rows.length} tiết • {totalNotesInPlan} ghi chú
                                                </span>
                                            )}

                                            {/* Bộ chuyển nhanh giữa các tuần đã soạn */}
                                            {allGeneratedPlans.length > 1 && generatedPlan && (
                                                <div className="flex items-center gap-1 ml-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const idx = allGeneratedPlans.findIndex(p => Number(p.weekNumber) === Number(generatedPlan.weekNumber));
                                                            if (idx > 0) {
                                                                setGeneratedPlan(allGeneratedPlans[idx - 1]);
                                                                setTargetWeek(Number(allGeneratedPlans[idx - 1].weekNumber));
                                                            }
                                                        }}
                                                        disabled={allGeneratedPlans.findIndex(p => Number(p.weekNumber) === Number(generatedPlan.weekNumber)) <= 0}
                                                        className="p-1 rounded bg-white border border-teal-200 text-teal-800 hover:bg-teal-100 disabled:opacity-40 cursor-pointer"
                                                        title="Tuần trước"
                                                    >
                                                        <ChevronLeft size={13} />
                                                    </button>
                                                    <select
                                                        value={String(generatedPlan.weekNumber)}
                                                        onChange={(e) => {
                                                            const wNum = parseInt(e.target.value, 10);
                                                            const found = allGeneratedPlans.find(p => Number(p.weekNumber) === wNum);
                                                            if (found) {
                                                                setGeneratedPlan(found);
                                                                setTargetWeek(wNum);
                                                            }
                                                        }}
                                                        className="px-2 py-0.5 bg-white border border-teal-300 rounded text-xs font-bold text-teal-900 outline-none"
                                                    >
                                                        {allGeneratedPlans.map(p => (
                                                            <option key={p.weekNumber} value={String(p.weekNumber)}>
                                                                Xem Tuần {p.weekNumber}
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            const idx = allGeneratedPlans.findIndex(p => Number(p.weekNumber) === Number(generatedPlan.weekNumber));
                                                            if (idx >= 0 && idx < allGeneratedPlans.length - 1) {
                                                                setGeneratedPlan(allGeneratedPlans[idx + 1]);
                                                                setTargetWeek(Number(allGeneratedPlans[idx + 1].weekNumber));
                                                            }
                                                        }}
                                                        disabled={allGeneratedPlans.findIndex(p => Number(p.weekNumber) === Number(generatedPlan.weekNumber)) >= allGeneratedPlans.length - 1}
                                                        className="p-1 rounded bg-white border border-teal-200 text-teal-800 hover:bg-teal-100 disabled:opacity-40 cursor-pointer"
                                                        title="Tuần kế tiếp"
                                                    >
                                                        <ChevronRight size={13} />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {generatedPlan && generatedPlan.rows.length > 0 && (
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={handleAddNewRow}
                                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer bg-teal-100 text-teal-900 hover:bg-teal-200 border border-teal-300"
                                                title="Thêm dòng mới vào bảng"
                                            >
                                                <Plus size={13} /> Thêm dòng
                                            </button>
                                            <button
                                                type="button"
                                                onClick={handleExportWord}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white shadow-sm transition-colors cursor-pointer bg-emerald-600 hover:bg-emerald-700 active:scale-95"
                                                title="Tải về file Word (.docx) của tuần đang xem theo Nghị định 30"
                                            >
                                                <Download size={14} /> TẢI TUẦN {generatedPlan.weekNumber} (.DOCX)
                                            </button>
                                        </div>
                                    )}
                                </div>

                                {/* Thanh lọc dữ liệu */}
                                {generatedPlan && generatedPlan.rows.length > 0 && (
                                    <div className="p-2.5 bg-slate-50 border-b border-gray-200 flex flex-wrap items-center gap-3 text-xs">
                                        <div className="flex items-center gap-1.5 font-bold text-gray-700">
                                            <Filter size={13} className="text-teal-600" /> Bộ lọc:
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 text-[11px]">Lớp:</span>
                                            <select
                                                value={selectedClassFilter}
                                                onChange={(e) => setSelectedClassFilter(e.target.value)}
                                                className="p-1 border rounded bg-white text-xs outline-none font-medium"
                                            >
                                                <option value="all">Tất cả lớp ({uniqueClasses.length})</option>
                                                {uniqueClasses.map((c, idx) => (
                                                    <option key={idx} value={c}>Lớp {c}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-500 text-[11px]">Môn:</span>
                                            <select
                                                value={selectedSubjectFilter}
                                                onChange={(e) => setSelectedSubjectFilter(e.target.value)}
                                                className="p-1 border rounded bg-white text-xs outline-none font-medium"
                                            >
                                                <option value="all">Tất cả môn ({uniqueSubjects.length})</option>
                                                {uniqueSubjects.map((s, idx) => (
                                                    <option key={idx} value={s}>{s}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div className="ml-auto text-[11px] text-gray-500 italic">
                                            Hiển thị {filteredRows.length} / {generatedPlan.rows.length} tiết • Bấm vào <b>(T1)/(T2)</b> để chuyển nhanh
                                        </div>
                                    </div>
                                )}

                                {/* VÙNG NỘI DUNG BẢNG */}
                                <div className="flex-1 p-3 overflow-x-auto overflow-y-auto max-h-[640px]">
                                    {!generatedPlan || generatedPlan.rows.length === 0 ? (
                                        <div className="h-full min-h-[420px] flex flex-col items-center justify-center p-8 text-center text-gray-500 space-y-3">
                                            <Calendar size={48} className="text-gray-300" />
                                            <h4 className="text-sm font-bold text-gray-700">Chưa có tuần nào được chọn để xem chi tiết</h4>
                                            <p className="text-xs text-gray-500 max-w-md">
                                                Vui lòng bấm <b>"SOẠN TOÀN BỘ CÁC TUẦN"</b> ở Bước 3 hoặc chọn một tuần từ tab <b>"Danh sách các tuần"</b> để xem và chỉnh sửa chi tiết.
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="border border-slate-300 rounded-lg overflow-hidden shadow-2xs bg-white">
                                            <table className="w-full text-left border-collapse text-xs">
                                                <thead className="bg-slate-100 text-slate-900 sticky top-0 border-b border-slate-300 z-10 shadow-2xs font-bold text-center">
                                                    <tr>
                                                        <th className="p-2 border-r border-slate-200 w-[14%]">Thứ, ngày</th>
                                                        <th className="p-2 border-r border-slate-200 w-[8%]">Buổi</th>
                                                        <th className="p-2 border-r border-slate-200 w-[6%]">Tiết</th>
                                                        <th className="p-2 border-r border-slate-200 w-[8%]">LỚP</th>
                                                        <th className="p-2 border-r border-slate-200 w-[9%]">MÔN</th>
                                                        <th className="p-2 text-left border-r border-slate-200 w-[39%]">Tên bài dạy</th>
                                                        <th className="p-2 text-left border-r border-slate-200 w-[12%]">Ghi chú</th>
                                                        <th className="p-2 w-[4%]">Xoá</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-gray-100">
                                                    {filteredRows.map((row, idx) => {
                                                        const hasNote = !!(row.notes && row.notes.trim().length > 0);
                                                        return (
                                                            <tr key={row.id || idx} className="hover:bg-teal-50/40 transition-colors odd:bg-white even:bg-slate-50/50">
                                                                {/* 1. Thứ, ngày */}
                                                                <td className="p-2 text-center font-bold text-teal-950 border-r border-gray-100 whitespace-nowrap">
                                                                    <input
                                                                        type="text"
                                                                        value={row.dayAndDate}
                                                                        onChange={(e) => handleUpdateRow(row.id, 'dayAndDate', e.target.value)}
                                                                        className="w-full text-center bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded font-bold"
                                                                    />
                                                                </td>

                                                                {/* 2. Buổi */}
                                                                <td className="p-2 text-center border-r border-gray-100 whitespace-nowrap">
                                                                    <input
                                                                        type="text"
                                                                        value={row.session}
                                                                        onChange={(e) => handleUpdateRow(row.id, 'session', e.target.value)}
                                                                        className="w-full text-center bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded text-slate-700"
                                                                    />
                                                                </td>

                                                                {/* 3. Tiết */}
                                                                <td className="p-2 text-center font-bold text-slate-800 border-r border-gray-100">
                                                                    <input
                                                                        type="text"
                                                                        value={row.period}
                                                                        onChange={(e) => handleUpdateRow(row.id, 'period', e.target.value)}
                                                                        className="w-full text-center bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded font-bold"
                                                                    />
                                                                </td>

                                                                {/* 4. LỚP */}
                                                                <td className="p-2 text-center font-bold text-slate-900 border-r border-gray-100">
                                                                    <input
                                                                        type="text"
                                                                        value={row.className}
                                                                        onChange={(e) => handleUpdateRow(row.id, 'className', e.target.value)}
                                                                        className="w-full text-center bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded font-bold text-slate-800"
                                                                    />
                                                                </td>

                                                                {/* 5. MÔN */}
                                                                <td className="p-2 text-center font-bold text-teal-900 border-r border-gray-100">
                                                                    <input
                                                                        type="text"
                                                                        value={row.subject}
                                                                        onChange={(e) => handleUpdateRow(row.id, 'subject', e.target.value)}
                                                                        className="w-full text-center bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded font-bold text-teal-900"
                                                                    />
                                                                </td>

                                                                {/* 6. Tên bài dạy */}
                                                                <td className="p-2 text-gray-900 border-r border-gray-100">
                                                                    <div className="flex items-center gap-1.5">
                                                                        <input
                                                                            type="text"
                                                                            value={row.lessonName}
                                                                            onChange={(e) => handleUpdateRow(row.id, 'lessonName', e.target.value)}
                                                                            className="w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded font-medium leading-tight text-slate-900"
                                                                        />
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => togglePeriodTag(row.id)}
                                                                            className="shrink-0 px-1.5 py-0.5 bg-teal-50 hover:bg-teal-100 border border-teal-300 text-teal-800 rounded text-[10px] font-bold cursor-pointer transition-colors"
                                                                            title="Bấm để đổi nhanh giữa (T1) và (T2)"
                                                                        >
                                                                            {row.lessonName.includes('(T2)') ? '(T2)' : row.lessonName.includes('(T1)') ? '(T1)' : 'T1/T2'}
                                                                        </button>
                                                                    </div>
                                                                </td>

                                                                {/* 7. Ghi chú */}
                                                                <td className="p-2 border-r border-gray-100">
                                                                    <input
                                                                        type="text"
                                                                        value={row.notes || ''}
                                                                        placeholder="Trống nếu PPCT không có ghi chú"
                                                                        onChange={(e) => handleUpdateRow(row.id, 'notes', e.target.value)}
                                                                        className={`w-full bg-transparent outline-none focus:bg-white focus:ring-1 focus:ring-teal-400 rounded text-[11px] ${hasNote ? 'text-teal-900 font-semibold italic' : 'text-gray-400 italic'}`}
                                                                    />
                                                                </td>

                                                                {/* Xoá */}
                                                                <td className="p-2 text-center">
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => handleDeleteRow(row.id)}
                                                                        className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition-colors cursor-pointer"
                                                                        title="Xoá tiết này"
                                                                    >
                                                                        <Trash2 size={13} />
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TeachingPlanTab;
