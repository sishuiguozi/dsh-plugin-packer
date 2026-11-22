/**
 * dsh-plugin-packer — runtime assets.
 *
 * A plain plugin pack is the plugin plus its node dependency closure. That is
 * enough when everything the plugin needs lives in `node_modules`, and not
 * enough when the real weight lives elsewhere on the machine: a plugin may keep
 * a large tool environment, model files or a data directory under `DSH_HOME`,
 * and then a plain archive reaches the next machine with none of it.
 *
 * A runtime asset closes that gap. It is declared per plugin in
 *
 *   <profile>/.plugin-packer/assets/<plugin>.json
 *
 * staged into the archive under `assets/<id>/…`, and materialised on import by
 * running a command that travels *inside* the asset — no index, no shell, no
 * network. Everything here is filesystem + child-process work; the HTTP layer
 * in ./index.js owns requests.
 *
 * The mechanism is deliberately generic: this module knows nothing about any
 * particular plugin, and a plugin that needs nothing simply has no descriptor.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

/** Where a plugin declares its assets. */
export const DESCRIPTOR_DIR = '.plugin-packer/assets';
/** Archive prefix every staged asset lands under. */
export const ASSET_PREFIX = 'assets';
/** Placeholder keys a descriptor may use in paths, args and env. */
export const PLACEHOLDERS = Object.freeze(['DSH_HOME', 'PROFILE', 'ASSET', 'PLUGIN_DIR']);
/** Assets with an install recipe may not point at the network; refuse these. */
const NETWORK_FLAGS = Object.freeze(['--index-url', '--extra-index-url', '--upgrade', '--refresh']);
const ASSET_ID = /^[a-z0-9][a-z0-9._-]*$/u;
const MAX_CAPTURE = 64 * 1024;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Directory that holds the asset descriptors of this profile.
 * @param {string} profileDir - absolute profile directory.
 * @returns {string} absolute descriptor directory.
 */
export function descriptorDir(profileDir) {
  return join(profileDir, '.plugin-packer', 'assets');
}

/**
 * Read every descriptor in the profile, skipping (and reporting) broken ones:
 * one malformed file must not hide the other plugins' assets.
 * @param {string} profileDir - absolute profile directory.
 * @returns {{ descriptors: any[], errors: { file: string, message: string }[] }} inventory.
 */
