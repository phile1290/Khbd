import React from 'react';
import { LessonPlanResponse, Period } from '../types';
import { formatActivityName, formatTopicName, alignContent, formatObjectives, formatLessonTitleWithPeriod, paginateActivityRowsForWordPages, ensureFourActivitiesInAllPeriods, extractExplicitPeriodNumber, extractIntegrationPrefixFromObjectives } from '../utils';
import { isImageHintLine } from '../utils/lessonImageGenerator';
import FormattedText from './FormattedText';

interface Props {
    result: LessonPlanResponse;
    inputData: any;
    id?: string;
    hideTableBorders?: boolean;
}

const formatGradeHeader = (val?: string) => {
    const v = (val || '').trim();
    if (!v) return 'LỚP 5';
    const upper = v.toUpperCase();
    if (upper.startsWith('LỚP')) return upper;
    return `LỚP ${upper}`;
};

const formatSubjectHeader = (val?: string) => {
    const v = (val || '').trim();
    if (!v) return 'MÔN HỌC';
    const upper = v.toUpperCase();
    if (upper.startsWith('MÔN HỌC:')) return upper;
    if (upper.startsWith('MÔN HỌC')) return `MÔN HỌC: ${upper.replace(/^MÔN HỌC\s*/, '')}`;
    if (upper.startsWith('MÔN:')) return `MÔN HỌC: ${upper.replace(/^MÔN:\s*/, '')}`;
    if (upper.startsWith('MÔN')) return `MÔN HỌC: ${upper.replace(/^MÔN\s*/, '')}`;
    return `MÔN HỌC: ${upper}`;
};

