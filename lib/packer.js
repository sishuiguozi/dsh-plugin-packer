/**
 * Profile inventory plus export/import for DSH plugin packages.
 *
 * A DSH plugin is a package the profile depends on that declares dsh.bundle
 * (a Cordis patch layer) or dsh.client (a browser half). Such a package is
 * only self-contained when its dependency closure travels with it: the
 * profile uses a hoisted node_modules, so a plugin's runtime dependencies are
 * siblings in that same tree, and a portable archive has to carry them.
 *
 * Everything here is pure filesystem work on the profile directory; the HTTP
 * layer in ./index.js owns requests and the plugin-manager service.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';

/** Archive format marker; import refuses anything else. */
export const PACK_FORMAT = 'dsh-plugin-pack';
/** Format this packer emits. 2 adds the optional runtime-asset block; a pack
 * without assets is still written as format 1, so an archive stays readable by
 * tooling that predates the asset block. */
export const PACK_FORMAT_VERSION = 2;
/** Formats this packer accepts on import. */
export const ACCEPTED_FORMAT_VERSIONS = Object.freeze([1, 2]);
/** Package names npm accepts; also the path-traversal guard for imports. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function tryReadJson(file) {
  try {
    return readJson(file);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a package directory the way Node resolves a specifier from fromDir.
 * @param {string} fromDir - directory the resolution starts at.
 * @param {string} name - package name.
 * @returns {string | null} canonical package directory, or null when absent.
 */
export function resolvePackageDir(fromDir, name) {
  let current = fromDir;
  for (;;) {
    const candidate = join(current, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Recursively list regular files below a directory. Symbolic links are
 * skipped: a link either points inside the same package (already listed) or
 * outside the archive boundary, and following it would make the export
 * non-portable.
 * @param {string} dir - absolute directory.
 * @param {number} [limit] - maximum files to collect.
 * @param {{ includeFile: (relPath: string) => boolean, includeDir: (relDir: string) => boolean } | null} [filter] - optional
 *   allow-list applied while walking; a rejected directory is never entered.
 * @returns {{ path: string, size: number, mtime: Date }[]} relative files.
 */
export function listFiles(dir, limit = 200000, filter = null) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) break;
    const absolute = relDir === '' ? dir : join(dir, relDir);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : relDir + '/' + entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (filter !== null && !filter.includeDir(relPath)) continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (filter !== null && !filter.includeFile(relPath)) continue;
      let stat;
      try {
        stat = statSync(join(dir, relPath));
      } catch {
        continue;
      }
      files.push({ path: relPath, size: stat.size, mtime: stat.mtime });
      if (files.length >= limit) return files;
    }
  }
  return files;
}

/**
 * Translate one npm-style glob into a regular expression.
 * Only `*` (within a path segment), `**` (across segments) and `?` are
 * supported, which is the whole syntax plugin `files` lists actually use.
 * @param {string} pattern - glob such as `lib/types/**\/*.d.ts`.
 * @returns {RegExp} anchored expression.
 */
function globToRegExp(pattern) {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += '\\' + char;
    } else {
      out += char;
    }
  }
  return new RegExp(out + '$');
}

/**
 * Build the walk filter for one package's `files` allow-list.
 *
 * Export used to archive the whole installed directory, which is wrong for a
 * package installed as a `link:` to a working tree: this very plugin measures
 * 240 MB on disk because of its build caches, and every export dragged all of
 * it into the zip. npm itself only installs `files`, so honouring it is both
 * correct and much smaller. A package without `files` keeps the old
 * everything-but-symlinks behaviour.
 * @param {any} manifest - the package manifest (only `files` is read).
 * @returns {{ includeFile: (relPath: string) => boolean, includeDir: (relDir: string) => boolean } | null} filter.
 */