export function readDescriptors(profileDir) {
  const dir = descriptorDir(profileDir);
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { descriptors: [], errors: [] };
  }
  const descriptors = [];
  const errors = [];
  for (const name of names) {
    try {
      const raw = readJson(join(dir, name));
      descriptors.push(normalizeDescriptor(raw, name));
    } catch (error) {
      errors.push({ file: name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { descriptors, errors };
}

/**
 * Validate one descriptor file. Only the shape this module consumes is checked;
 * the plugin name is matched against the package being exported by the caller.
 * @param {any} raw - parsed JSON.
 * @param {string} file - descriptor file name, for error messages.
 * @returns {{ plugin: string, assets: any[], file: string }} validated descriptor.
 */
export function normalizeDescriptor(raw, file) {
  if (raw === null || typeof raw !== 'object') throw new Error(file + ': descriptor is not an object');
  const plugin = typeof raw.plugin === 'string' ? raw.plugin.trim() : '';
  if (plugin === '') throw new Error(file + ': "plugin" must name the package these assets belong to');
  if (!Array.isArray(raw.assets) || raw.assets.length === 0) throw new Error(file + ': "assets" must be a non-empty array');
  const assets = raw.assets.map((asset, index) => normalizeAsset(asset, file + '#' + index));
  const ids = new Set();
  for (const asset of assets) {
    if (ids.has(asset.id)) throw new Error(file + ': duplicate asset id "' + asset.id + '"');
    ids.add(asset.id);
  }
  return { plugin, assets, file };
}

/**
 * Validate one asset entry.
 * @param {any} raw - descriptor asset.
 * @param {string} where - label used in error messages.
 * @returns {any} normalized asset.
 */
function normalizeAsset(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new Error(where + ': asset is not an object');
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!ASSET_ID.test(id)) throw new Error(where + ': "id" must match ' + String(ASSET_ID));
  const kind = raw.kind === undefined ? 'offline-env' : raw.kind;
  if (kind !== 'offline-env' && kind !== 'files') throw new Error(where + ': unknown kind "' + String(kind) + '" (expected offline-env or files)');
  const installDir = typeof raw.installDir === 'string' ? raw.installDir.trim() : '';
  if (installDir === '') throw new Error(where + ': "installDir" is required (placeholders allowed)');
  const bundleDir = typeof raw.bundleDir === 'string' ? raw.bundleDir.trim() : '';
  if (bundleDir === '') throw new Error(where + ': "bundleDir" is required: the local directory to stage into the archive');
  const install = raw.install === undefined ? null : normalizeInstall(raw.install, where);
  const postInstall = raw.postInstall === undefined ? null : normalizePostInstall(raw.postInstall, where);
  return {
    id,
    kind,
    label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : id,
    bundleDir,
    installDir,
    install,
    postInstall,
    keep: raw.keep === true,
    excludes: Array.isArray(raw.excludes) ? raw.excludes.filter((entry) => typeof entry === 'string') : [],
  };
}

function normalizeInstall(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new Error(where + ': "install" is not an object');
  const executable = typeof raw.executable === 'string' ? raw.executable.trim() : '';
  if (executable === '') throw new Error(where + ': "install.executable" must name a program inside the asset');
  const args = Array.isArray(raw.args) ? raw.args : [];
  for (const arg of args) if (typeof arg !== 'string') throw new Error(where + ': "install.args" must be strings');
  for (const arg of args) {
    for (const flag of NETWORK_FLAGS) {
      if (arg === flag || arg.startsWith(flag + '=')) throw new Error(where + ': "install.args" may not use ' + flag + ' (offline assets only)');
    }
  }
  const env = {};
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object') throw new Error(where + ': "install.env" is not an object');
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== 'string') throw new Error(where + ': "install.env.' + key + '" must be a string');
      env[key] = value;
    }
  }
  const expect = Array.isArray(raw.expect) ? raw.expect : [];
  for (const entry of expect) if (typeof entry !== 'string') throw new Error(where + ': "install.expect" must be strings');
  const timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) ? Math.max(1000, Math.min(raw.timeoutMs, 30 * 60 * 1000)) : 10 * 60 * 1000;
  return { executable, args: [...args], env, cwd: typeof raw.cwd === 'string' ? raw.cwd : '<ASSET>', expect, timeoutMs };
}

function normalizePostInstall(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new Error(where + ': "postInstall" is not an object');
  const script = typeof raw.script === 'string' ? raw.script.trim() : '';
  if (script === '') throw new Error(where + ': "postInstall.script" must name a file inside the asset');
  const args = Array.isArray(raw.args) ? raw.args : [];
  for (const arg of args) if (typeof arg !== 'string') throw new Error(where + ': "postInstall.args" must be strings');
  const env = {};
  if (raw.env !== undefined) {
    if (raw.env === null || typeof raw.env !== 'object') throw new Error(where + ': "postInstall.env" is not an object');
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value !== 'string') throw new Error(where + ': "postInstall.env.' + key + '" must be a string');
      env[key] = value;
    }
  }
  const timeoutMs = typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) ? Math.max(1000, Math.min(raw.timeoutMs, 10 * 60 * 1000)) : 2 * 60 * 1000;
  return { script, args: [...args], env, timeoutMs };
}

/**
 * List a bundle directory. Directory junctions are followed (uv links a minor
 * Python version to the exact one) and symbol links are skipped, so the staged
 * tree always contains real files.
 * @param {string} root - absolute directory.
 * @param {string[]} excludes - POSIX-relative prefixes to drop.
 * @param {number} [limit] - safety valve for runaway trees.
 * @returns {Promise<{ path: string, size: number, mtime: Date }[]>} relative files.
 */
