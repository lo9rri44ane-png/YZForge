'use strict';
const { isAbsolute, relative } = require('node:path');

/** CLI 与 Creator 共用的附加诊断；message 和既有错误码仍由调用方保留。 */
function diagnostic(code, message, { root, file, ...details } = {}) {
    return {
        code,
        severity: 'error',
        message,
        ...(file === undefined
            ? {}
            : { file: (root && isAbsolute(file) ? relative(root, file) : file).replaceAll('\\', '/') }),
        ...details,
    };
}

function diagnosticsFromError(error, fallbackCode = 'YZ_TOOL_ERROR') {
    if (Array.isArray(error?.diagnostics) && error.diagnostics.length) return error.diagnostics;
    return [diagnostic(typeof error?.code === 'string' ? error.code : fallbackCode, error?.message ?? String(error))];
}

function validationError(message, diagnostics) {
    return Object.assign(Error(message), { diagnostics });
}

module.exports = { diagnostic, diagnosticsFromError, validationError };
