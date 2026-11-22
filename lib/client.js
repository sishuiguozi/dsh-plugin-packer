window.__ModuleLoader__.load({
  id: 'dsh-plugin-packer',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const css = `
.pk-section{width:100%;max-width:900px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.pk-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}
.pk-title{font-size:14px;font-weight:500;line-height:22px;margin:0}
.pk-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:2px 0 0;max-width:620px}
.pk-actions{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pk-btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;cursor:pointer;white-space:nowrap}
.pk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.pk-btn:disabled{opacity:.5;cursor:default}
.pk-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
.pk-btn[data-tiny=true]{padding:2px 9px;font-size:12px;line-height:16px}
.pk-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.pk-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pk-search{flex:1 1 200px;min-width:160px}
.pk-search input{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;outline:none}
.pk-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.pk-select{height:32px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px;outline:none}
.pk-tabs{display:flex;gap:6px;flex-wrap:wrap}
.pk-tab{border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:3px 11px;cursor:pointer}
.pk-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pk-tab[data-on=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.pk-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pk-status[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.pk-batch{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:7px 10px;font-size:12px;line-height:18px}
.pk-batch-count{font-weight:500}
.pk-batch-hint{color:var(--dsw-alias-label-tertiary)}
.pk-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pk-row{display:flex;align-items:flex-start;gap:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);padding:8px 10px}
.pk-row[data-selected=true]{border-color:var(--dsw-alias-state-business-primary)}
.pk-check{margin:3px 0 0;width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.pk-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.pk-name{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pk-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pk-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;padding:0 5px;font-size:11px;line-height:16px;white-space:nowrap}
.pk-tag[data-on=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.pk-tag[data-accent=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.pk-tag[data-muted=true]{opacity:.7}
.pk-date{font-variant-numeric:tabular-nums}
.pk-empty{padding:14px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pk-result{display:flex;flex-direction:column;gap:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.pk-result code{font-family:var(--dsw-font-mono,monospace);font-size:11px}
`;

    const tagId = 'dsh-plugin-packer/PackerSettingsTab.css';
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-packer';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const API = '/plugin-packer/api';
    const LABEL = '插件打包';
    /* Waited between two downloads of one batch: browsers rate-limit
     * programmatic downloads, and a burst makes them drop files silently. */
    const BATCH_GAP_MS = 600;

    const SORT_OPTIONS = [
      { value: 'updated', label: '按更新时间' },
      { value: 'installed', label: '按安装日期' },
      { value: 'name', label: '按名称' },
      { value: 'size', label: '按体积' },
      { value: 'status', label: '按状态' },
      { value: 'version', label: '按版本' },
    ];

    const FILTERS = [
      { value: 'all', label: '全部' },
      { value: 'exportable', label: '可导出' },
      { value: 'enabled', label: '已启用' },
      { value: 'disabled', label: '未启用' },
      { value: 'bundled', label: '应用内置' },
    ];

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || bytes < 0) return '—';
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB'];
      let value = bytes / 1024;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) { value = value / 1024; index += 1; }
      return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[index];
    }

    const pad2 = (value) => String(value).padStart(2, '0');

    function formatDate(iso) {
      if (typeof iso !== 'string' || iso === '') return '—';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '—';
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function formatClock(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    function formatRelative(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const time = new Date(iso).getTime();
      if (!Number.isFinite(time)) return '';
      const delta = Date.now() - time;
      if (delta < 0) return '未来';
      if (delta < 60 * 1000) return '刚刚';
      const minutes = Math.floor(delta / (60 * 1000));
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      const days = Math.floor(hours / 24);
      if (days < 31) return days + ' 天前';
      return formatDate(iso);
    }

    function sleep(ms) {
      return new Promise((done) => setTimeout(done, ms));
    }

    async function readError(response) {
      try {
        const payload = await response.json();
        if (payload && payload.error && payload.error.message) return payload.error.message;
        return JSON.stringify(payload);
      } catch (error) {
        return 'HTTP ' + response.status;
      }
    }

    /** Compare two semver-ish strings; only equality matters here. */
    function sameVersion(left, right) {
      return typeof left === 'string' && typeof right === 'string' && left.trim() === right.trim();
    }

    function downloadBlob(blob, fileName) {
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 120000);
    }

    function readFileName(response, fallback) {
      const disposition = response.headers.get('content-disposition') || '';
      const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      if (encoded !== null) {
        try {
          return decodeURIComponent(encoded[1]);
        } catch (error) {
          return fallback;
        }
      }
      return fallback;
    }

    function Row(props) {
      const row = props.row;
      const busy = props.busy;
      const selected = props.selected;
      const latest = props.latest;
      const latestEntry = latest === null ? null : latest[row.name];
      const meta = [];
      if (row.version) meta.push(h('span', { key: 'v', className: 'pk-tag' }, 'v' + row.version));
      if (row.installed) {
        /* A link: package points at a working tree, so the directory size
         * includes build caches, asset sources and deliverables. Say so rather
         * than implying the plugin itself is that heavy. */
        meta.push(h('span', {
          key: 's',
          className: 'pk-tag',
          title: row.linked
            ? '链接目录（源码树）的总占用，含构建缓存、资产源与交付物。导出的包按 package.json 的 files 白名单打包，通常只有几十 KB 到几 MB。'
            : '安装目录的总占用',
        }, formatBytes(row.bytes) + ' · ' + row.files + ' 个文件' + (row.linked ? '（源码目录）' : '')));
      }
      if (row.linked) meta.push(h('span', { key: 'ln', className: 'pk-tag', 'data-muted': 'true', title: '在 profile 外，用 link: 指向源码树' }, '链接目录'));
      if (row.installed && row.installedAt) {
        meta.push(h('span', { key: 'i', className: 'pk-date', title: '安装日期：' + row.installedAt },
          '安装 ' + formatDate(row.installedAt)));
      }
      if (row.installed && row.updatedAt) {
        meta.push(h('span', { key: 'u', className: 'pk-date', title: '最后更新：' + row.updatedAt + ' ' + formatClock(row.updatedAt) },
          '更新 ' + formatRelative(row.updatedAt) + '（' + formatDate(row.updatedAt) + '）'));
      }
      if (latestEntry !== null && latestEntry !== undefined) {
        if (latestEntry.latest !== null && latestEntry.latest !== undefined) {
          const fresh = sameVersion(latestEntry.latest, row.version);
          meta.push(h('span', { key: 'l', className: 'pk-tag', 'data-accent': fresh ? 'false' : 'true', 'data-on': fresh ? 'true' : 'false' },
            fresh ? '已是最新' : '最新 v' + latestEntry.latest));
        } else if (latestEntry.error === 'unpublished') {
          meta.push(h('span', { key: 'l', className: 'pk-tag', 'data-muted': 'true' }, '未发布到 npm'));
        } else if (latestEntry.error === 'offline' || latestEntry.error === 'timeout') {
          meta.push(h('span', { key: 'l', className: 'pk-tag', 'data-muted': 'true' }, '最新版本未知'));
        }
      }
      if (row.bundle) meta.push(h('span', { key: 'b', className: 'pk-tag', 'data-on': row.enabled ? 'true' : 'false' }, row.enabled ? '已启用' : '未启用'));
      else meta.push(h('span', { key: 'b', className: 'pk-tag', 'data-muted': 'true' }, '非 bundle'));
      if (row.client) meta.push(h('span', { key: 'c', className: 'pk-tag', 'data-muted': 'true' }, '含界面'));
      if (row.assets) meta.push(h('span', { key: 'a', className: 'pk-tag', 'data-muted': 'true' }, '含运行时资产 ×' + row.assets));
      if (!row.installed) meta.push(h('span', { key: 'r', className: 'pk-tag', 'data-muted': 'true' }, '随应用内置'));
      else if (row.reason === 'not-a-plugin') meta.push(h('span', { key: 'r', className: 'pk-tag', 'data-muted': 'true' }, '非插件包'));

      const checkbox = row.exportable
        ? h('input', {
            className: 'pk-check',
            type: 'checkbox',
            checked: selected,
            disabled: busy !== null,
            'aria-label': '选择 ' + row.name,
            onChange: () => props.onToggle(row.name),
          })
        : h('span', { className: 'pk-check', 'aria-hidden': 'true' });

      const action = row.exportable
        ? h('button', {
            className: 'pk-btn',
            type: 'button',
            'data-tiny': 'true',
            disabled: busy !== null,
            onClick: () => props.onExport(row.name),
          }, busy === row.name ? '打包中…' : '导出')
        : h('button', {
            className: 'pk-btn',
            type: 'button',
            'data-tiny': 'true',
            disabled: true,
            title: row.installed ? '该包不是 DSH 插件，没有可导出的插件内容' : '该插件随应用分发，profile 中没有可导出的文件',
          }, '不可导出');

      return h('li', { className: 'pk-row', 'data-selected': selected ? 'true' : 'false' },
        checkbox,
        h('div', { className: 'pk-main' },
          h('span', { className: 'pk-name', title: row.description || row.name }, row.name),
          h('span', { className: 'pk-meta' }, meta)
        ),
        action
      );
    }

    function PackerSettingsTab() {
      const [state, setState] = React.useState({ loading: true, rows: [], profile: null, totals: null, error: null });
      const [sortKey, setSortKey] = React.useState('updated');
      const [sortOrder, setSortOrder] = React.useState('desc');
      const [filter, setFilter] = React.useState('all');
      const [query, setQuery] = React.useState('');
      const [selected, setSelected] = React.useState(() => new Set());
      const [latest, setLatest] = React.useState(null);
      const [latestBusy, setLatestBusy] = React.useState(false);
      const [busy, setBusy] = React.useState(null);
      const [progress, setProgress] = React.useState(null);
      const [status, setStatus] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const fileInput = React.useRef(null);

      const load = React.useCallback(async (nextSortKey, nextSortOrder) => {
        const key = nextSortKey === undefined ? sortKey : nextSortKey;
        const order = nextSortOrder === undefined ? sortOrder : nextSortOrder;
        setState((prev) => ({ ...prev, loading: prev.rows.length === 0, error: null }));
        try {
          const response = await fetch(API + '/list?sort=' + encodeURIComponent(key) + '&order=' + encodeURIComponent(order), {
            headers: { accept: 'application/json' },
          });
          if (!response.ok) throw new Error(await readError(response));
          const payload = await response.json();
          setState({ loading: false, rows: payload.rows || [], profile: payload.profile || null, totals: payload.totals || null, error: null });
          /* Selections for packages that no longer exist are dropped, so a
           * stale batch can never ask the host to pack a missing plugin. */
          setSelected((prev) => {
            if (prev.size === 0) return prev;
            const alive = new Set((payload.rows || []).filter((row) => row.exportable).map((row) => row.name));
            const next = new Set([...prev].filter((name) => alive.has(name)));
            return next.size === prev.size ? prev : next;
          });
        } catch (error) {
          setState({ loading: false, rows: [], profile: null, totals: null, error: error && error.message ? error.message : String(error) });
        }
      }, [sortKey, sortOrder]);

      React.useEffect(() => { load(sortKey, sortOrder); }, [sortKey, sortOrder, load]);

      const exportOne = React.useCallback(async (name) => {
        const response = await fetch(API + '/export?name=' + encodeURIComponent(name));
        if (!response.ok) throw new Error(await readError(response));
        const blob = await response.blob();
        const fallback = name.replace(/[^a-zA-Z0-9._-]+/g, '-') + '.dsh-plugin.zip';
        downloadBlob(blob, readFileName(response, fallback));
        return blob.size;
      }, []);

      const exportSingle = React.useCallback(async (name) => {
        setBusy(name);
        setStatus({ text: '正在收集 ' + name + ' 及其依赖…', error: false });
        try {
          const bytes = await exportOne(name);
          setStatus({ text: '已导出 ' + name + '（' + formatBytes(bytes) + '）', error: false });
        } catch (error) {
          setStatus({ text: '导出失败：' + (error && error.message ? error.message : String(error)), error: true });
        } finally {
          setBusy(null);
        }
      }, [exportOne]);

      const orderedNames = React.useMemo(() => state.rows.filter((row) => row.exportable).map((row) => row.name), [state.rows]);

      const selectedNames = React.useMemo(
        () => orderedNames.filter((name) => selected.has(name)),
        [orderedNames, selected],
      );

      const selectedBytes = React.useMemo(() => {
        let total = 0;
        for (const row of state.rows) if (selected.has(row.name) && typeof row.bytes === 'number') total += row.bytes;
        return total;
      }, [state.rows, selected]);

      const exportBatch = React.useCallback(async () => {
        const names = selectedNames;
        if (names.length === 0) return;
        setBusy('__batch__');
        setProgress({ done: 0, total: names.length, current: names[0] });
        setStatus({ text: '开始打包 ' + names.length + ' 个插件，逐个下载…', error: false });
        const failures = [];
        let bytes = 0;
        let done = 0;
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          setProgress({ done: index, total: names.length, current: name });
          try {
            bytes += await exportOne(name);
            done += 1;
          } catch (error) {
            failures.push(name + '（' + (error && error.message ? error.message : String(error)) + '）');
          }
          if (index < names.length - 1) await sleep(BATCH_GAP_MS);
        }
        setProgress(null);
        setBusy(null);
        if (failures.length === 0) {
          setStatus({ text: '批量打包完成：' + done + ' 个插件，合计 ' + formatBytes(bytes) + '。浏览器若询问是否允许多个下载，请选择允许。', error: false });
        } else {
          setStatus({ text: '批量打包：成功 ' + done + '/' + names.length + '，失败 ' + failures.join('、'), error: true });
        }
      }, [exportOne, selectedNames]);

      const importArchive = React.useCallback(async (file) => {
        if (!file) return;
        setBusy('__import__');
        setResult(null);
        setStatus({ text: '正在导入 ' + file.name + '（' + formatBytes(file.size) + '）…', error: false });
        try {
          const response = await fetch(API + '/import', {
            method: 'POST',
            headers: { 'content-type': 'application/zip' },
            body: file,
          });
          if (!response.ok) throw new Error(await readError(response));
          const payload = await response.json();
          setResult(payload);
          const application = payload.application || {};
          const applied = application.application === 'applied';
          setStatus({
            text: '导入完成：' + payload.installed.length + ' 个包' + (applied ? '，已即时生效' : application.application === 'restart-required' ? '，需要重启 DSH 生效' : ''),
            error: false,
          });
          await load();
        } catch (error) {
          setStatus({ text: '导入失败：' + (error && error.message ? error.message : String(error)), error: true });
        } finally {
          setBusy(null);
          if (fileInput.current) fileInput.current.value = '';
        }
      }, [load]);

      const checkLatest = React.useCallback(async () => {
        const names = state.rows.filter((row) => row.installed && typeof row.version === 'string').map((row) => row.name);
        if (names.length === 0) return;
        setLatestBusy(true);
        setStatus({ text: '正在查询 npm 上的最新版本…', error: false });
        try {
          const response = await fetch(API + '/latest?names=' + encodeURIComponent(names.join(',')), { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(await readError(response));
          const payload = await response.json();
          const versions = payload.versions || {};
          setLatest(versions);
          const upgradable = names.filter((name) => {
            const entry = versions[name];
            return entry && typeof entry.latest === 'string' && !sameVersion(entry.latest, (state.rows.find((row) => row.name === name) || {}).version);
          });
          setStatus({
            text: upgradable.length === 0
              ? '已检查 ' + names.length + ' 个插件：没有可升级的新版本。'
              : '已检查 ' + names.length + ' 个插件：' + upgradable.length + ' 个有新版本（' + upgradable.slice(0, 3).join('、') + (upgradable.length > 3 ? ' 等' : '') + '）。',
            error: false,
          });
        } catch (error) {
          setStatus({ text: '查询最新版本失败：' + (error && error.message ? error.message : String(error)), error: true });
        } finally {
          setLatestBusy(false);
        }
      }, [state.rows]);

      const toggle = React.useCallback((name) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return next;
        });
      }, []);

      const rows = state.rows;
      const normalized = query.trim().toLowerCase();
      const filtered = (normalized === ''
        ? rows
        : rows.filter((row) => row.name.toLowerCase().includes(normalized) || (row.description || '').toLowerCase().includes(normalized))
      ).filter((row) => {
        if (filter === 'exportable') return row.exportable;
        if (filter === 'enabled') return row.exportable && row.enabled;
        if (filter === 'disabled') return row.exportable && !row.enabled;
        if (filter === 'bundled') return !row.exportable;
        return true;
      });

      const selectable = filtered.filter((row) => row.exportable);
      const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.name));

      const toggleAll = () => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (allSelected) {
            for (const row of selectable) next.delete(row.name);
          } else {
            for (const row of selectable) next.add(row.name);
          }
          return next;
        });
      };

      const progressText = progress === null
        ? ''
        : '正在打包 ' + (progress.done + 1) + '/' + progress.total + '：' + progress.current;

      return h('div', { className: 'pk-section' },
        h('div', { className: 'pk-head' },
          h('div', null,
            h('h3', { className: 'pk-title' }, '插件打包 · 导出 / 导入'),
            h('p', { className: 'pk-desc' }, '导出会把插件本体、它的全部运行时依赖以及清单打成一个 zip；导入会把这些包写回当前 profile，并交给官方插件管理器启用。'),
            h('p', { className: 'pk-desc' },
              '当前 profile：' + String((state.profile && state.profile.name) || '—')
              + ' · ' + String(state.profile && typeof state.profile.packages === 'number' ? state.profile.packages : 0) + ' 个包'
              + (state.totals ? ' · 合计 ' + formatBytes(state.totals.bytes) + '（可导出 ' + formatBytes(state.totals.exportableBytes) + '）' : ''))
          ),
          h('div', { className: 'pk-actions' },
            h('input', {
              ref: fileInput,
              type: 'file',
              accept: '.zip,application/zip',
              style: { display: 'none' },
              onChange: (event) => { const file = event.target.files && event.target.files[0]; importArchive(file); },
            }),
            h('button', { className: 'pk-btn', type: 'button', disabled: busy !== null, onClick: () => { if (fileInput.current) fileInput.current.click(); } }, busy === '__import__' ? '导入中…' : '导入 zip'),
            h('button', { className: 'pk-btn', type: 'button', disabled: busy !== null || latestBusy, onClick: checkLatest }, latestBusy ? '查询中…' : '检查最新版本'),
            h('button', { className: 'pk-btn', type: 'button', disabled: busy !== null || state.loading, onClick: () => load() }, '刷新')
          )
        ),
        h('div', { className: 'pk-toolbar' },
          h('div', { className: 'pk-search' },
            h('input', {
              type: 'search',
              placeholder: '按包名或描述过滤…',
              value: query,
              onChange: (event) => setQuery(event.target.value),
            })
          ),
          h('select', {
            className: 'pk-select',
            value: sortKey,
            'aria-label': '排序字段',
            onChange: (event) => setSortKey(event.target.value),
          }, SORT_OPTIONS.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
          h('button', {
            className: 'pk-btn',
            type: 'button',
            'data-tiny': 'true',
            title: sortOrder === 'desc' ? '当前：最新在前，点击切换为最旧在前' : '当前：最旧在前，点击切换为最新在前',
            onClick: () => setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc'),
          }, sortOrder === 'desc' ? '↓ 新→旧' : '↑ 旧→新')
        ),
        h('div', { className: 'pk-tabs' },
          FILTERS.map((entry) => h('button', {
            key: entry.value,
            className: 'pk-tab',
            type: 'button',
            'data-on': filter === entry.value ? 'true' : 'false',
            onClick: () => setFilter(entry.value),
          }, entry.label))
        ),
        h('div', { className: 'pk-batch' },
          h('label', { className: 'pk-batch-count', style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: selectable.length === 0 ? 'default' : 'pointer' } },
            h('input', {
              className: 'pk-check',
              type: 'checkbox',
              checked: allSelected,
              disabled: selectable.length === 0 || busy !== null,
              onChange: toggleAll,
            }),
            '已选 ' + selectedNames.length + ' 个'
            + (selectedNames.length > 0 ? ' · ' + formatBytes(selectedBytes) : '')
            + ' · 当前视图 ' + selectable.length + ' 个可选'
          ),
          h('button', {
            className: 'pk-btn',
            type: 'button',
            'data-primary': 'true',
            disabled: busy !== null || selectedNames.length === 0,
            onClick: exportBatch,
          }, busy === '__batch__' ? '批量打包中…' : '打包选中（' + selectedNames.length + '）'),
          selectedNames.length === 0 ? null : h('button', {
            className: 'pk-btn',
            type: 'button',
            'data-tiny': 'true',
            disabled: busy !== null,
            onClick: () => setSelected(new Set()),
          }, '清空选择'),
          h('span', { className: 'pk-batch-hint' }, '勾选多个后逐个打包下载；浏览器若询问「允许多个文件下载」，选择允许。')
        ),
        progressText === '' ? null : h('p', { className: 'pk-status' }, progressText),
        status === null ? null : h('p', { className: 'pk-status', 'data-error': status.error ? 'true' : 'false' }, status.text),
        state.loading ? h('p', { className: 'pk-status' }, '正在读取插件清单…') : null,
        state.error === null ? null : h('p', { className: 'pk-status', 'data-error': 'true' }, state.error),
        !state.loading && state.error === null && filtered.length === 0 ? h('p', { className: 'pk-empty' }, '没有匹配的插件。') : null,
        h('ul', { className: 'pk-list' }, filtered.map((row) => h(Row, {
          key: row.name,
          row,
          busy,
          selected: selected.has(row.name),
          latest,
          onToggle: toggle,
          onExport: exportSingle,
        }))),
        result === null ? null : h('div', { className: 'pk-result' },
          h('span', null, '已导入 ', h('code', null, String(result.root && result.root.name)), ' · ', String(result.installed.length), ' 个包'),
          h('span', null, '覆盖的旧版本：', (result.replaced || []).length === 0 ? '无' : (result.replaced || []).join(', ')),
          h('span', null, '生效方式：', result.application && result.application.application === 'applied' ? '已即时应用' : result.application && result.application.application === 'restart-required' ? '需要重启 DSH（' + (result.application.reason || '未提供原因') + '）' : '仅写入依赖'),
          h('span', null, '备份目录：', h('code', null, String(result.backupRoot)), typeof result.backupsPruned === 'number' && result.backupsPruned > 0 ? '（已清理 ' + result.backupsPruned + ' 份旧备份）' : '')
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'plugin-packer',
          order: 40,
          label: LABEL,
        }, PackerSettingsTab));
      },
    };
  },
});
