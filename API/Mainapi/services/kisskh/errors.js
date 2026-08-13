class KisskhError extends Error {
  constructor(code, safeMessage, options = {}) {
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'KisskhError';
    this.code = code;
    this.safeMessage = safeMessage;
    if (options.details !== undefined) {
      Object.defineProperty(this, 'details', {
        configurable: false,
        enumerable: false,
        writable: false,
        value: options.details,
      });
    }
  }

  toJSON() {
    return { code: this.code, message: this.safeMessage };
  }
}

module.exports = { KisskhError };
