import { NotFoundException } from "@nestjs/common";
import type { User } from "@prisma/client";
import type { UserReader } from "./ports";

/**
 * Reads one user, or answers 404.
 *
 * A function rather than a provider: it closes over nothing, and both sides of
 * the module need it — the read side to answer a query, the write side to
 * evaluate a precondition before it writes. Duplicating four lines in each
 * would be four lines; duplicating the *message* is what would drift, and the
 * e2e suite asserts on it.
 */
export async function requireUser(reader: UserReader, id: string): Promise<User> {
  const user = await reader.findById(id);
  if (!user) throw new NotFoundException(`User ${id} not found`);
  return user;
}
