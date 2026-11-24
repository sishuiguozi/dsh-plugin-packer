/**
 * dsh-plugin-packer host half.
 *
 * One loopback JSON API for the settings tab: list, latest, export, import,
 * assets, health. Beyond the plain export/import pair it adds:
 *
 *   - `assets` on the catalogue rows and in exported manifests, so a plugin
 *     that needs a runtime environment travels with it;
 *   - `GET /api/assets` for the on-disk state of those assets;
 *   - an import that materialises runtime assets after copying the shell;
 *   - dates and ordering (`sort`/`order`) so the tab can show when a plugin was
 *     installed and when it last changed.
 *
 * Import accepts both archive formats (`PACK_FORMAT_VERSION` 1 and 2); export
 * writes format 1 for a plugin without assets, so an archive stays readable by
 * older tooling.
 */
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createZipStream, readZip } from './zip.js';
import {
  PACK_FORMAT_VERSION,
  buildManifest,
  expandClosure,
  extractArchive,
  installPack,
  listPlugins,
  planArchive,
  pruneBackups,
  readProfileFacts,
} from './packer.js';
import { describeAssets, installAssets, stageAssets } from './assets.js';

/** Prefix the settings tab and the browser fetch use. */
const ROUTE_PREFIX = '/plugin-packer';

/** This package's version, recorded in every archive manifest. */
const OWN_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(payload.length),
  });
  response.end(payload);
}

function fail(response, status, message) {
  sendJson(response, status, { ok: false, error: { message } });
}

/**
 * Reject anything that did not arrive over loopback: this API installs code
 * into the profile and must not be reachable from the network.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {boolean} true when the peer is local.
 */
function isLoopback(request) {
  const address = request.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Reject browser requests a foreign page started: a cross-site form or fetch
 * must not reach an API that writes code into the profile.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {boolean} true when the request did not come from another site.
 */
function isSameOrigin(request) {
  const site = request.headers['sec-fetch-site'];
  if (site === undefined) return true;
  return site !== 'cross-site';
}

/**
 * Ask the host's own request gate, when this DSH release publishes one.
 *
 * `ctx.connection.requestRejection(request)` answers 401 or 403 for a request
 * the host would refuse, and `undefined` for one it admits. It is resolved
 * through the service registry rather than declared in `inject`, because the
 * gate arrived in a later release: a plugin that hard-required it would fail
 * to load on an older host instead of falling back to its own checks.
 *
 * A rejection shape this code does not recognise is treated as a refusal —
 * failing closed is the only safe direction for an API that writes packages
 * and files.
 * @param {any} ctx - Cordis context of the host plugin.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {401 | 403 | undefined} status to answer with, or undefined to continue.
 */
function hostRequestRejection(ctx, request) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
    const gate = connection?.requestRejection;
    if (typeof gate !== 'function') return undefined;
    const rejection = gate.call(connection, request);
    if (rejection === undefined || rejection === null) return undefined;
    if (rejection === 401 || rejection === 403) return rejection;
    if (typeof rejection === 'object' && typeof rejection.status === 'number') return rejection.status;
    return 403;
  } catch {
    /* A host without the service, or a gate that throws, keeps our baseline. */
    return undefined;
  }
}

/**
 * Describe a filesystem location without leaking an absolute path.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} absolute - path to describe.
 * @returns {string} profile-relative location.
 */
function describePath(profileDir, absolute) {
  const parts = String(absolute).split(/[\\/]+/).filter((part) => part !== '');
  const profileParts = String(profileDir).split(/[\\/]+/).filter((part) => part !== '');
  let shared = 0;
  while (shared < parts.length && shared < profileParts.length && parts[shared].toLowerCase() === profileParts[shared].toLowerCase()) shared += 1;
  if (shared === profileParts.length) return '<profile>/' + parts.slice(shared).join('/');
  return '<external>/' + parts.slice(-1).join('/');
}

/**
 * Replace machine paths inside a message with the labels {@link describePath} uses.
 * @param {string} message - raw message.
 * @param {string} profileDir - absolute profile directory.
 * @returns {string} message safe to return to the browser.
 */
