import React, { useEffect, useState } from 'react';
import {
    cleanPrefix,
    isActivityIntegrationLine,
    formatActivityIntegrationLine
} from '../utils';
import {
    isImageHintLine,
    extractCleanImageDescription,
    renderPedagogicalIllustrationDataUrl,
    subscribeToImageUpdates
} from '../utils/lessonImageGenerator';

interface Props {
    text: string;
    lessonTitle?: string;
    precedingText?: string;
    integrationPrefix?: string;
}

const FormattedText: React.FC<Props> = ({
    text,
    lessonTitle = '',
    precedingText = '',
    integrationPrefix = 'Tích hợp giáo dục kĩ năng công dân số'
}) => {
    const [, setImageTick] = useState(0);

    useEffect(() => {
        return subscribeToImageUpdates(() => {
            setImageTick(t => t + 1);
        });
    }, []);

    if (!text) return null;

    const processedText = text
        .replace(/(\[Gợi ý hình ảnh:|Gợi ý hình ảnh:|\(Gợi ý hình ảnh:|\[Hình ảnh minh họa:|Hình ảnh minh họa:)/gi, '\n$1')
        .replace(/(\[Tích hợp[^\]]*\]:|-?\s*Tích hợp\s+[^:\n]+:)/gi, '\n$1');

    const cleanedText = cleanPrefix(processedText);
    const lines = cleanedText.split('\n');

    let runningContext = precedingText || '';

    return (
        <>
            {lines.map((line, index) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) return null;

                const isImageSuggestion = isImageHintLine(trimmedLine);
                const isIntegrated = isActivityIntegrationLine(trimmedLine);

                const baseStyle: React.CSSProperties = {
                    textAlign: 'justify',
                    fontFamily: '"Times New Roman", serif',
                    fontSize: '13pt',
                    lineHeight: '1.3',
                    margin: '0 0 3pt 0'
                };

                if (isImageSuggestion) {
                    const imgDataUrl = renderPedagogicalIllustrationDataUrl(
                        trimmedLine,
                        lessonTitle,
                        runningContext
                    );
                    const cleanDesc = extractCleanImageDescription(trimmedLine);
                    return (
                        <div key={index} style={{ margin: '6pt 0', textAlign: 'center' }}>
                            {imgDataUrl ? (
                                <img
                                    src={imgDataUrl}
                                    alt={cleanDesc}
                                    style={{
                                        maxWidth: '100%',
                                        width: '320px',
                                        height: 'auto',
                                        borderRadius: '6px',
                                        border: '1px solid #cbd5e1',
                                        display: 'inline-block'
                                    }}
                                />
                            ) : (
                                <div
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: '8px',
                                        width: '320px',
                                        maxWidth: '100%',
                                        minHeight: '110px',
                                        padding: '12px',
                                        borderRadius: '6px',
                                        border: '1px dashed #94a3b8',
                                        backgroundColor: '#f8fafc',
                                        color: '#0f766e',
                                        fontSize: '11pt',
                                        fontStyle: 'italic'
                                    }}
                                >
                                    <span>Đang vẽ hình ảnh minh họa trực quan...</span>
                                </div>
                            )}
                        </div>
                    );
                }

                if (isIntegrated) {
                    const formattedIntegration = formatActivityIntegrationLine(
                        trimmedLine,
                        integrationPrefix
                    );
                    return (
                        <div
                            key={index}
                            style={{
                                ...baseStyle,
                                fontStyle: 'italic',
                                fontWeight: 'normal',
                                color: '#dc2626'
                            }}
                        >
                            {formattedIntegration}
                        </div>
                    );
                }

                const cleanText = trimmedLine.replace(/\*\*/g, '');
                runningContext = `${runningContext}\n${cleanText}`.trim();

                return (
                    <div key={index} style={baseStyle}>
                        {cleanText}
                    </div>
                );
            }).filter(Boolean)}
        </>
    );
};

export default FormattedText;