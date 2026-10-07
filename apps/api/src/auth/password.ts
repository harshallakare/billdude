/**
 * apps/api/src/auth/password.ts
 *
 * Usage: Argon2id password hashing.
 *
 *   const hash = await hashPassword("s3cret");
 *   const ok = await verifyPassword(hash, "s3cret");
 */
import { hash, verify } from "@node-rs/argon2";

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** A real hash to verify against when the user does not exist, so timing does not reveal valid emails. */
export const DUMMY_HASH = await hashPassword("billdude-timing-equaliser");
