// Stub until M0 Task 0.5 replaces it with the in-memory Zoho.
export class FakeZoho {
  static create(): Promise<FakeZoho> {
    return Promise.resolve(new FakeZoho());
  }
  fetch: typeof fetch = (input, init) => fetch(input, init);
}
