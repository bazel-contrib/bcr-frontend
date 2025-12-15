goog.module("centrl.language");

const RepositoryMetadata = goog.require('proto.build.stack.bazel.bzlmod.v1.RepositoryMetadata');

/**
 * @typedef {{
 *   name: string,
 *   sanitizedName: string,
 *   percentage: number,
 *   isPrimary: boolean
 * }}
 */
let LanguageData;


/**
 * Sanitize a language name for use as a CSS identifier
 * Matches the logic in pkg/css/identifier.go SanitizeIdentifier
 * @param {string} name
 * @return {string}
 */
function sanitizeLanguageName(name) {
    // Replace spaces and special characters
    let sanitized = name
        .replace(/ /g, '-')
        .replace(/\+/g, 'plus')
        .replace(/#/g, 'sharp');

    // Remove any remaining invalid characters (keep only alphanumeric, hyphen, underscore)
    sanitized = sanitized.replace(/[^a-zA-Z0-9\-_]/g, '');

    return sanitized;
}
exports.sanitizeLanguageName = sanitizeLanguageName;


/**
 * Unsanitize a language name from CSS identifier back to original form
 * Reverses the logic in sanitizeLanguageName
 * @param {string} sanitizedName
 * @return {string}
 */
function unsanitizeLanguageName(sanitizedName) {
    // Reverse the replacements
    let unsanitized = sanitizedName
        .replace(/sharp/g, '#')
        .replace(/plus/g, '+')
        .replace(/-/g, ' ');

    return unsanitized;
}
exports.unsanitizeLanguageName = unsanitizeLanguageName;


/**
 * Compute language breakdown data from repository metadata
 * @param {?RepositoryMetadata} repoMetadata
 * @return {!Array<!LanguageData>}
 */
function computeLanguageData(repoMetadata) {
    const languageData = /** @type {!Array<!LanguageData>} */([]);
    if (!repoMetadata) {
        return languageData;
    }

    const languagesMap = repoMetadata.getLanguagesMap();
    let total = 0;
    for (const lang of languagesMap.keys()) {
        total += languagesMap.get(lang);
    }

    if (total > 0) {
        for (const lang of languagesMap.keys()) {
            const count = languagesMap.get(lang);
            const percentage = Math.round((count * 1000) / total) / 10;
            languageData.push({
                name: lang,
                sanitizedName: sanitizeLanguageName(lang),
                percentage: percentage,
                isPrimary: lang === repoMetadata.getPrimaryLanguage()
            });
        }
        // Sort by percentage descending, primary first
        languageData.sort((a, b) => {
            if (a.isPrimary) return -1;
            if (b.isPrimary) return 1;
            return b.percentage - a.percentage;
        });
    }

    return languageData;
}
exports.computeLanguageData = computeLanguageData;