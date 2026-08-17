// expense-intake/test/index.test.js
import workerModule from '../src/index.js';

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  const request = new Request('https://expense-intake.example.com/', { method: 'GET' });
  const response = await workerModule.fetch(request, {});
  assert(response.status === 404, 'unrouted requests should 404 until later build steps add real routes');

  console.log('PASS: index.test.js');
}

await main();
