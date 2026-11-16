/** An error whose message is safe and meant to be shown to the user as-is. */
export class UserError extends Error {
  override name = 'UserError';
}

/** Thrown when a permission check fails inside a service (dashboard routes map it to 403). */
export class PermissionDeniedError extends UserError {
  override name = 'PermissionDeniedError';
  constructor(public readonly node: string) {
    super(`You don't have permission (\`${node}\`).`);
  }
}

export function isUserError(err: unknown): err is UserError {
  return err instanceof UserError;
}
