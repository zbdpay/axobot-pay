import fs from "node:fs/promises";
import path from "node:path";

interface SettledTokenRecord {
  chargeId: string;
  paymentHash: string;
  amountSats: number;
  expiresAt: number;
  resource: string;
  verifiedAt: number;
}

interface TokenStoreFile {
  settled: Record<string, SettledTokenRecord>;
}

const emptyStore = (): TokenStoreFile => ({
  settled: {},
});

const readStore = async (filePath: string): Promise<TokenStoreFile> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TokenStoreFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.settled) {
      return emptyStore();
    }
    return {
      settled: parsed.settled,
    };
  } catch {
    return emptyStore();
  }
};

const writeStoreAtomic = async (
  filePath: string,
  store: TokenStoreFile,
): Promise<void> => {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
};

export class FileTokenStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async isSettled(chargeId: string, paymentHash: string): Promise<boolean> {
    const store = await readStore(this.filePath);
    const entry = store.settled[chargeId];
    if (!entry) {
      return false;
    }
    return entry.paymentHash === paymentHash;
  }

  async markSettled(
    record: Omit<SettledTokenRecord, "verifiedAt">,
  ): Promise<void> {
    const store = await readStore(this.filePath);
    store.settled[record.chargeId] = {
      ...record,
      verifiedAt: Math.floor(Date.now() / 1000),
    };
    await writeStoreAtomic(this.filePath, store);
  }
}
