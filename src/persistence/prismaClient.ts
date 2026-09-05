import { PrismaClient } from '@prisma/client';
import { ConfigData } from '@bot/configurations/configData';
import { Logger } from '@domain/logger';

export const isTransientDbError = (err: unknown): boolean => {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
  return (
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1017' ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('connection closed') ||
    msg.includes('Connection terminated') ||
    msg.includes("Can't reach database server")
  );
};

export async function withDbRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (isTransientDbError(err) && attempt < maxRetries) {
        const delay = Math.min(250 * Math.pow(2, attempt - 1), 2000);
        Logger.warn(`Transient database error (${(err as Error)?.message ?? 'network'}), retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function checkDatabaseHealth(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { healthy: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const basePrisma = new PrismaClient({
  datasources: {
    db: { url: ConfigData.Data.database.connectionString },
  },
});

export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        return withDbRetry(() => query(args));
      },
    },
  },
}) as unknown as PrismaClient;