export async function listBundleFiles(root, excludes = [], limit = 400000) {
  const files = [];
  const stack = [''];
  while (stack.length > 0 && files.length < limit) {
    const relDir = stack.pop();
    const absolute = relDir === '' ? root : join(root, relDir);
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : relDir + '/' + entry.name;
      if (excludes.some((prefix) => relPath === prefix || relPath.startsWith(prefix.replace(/\/+$/u, '') + '/'))) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(join(root, relPath));
        files.push({ path: relPath, size: info.size, mtime: info.mtime });
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return files;
}

/**
 * Stage the assets one plugin declares into archive entries.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} pluginName - package being exported.
 * @returns {Promise<{ entries: any[], sources: any[], totals: { files: number, bytes: number }, errors: string[] }>} staging.
 */
export async function stageAssets(profileDir, pluginName) {
  const { descriptors, errors } = readDescriptors(profileDir);
  /* A descriptor that does not parse would silently export "no assets" — the
   * exact failure this feature exists to prevent. Refuse instead. */
  if (errors.length > 0) {
    throw new Error("asset descriptor(s) unusable in " + DESCRIPTOR_DIR + ": " + errors.map((entry) => entry.file + ": " + entry.message).join("; "));
  }
  const mine = descriptors.filter((descriptor) => descriptor.plugin === pluginName);
  const entries = [];
  const sources = [];
  let files = 0;
  let bytes = 0;
  for (const descriptor of mine) {
    for (const asset of descriptor.assets) {
      if (!existsSync(asset.bundleDir)) throw new Error('asset "' + asset.id + '" points at a missing bundle: ' + asset.bundleDir + ' (declare it in ' + DESCRIPTOR_DIR + '/' + descriptor.file + ')');
      const listed = await listBundleFiles(asset.bundleDir, asset.excludes);
      if (listed.length === 0) throw new Error('asset "' + asset.id + '" bundles no files: ' + asset.bundleDir);
      let assetBytes = 0;
      for (const file of listed) {
        const name = ASSET_PREFIX + '/' + asset.id + '/' + file.path;
        sources.push({ name, file: join(asset.bundleDir, file.path), size: file.size, mtime: file.mtime });
        assetBytes += file.size;
      }
      entries.push({
        id: asset.id,
        kind: asset.kind,
        label: asset.label,
        installDir: asset.installDir,
        keep: asset.keep,
        install: asset.install === null ? null : {
          executable: asset.install.executable,
          args: asset.install.args,
          env: asset.install.env,
          cwd: asset.install.cwd,
          expect: asset.install.expect,
          timeoutMs: asset.install.timeoutMs,
        },
        postInstall: asset.postInstall,
        totals: { files: listed.length, bytes: assetBytes },
      });
      files += listed.length;
      bytes += assetBytes;
    }
  }
  return { entries, sources, totals: { files, bytes }, errors };
}

/**
 * Replace the placeholders a descriptor may use.
 * @param {string} text - raw value.
 * @param {{ home: string, profile: string, asset: string, plugin: string }} ctx - absolute targets.
 * @returns {string} expanded value.
 */
export function expand(text, ctx) {
  let out = String(text);
  const map = { DSH_HOME: ctx.home, PROFILE: ctx.profile, ASSET: ctx.asset, PLUGIN_DIR: ctx.plugin };
  for (const [key, value] of Object.entries(map)) {
    out = out.split('<' + key + '>').join(value);
  }
  return out;
}

/** Expand placeholders in every string of an array / object tree. */
function expandDeep(value, ctx) {
  if (typeof value === 'string') return expand(value, ctx);
  if (Array.isArray(value)) return value.map((entry) => expandDeep(entry, ctx));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = expandDeep(entry, ctx);
    return out;
  }
  return value;
}

/**
 * Install the assets listed by an archive manifest.
 *
 * Order per asset: copy `assets/<id>` into its final `installDir` (the Python
 * interpreter inside it is referenced by `pyvenv.cfg`, so it must live at the
 * final path before the recipe runs), run the recipe, verify `expect` paths,
 * then run the post-install hook.
 *
 * @param {{ packDir: string, profileDir: string, home: string, manifest: any, backupRoot: string, logger?: any }} options - import context.
 * @returns {Promise<any[]>} one report per asset.
 */
