const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const COLLECTIONS = Object.freeze([
  'users',
  'institutions',
  'programmes',
  'approved-intakes',
  'students',
  'enrolments',
  'validation-issues',
  'verification-records',
  'audit-logs',
]);

class UnknownCollectionError extends Error {
  constructor(collection) {
    super(`Unknown collection: ${collection}`);
    this.name = 'UnknownCollectionError';
  }
}

class DataCorruptionError extends Error {
  constructor(collection) {
    super(`Stored data for collection "${collection}" is not valid JSON.`);
    this.name = 'DataCorruptionError';
  }
}

class JsonStore {
  constructor({ dataDirectory, fileSystem = fs } = {}) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const configuredDirectory = dataDirectory || process.env.DATA_DIR || 'data/local';
    this.dataDirectory = path.isAbsolute(configuredDirectory)
      ? path.resolve(configuredDirectory)
      : path.resolve(projectRoot, configuredDirectory);
    this.fileSystem = fileSystem;
    this.writeQueues = new Map();
    this.initializations = new Map();
  }

  collectionPath(collection) {
    if (!COLLECTIONS.includes(collection)) {
      throw new UnknownCollectionError(collection);
    }

    return path.join(this.dataDirectory, `${collection}.json`);
  }

  async ensureCollection(collection) {
    const filePath = this.collectionPath(collection);
    // Readers and queued writers must await the same initialization. Otherwise a
    // delayed reader can rename its empty file over an already completed write.
    if (this.initializations.has(collection)) return this.initializations.get(collection);
    const pending = (async () => {
      await this.fileSystem.mkdir(this.dataDirectory, { recursive: true });
      try {
        await this.fileSystem.access(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await this._atomicWrite(filePath, []);
      }
    })();
    this.initializations.set(collection, pending);
    try { await pending; }
    finally { if (this.initializations.get(collection) === pending) this.initializations.delete(collection); }
  }

  async readCollection(collection, { initialize = true } = {}) {
    if (initialize) await this.ensureCollection(collection);
    const filePath = this.collectionPath(collection);
    let rawJson;
    try {
      rawJson = await this.fileSystem.readFile(filePath, 'utf8');
    } catch (error) {
      if (!initialize && error.code === 'ENOENT') return [];
      throw error;
    }

    try {
      const data = JSON.parse(rawJson);
      if (!Array.isArray(data)) {
        throw new Error('Collection root must be an array.');
      }
      return data;
    } catch (error) {
      throw new DataCorruptionError(collection);
    }
  }

  async writeCollection(collection, records) {
    this._assertRecords(records);
    return this._runWrite(collection, async () => {
      // Replacement is not a corruption-recovery mechanism. Preserve malformed
      // existing bytes until an operator repairs them explicitly.
      await this.readCollection(collection);
      await this._atomicWrite(this.collectionPath(collection), records);
      return records;
    });
  }

  async updateCollection(collection, updateRecords) {
    if (typeof updateRecords !== 'function') {
      throw new TypeError('updateRecords must be a function.');
    }

    return this._runWrite(collection, async () => {
      const currentRecords = await this.readCollection(collection);
      const nextRecords = await updateRecords(currentRecords);
      this._assertRecords(nextRecords);
      await this._atomicWrite(this.collectionPath(collection), nextRecords);
      return nextRecords;
    });
  }

  _assertRecords(records) {
    if (!Array.isArray(records)) {
      throw new TypeError('Collection data must be an array.');
    }
  }

  // Serialize a coordinated read with this instance's writes without rewriting
  // the collection. Never update the same collection from inside its lock.
  withCollectionLock(collection, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function.');
    return this._runWrite(collection, operation);
  }

  _runWrite(collection, operation) {
    this.collectionPath(collection);
    const previous = this.writeQueues.get(collection) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.writeQueues.set(collection, next);

    return next.finally(() => {
      if (this.writeQueues.get(collection) === next) {
        this.writeQueues.delete(collection);
      }
    });
  }

  async _atomicWrite(filePath, records) {
    const temporaryPath = path.join(
      this.dataDirectory,
      `.${path.basename(filePath)}.${randomUUID()}.tmp`,
    );
    const serializedRecords = `${JSON.stringify(records, null, 2)}\n`;

    try {
      await this.fileSystem.writeFile(temporaryPath, serializedRecords, 'utf8');
      await this.fileSystem.rename(temporaryPath, filePath);
    } catch (error) {
      await this.fileSystem.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

module.exports = {
  COLLECTIONS,
  DataCorruptionError,
  JsonStore,
  UnknownCollectionError,
};
