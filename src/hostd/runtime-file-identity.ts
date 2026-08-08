/**
 * The stable fields used to fence a regular-file read against path replacement
 * and concurrent content mutation. Windows ChangeTime (`ctimeNs`) is kept as a
 * strict field: a metadata refresh may trigger one new, complete read, but the
 * accepted read must observe every field as stable from open through close.
 */
export interface RuntimeFileIdentity {
  isFile(): boolean;
  readonly nlink: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export type RuntimeFileIdentityField =
  | "fileType"
  | "nlink"
  | "dev"
  | "ino"
  | "size"
  | "mtimeNs"
  | "ctimeNs";

export class RuntimeFileIdentityChangedError extends Error {
  readonly changedFields: readonly RuntimeFileIdentityField[];

  constructor(message: string, changedFields: readonly RuntimeFileIdentityField[]) {
    super(message);
    this.name = "RuntimeFileIdentityChangedError";
    this.changedFields = Object.freeze([...changedFields]);
  }
}

export function assertSameRuntimeFileIdentity(
  left: RuntimeFileIdentity,
  right: RuntimeFileIdentity,
  message: string,
): void {
  const changedFields: RuntimeFileIdentityField[] = [];
  if (!right.isFile()) changedFields.push("fileType");
  if (right.nlink !== 1n) changedFields.push("nlink");
  if (left.dev !== right.dev) changedFields.push("dev");
  if (left.ino !== right.ino) changedFields.push("ino");
  if (left.size !== right.size) changedFields.push("size");
  if (left.mtimeNs !== right.mtimeNs) changedFields.push("mtimeNs");
  if (left.ctimeNs !== right.ctimeNs) changedFields.push("ctimeNs");
  if (changedFields.length > 0) {
    throw new RuntimeFileIdentityChangedError(message, changedFields);
  }
}

export function isCtimeOnlyRuntimeFileIdentityChange(
  error: unknown,
): error is RuntimeFileIdentityChangedError {
  return error instanceof RuntimeFileIdentityChangedError &&
    error.changedFields.length === 1 &&
    error.changedFields[0] === "ctimeNs";
}

/**
 * A Cloud Files provider may hydrate a placeholder during the first read and
 * update only Windows ChangeTime. Retry that exact operation once so the
 * accepted pass still proves a stable ctime, identity, size, mtime, and digest.
 * Any other drift fails immediately; a second ctime drift is returned to the
 * caller for typed transient classification.
 */
export async function retryOnceAfterCtimeOnlyIdentityChange<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isCtimeOnlyRuntimeFileIdentityChange(error)) throw error;
  }
  return await operation();
}
