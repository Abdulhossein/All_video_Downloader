// Shared utility functions

/**
 * Sanitize a string for use as a filename.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFilename(name) {
    if (!name) return '';
    // Remove illegal characters, trim whitespace, and limit length.
    return name.replace(/[<>:"/\|?*]/g, ' ').replace(/\s\s+/g, ' ').trim().substring(0, 150);
}

/**
 * Get the extension from a URL, handling query strings and fragments.
 * @param {string} url
 * @returns {string}
 */
function getExtensionFromUrl(url) {
    if (!url) return '';
    try {
        const pathname = new URL(url).pathname;
        const lastDot = pathname.lastIndexOf('.');
        if (lastDot === -1) return '';
        return pathname.substring(lastDot + 1).toLowerCase().split('?')[0].split('#')[0];
    } catch (e) {
        return '';
    }
}

/**
 * The single source of truth for generating a final filename.
 * It prioritizes the URL for the extension and uses the title for the name.
 * @param {any} stream The stream object from the background.
 * @param {string} downloadUrl The specific URL being downloaded (from quality selection).
 * @returns {string}
 */
function getFilename(stream, downloadUrl) {
    // 1. Determine the extension.
    let ext = getExtensionFromUrl(downloadUrl);
    if (!ext) {
        const typeMap = { 'video': 'mp4', 'audio': 'mp3', 'image': 'jpg', 'hls': 'mp4', 'dash': 'mp4' };
        ext = typeMap[stream.type] || stream.type || 'media';
    }

    // 2. Determine the base name.
    let name = sanitizeFilename(stream.title || 'media');
    
    try {
        const urlPath = new URL(downloadUrl).pathname;
        const nameFromUrl = decodeURIComponent(urlPath.substring(urlPath.lastIndexOf('/') + 1));
        
        // If the title is generic, use the filename from the URL.
        if (/^(media|video|audio|index|master|playlist)/i.test(name) && nameFromUrl) {
            name = nameFromUrl;
        }
    } catch(e) { /* ignore URL parsing errors */ }
    
    // 3. Clean the base name by removing a pre-existing extension.
    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0) {
        const potentialExt = name.substring(lastDot + 1).toLowerCase();
        const KNOWN_EXTENSIONS = ['mp3', 'mp4', 'webm', 'flv', 'mov', 'avi', 'mkv', 'aac', 'wav', 'ogg', 'jpeg', 'jpg', 'png', 'gif', 'bmp', 'm3u8', 'ts', 'm4s', 'mpd'];
        if (KNOWN_EXTENSIONS.includes(potentialExt)) {
            name = name.substring(0, lastDot);
        }
    }
    
    // 4. Combine and sanitize.
    return sanitizeFilename(`${name}.${ext}`);
}


/**
 * @param {string} url
 * @param {string=} streamTypeHint
 * @returns {string}
 */
function detectContentType(url, streamTypeHint = 'unknown') {
    if (!url) return 'unknown';
    
    const ext = getExtensionFromUrl(url);

    if (!ext) {
        if (streamTypeHint && streamTypeHint !== 'auto') return streamTypeHint;
        return 'other';
    }

    // Media
    if (['m3u8'].includes(ext)) return 'hls';
    if (['mpd'].includes(ext)) return 'dash';
    if (['mp4', 'webm', 'flv', 'mov', 'ogv', 'avi', 'mpg', 'mpeg', 'mkv'].includes(ext)) return 'video';
    if (['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac'].includes(ext)) return 'audio';
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return 'image';

    // Archives
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso', 'img', 'udf'].includes(ext)) return 'zip';
    
    // OS/Executables
    if (['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk'].includes(ext)) return 'os';
    
    // Documents
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'html', 'htm'].includes(ext)) return 'document';
    
    return 'other';
}


/**
 * XSS PROTECTION: Sanitize user-controlled content before inserting into the DOM.
 * @param {any} text The text to sanitize.
 * @param {number} [maxLength=150] The maximum length of the output string.
 * @returns {string} The sanitized, plain text string.
 */
function sanitize(text, maxLength = 150) {
    const div = document.createElement('div');
    div.textContent = String(text || '').substring(0, maxLength);
    return div.textContent;
}