export function filesFilter(manifest) {
  const declared = Array.isArray(manifest?.files)
    ? manifest.files.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    : [];
  if (declared.length === 0) return null;
  const patterns = declared.map((entry) => {
    const normalized = entry.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
    return { entry: normalized, regex: /[*?]/.test(normalized) ? globToRegExp(normalized) : null };
  });
  /* npm always ships these regardless of `files`. */
  const alwaysFile = /^(?:readme|license|licence|changelog|history|notice)(?:\.[A-Za-z0-9]+)?$/;
  const includeFile = (relPath) => {
    if (relPath === 'package.json') return true;
    if (!relPath.includes('/') && alwaysFile.test(relPath)) return true;
    for (const pattern of patterns) {
      if (pattern.regex !== null) {
        if (pattern.regex.test(relPath)) return true;
      } else if (relPath === pattern.entry || relPath.startsWith(pattern.entry + '/')) {
        return true;
      }
    }
    return false;
  };
  const includeDir = (relDir) => {
    if (relDir === '') return true;
    for (const pattern of patterns) {
      if (pattern.regex !== null) {
        /* A glob reaches anything below its literal prefix, so only a
         * directory disjoint from that prefix can be pruned. */
        const literal = pattern.entry.split(/[*?]/)[0];
        const prefix = literal.includes('/') ? literal.slice(0, literal.lastIndexOf('/')) : '';
        if (prefix === '' || prefix === relDir || prefix.startsWith(relDir + '/') || relDir.startsWith(prefix + '/')) return true;
        continue;
      }
      if (pattern.entry === relDir || pattern.entry.startsWith(relDir + '/') || relDir.startsWith(pattern.entry + '/')) return true;
    }
    return false;
  };
  return { includeFile, includeDir };
}

/** Directory-size cache keyed by absolute path and mtime. */
const sizeCache = new Map();

/**
 * Measure a package directory, reusing a cached result while its mtime holds.
 * @param {string} dir - absolute package directory.
 * @returns {{ bytes: number, files: number, newest: number }} aggregate size,
 *   file count, and the newest file mtime (epoch ms) seen while walking.
 */
export function measureDir(dir) {
  let stamp = 0;
  try {
    stamp = statSync(dir).mtimeMs;
  } catch {
    return { bytes: 0, files: 0, newest: 0 };
  }
  const cached = sizeCache.get(dir);
  if (cached !== undefined && cached.stamp === stamp) return cached.value;
  const files = listFiles(dir);
  let bytes = 0;
  let newest = 0;
  for (const file of files) {
    bytes += file.size;
    const stampOfFile = file.mtime instanceof Date ? file.mtime.getTime() : 0;
    if (stampOfFile > newest) newest = stampOfFile;
  }
  const value = { bytes, files: files.length, newest };
  sizeCache.set(dir, { stamp, value });
  return value;
}

/**
 * Read the two dates a catalogue row shows: when this package directory
 * appeared in the profile, and when its manifest last changed.
 *
 * Birth time is the honest "installed at" on a copy/import (Windows and
 * macOS keep it, Linux reports 0), so it is preferred and mtime is the
 * fallback for filesystems that cannot say.
 * @param {string} dir - absolute package directory.
 * @returns {{ installedAt: string | null, manifestAt: string | null }} ISO dates.
 */
export function readPackageDates(dir) {
  const stamps = (file) => {
    try {
      const info = statSync(file);
      return {
        born: Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs,
        modified: info.mtimeMs,
      };
    } catch {
      return { born: 0, modified: 0 };
    }
  };
  const manifest = stamps(join(dir, 'package.json'));
  const root = stamps(dir);
  const born = manifest.born > 0 ? manifest.born : root.born;
  return {
    installedAt: born > 0 ? new Date(born).toISOString() : null,
    manifestAt: manifest.modified > 0 ? new Date(manifest.modified).toISOString() : null,
  };
}

/**
 * Read the profile manifest and the bundle roster it declares.
 * @param {string} profileDir - absolute profile directory.
 * @returns {{ manifest: any, dependencies: Record<string, string>, bundles: Set<string> }} profile facts.
 */
export function readProfileFacts(profileDir) {
  const manifest = readJson(join(profileDir, 'package.json'));
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const bundles = new Set(Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []);
  return { manifest, dependencies, bundles };
}

/**
 * Whether a package manifest describes an installable DSH plugin.
 * @param {any} manifest - package.json contents.
 * @returns {boolean} true when the package declares a bundle patch or a client half.
 */
export function isPluginManifest(manifest) {
  return manifest?.dsh?.bundle !== undefined || manifest?.dsh?.client !== undefined;
}

