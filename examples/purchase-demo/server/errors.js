export class DemoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DemoError';
    this.status = status;
    this.code = code;
  }
}
