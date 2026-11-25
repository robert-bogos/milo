// Runs one discovery load and prints the sample as JSON. See isolatedDiscoveryRun in runner.js.
import { lighthouseRun } from './runner.js';

const [url, config] = process.argv.slice(2);
const sample = await lighthouseRun(url, { config: JSON.parse(config), discovery: true });
process.stdout.write(`${JSON.stringify(sample)}\n`);