function redactPaths(message, profileDir) {
  let text = String(message);
  if (typeof profileDir === 'string' && profileDir !== '') {
    const variants = new Set([profileDir, profileDir.replace(/\\/g, '/'), profileDir.replace(/\//g, '\\')]);
    for (const variant of variants) text = text.split(variant).join('<profile>');
  }
  return text.replace(/[A-Za-z]:[\\/][^\s"',;)]*/g, (match) => '<external>/' + match.split(/[\\/]+/).pop());
}

/**
 * Read a request body with an upper bound.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {number} limit - maximum bytes.
 * @returns {Promise<Buffer>} body bytes.
 */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('archive exceeds the ' + Math.round(limit / (1024 * 1024)) + ' MiB import limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Stream a zip response, honouring backpressure.
 * @param {import('node:http').ServerResponse} response - response to write.
 * @param {AsyncGenerator<Buffer>} chunks - archive chunks.
 * @param {string} downloadName - file name offered to the browser.
 * @returns {Promise<void>} resolves once the response is complete.
 */
async function streamZip(response, chunks, downloadName) {
  const ascii = downloadName.replace(/[^\x20-\x7e]/g, '_');
  response.writeHead(200, {
    'content-type': 'application/zip',
    'cache-control': 'no-store',
    'content-disposition': 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(downloadName),
  });
  for await (const chunk of chunks) {
    if (!response.write(chunk)) await once(response, 'drain');
  }
  response.end();
}

/**
 * Resolve the profile directory the running host was launched with.
 * @param {any} ctx - Cordis context of the host plugin.
 * @returns {string} absolute profile directory.
 */
function profileDirOf(ctx) {
  const profile = ctx.get('profileContext');
  const dir = profile?.dir;
  if (typeof dir !== 'string' || dir === '') {
    throw new Error('this DSH process was not started from a profile directory, so plugin packaging is unavailable');
  }
  return dir;
}

/**
 * DSH home: the environment's `DSH_HOME`, else the profile's grandparent when
 * the layout is `<home>/profiles/<name>`.
 * @param {string} profileDir - absolute profile directory.
 * @returns {string} absolute home directory.
 */
function dshHomeOf(profileDir) {
  /* A profile at <home>/profiles/<name> names its own home. The environment is
   * the fallback, not the authority: tooling and tests mount profiles from
   * other homes inside a process that already exports DSH_HOME. */
  const parent = dirname(profileDir);
  if (basename(parent) === 'profiles') return dirname(parent);
  const fromEnvironment = String(process.env.DSH_HOME ?? '').trim();
  return fromEnvironment !== '' ? fromEnvironment : profileDir;
}

/**
 * Select an imported bundle in the profile manifest when the plugin manager is
 * not loaded: the package is on disk and in the dependency list either way, so
 * the next start mounts it.
 * @param {string} profileDir - absolute profile directory.
 * @param {string} name - bundle package name.
 * @returns {boolean} whether the bundle list changed.
 */
function selectBundleInManifest(profileDir, name) {
  const file = join(profileDir, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const profile = manifest.dsh?.profile;
  if (manifest.dsh === undefined || profile === undefined) return false;
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : [];
  if (bundles.includes(name)) return false;
  bundles.push(name);
  manifest.dsh.profile = { ...profile, bundles };
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return true;
}

/**
 * Enable an imported bundle through the official plugin manager so the running
 * composition picks it up without a restart, or select it in the profile
 * manifest when that service is unavailable.
 * @param {any} ctx - Cordis context of the host plugin.
 * @param {any} root - archive root descriptor.
 * @param {string} profileDir - absolute profile directory.
 * @returns {Promise<{ application: string, reason?: string }>} how the change was applied.
 */
async function enableImported(ctx, root, profileDir) {
  if (root?.bundle !== true) return { application: 'dependencies-only' };
  const manager = ctx.get('pluginManager');
  if (manager === undefined) {
    try {
      const selected = selectBundleInManifest(profileDir, root.name);
      return {
        application: 'restart-required',
        reason: selected
          ? 'added to the profile bundle list; restart DSH to load it'
          : 'the plugin manager service is not loaded',
      };
    } catch (error) {
      return { application: 'restart-required', reason: redactPaths(error instanceof Error ? error.message : String(error), profileDir) };
    }
  }
  try {
    const report = await manager.setBundleEnabled(root.name, true);
    return { application: report?.application === 'restart-required' ? 'restart-required' : 'applied' };
  } catch (error) {
    return { application: 'restart-required', reason: redactPaths(error instanceof Error ? error.message : String(error), profileDir) };
  }
}

/**
 * Ask the npm registry for the newest published version of each package.
 *
 * The catalogue shows what is installed; "is this the newest release" is the
 * one fact a profile cannot answer on its own, and a package that only exists
 * as a `link:` or `file:` dependency was never published at all. Every failure
 * is per-package and silent: an offline machine simply sees "未知".
 * @param {string[]} names - package names to look up.
 * @param {number} [timeoutMs] - per-request budget.
 * @returns {Promise<Record<string, { latest: string | null, error: string | null }>>} answers.
 */
async function fetchLatestVersions(names, timeoutMs = 6000) {
  const out = {};
  const queue = [...names];
  const worker = async () => {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(name).replace(/^%40/, '@') + '/latest', {
          headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          out[name] = { latest: null, error: response.status === 404 ? 'unpublished' : 'HTTP ' + response.status };
          continue;
        }
        const payload = await response.json();
        out[name] = { latest: typeof payload?.version === 'string' ? payload.version : null, error: payload?.version ? null : 'unpublished' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        out[name] = { latest: null, error: /abort/i.test(message) ? 'timeout' : 'offline' };
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, names.length) }, worker));
  return out;
}

/**
 * Handle one API request.
 * @param {any} ctx - Cordis context of the host plugin.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {import('node:http').ServerResponse} response - response to fill.
 * @param {{ maxImportBytes: number }} config - resolved plugin config.
 * @returns {Promise<void>} resolves when the response is finished.
 */
async function handle(ctx, request, response, config) {
  if (!isLoopback(request)) {
    fail(response, 403, 'plugin packaging is only available over loopback');
    return;
  }
  if (!isSameOrigin(request)) {
    fail(response, 403, 'plugin packaging refuses cross-site requests');
    return;
  }
  /* The two checks above are this plugin's own baseline. Ask the host's gate
   * as well: from DSH 0.2.3 it also carries the browser login and the declared
   * authorities, so a page the user opened elsewhere cannot drive this API
   * even when a request arrives over loopback without our headers. Older
   * hosts publish no such service, and the baseline checks stay in force. */
  const hostStatus = hostRequestRejection(ctx, request);
  if (hostStatus !== undefined) {
    fail(response, hostStatus, 'the host refused this request under its access policy');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== ROUTE_PREFIX && !url.pathname.startsWith(ROUTE_PREFIX + '/')) {
    fail(response, 404, 'unknown plugin-packer route ' + url.pathname);
    return;
  }
  const route = url.pathname.slice(ROUTE_PREFIX.length + 1);
  const profileDir = profileDirOf(ctx);
  const home = dshHomeOf(profileDir);

  if (route === 'api/list' && request.method === 'GET') {
    const catalogue = listPlugins(profileDir, {
      sort: url.searchParams.get('sort') ?? undefined,
      order: url.searchParams.get('order') ?? undefined,
    });
    const facts = readProfileFacts(profileDir);
    const inventory = describeAssets(profileDir, home);
    const assetCount = new Map();
    for (const descriptor of inventory.descriptors) assetCount.set(descriptor.plugin, (assetCount.get(descriptor.plugin) ?? 0) + descriptor.assets.length);
    const rows = catalogue.rows.map((row) => ({ ...row, assets: assetCount.get(row.name) ?? 0 }));
    const totalBytes = rows.reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0);
    const totalFiles = rows.reduce((sum, row) => sum + (typeof row.files === 'number' ? row.files : 0), 0);
    sendJson(response, 200, {
      ok: true,
      formatVersion: PACK_FORMAT_VERSION,
      sort: catalogue.sort,
      order: catalogue.order,
      profile: { name: ctx.get('profileContext')?.name ?? null, packages: rows.length },
      totals: {
        bytes: totalBytes,
        files: totalFiles,
        plugins: rows.filter((row) => row.exportable).length,
        exportableBytes: rows.filter((row) => row.exportable).reduce((sum, row) => sum + (typeof row.bytes === 'number' ? row.bytes : 0), 0),
      },
      bundles: [...facts.bundles],
      rows,
      assetErrors: inventory.errors,
    });
    return;
  }

  if (route === 'api/latest' && request.method === 'GET') {
    const names = (url.searchParams.get('names') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .slice(0, 200);
    if (names.length === 0) {
      fail(response, 400, 'missing names parameter');
      return;
    }
    sendJson(response, 200, { ok: true, versions: await fetchLatestVersions(names) });
    return;
  }

  if (route === 'api/assets' && request.method === 'GET') {
    const inventory = describeAssets(profileDir, home);
    sendJson(response, 200, {
      ok: true,
      home: describePath(profileDir, home),
      descriptors: inventory.descriptors.map((descriptor) => ({
        ...descriptor,
        assets: descriptor.assets.map((asset) => ({
          ...asset,
          installDir: describePath(profileDir, asset.installDir),
          bundleDir: describePath(profileDir, asset.bundleDir),
          expect: asset.expect.map((entry) => ({ ...entry, path: describePath(profileDir, entry.path) })),
        })),
      })),
      errors: inventory.errors,
    });
    return;
  }

  if (route === 'api/export' && request.method === 'GET') {
    const name = url.searchParams.get('name') ?? '';
    if (name === '') {
      fail(response, 400, 'missing name parameter');
      return;
    }
    const closure = expandClosure(profileDir, name);
    const plan = planArchive(profileDir, closure);
    const staged = await stageAssets(profileDir, name);
    const facts = readProfileFacts(profileDir);
    const manifest = buildManifest(closure, plan, {
      profileName: ctx.get('profileContext')?.name ?? 'unknown',
      enabled: facts.bundles.has(name),
      generatorVersion: OWN_VERSION,
      assets: staged.entries,
    });
    const header = { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') };
    const safeName = name.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const downloadName = safeName + '-' + (closure.root.version ?? 'pack') + '-' + stamp + '.dsh-plugin.zip';
    await streamZip(response, createZipStream([header, ...plan.sources, ...staged.sources]), downloadName);
    ctx.logger?.info?.(
      'plugin-packer: exported ' + name + ' (' + plan.files + ' package files, ' + plan.total + ' bytes' +
        (staged.entries.length === 0 ? '' : '; ' + staged.totals.files + ' asset files, ' + staged.totals.bytes + ' bytes') + ')',
    );
    return;
  }

  if (route === 'api/import' && request.method === 'POST') {
    const body = await readBody(request, config.maxImportBytes);
    if (body.length === 0) {
      fail(response, 400, 'empty request body');
      return;
    }
    const members = readZip(body);
    const sandbox = await mkdtemp(join(tmpdir(), 'dsh-plugin-pack2-'));
    try {
      const extracted = join(sandbox, 'pack');
      await extractArchive(extracted, members);
      const backupRoot = join(profileDir, '.plugin-packer', 'backups');
      await mkdir(backupRoot, { recursive: true });
      const report = await installPack(profileDir, extracted, backupRoot);
      const assets = await installAssets({
        packDir: report.packDir,
        profileDir,
        home,
        manifest: report.manifest,
        backupRoot,
        logger: ctx.logger,
      });
      const application = await enableImported(ctx, report.root, profileDir);
      /* Displaced packages and environments pile up one batch per import.
       * Five batches is plenty to roll back a bad install; everything older is
       * dead weight in the profile. */
      const pruned = await pruneBackups(backupRoot, 5);
      sendJson(response, 200, {
        ok: true,
        formatVersion: report.formatVersion,
        root: report.root,
        installed: report.installed,
        replaced: report.replaced,
        backupRoot: describePath(profileDir, backupRoot),
        backupsPruned: pruned.removed.length,
        assets: assets.map((asset) => ({
          id: asset.id,
          kind: asset.kind,
          label: asset.label,
          installDir: describePath(profileDir, asset.installDir),
          replaced: asset.replaced,
          files: asset.files,
          bytes: asset.bytes,
          install: asset.install === null ? null : { code: asset.install.code, ms: asset.install.ms },
          postInstall: asset.postInstall === null ? null : { code: asset.postInstall.code, ms: asset.postInstall.ms },
        })),
        application,
      });
      ctx.logger?.info?.(
        'plugin-packer: imported ' + String(report.root?.name) + ' (' + report.installed.length + ' packages, ' +
          assets.length + ' assets, ' + application.application + ')',
      );
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
    return;
  }

  if (route === 'api/health' && request.method === 'GET') {
    sendJson(response, 200, {
      ok: true,
      version: OWN_VERSION,
      packFormatVersion: PACK_FORMAT_VERSION,
      acceptsFormats: [1, 2],
      assets: true,
      home: existsSync(home),
    });
    return;
  }
  fail(response, 404, 'unknown plugin-packer route ' + route);
}

/** Plugin body: claim the loopback API routes on the host web server. */
export function apply(ctx, config = {}) {
  const resolved = { maxImportBytes: config.maxImportBytes ?? 512 * 1024 * 1024 };
  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      try {
        await handle(ctx, request, response, resolved);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let profileDir = '';
        try {
          profileDir = profileDirOf(ctx);
        } catch {
          profileDir = '';
        }
        const safe = redactPaths(message, profileDir);
        ctx.logger?.warn?.('plugin-packer: ' + safe);
        if (!response.headersSent) fail(response, 500, safe);
        else response.destroy();
      }
    },
  });
  ctx.effect(() => dispose, 'plugin-packer routes');
  ctx.logger?.info?.('plugin-packer: API ready at ' + ROUTE_PREFIX + '/api');
}

/** Services this plugin needs before it can register routes. */
export const inject = ['webServer'];
