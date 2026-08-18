// expense-intake/test/fake-d1.js
// Mimics the shape of the real D1 binding (env.DB) closely enough to test query-layer
// wiring: prepare(sql).bind(...params).first()/.all()/.run(). Keyed by exact SQL string,
// since src/db.js's queries are fixed, known strings — same call-recording spirit as
// fakeFetch elsewhere in this codebase.
export function createFakeD1(responses = {}) {
  const calls = [];

  function makeStatement(sql) {
    let boundParams = [];
    const statement = {
      bind(...params) {
        boundParams = params;
        return statement;
      },
      async first() {
        calls.push({ sql, params: boundParams, method: 'first' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return value === undefined ? null : value;
      },
      async all() {
        calls.push({ sql, params: boundParams, method: 'all' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return { results: value || [] };
      },
      async run() {
        calls.push({ sql, params: boundParams, method: 'run' });
        const handler = responses[sql];
        const value = typeof handler === 'function' ? handler(boundParams) : handler;
        return value || { success: true, meta: { last_row_id: 1, changes: 1 } };
      },
    };
    return statement;
  }

  return {
    prepare(sql) {
      return makeStatement(sql);
    },
    calls,
  };
}