/** Sort keys the catalogue understands. */
export const SORT_KEYS = Object.freeze(['name', 'installed', 'updated', 'size', 'status', 'version']);

/**
 * Build the catalogue the settings tab renders. Rows split three ways: plugin
 * packages present in the profile (exportable), plugin dependencies that ship
 * inside the application bundle (visible but not exportable, because their
 * bytes are not on the profile filesystem), and ordinary dependencies, which
 * are omitted because they are not plugins.
 *
 * Every row carries the two dates the tab shows (`installedAt` = when the
 * directory appeared, `updatedAt` = newest file mtime) so the caller can sort
 * and label without a second pass over the disk.
 * @param {string} profileDir - absolute profile directory.
 * @param {{ sort?: string, order?: 'asc' | 'desc' }} [options] - ordering.
 * @returns {{ profile: string, sort: string, order: 'asc' | 'desc', rows: any[] }} catalogue.
 */
export function listPlugins(profileDir, options = {}) {
  const { dependencies, bundles } = readProfileFacts(profileDir);
  const rows = [];
  const seen = new Set();
  const modulesRoot = join(profileDir, 'node_modules');
  /**
   * A package whose real path sits outside `node_modules` was installed as a
   * link (`link:` dependency, junction or symlink) and points at a working
   * tree. Its directory size then includes build caches, asset sources and
   * deliverables that never ship, so the tab labels it instead of implying the
   * plugin itself is that large.
   */
  const isLinked = (dir) => {
    const rel = relative(modulesRoot, dir);
    return rel === '' || rel.startsWith('..') || isAbsolute(rel);
  };
  const pushMeasured = (dir, row) => {
    if (dir === null) {
      rows.push(row);
      return;
    }
    const measured = measureDir(dir);
    const dates = readPackageDates(dir);
    const newest = Math.max(measured.newest, dates.manifestAt === null ? 0 : Date.parse(dates.manifestAt));
    rows.push({
      ...row,
      bytes: measured.bytes,
      files: measured.files,
      linked: isLinked(dir),
      installedAt: dates.installedAt,
      updatedAt: newest > 0 ? new Date(newest).toISOString() : null,
    });
  };
  for (const [name, range] of Object.entries(dependencies)) {
    seen.add(name);
    const dir = resolvePackageDir(profileDir, name);
    if (dir === null) {
      pushMeasured(null, {
        name,
        range,
        version: null,
        installed: false,
        exportable: false,
        reason: 'bundled-in-app',
        bundle: null,
        client: null,
        enabled: false,
        description: null,
        bytes: null,
        files: null,
        installedAt: null,
        updatedAt: null,
      });
      continue;
    }
    const manifest = tryReadJson(join(dir, 'package.json'));
    if (!isPluginManifest(manifest)) continue;
    pushMeasured(dir, {
      name,
      range,
      version: manifest.version ?? null,
      installed: true,
      exportable: true,
      reason: null,
      bundle: manifest.dsh?.bundle !== undefined,
      client: manifest.dsh?.client !== undefined,
      enabled: bundles.has(name),
      description: typeof manifest.description === 'string' ? manifest.description : null,
    });
  }
  /* Bundles the profile enables but does not depend on come from the
   * application itself (the shipped @deepseek-ai layers). They are listed so
   * the catalogue is complete; their bytes are not on the profile disk. */
  for (const name of bundles) {
    if (seen.has(name)) continue;
    const dir = resolvePackageDir(profileDir, name);
    if (dir === null) {
      pushMeasured(null, {
        name,
        range: null,
        version: null,
        installed: false,
        exportable: false,
        reason: 'bundled-in-app',
        bundle: true,
        client: null,
        enabled: true,
        description: null,
        bytes: null,
        files: null,
        installedAt: null,
        updatedAt: null,
      });
      continue;
    }
    const manifest = tryReadJson(join(dir, 'package.json'));
    pushMeasured(dir, {
      name,
      range: null,
      version: manifest?.version ?? null,
      installed: true,
      exportable: isPluginManifest(manifest),
      reason: isPluginManifest(manifest) ? null : 'not-a-plugin',
      bundle: manifest?.dsh?.bundle !== undefined,
      client: manifest?.dsh?.client !== undefined,
      enabled: true,
      description: typeof manifest?.description === 'string' ? manifest.description : null,
    });
  }
  const sort = SORT_KEYS.includes(options.sort) ? options.sort : 'updated';
  const order = options.order === 'asc' || options.order === 'desc'
    ? options.order
    : sort === 'name' || sort === 'status' || sort === 'version' ? 'asc' : 'desc';
  const sortValue = (row) => {
    switch (sort) {
      case 'name': return row.name.toLowerCase();
      case 'installed': return row.installedAt === null ? -1 : Date.parse(row.installedAt);
      case 'updated': return row.updatedAt === null ? -1 : Date.parse(row.updatedAt);
      case 'size': return row.bytes ?? -1;
      case 'status': return row.exportable ? (row.enabled ? 0 : 1) : 2;
      case 'version': return row.version ?? '';
      default: return 0;
    }
  };
  rows.sort((left, right) => {
    const a = sortValue(left);
    const b = sortValue(right);
    const primary = typeof a === 'string' ? a.localeCompare(b) : a - b;
    if (primary !== 0) return order === 'desc' ? -primary : primary;
    /* A tie keeps exportable rows above application-bundled ones, then falls
     * back to the name so the list never reshuffles between refreshes. */
    const rank = (row) => (row.exportable ? (row.enabled ? 0 : 1) : 2);
    return rank(left) - rank(right) || left.name.localeCompare(right.name);
  });
  return { profile: profileDir, sort, order, rows };
}