const LessonPreview: React.FC<Props> = ({ result: rawResult, inputData, id }) => {
    const result = ensureFourActivitiesInAllPeriods(rawResult, inputData);
    
    const renderSinglePeriod = (period: Period, index: number) => {
        const periodNum =
            Number(inputData?.periodIndexInLesson) ||
            Number(period.period_number) ||
            extractExplicitPeriodNumber(inputData?.lessonName || '') ||
            extractExplicitPeriodNumber(result.lesson_full_title || '') ||
            (index + 1);
        const rawTitleSource =
            inputData?.baseLessonName ||
            inputData?.lessonName ||
            result.lesson_full_title ||
            "KẾ HOẠCH BÀI DẠY";
        const lessonTitle = formatLessonTitleWithPeriod(
            rawTitleSource,
            periodNum
        );

        const displaySchool = inputData.schoolName || 'Trường Tiểu học Mỹ An';
        const displayTeacher = inputData.teacherName || 'GV: Lê Văn Phi';

        const styles = {
            container: { marginBottom: '30px', fontFamily: '"Times New Roman", Times, serif', fontSize: '13pt', lineHeight: '1.3' },
            sectionTitle: { fontWeight: 'bold', textTransform: 'uppercase' as const, marginBottom: '4pt', marginTop: '14pt', fontSize: '13pt' },
            justify: { textAlign: 'justify' as const, fontSize: '13pt' },
            table: { 
                width: '100%', 
                minWidth: '650px', 
                tableLayout: 'fixed' as const, 
                borderCollapse: 'collapse' as const, 
                marginBottom: '0px', 
                border: '1.5px solid black',
                fontSize: '13pt' 
            }, 
            headerCell: { 
                border: '1px solid black', 
                padding: '6px 8px', 
                textAlign: 'center' as const, 
                verticalAlign: 'middle', 
                fontWeight: 'bold', 
                backgroundColor: '#ffffff'
            },
            // Cột TG
            bodyCellTg: { 
                borderTop: 'none',
                borderLeft: '1.5px solid black',
                borderRight: '1px solid black',
                padding: '6px 8px', 
                textAlign: 'center' as const, 
                verticalAlign: 'top', 
                fontWeight: 'bold' 
            },
            // Cột Hoạt động của Giáo viên
            bodyCellGv: { 
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: '1px solid black',
                padding: '6px 8px', 
                verticalAlign: 'top', 
                textAlign: 'justify' as const 
            },
            // Cột Hoạt động của Học sinh
            bodyCellHs: { 
                borderTop: 'none',
                borderLeft: 'none',
                borderRight: '1.5px solid black',
                padding: '6px 8px', 
                verticalAlign: 'top', 
                textAlign: 'justify' as const 
            },
            pageBreak: { pageBreakAfter: 'always' as const, borderBottom: '3px double #ccc', paddingBottom: '20px', marginBottom: '40px', display: 'block' }
        };

        const formattedObjs = formatObjectives(period.objectives);
        const integrationPrefix = extractIntegrationPrefixFromObjectives(
            period.objectives,
            inputData?.integrationNotes
        );
        const teacherMat = (period.materials?.teacher || '').replace(/\*\*/g, '').replace(/^[-–\*\s]+/, '');
        const studentMat = (period.materials?.student || '').replace(/\*\*/g, '').replace(/^[-–\*\s]+/, '');

        return (
            <div key={index} style={styles.pageBreak} className="period-container">
                <div style={styles.container}>
                    {/* TIÊU ĐỀ 4 DÒNG VIẾT HOA CĂN GIỮA CHUẨN XÁC TUYỆT ĐỐI THEO YÊU CẦU:
                        1. KẾ HOẠCH BÀI DẠY (viết hoa, căn giữa)
                        2. LỚP ... (viết hoa, căn giữa)
                        3. MÔN HỌC: ... (viết hoa, căn giữa)
                        4. tên bài dạy: [TÊN BÀI DẠY VIẾT HOA] (căn giữa, chỉ có chữ "tên bài dạy" viết thường và nguyên)
                    */}
                    <div style={{ textAlign: 'center', marginBottom: '16pt' }}>
                        <div style={{ fontWeight: 'bold', fontSize: '14pt', textTransform: 'uppercase', marginBottom: '4pt' }}>
                            KẾ HOẠCH BÀI DẠY
                        </div>
                        <div style={{ fontWeight: 'bold', fontSize: '13pt', textTransform: 'uppercase', marginBottom: '4pt' }}>
                            {formatGradeHeader(inputData.grade || result.grade_class)}
                        </div>
                        <div style={{ fontWeight: 'bold', fontSize: '13pt', textTransform: 'uppercase', marginBottom: '6pt' }}>
                            {formatSubjectHeader(inputData.subject || result.subject)}
                        </div>
                        <div style={{ fontSize: '13pt', marginTop: '4pt' }}>
                            <span style={{ fontStyle: 'italic', fontWeight: 'normal', textTransform: 'none' }}>tên bài dạy: </span>
                            <span style={{ fontWeight: 'bold', textTransform: 'uppercase' }}>{lessonTitle.toUpperCase()}</span>
                        </div>
                    </div>

                    {/* MỤC I. YÊU CẦU CẦN ĐẠT */}
                    <h3 style={styles.sectionTitle}>I. YÊU CẦU CẦN ĐẠT:</h3>
                    <div style={styles.justify}>
                        {formattedObjs.map((obj, i) => (
                            <div key={i} style={{
                                marginBottom: '3pt',
                                fontStyle: obj.isIntegration ? 'italic' : 'normal',
                                fontWeight: 'normal'
                            }}>
                                {obj.isIntegration ? <i style={{ fontWeight: 'normal' }}>{obj.text}</i> : obj.text}
                            </div>
                        ))}
                    </div>

                    {/* MỤC II. ĐỒ DÙNG DẠY HỌC */}
                    <h3 style={styles.sectionTitle}>II. ĐỒ DÙNG DẠY HỌC:</h3>
                    <div style={styles.justify}>
                        <div style={{ marginBottom: '3pt' }}>
                            <span style={{ fontWeight: 'bold' }}>1. GV: </span>
                            {teacherMat}
                        </div>
                        <div style={{ marginBottom: '3pt' }}>
                            <span style={{ fontWeight: 'bold' }}>2. HS: </span>
                            {studentMat}
                        </div>
                    </div>

                    {/* MỤC III. CÁC HOẠT ĐỘNG DẠY HỌC */}
                    <h3 style={{ ...styles.sectionTitle, marginBottom: '6pt' }}>III. CÁC HOẠT ĐỘNG DẠY HỌC:</h3>
                    <div className="overflow-x-auto w-full pb-2">
                        {(() => {
                            const flatRows: Array<{
                                key: string;
                                timeText: string;
                                isFirstRowOfActivity: boolean;
                                isLastRowOfActivity: boolean;
                                actName: string;
                                formattedActName: string;
                                topic?: string;
                                formattedTopic?: string;
                                teacher: string;
                                student: string;
                                precedingTeacher?: string;
                            }> = [];

                            (period.activities || []).forEach((act, actIndex) => {
                                const actRows = act.rows || [];
                                const formattedActName = formatActivityName(act.name);
                                const formattedTopic = act.topic ? formatTopicName(act.topic) : '';
                                let lastTeacherLineInAct = '';
                                actRows.forEach((row, rowIndex) => {
                                    const alignedSubRows = alignContent(row.teacher, row.student, lastTeacherLineInAct);
                                    alignedSubRows.forEach((subRow, subRowIndex) => {
                                        if (subRow.teacher && !isImageHintLine(subRow.teacher)) {
                                            lastTeacherLineInAct = subRow.teacher;
                                        }
                                        const isFirstRowOfActivity = rowIndex === 0 && subRowIndex === 0;
                                        const isLastRowOfActivity = rowIndex === actRows.length - 1 && subRowIndex === alignedSubRows.length - 1;
                                        const timeText = isFirstRowOfActivity ? (act.time || '').replace(/phút/gi, "'").replace(/\s/g, '') : '';
                                        flatRows.push({
                                            key: `${actIndex}-${rowIndex}-${subRowIndex}`,
                                            timeText,
                                            isFirstRowOfActivity,
                                            isLastRowOfActivity,
                                            actName: act.name,
                                            formattedActName,
                                            topic: act.topic,
                                            formattedTopic,
                                            teacher: subRow.teacher,
                                            student: subRow.student,
                                            precedingTeacher: subRow.precedingTeacher
                                        });
                                    });
                                });
                            });

                            const pageChunks = paginateActivityRowsForWordPages(
                                flatRows,
                                formattedObjs.length,
                                teacherMat.length,
                                studentMat.length
                            );

                            return pageChunks.map((pageRows, pageIdx) => {
                                const isLastPageOfPeriod = pageIdx === pageChunks.length - 1;

                                return (
                                    <React.Fragment key={`page-chunk-${pageIdx}`}>
                                        <table style={styles.table}>
                                            <thead style={{ display: 'table-header-group' }}>
                                                <tr className="header-row">
                                                    <th style={{ ...styles.headerCell, width: '10%' }}>TG</th>
                                                    <th style={{ ...styles.headerCell, width: '52%' }}>HOẠT ĐỘNG CỦA GIÁO VIÊN</th>
                                                    <th style={{ ...styles.headerCell, width: '38%' }}>HOẠT ĐỘNG CỦA HỌC SINH</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {pageRows.map((r, idx) => {
                                                    const isLastRowOfPageTable = idx === pageRows.length - 1;
                                                    // Đóng khung bảng ở dòng cuối của MỖI TRANG, ẩn đường kẻ ngang giữa các nội dung bên trong cùng một trang
                                                    const borderBottomValue = isLastRowOfPageTable ? '1.5px solid black' : 'none';

                                                    const tgStyle = { ...styles.bodyCellTg, borderBottom: borderBottomValue };
                                                    const gvStyle = { ...styles.bodyCellGv, borderBottom: borderBottomValue };
                                                    const hsStyle = { ...styles.bodyCellHs, borderBottom: borderBottomValue };

                                                    return (
                                                        <tr key={r.key}>
                                                            <td style={tgStyle}>
                                                                {r.timeText}
                                                            </td>
                                                            <td style={gvStyle}>
                                                                {r.isFirstRowOfActivity && (
                                                                    <>
                                                                        <div style={{ fontWeight: 'bold', marginBottom: '3pt', textTransform: 'none' }}>
                                                                            {r.formattedActName}
                                                                        </div>
                                                                        {r.formattedTopic && (
                                                                            <div style={{ fontWeight: 'bold', marginBottom: '3pt', textDecoration: 'none' }}>
                                                                                {r.formattedTopic}
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                )}
                                                                <FormattedText
                                                                    text={r.teacher}
                                                                    lessonTitle={lessonTitle}
                                                                    precedingText={r.precedingTeacher || ''}
                                                                    integrationPrefix={integrationPrefix}
                                                                />
                                                            </td>
                                                            <td style={hsStyle}>
                                                                {r.isFirstRowOfActivity && (
                                                                    <>
                                                                        <div style={{ marginBottom: '3pt', height: '1.3em', userSelect: 'none' }} aria-hidden="true">&nbsp;</div>
                                                                        {r.formattedTopic && (
                                                                            <div style={{ marginBottom: '3pt', height: '1.3em', userSelect: 'none' }} aria-hidden="true">&nbsp;</div>
                                                                        )}
                                                                    </>
                                                                )}
                                                                <FormattedText
                                                                    text={r.student}
                                                                    lessonTitle={lessonTitle}
                                                                    integrationPrefix={integrationPrefix}
                                                                />
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>

                                        {!isLastPageOfPeriod && (
                                            <>
                                                <div className="preview-only-footer" style={{
                                                    marginTop: '14pt',
                                                    marginBottom: '18pt',
                                                    paddingTop: '6pt',
                                                    borderTop: '1px solid black',
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center',
                                                    fontSize: '11pt',
                                                    fontFamily: '"Times New Roman", Times, serif'
                                                }}>
                                                    <span style={{ fontStyle: 'italic', color: '#e11d48', fontWeight: '500' }}>
                                                        {displaySchool}
                                                    </span>
                                                    <span style={{ fontSize: '9.5pt', color: '#64748b', fontStyle: 'italic' }}>
                                                        --- Hết trang {pageIdx + 1} (Đã đóng khung bảng cuối trang) • Sang trang {pageIdx + 2} ---
                                                    </span>
                                                    <span style={{ fontStyle: 'italic', color: '#e11d48', fontWeight: '500' }}>
                                                        {displayTeacher}
                                                    </span>
                                                </div>
                                                <br style={{ clear: 'both', pageBreakBefore: 'always' }} />
                                            </>
                                        )}
                                    </React.Fragment>
                                );
                            });
                        })()}
                    </div>

                    {/* MỤC ĐIỀU CHỈNH SAU BÀI DẠY */}
                    <div style={{ marginTop: '8pt', paddingTop: '0px' }}>
                        <div style={{ fontWeight: 'bold', fontSize: '13pt', marginBottom: '4pt' }}>
                            Điều chỉnh sau bài dạy:
                        </div>
                        <p style={{ fontStyle: 'italic', color: '#666', textAlign: 'justify', marginTop: '2pt' }}>
                            ..................................................................................................................................................................................................................................................................................................................
                        </p>
                    </div>

                    {/* ĐƯỜNG KẺ NGANG Ở CUỐI TRANG VÀ THÔNG TIN TRƯỜNG, GIÁO VIÊN */}
                    <div className="preview-only-footer" style={{
                        marginTop: '16pt',
                        paddingTop: '6pt',
                        borderTop: '1px solid black',
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '11pt',
                        fontFamily: '"Times New Roman", Times, serif'
                    }}>
                        <span style={{ fontStyle: 'italic', color: '#e11d48', fontWeight: '500' }}>
                            {displaySchool}
                        </span>
                        <span style={{ fontStyle: 'italic', color: '#e11d48', fontWeight: '500' }}>
                            {displayTeacher}
                        </span>
                    </div>
                </div>
            </div>
        );
    };

    return (
        <div id={id} className="max-w-[21cm] mx-auto bg-white text-black p-4">
             {result.periods && result.periods.map((period, idx) => renderSinglePeriod(period, idx))}
        </div>
    );
};

export default LessonPreview;