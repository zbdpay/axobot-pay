import fs from "node:fs/promises";
import path from "node:path";

export type StoredMppSessionStatus =
  | "open"
  | "paused"
  | "closing"
  | "closed"
  | "refund_failed";

export interface StoredMppSession {
  sessionId: string;
  resource: string;
  realm: string;
  paymentHash: string;
  bearerSecret: string | null;
  chargeId: string;
  status: StoredMppSessionStatus;
  unitAmountSats: number;
  unitType: string | null;
  depositSats: number;
  spentSats: number;
  returnInvoice: string | null;
  returnLightningAddress: string | null;
  openedAt: string;
  lastActivityAt: string;
  idleTimeoutAt: string | null;
  closedAt: string | null;
  refundSats: number | null;
  refundStatus: "pending" | "succeeded" | "failed" | "skipped" | null;
  refundReference: string | null;
}

export interface StoredMppChallenge {
  id: string;
  intent: "charge" | "session";
  realm: string;
  request: string;
  resource: string;
  paymentHash: string;
  chargeId: string;
  amountSats: number;
  depositSats: number;
  expiresAt: number;
  consumed: boolean;
  resultStatus?: number | undefined;
  resultBody?: unknown;
}

export interface MppSessionStore {
  getChallenge(id: string): Promise<StoredMppChallenge | null>;
  saveChallenge(challenge: StoredMppChallenge): Promise<void>;
  getSession(sessionId: string): Promise<StoredMppSession | null>;
  saveSession(session: StoredMppSession): Promise<void>;
}

interface FileStoreShape {
  challenges: Record<string, StoredMppChallenge>;
  sessions: Record<string, StoredMppSession>;
}

const EMPTY_STORE: FileStoreShape = {
  challenges: {},
  sessions: {},
};

async function readStore(filePath: string): Promise<FileStoreShape> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FileStoreShape>;
    return {
      challenges:
        parsed.challenges && typeof parsed.challenges === "object"
          ? (parsed.challenges as Record<string, StoredMppChallenge>)
          : {},
      sessions:
        parsed.sessions && typeof parsed.sessions === "object"
          ? (parsed.sessions as Record<string, StoredMppSession>)
          : {},
    };
  } catch {
    return { ...EMPTY_STORE };
  }
}

async function writeStore(filePath: string, store: FileStoreShape): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export class FileMppSessionStore implements MppSessionStore {
  constructor(private readonly filePath: string) {}

  async getChallenge(id: string): Promise<StoredMppChallenge | null> {
    const store = await readStore(this.filePath);
    return store.challenges[id] ?? null;
  }

  async saveChallenge(challenge: StoredMppChallenge): Promise<void> {
    const store = await readStore(this.filePath);
    store.challenges[challenge.id] = challenge;
    await writeStore(this.filePath, store);
  }

  async getSession(sessionId: string): Promise<StoredMppSession | null> {
    const store = await readStore(this.filePath);
    return store.sessions[sessionId] ?? null;
  }

  async saveSession(session: StoredMppSession): Promise<void> {
    const store = await readStore(this.filePath);
    store.sessions[session.sessionId] = session;
    await writeStore(this.filePath, store);
  }
}
