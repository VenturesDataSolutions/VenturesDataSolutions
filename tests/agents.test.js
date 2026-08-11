const { readPage, assert, assertCommonChrome } = require('./helpers');

const html = readPage('agents.html');
assertCommonChrome(html, 'Agents');

// Three tiers, each with setup fee + care plan pricing
assert(/Pipeline Basics/.test(html), 'Agents: missing Starter tier');
assert(/Full Pipeline Automation/.test(html), 'Agents: missing Core tier');
assert(/Full Agent Platform/.test(html), 'Agents: missing Full Agent Platform tier');
assert(html.includes('$800') && html.includes('$1,200'), 'Agents: missing Starter setup fee range');
assert(html.includes('$100') && html.includes('$150'), 'Agents: missing Starter care plan range');
assert(html.includes('$1,800') && html.includes('$2,800'), 'Agents: missing Core setup fee range');
assert(html.includes('$250') && html.includes('$400'), 'Agents: missing Core care plan range');
assert(html.includes('$2,800') && html.includes('$4,500'), 'Agents: missing Full Platform setup fee range');
assert(html.includes('$350') && html.includes('$650'), 'Agents: missing Full Platform care plan range');

// Feature callouts required by spec
assert(/showing schedule/i.test(html), 'Agents: missing showing schedule automation feature');
assert(/listing status/i.test(html), 'Agents: missing listing status tracking feature');
assert(/stage-based/i.test(html), 'Agents: missing stage-based follow-up feature');
assert(/multi-agent|small brokerage/i.test(html), 'Agents: missing multi-agent/brokerage support feature');
assert(/disclosure/i.test(html), 'Agents: missing contract/disclosure document handling feature');

// Unstructured data callout
assert(/handwritten notes/i.test(html), 'Agents: missing unstructured-data handling callout');

// Wording safety: must not claim exclusive county leads are part of the Agent platform
assert(!/includes.{0,40}county.{0,20}lead/i.test(html), 'Agents: must not word county leads as included in the platform');
assert(/public.{0,20}records/i.test(html), 'Agents: missing general-public-records distinction');

console.log('PASS: agents.test.js');
