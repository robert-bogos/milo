// Runs one discovery load and prints the sample as JSON. See isolatedDiscoveryRun in runner.js.
import { discoveryRun } from './runner.js';

const [url, config] = process.argv.slice(2);
const sample = await discoveryRun(url, { config: JSON.parse(config) });
process.stdout.write(`${JSON.stringify(sample)}\n`);
