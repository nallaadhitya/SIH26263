const { JsonStore } = require('./json-store');
const { MySqlStore } = require('./mysql-store');
function createStorage({ driver = process.env.STORAGE_DRIVER, ...options } = {}) {
  if (driver === 'json' && process.env.NODE_ENV !== 'production') return new JsonStore(options);
  if (driver === 'mysql') return new MySqlStore(options);
  throw new Error('Set STORAGE_DRIVER explicitly to mysql (or json for isolated local use)');
}
module.exports = { createStorage };