export async function installAssets(options) {
  const { packDir, profileDir, home, manifest, backupRoot, logger } = options;
  const listed = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const reports = [];
  for (const entry of listed) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!ASSET_ID.test(id)) throw new Error('archive lists an invalid asset id: ' + String(entry?.id));
    const source = join(packDir, ASSET_PREFIX, id);
    if (!existsSync(source)) throw new Error('archive is missing the payload of asset "' + id + '"');
    const ctx = {
      home,
      profile: profileDir,
      asset: '',
      plugin: join(profileDir, 'node_modules', String(manifest?.root?.name ?? '')),
    };
    const declared = typeof entry.installDir === 'string' ? expand(entry.installDir, { ...ctx, asset: source }) : '';
    if (declared === '' || !isAbsolute(declared)) throw new Error('asset "' + id + '" needs an absolute installDir after placeholder expansion, got: ' + declared);
    const installDir = resolve(declared);
    /* Plugins belong in node_modules; an asset never does. On another drive
     * relative() returns an absolute path, which means "somewhere else" — fine. */
    const relToModules = relative(resolve(profileDir, 'node_modules'), installDir);
    const insideModules = relToModules === '' || (!relToModules.startsWith('..') && !isAbsolute(relToModules));
    if (insideModules) {
      throw new Error('asset "' + id + '" may not install into node_modules (' + installDir + ')');
    }
    ctx.asset = installDir;
    /* Facts the hook cannot guess: which home, which profile, which plugin
     * directory it is finishing. The descriptor may override them, but its
     * defaults must already be right — the importing machine has one truth. */
    const contextEnv = {
      DSH_HOME: home,
      DSH_PROFILE_DIR: profileDir,
      DSH_PLUGIN_DIR: join(profileDir, 'node_modules', String(manifest?.root?.name ?? '')),
      DSH_ASSET_DIR: installDir,
    };
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    let replaced = false;
    if (existsSync(installDir)) {
      const backup = join(backupRoot, 'assets-' + stamp, id);
      await mkdir(join(backup, '..'), { recursive: true });
      try {
        renameSync(installDir, backup);
        replaced = true;
      } catch {
        rmSync(installDir, { recursive: true, force: true });
      }
    }
    await mkdir(installDir, { recursive: true });
    await cp(source, installDir, { recursive: true, dereference: true });
    let install = null;
    if (entry.install !== null && entry.install !== undefined) {
      const executable = resolve(installDir, expand(entry.install.executable, ctx));
      assertInside(installDir, executable, 'asset "' + id + '" executable');
      if (!existsSync(executable)) throw new Error('asset "' + id + '" is missing its installer: ' + executable);
      const cwd = resolve(expand(entry.install.cwd ?? '<ASSET>', ctx));
      const env = {};
      for (const [key, value] of Object.entries(entry.install.env ?? {})) env[key] = expand(value, ctx);
      logger?.info?.('plugin-packer: installing asset ' + id + ' with ' + executable);
      install = await runProcess({
        exe: executable,
        args: (entry.install.args ?? []).map((arg) => expand(arg, ctx)),
        env: { ...contextEnv, ...env },
        cwd,
        timeoutMs: entry.install.timeoutMs ?? 10 * 60 * 1000,
      });
      if (install.code !== 0) {
        throw new Error('asset "' + id + '" installer exited with code ' + install.code + (install.stderrTail === '' ? '' : ': ' + install.stderrTail));
      }
      for (const expected of entry.install.expect ?? []) {
        const target = resolve(expand(expected, ctx));
        if (!existsSync(target)) throw new Error('asset "' + id + '" installer finished but ' + target + ' is missing');
      }
    }
    let postInstall = null;
    if (entry.postInstall !== null && entry.postInstall !== undefined) {
      const script = resolve(installDir, expand(entry.postInstall.script, ctx));
      assertInside(installDir, script, 'asset "' + id + '" post-install script');
      if (!existsSync(script)) throw new Error('asset "' + id + '" is missing its post-install script: ' + script);
      const env = {};
      for (const [key, value] of Object.entries(entry.postInstall.env ?? {})) env[key] = expand(value, ctx);
      logger?.info?.('plugin-packer: activating asset ' + id + ' with ' + script);
      postInstall = await runProcess({
        exe: process.execPath,
        args: [script, ...(entry.postInstall.args ?? []).map((arg) => expand(arg, ctx))],
        env: { ...contextEnv, ...env },
        cwd: installDir,
        timeoutMs: entry.postInstall.timeoutMs ?? 2 * 60 * 1000,
      });
      if (postInstall.code !== 0) {
        throw new Error('asset "' + id + '" post-install hook exited with code ' + postInstall.code + (postInstall.stderrTail === '' ? '' : ': ' + postInstall.stderrTail));
      }
    }
    reports.push({
      id,
      kind: entry.kind ?? 'offline-env',
      label: entry.label ?? id,
      installDir,
      replaced,
      files: entry.totals?.files ?? null,
      bytes: entry.totals?.bytes ?? null,
      install,
      postInstall,
    });
  }
  return reports;
}