/**
 * Expand one plugin into its dependency closure. Dependencies are followed
 * through dependencies and through resolvable optionalDependencies /
 * peerDependencies. Anything that does not resolve inside the profile ships
 * with the application itself and is recorded as host-provided, not copied.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} rootName - package name of the plugin to expand.
 * @param {string | null} [knownDir] - directory of the root package when it is
 *   not installed in the profile (packing a plugin source tree).
 * @returns {{ root: any, packages: any[], hostProvided: any[] }} closure.
 */
export function expandClosure(profileDir, rootName, knownDir = null) {
  const rootDir = knownDir ?? resolvePackageDir(profileDir, rootName);
  if (rootDir === null) throw new Error('plugin "' + rootName + '" is not installed in this profile');
  const rootManifest = tryReadJson(join(rootDir, 'package.json'));
  if (!isPluginManifest(rootManifest)) throw new Error('package "' + rootName + '" is not a DSH plugin');
  const packages = new Map();
  const hostProvided = new Map();
  const pending = [{ name: rootName, from: profileDir, requiredBy: null, dir: rootDir }];
  while (pending.length > 0) {
    const item = pending.shift();
    if (item === undefined) break;
    const dir = item.dir ?? resolvePackageDir(item.from, item.name);
    const manifest = dir === null ? undefined : tryReadJson(join(dir, 'package.json'));
    if (dir === null || manifest === undefined) {
      const known = hostProvided.get(item.name);
      if (known === undefined) hostProvided.set(item.name, { name: item.name, requiredBy: [item.requiredBy] });
      else if (item.requiredBy !== null && !known.requiredBy.includes(item.requiredBy)) known.requiredBy.push(item.requiredBy);
      continue;
    }
    if (packages.has(dir)) continue;
    const dependencies = manifest.dependencies ?? {};
    const optional = manifest.optionalDependencies ?? {};
    const peers = manifest.peerDependencies ?? {};
    const peerMeta = manifest.peerDependenciesMeta ?? {};
    const owner = manifest.name ?? item.name;
    packages.set(dir, {
      name: owner,
      version: typeof manifest.version === 'string' ? manifest.version : null,
      dir,
      dependencies,
      /* Kept so planArchive can honour the package's own `files` allow-list. */
      files: Array.isArray(manifest.files) ? manifest.files : null,
    });
    for (const depName of Object.keys(dependencies)) pending.push({ name: depName, from: dir, requiredBy: owner });
    for (const depName of Object.keys(optional)) pending.push({ name: depName, from: dir, requiredBy: owner });
    for (const depName of Object.keys(peers)) {
      if (peerMeta[depName]?.optional === true && resolvePackageDir(dir, depName) === null) continue;
      pending.push({ name: depName, from: dir, requiredBy: owner });
    }
  }
  const list = [...packages.values()];
  list.sort((left, right) => (left.name === rootName ? -1 : right.name === rootName ? 1 : left.name.localeCompare(right.name)));
  return {
    root: {
      name: rootName,
      version: rootManifest.version ?? null,
      bundle: rootManifest.dsh?.bundle !== undefined,
      client: rootManifest.dsh?.client !== undefined,
    },
    packages: list,
    hostProvided: [...hostProvided.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Compute the archive layout for a closure.
 * @param {string} profileDir - absolute profile directory.
 * @param {{ packages: any[] }} closure - expanded closure.
 * @returns {{ relative: (dir: string) => string, sources: any[], total: number, files: number }} archive plan.
 */
export function planArchive(profileDir, closure) {
  const modulesRoot = join(profileDir, 'node_modules');
  const relativeByDir = new Map();
  for (const entry of closure.packages) {
    const relInside = relative(modulesRoot, entry.dir);
    /* A package linked from another drive makes relative() return an absolute
     * path; that is not portable, so the archive keeps the package name. */
    const portable = relInside !== '' && !isAbsolute(relInside) && !relInside.startsWith('..') && !relInside.includes(sep + '.pnpm');
    relativeByDir.set(entry.dir, posix.join('packages', (portable ? relInside : entry.name).split(sep).join('/')));
  }
  const sources = [];
  let total = 0;
  for (const entry of closure.packages) {
    const prefix = relativeByDir.get(entry.dir);
    const filter = filesFilter({ files: entry.files });
    for (const file of listFiles(entry.dir, 200000, filter)) {
      sources.push({ name: prefix + '/' + file.path, file: join(entry.dir, file.path), size: file.size, mtime: file.mtime });
      total += file.size;
    }
  }
  return { relative: (dir) => relativeByDir.get(dir) ?? posix.join('packages', dir), sources, total, files: sources.length };
}

/**
 * Build the manifest stored at the archive root.
 * @param {any} closure - expanded closure.
 * @param {any} plan - archive plan.
 * @param {{ profileName: string, enabled: boolean, generatorVersion: string }} info - profile facts.
 * @returns {any} manifest object.
 */
export function buildManifest(closure, plan, info) {
  const assets = Array.isArray(info.assets) ? info.assets : [];
  return {
    format: PACK_FORMAT,
    // Additive: only a pack that carries runtime assets needs format 2.
    formatVersion: assets.length === 0 ? 1 : PACK_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    generator: { name: 'dsh-plugin-packer', version: info.generatorVersion },
    profile: { name: info.profileName },
    root: { ...closure.root, enabled: info.enabled },
    packages: closure.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      path: plan.relative(entry.dir),
      dependencies: entry.dependencies,
    })),
    hostProvided: closure.hostProvided,
    assets,
    totals: {
      packages: closure.packages.length,
      files: plan.files,
      bytes: plan.total,
      assets: assets.length,
      assetBytes: assets.reduce((sum, asset) => sum + (asset?.totals?.bytes ?? 0), 0),
      assetFiles: assets.reduce((sum, asset) => sum + (asset?.totals?.files ?? 0), 0),
    },
  };
}

