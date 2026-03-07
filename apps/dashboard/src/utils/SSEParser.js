
export const parseJsonStream = (text) => {
    if (!text || typeof text !== 'string') return [];

    // Brute force fallback - look for JSON objects surrounded by {} in the text
    // This helps catch chunks that might be missed by the parser
    if (text.includes('{') && text.includes('}')) {
        const potentialJson = text.substring(
            text.indexOf('{'),
            text.lastIndexOf('}') + 1
        );

        try {
            const forceParsed = JSON.parse(potentialJson);
            // Verify this is a valid message (either a chunk or status update)
            if (forceParsed &&
                forceParsed.messageId &&
                (forceParsed.text || forceParsed.status) &&
                typeof forceParsed.messageId !== 'undefined') {

                return forceParsed;
            }
        } catch (e) { }
    }

    const results = [];

    // Strategy 1: Direct JSON parse if it's a clean JSON object
    try {
        const directParsed = JSON.parse(text);
        if (directParsed && typeof directParsed === 'object' && directParsed.messageId &&
            (directParsed.text || directParsed.status)) {
            results.push(directParsed);
            return results;
        }
    } catch (e) {
        console.log('Error:', e);
    }

    // Strategy 2: Handle quoted strings that contain JSON
    if (text.startsWith('"') && text.endsWith('"')) {
        try {
            // This will handle escaped quotes within the string
            const unquoted = JSON.parse(text);
            if (typeof unquoted === 'string') {
                // Try parsing the unquoted content
                try {
                    const parsed = JSON.parse(unquoted);
                    if (parsed && typeof parsed === 'object' && parsed.messageId &&
                        (parsed.text || parsed.status)) {
                        results.push(parsed);
                        return results;
                    }
                } catch (innerErr) { }

                // If that failed, use the unquoted content for the next strategies
                text = unquoted;
            }
        } catch (e) {
            console.log('Error:', e);
        }
    }

    // Strategy 3: Handle SSE format with data: prefix
    if (text.includes('data:')) {
        const dataLines = text.split('\n')
            .filter(line => line.trim().startsWith('data:'));

        for (const line of dataLines) {
            try {
                const jsonPart = line.substring(line.indexOf(':') + 1).trim();
                const parsed = JSON.parse(jsonPart);
                if (parsed && typeof parsed === 'object' && parsed.messageId &&
                    (parsed.text || parsed.status)) {
                    results.push(parsed);
                }
            } catch (e) { }
        }
    }

    // Strategy 4: Extract any JSON-like structures in the string
    // Look specifically for chunk message JSON patterns to avoid parsing code blocks
    const possibleJsons = [];
    let startIdx = text.indexOf('{');

    while (startIdx !== -1) {
        let openBraces = 1;
        let endIdx = startIdx + 1;
        let inString = false;
        let escaped = false;

        // Find matching closing brace
        while (endIdx < text.length && openBraces > 0) {
            const char = text[endIdx];

            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = !inString;
            } else if (!inString) {
                if (char === '{') openBraces++;
                else if (char === '}') openBraces--;
            }

            endIdx++;
        }

        if (openBraces === 0) {
            const jsonCandidate = text.substring(startIdx, endIdx);
            possibleJsons.push(jsonCandidate);
        }

        startIdx = text.indexOf('{', startIdx + 1);
    }

    for (const jsonStr of possibleJsons) {
        try {
            const parsed = JSON.parse(jsonStr);
            // Consider it valid if it has messageId and either text or status
            if (parsed && typeof parsed === 'object' && parsed.messageId &&
                (parsed.text || parsed.status)) {
                results.push(parsed);
            }
        } catch (e) {
            console.log('Error:', e);
        }
    }

    if (results.length === 0 && text.includes('data:')) {
        // Extract data from malformed JSON as a last resort
        const statusMatch = text.match(/status":"([^"]+)"/);
        const idMatch = text.match(/messageId":(\d+)/);
        const typeMatch = text.match(/type":"([^"]+)"/);
        const textMatch = text.match(/text":"([^"]+)"/);

        // Generate a fallback message ID if needed
        const messageId = idMatch ? parseInt(idMatch[1]) : Date.now();

        if (statusMatch && statusMatch[1] && typeMatch && typeMatch[1] === 'status') {
            results.push({ messageId, type: 'status', status: JSON.parse(statusMatch[1]) });
        } else if (textMatch && textMatch[1]) {
            // Handle text chunk
            results.push({ messageId, type: 'text', text: textMatch[1] });
        }
    }

    return results;
};
