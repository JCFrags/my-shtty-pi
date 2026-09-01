export class OrchestratorError extends Error {
    code;
    retryable;
    details;
    remediation;
    constructor(code, message, options = {}) {
        super(message);
        this.name = "OrchestratorError";
        this.code = code;
        this.retryable = options.retryable ?? false;
        this.details = options.details;
        this.remediation = options.remediation;
    }
}
export function safeError(error) {
    return error instanceof OrchestratorError
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR", message: "The operation failed." };
}
