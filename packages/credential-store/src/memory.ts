import type { CredentialBackend } from "./types.js";

/** Test-only backend. Production applications must use an operating-system backend. */
export class MemoryCredentialBackend implements CredentialBackend {
  readonly #values = new Map<string, string>();

  async set(service: string, account: string, secret: string): Promise<void> {
    this.#values.set(`${service}\u0000${account}`, secret);
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.#values.get(`${service}\u0000${account}`) ?? null;
  }

  async delete(service: string, account: string): Promise<void> {
    this.#values.delete(`${service}\u0000${account}`);
  }
}
