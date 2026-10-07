import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Personal local storage, outside the repository. A whole-account compromise can read the key too.
export async function createVault(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32' && ((await stat(directory)).mode & 0o077)) throw new Error('Credential directory must be private (mode 700).');
  const keyPath = join(directory, 'key');
  let key;
  try { key = await readFile(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const file = await open(keyPath, 'wx', 0o600);
    try { key = randomBytes(32); await file.writeFile(key); await file.sync(); } finally { await file.close(); }
  }
  if (key.length !== 32 || (process.platform !== 'win32' && ((await stat(keyPath)).mode & 0o077))) throw new Error('Credential key is invalid or not private.');
  const statePath = join(directory, 'state.enc');
  let writes = Promise.resolve();
  return {
    async load() {
      let bytes;
      try { bytes = await readFile(statePath); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      if (bytes.length < 29 || bytes[0] !== 1) throw new Error('Invalid encrypted credential file.');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13), { authTagLength: 16 });
      decipher.setAAD(Buffer.from('better-hall-aircon-v1'));
      decipher.setAuthTag(bytes.subarray(13, 29));
      const records = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
      if (!Array.isArray(records)) throw new Error('Invalid credential records.');
      return records;
    },
    save(records) {
      const plaintext = JSON.stringify(records); // Snapshot now, not later in the write queue.
      const operation = writes.catch(() => {}).then(async () => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        cipher.setAAD(Buffer.from('better-hall-aircon-v1'));
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tmpPath = join(directory, `state-${randomBytes(8).toString('hex')}.tmp`);
        const file = await open(tmpPath, 'wx', 0o600);
        try {
          await file.writeFile(Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]));
          await file.sync(); await file.close(); await rename(tmpPath, statePath);
        } catch (error) { await file.close().catch(() => {}); await unlink(tmpPath).catch(() => {}); throw error; }
      });
      writes = operation; return operation;
    },
  };
}
