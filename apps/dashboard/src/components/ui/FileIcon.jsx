import React from 'react';
import { extToLangMap } from '@/utils/extToLang.js';
// Import the icon theme data
import { theme } from '@/utils/theme.js';

// File/Folder icon component
const FileIcon = ({ language, fileName = '', style }) => {

    // Get file extension for mapping
    const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
    // console.log(fileExtension, fileName);
    // Get icon definition
    let id

        if (theme.fileNames[fileName]) {
        id = theme.fileNames[fileName]
    } else if (theme.fileExtensions[fileExtension]) {
        id = theme.fileExtensions[fileExtension]
    } else if (theme.languageIds[language]) {
        id = theme.languageIds[language]
    } else if (theme.languageIds[extToLangMap[fileExtension]]) {
        id = theme.languageIds[extToLangMap[fileExtension]]
    } else if (theme.languageIds[fileExtension]) {
        id = theme.languageIds[fileExtension]
    } else {

     }

    const iconDef = theme.iconDefinitions[id]

    if (iconDef) {
        return (
            <div className="flex items-center">
                <span
                    className="mr-1 w-[16px]"
                    data-icon={id}
                    style={{
                        fontFamily: 'monokai_pro_icons',
                        color: iconDef.fontColor,
                        fontSize: '16px',
                        width: '16px',
                        height: '16px',
                        lineHeight: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        ...style
                    }}
                >
                    {String.fromCharCode(parseInt(iconDef.fontCharacter.replace('\\', '0x'), 16))}
                </span>
            </div>
        );
    }else {
    }

};

export default FileIcon;