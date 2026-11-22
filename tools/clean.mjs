#!/usr/bin/env node
/**
 * Remove the byte-heavy directories this repository generates.
 *
 * `build/tmp` and `build/dist` are test scratch space: earlier versions of the
 * test suite mounted throwaway DSH homes inside the repository and wrote the
 * exported archives next to the source. A few runs left 2.3 GB of duplicated
 * runtime environments behind. They are never needed to run the plugin and are
 * rebuilt on demand, so `npm run clean` drops them.
 *
 *   node tools/clean.mjs          # build/tmp + build/dist
 *   node tools/clean.mjs --all    # also build/pipenv + build/stage (asset source)
 *
 * `deliver/` is left alone: those zips are hand-made deliverables, not cache.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALL = process.argv.includes('--all');

const targets = ['build/tmp', 'build/dist'];
if (ALL) targets.push('build/pipenv', 'build/stage');

function measure(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        bytes += statSync(absolute).size;
      } catch {
        /* vanished */
      }
    }
  }
  return bytes;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
}

let freed = 0;
for (const relative of targets) {
  const target = join(REPO, ...relative.split('/'));
  if (!existsSync(target)) {
    console.log('skip   ' + relative + ' (不存在)');
    continue;
  }
  const bytes = measure(target);
  try {
    rmSync(target, { recursive: true, force: true });
    freed += bytes;
    console.log('remove ' + relative + ' (' + human(bytes) + ')');
  } catch (error) {
    console.log('kept   ' + relative + ' (' + (error instanceof Error ? error.message : String(error)) + ')');
  }
}
console.log('\n释放 ' + human(freed) + (ALL ? '' : '；加 --all 可同时清理 build/pipenv 与 build/stage（资产源，删除后需重建）'));
