// graph.json without what legitimately differs between machines: timestamps, timings and the absolute
// project roots (replaced by <backend> / <frontend> wherever they appear, in either slash style).
// Usage: node normalize-graph.mjs <graph.json> <out.json>
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
const graph = JSON.parse(fs.readFileSync(input, 'utf8'));
const { backendRoot, frontendRoot } = graph.meta;
for (const key of ['generatedAt', 'durationMs', 'timings', 'backendRoot', 'frontendRoot']) delete graph.meta[key];
let text = JSON.stringify(graph, null, 1);
for (const [root, label] of [
  [backendRoot, '<backend>'],
  [frontendRoot, '<frontend>'],
]) {
  if (!root) continue;
  for (const form of new Set([root, root.replace(/\//g, '\\\\'), root.replace(/\//g, '\\')])) text = text.split(form).join(label);
}
fs.writeFileSync(output, text + '\n');
