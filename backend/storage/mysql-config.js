function mysqlConfig(env = process.env) {
  if (!['127.0.0.1','localhost','::1'].includes(env.MYSQL_HOST || '')
    || !/^[A-Za-z0-9_]{1,64}$/.test(env.MYSQL_DATABASE || '')
    || !env.MYSQL_USER || !env.MYSQL_PASSWORD || !/^\d+$/.test(env.MYSQL_PORT || '')) {
    throw new Error('Explicit local MySQL configuration is required');
  }
  const port = Number(env.MYSQL_PORT);
  if (port < 1 || port > 65535) throw new Error('Invalid MySQL port');
  return { host: env.MYSQL_HOST, port, database: env.MYSQL_DATABASE, user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, connectionLimit: 6, connectTimeout: 5000,
    charset: 'UTF8MB4_BIN', timezone: 'Z', dateStrings: true, multipleStatements: false };
}
module.exports = { mysqlConfig };
