import fs from 'fs';
import path from 'path';

/**
 * Logs a message to a file based on the log type.
 *
 * @param {string} type - The type of log (error, access, or info).
 * @param {string} source - The source of the log (e.g., the function or module name).
 * @param {string|Error} messageOrError - The message to log, or an error object if the log type is 'error'.
 */
function logMessage(type, source, messageOrError) {
    try {
        const currentTime = new Date().toLocaleString();
        const isError = type === 'error';
        const isInfo = type === 'info'; // Added check for 'info' type
        const formattedMessage = isError
            ? `${currentTime} - Source: ${source}\nError: ${messageOrError?.stack || messageOrError}\n\n`
            : (isInfo
                ? `${currentTime} - Source: ${source}\nInfo: ${messageOrError}\n\n`
                : `${currentTime} - Source: ${source}\nMessage: ${messageOrError}\n\n`);

        // Get the current working directory of the project using process.cwd()
        const logsDir = path.join(process.cwd(), 'logger', 'logs', isError ? 'error' : isInfo ? 'info' : 'access');

        // Ensure the directory exists
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Generate the log file name based on the log type and current date
        const logFileName = `${type}_${formatDate(new Date())}.log`;
        const logFilePath = path.join(logsDir, logFileName);

        // Write the log to the file
        fs.appendFile(logFilePath, formattedMessage, (err) => {
            if (err) {
                console.error('Error writing to log file:', err);
            } else {
                console.log(`${currentTime} Log written to ${type} file`);
            }
        });
    } catch (error) {
        console.error('Unexpected logging error:', error);
    }
}

/**
 * Helper function to format dates in the format YYYY-MM-DD.
 *
 * @param {Date} date - The date to format.
 * @returns {string} The formatted date string.
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export { logMessage };