/**
 * Sanitize an archive entry name into a path below the extraction root.
 * @param {string} name - entry name from the archive.
 * @returns {string | null} safe POSIX-relative path, or null when unacceptable.
 */
export function safeEntryPath(name) {
  if (name.includes('\\')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null;
  const normalized = posix.normalize(name);
  if (normalized === '.' || normalized === '..') return null;
  if (normalized.startsWith('../')) return null;
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

/**
 * Extract an archive into a fresh directory.
 * @param {string} targetDir - directory to extract into (created).
 * @param {{ name: string, directory: boolean, data: Buffer }[]} members - archive members.
 * @returns {Promise<number>} number of files written.
 */
export async function extractArchive(targetDir, members) {
  await mkdir(targetDir, { recursive: true });
  let written = 0;
  for (const member of members) {
    const safe = safeEntryPath(member.name);
    if (safe === null) throw new Error('archive contains an unsafe path: ' + member.name);
    const destination = join(targetDir, safe.split('/').join(sep));
    if (member.directory) {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, member.data);
    written += 1;
  }
  return written;
}

/**
 * Keep only the newest `keep` backup batches under a backup root.
 *
 * Every import moves the displaced package directories aside, and every asset
 * import moves the displaced environment aside too. On a machine that swaps
 * plugin versions a few times those piles add up to gigabytes, so pruning is
 * part of installing rather than an afterthought. Directories that do not look
 * like our own batches are left alone.
 * @param {string} backupRoot - `<profile>/.plugin-packer/backups`.
 * @param {number} [keep] - batches to retain.
 * @returns {Promise<{ removed: string[], kept: string[] }>} what changed.
 */
export async function pruneBackups(backupRoot, keep = 5) {
  let entries;
  try {
    entries = readdirSync(backupRoot, { withFileTypes: true });
  } catch {
    return { removed: [], kept: [] };
  }
  const batches = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      let stamp = 0;
      try {
        stamp = statSync(join(backupRoot, entry.name)).mtimeMs;
      } catch {
        stamp = 0;
      }
      return { name: entry.name, stamp };
    })
    .sort((left, right) => right.stamp - left.stamp);
  const kept = batches.slice(0, Math.max(0, keep)).map((entry) => entry.name);
  const removed = [];
  for (const batch of batches.slice(Math.max(0, keep))) {
    try {
      await rm(join(backupRoot, batch.name), { recursive: true, force: true });
      removed.push(batch.name);
    } catch {
      /* a locked file keeps its batch; it is retried on the next import */
    }
  }
  return { removed, kept };
}