/** Reject a path that escapes its asset directory. */
function assertInside(root, target, what) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return;
  throw new Error(what + ' escapes its asset directory: ' + target);
}

/**
 * Run one child process without a shell and capture a bounded tail of its
 * output. The asset's own executables are the only thing spawned.
 * @param {{ exe: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs: number }} options - process.
 * @returns {Promise<{ code: number, stdoutTail: string, stderrTail: string, ms: number }>} result.
 */
export function runProcess(options) {
  const started = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(options.exe, options.args, {
      cwd: existsSync(options.cwd) ? options.cwd : undefined,
      env: { ...process.env, ...options.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_CAPTURE);
    child.stdout?.on('data', (chunk) => {
      stdout = keep(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = keep(stderr, chunk);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      rejectPromise(new Error('timed out after ' + Math.round(options.timeoutMs / 1000) + 's: ' + options.exe));
    }, options.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: typeof code === 'number' ? code : -1,
        stdoutTail: stdout.trim().slice(-2000),
        stderrTail: stderr.trim().slice(-2000),
        ms: Date.now() - started,
      });
    });
  });
}

/**
 * Report the on-disk state of the assets declared in this profile, for the
 * settings tab. Never throws: a broken descriptor is reported, not fatal.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} home - DSH home.
 * @returns {{ descriptors: any[], errors: any[] }} per-asset status.
 */
export function describeAssets(profileDir, home) {
  const { descriptors, errors } = readDescriptors(profileDir);
  const rows = descriptors.map((descriptor) => ({
    plugin: descriptor.plugin,
    file: descriptor.file,
    assets: descriptor.assets.map((asset) => {
      const ctx = { home, profile: profileDir, asset: '', plugin: join(profileDir, 'node_modules', descriptor.plugin) };
      const installDir = isAbsolute(expand(asset.installDir, { ...ctx, asset: '<asset>' })) ? expand(asset.installDir, { ...ctx, asset: join(profileDir, '.plugin-packer-placeholder') }) : '';
      const present = installDir !== '' && existsSync(installDir);
      const expects = (asset.install?.expect ?? []).map((expected) => {
        const target = expand(expected, { ...ctx, asset: installDir });
        return { path: target, ok: existsSync(target) };
      });
      let bytes = null;
      if (existsSync(asset.bundleDir)) bytes = measureSync(asset.bundleDir);
      return {
        id: asset.id,
        label: asset.label,
        kind: asset.kind,
        installDir,
        installed: present,
        ready: present && expects.every((entry) => entry.ok),
        expect: expects,
        bundleDir: asset.bundleDir,
        bundle: bytes,
      };
    }),
  }));
  return { descriptors: rows, errors };
}

/** Cheap recursive byte count, tolerating unreadable entries. */
function measureSync(dir, budget = 200000) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0 && files < budget) {
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
        files += 1;
      } catch {
        /* unreadable */
      }
    }
  }
  return { files, bytes };
}

/** Stable id for a staged bundle, used in logs. */
export function bundleDigest(dir) {
  return createHash('sha256').update(String(dir)).digest('hex').slice(0, 12);
}

/** Write a file, creating its directory. Exported for the build script. */
export async function writeText(file, text) {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, text, 'utf8');
  return file;
}

/** POSIX-style separator helper for archive paths. */
export function posixify(path) {
  return String(path).split(sep).join('/');
}
