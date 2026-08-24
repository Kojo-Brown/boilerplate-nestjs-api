import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import type { TransactionContext, TransactionRunner } from "./transaction.port";

/** The handle {@link PrismaTransactionRunner} hands to adapters. */
export interface PrismaTransactionContext extends TransactionContext {
  readonly backend: "prisma";
  /**
   * The interactive-transaction client. Every write made through this — and
   * nothing written through the top-level client — is part of the transaction.
   */
  readonly client: Prisma.TransactionClient;
}

export function isPrismaTransaction(tx: TransactionContext): tx is PrismaTransactionContext {
  return tx.backend === "prisma";
}

/**
 * Narrows a handle to the Prisma client inside it, or explains what went wrong.
 *
 * Every Prisma-backed adapter that takes a transaction calls this first. The
 * alternative — a cast — turns a handle from another backend into
 * `undefined.outboxEvent` at the first property access, which says nothing
 * about the actual mistake.
 */
export function requirePrismaTransaction(
  tx: TransactionContext,
  adapter: string,
): Prisma.TransactionClient {
  if (!isPrismaTransaction(tx)) {
    throw new TypeError(
      `${adapter} was given a "${tx.backend}" transaction. It can only write inside a ` +
        `transaction opened by PrismaTransactionRunner.`,
    );
  }
  return tx.client;
}

/**
 * How long the callback may take before Prisma aborts the transaction, and how
 * long `run` waits for a free connection to start one.
 *
 * Prisma's own defaults are 5s and 2s. The timeout is stated here rather than
 * inherited because the callback holds every row it has touched for its whole
 * duration: what the number means is "how long one writer may block every other
 * writer", and that is a decision, not a default.
 */
const TRANSACTION_TIMEOUT_MS = 5_000;
const TRANSACTION_MAX_WAIT_MS = 2_000;

/**
 * The Prisma-backed {@link TransactionRunner}.
 *
 * Interactive transactions rather than `$transaction([...])`: the batch form
 * takes an array of queries built up front, and the outbox needs to write an
 * event whose payload is derived from the row the first write returned.
 */
@Injectable()
export class PrismaTransactionRunner implements TransactionRunner {
  private readonly logger = new Logger(PrismaTransactionRunner.name);

  constructor(private readonly prisma: PrismaService) {}

  async run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const compensations: Array<() => void | Promise<void>> = [];

    try {
      return await this.prisma.$transaction(
        async (client) => {
          const tx: PrismaTransactionContext = {
            backend: "prisma",
            client,
            onRollback: (undo) => {
              compensations.push(undo);
            },
          };
          return work(tx);
        },
        { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
      );
    } catch (error) {
      await this.compensate(compensations);
      throw error;
    }
  }

  /**
   * Runs the registered compensations in reverse order.
   *
   * Each one is caught individually. A compensation that throws is a bug in a
   * participant, and letting it propagate would replace the error the caller
   * actually needs to see — the reason the transaction failed — with a
   * secondary one from the cleanup.
   */
  private async compensate(compensations: Array<() => void | Promise<void>>): Promise<void> {
    for (const undo of [...compensations].reverse()) {
      try {
        await undo();
      } catch (caught: unknown) {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.logger.error(`A rollback compensation failed and was ignored: ${message}`);
      }
    }
  }
}