/**
 * Install an extracted pack into the profile. Existing package directories
 * are moved aside first, so a failed import never destroys the working
 * installation. The profile manifest records the root plugin as a dependency;
 * the caller decides whether the bundle is enabled.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} packDir - directory the archive was extracted into.
 * @param {string} backupRoot - directory that receives displaced packages.
 * @returns {Promise<{ root: any, replaced: string[], installed: string[], manifest: any }>} install report.
 */
export async function installPack(profileDir, packDir, backupRoot) {
  const manifest = tryReadJson(join(packDir, 'manifest.json'));
  if (manifest === undefined) throw new Error('archive has no manifest.json');
  if (manifest.format !== PACK_FORMAT) throw new Error('archive is not a DSH plugin pack (format: ' + String(manifest.format) + ')');
  if (!ACCEPTED_FORMAT_VERSIONS.includes(manifest.formatVersion)) throw new Error('unsupported pack format version ' + String(manifest.formatVersion) + ' (expected one of ' + ACCEPTED_FORMAT_VERSIONS.join(', ') + ')');
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error('archive lists no packages');
  const modulesRoot = join(profileDir, 'node_modules');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const replaced = [];
  const installed = [];
  for (const entry of manifest.packages) {
    if (typeof entry?.name !== 'string' || !PACKAGE_NAME.test(entry.name)) throw new Error('archive lists an invalid package name: ' + String(entry?.name));
    if (typeof entry?.path !== 'string') throw new Error('archive entry for ' + entry.name + ' has no path');
    const safe = safeEntryPath(entry.path);
    if (safe === null) throw new Error('archive lists an unsafe package path: ' + entry.path);
    const source = join(packDir, safe.split('/').join(sep));
    if (!existsSync(join(source, 'package.json'))) throw new Error('archive is missing package contents for ' + entry.name);
    const destination = join(modulesRoot, entry.name.split('/').join(sep));
    if (existsSync(destination)) {
      const backup = join(backupRoot, stamp, entry.name.split('/').join(sep));
      await mkdir(dirname(backup), { recursive: true });
      await rename(destination, backup);
      replaced.push(entry.name);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true });
    installed.push(entry.name);
  }
  const profileManifest = readJson(join(profileDir, 'package.json'));
  const dependencies = { ...(profileManifest.dependencies ?? {}) };
  if (typeof manifest.root?.name === 'string') {
    const version = manifest.root.version;
    dependencies[manifest.root.name] = typeof version === 'string' ? '^' + version : '*';
  }
  profileManifest.dependencies = dependencies;
  await writeFile(join(profileDir, 'package.json'), JSON.stringify(profileManifest, null, 2) + '\n');
  return { root: manifest.root, replaced, installed, manifest, packDir, formatVersion: manifest.formatVersion };
}
