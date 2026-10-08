export interface StoredObject {
  body: string;
  etag: string;
}

export type PutCondition = { ifMatch: string } | { ifNoneMatch: true };

/** Thrown when a conditional write loses a race; the caller re-reads and retries. */
export class PreconditionFailed extends Error {
  constructor() {
    super('precondition failed');
  }
}

/** The slice of S3 the sync logic needs, so it can run against memory in tests and dev. */
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  /** Returns the new ETag. Throws PreconditionFailed when the condition does not hold. */
  put(key: string, body: string, cond: PutCondition): Promise<string>;
  list(prefix: string): Promise<{ key: string; etag: string }[]>;
}

export class MemoryStore implements ObjectStore {
  objects = new Map<string, StoredObject>();
  private n = 0;

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async put(key: string, body: string, cond: PutCondition) {
    const cur = this.objects.get(key);
    if ('ifNoneMatch' in cond ? cur : cur?.etag !== cond.ifMatch) throw new PreconditionFailed();
    const etag = `"m${++this.n}"`;
    this.objects.set(key, { body, etag });
    return etag;
  }

  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, etag: o.etag }));
  }
}
