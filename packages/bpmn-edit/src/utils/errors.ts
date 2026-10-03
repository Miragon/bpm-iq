/** Failures that name the file or element involved; the CLI prints their message and exits with 2. */
export class BpmnEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BpmnEditError";
  }
}
