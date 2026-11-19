// dsh-ollama-autostart — Client half.
//
// The control panel rendered on this bundle's Plugins page (the
// `plugins.bundle.config` keyed slot, keyed by the bundle's package name).
// Five rows, each a title + description + one action button + a result slot:
//
//   1. Start ollama service      — "启动 ollama 服务"; when the service is
//                                   already running the button is disabled
//                                   and reads "ollama 服务已启动";
//   2. Listen check             — "监听 ollama"; click -> "等待返回结果…" ->
//                                   "已启用" / "未启用" (/api/tags probe);
//   3. Embed direct test        — "嵌入直连测试"; bypasses DSH and hits
//                                   Ollama's /api/embed directly;
//   4. Version check            — "检查 Ollama 版本"; the host also runs
//                                   this once at boot and the last result is
//                                   shown;
//   5. Force-IPv4 CLI test      — "强制 IPv4 CLI 测试"; runs
//                                   MNEMON_EMBED_ENDPOINT=http://127.0.0.1:<port>
//                                   mnemon embed --status and shows 成功/失败.
//
// All row results come from the host half's prefix routes under
// /api/ollama-autostart (same origin; the browser half mounts them through
// the webServer service once the browser half has published it).
(function () {
  'use strict';

  /** The Loader row name, which is also this browser artifact's module id.
   *  MUST equal the installed package name. */
  var PLUGIN_ID = 'dsh-ollama-autostart';

  /** Locale namespace owned by this plugin. */
  var LOCALE_NS = 'ollama-autostart';

  /** The settings-page slot this panel contributes to, keyed by package name. */
  var CONFIG_SLOT = 'plugins.bundle.config';

  /** The host half's prefix routes. */
  var API = '/api/ollama-autostart';

  var EN = {
    panelTitle: 'Ollama service',
    autoStartTitle: 'Auto-start',
    autoStartDesc: 'Start the ollama service automatically when the DSH host boots. Switching it off never stops a service that is already running.',
    autoStartOn: 'Auto-start ON. {detail}',
    autoStartOff: 'Auto-start OFF: the host will not start the service on boot. The running service (if any) is untouched.',
    autoStartDetailStarted: 'the service was started now (pid {pid})',
    autoStartDetailRunning: 'it is already running',
    autoStartDetailNotReady: 'it was spawned (pid {pid}) but the port is not ready yet',
    autoStartToggleFail: 'Toggle failed: {error}',
    startTitle: 'Start ollama service',
    startDesc: 'Launch `ollama serve` as a detached background service. Running services are detected and skipped.',
    startButton: 'Start',
    startDisabledLabel: 'Ollama service already running',
    startWaiting: 'Starting…',
    startStarted: 'Started (pid {pid})',
    startSkipped: 'Already listening — skipped',
    modelsTitle: 'Query Ollama models',
    modelsDesc: 'Run `ollama list` then `ollama ps`; fall back to `curl -s /api/tags` when both fail. Shows model names, sizes and the currently loaded models.',
    modelsButton: 'Query models',
    modelsHeadList: 'Pulled models (ollama list):',
    modelsHeadPs: 'Currently loaded (ollama ps):',
    modelsSizeLabel: 'size',
    modelsModifiedLabel: 'modified',
    modelsUsageLabel: 'usage',
    modelsProcessorLabel: 'processor',
    modelsContextLabel: 'context',
    modelsRunnerLabel: 'runner',
    modelsUntilLabel: 'until',
    modelsNone: '(no pulled models yet)',
    modelsPsEmpty: '(no models loaded right now)',
    modelsListFailed: '(ollama list unavailable: {error})',
    modelsPsFailed: '(ollama ps unavailable: {error})',
    modelsApiOk: '{count} model(s) [via /api/tags fallback — sizes not available]:',
    modelsApiEmpty: 'No models [via /api/tags fallback]',
    modelsFail: 'Query failed: {error}',
    startNotReady: 'Spawned (pid {pid}); port not ready within 30s',
    startError: 'Start failed: {error}',
    listenTitle: 'Listen check',
    listenDesc: 'Probe Ollama with `GET /api/tags` and report whether the service is actually serving.',
    listenButton: 'Listen check',
    waiting: 'Waiting for result…',
    listenEnabled: 'Enabled' + ' ({models} models)',
    listenDisabled: 'Not enabled: {error}',
    embedTitle: 'Embed direct test',
    embedDesc: 'Bypass DSH and call Ollama /api/embed directly — a returned embeddings array means Ollama and the model themselves are fine.',
    embedButton: 'Embed direct test',
    embedOk: 'Success: {count} embedding(s), {dimension} dims — Ollama and model are healthy',
    embedFail: 'Failed: {error} — the problem is on the Ollama side',
    versionTitle: 'Ollama version',
    versionDesc: 'Run `ollama --version`. Detected automatically once when the host boots.',
    versionButton: 'Check Ollama version',
    versionResult: 'Ollama {version}',
    versionFail: 'Check failed: {error}',
    ipv4Title: 'Force-IPv4 CLI test',
    ipv4Desc: 'Run `MNEMON_EMBED_ENDPOINT=http://127.0.0.1:{port} mnemon embed --status` and report the exit verdict.',
    ipv4Button: 'Force-IPv4 CLI test',
    ipv4Ok: 'Success',
    ipv4Fail: 'Failed (exit {code}): {output}',
    apiError: 'API error: {error}'
  };

  var ZH = {
    panelTitle: 'Ollama 服务',
    autoStartTitle: '自启动',
    autoStartDesc: '宿主（dsh）启动时自动拉起 ollama 服务。关闭开关不会停止已在运行的服务，只影响下次启动。',
    autoStartOn: '已开启自启动。{detail}',
    autoStartOff: '已关闭自启动：宿主启动时将不再自动拉起服务；当前正在运行的服务不受影响。',
    autoStartDetailStarted: '服务已立即拉起（pid {pid}）',
    autoStartDetailRunning: '服务已在运行',
    autoStartDetailNotReady: '已拉起（pid {pid}），端口尚未就绪',
    autoStartToggleFail: '切换失败：{error}',
    startTitle: '启动 ollama 服务',
    startDesc: '以分离后台服务方式拉起 `ollama serve`；已在运行则自动跳过。',
    startButton: '启动',
    startDisabledLabel: 'ollama 服务已启动',
    startWaiting: '正在启动…',
    startStarted: '已拉起（pid {pid}）',
    startSkipped: '端口已有服务在监听 — 已跳过',
    modelsTitle: '查询 Ollama 模型',
    modelsDesc: '依次执行 `ollama list`、`ollama ps`；都失败时兜底 `curl -s /api/tags`。显示模型名称、占用与当前运行的模型。',
    modelsButton: '查询模型',
    modelsHeadList: '已拉取的模型（ollama list）：',
    modelsHeadPs: '当前运行中的模型（ollama ps）：',
    modelsSizeLabel: '大小',
    modelsModifiedLabel: '修改于',
    modelsUsageLabel: '占用',
    modelsProcessorLabel: '处理器',
    modelsContextLabel: '上下文',
    modelsRunnerLabel: '运行器',
    modelsUntilLabel: '保留至',
    modelsNone: '（暂无已拉取的模型）',
    modelsPsEmpty: '（当前没有运行中的模型）',
    modelsListFailed: '（ollama list 不可用：{error}）',
    modelsPsFailed: '（ollama ps 不可用：{error}）',
    modelsApiOk: '共 {count} 个模型（兜底 /api/tags，无占用信息）：',
    modelsApiEmpty: '暂无模型（兜底 /api/tags）',
    modelsFail: '查询失败：{error}',
    startNotReady: '已拉起（pid {pid}）；30 秒内端口未就绪',
    startError: '启动失败：{error}',
    listenTitle: '监听 ollama',
    listenDesc: '探测 Ollama `GET /api/tags`，判断服务是否真正在提供请求。',
    listenButton: '监听 ollama',
    waiting: '等待返回结果…',
    listenEnabled: '已启用' + '（{models} 个模型）',
    listenDisabled: '未启用：{error}',
    embedTitle: '嵌入直连测试',
    embedDesc: '绕过 DSH 直接调用 Ollama /api/embed — 返回 embeddings 数组说明 Ollama 与模型本身正常。',
    embedButton: '嵌入直连测试',
    embedOk: '成功：{count} 条 embedding（{dimension} 维）— Ollama 与模型正常',
    embedFail: '失败：{error} — 问题在 Ollama 侧',
    versionTitle: 'Ollama 版本',
    versionDesc: '执行 `ollama --version`。宿主启动时自动检测一次。',
    versionButton: '检查 Ollama 版本',
    versionResult: 'Ollama {version}',
    versionFail: '检查失败：{error}',
    ipv4Title: '强制 IPv4 CLI 测试',
    ipv4Desc: '执行 `MNEMON_EMBED_ENDPOINT=http://127.0.0.1:{port} mnemon embed --status`，回报退出判定。',
    ipv4Button: '强制 IPv4 CLI 测试',
    ipv4Ok: '成功',
    ipv4Fail: '失败（退出码 {code}）：{output}',
    apiError: '接口错误：{error}'
  };

  var PANEL_CSS = [
    '.oa_panel{display:flex;flex-direction:column;gap:2px;padding:8px 4px}',
    '.oa_panel_title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;',
    'line-height:16px;padding:2px 0 6px;margin:0}',
    '.oa_row{display:flex;align-items:flex-start;gap:10px;padding:10px 0;',
    'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
    '.oa_row:last-of-type{border-bottom:none}',
    '.oa_text{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}',
    '.oa_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:20px}',
    '.oa_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:16px;',
    'max-width:56ch}',
    '.oa_result{margin-top:4px;font-size:12px;line-height:16px;word-break:break-all;white-space:pre-line;',
    'color:var(--dsw-alias-label-secondary)}',
    /* Success/failure verdicts get semantic colors (theme tokens with a
       readable green/red fallback) so the outcome reads at a glance. */
    '.oa_result_ok{color:var(--dsw-alias-state-success, #4caf50)}',
    '.oa_result_fail{color:var(--dsw-alias-state-danger, #f44336)}',
    '.oa_result_wait{color:var(--dsw-alias-label-tertiary)}',
    '.oa_btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:36px;',
    'min-width:96px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);',
    'background:var(--dsw-alias-bg-module-platform);font:inherit;font-size:13px;font-weight:500;',
    'line-height:1;color:var(--dsw-alias-label-primary);cursor:pointer;box-sizing:border-box}',
    '.oa_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
    '.oa_btn:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
    '.oa_btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));',
    'outline-offset:2px}',
    '.oa_btn{-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    /* The auto-start switch: a real toggle (track + knob), not a button. */
    '.oa_switch{flex:none;position:relative;width:46px;height:28px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);',
    'background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .15s ease;',
    '-webkit-tap-highlight-color:transparent;touch-action:manipulation;padding:0}',
    '.oa_switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary, #3b82f6);',
    'border-color:var(--dsw-alias-state-business-primary, #3b82f6)}',
    '.oa_switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));',
    'outline-offset:2px}',
    '.oa_switch_knob{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;',
    'box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .15s ease}',
    '.oa_switch[aria-checked="true"] .oa_switch_knob{transform:translateX(18px)}',
    '.oa_switch:disabled{opacity:.5;cursor:default}'
  ].join('');

  /** Locale service face, captured on apply for the fallback translator. */
  var localeFace = null;

  /** React runtime, assigned when the loader materializes this module. */
  var React = null;

  /**
   * Translator built from the LIVE app locale — this is what "follow the
   * system/app language" means here: `ctx.locale.getLocale().active` is the
   * same source the host UI renders from, so the panel always matches the
   * language the rest of the GUI is in. Used for every panel string; the
   * slot-bound `t` prop is kept only as a last-resort fallback.
   */
  function makeTranslator(ctx) {
    var active = '';
    try {
      active = String((ctx && ctx.locale && ctx.locale.getLocale && ctx.locale.getLocale()) ? (ctx.locale.getLocale().active || '') : '');
    } catch (error) {
      active = '';
    }
    var dict = active.indexOf('zh') === 0 ? ZH : EN;
    return function (key, params) {
      var text = dict[key];
      if (text === undefined) text = EN[key] !== undefined ? EN[key] : key;
      if (!params) return text;
      return String(text).replace(/\{(\w+)\}/g, function (match, name) {
        return name in params ? String(params[name]) : match;
      });
    };
  }

  /** Fallback translator used only if the live locale face is missing. */
  function fallbackTranslate(key, params) {
    var active = localeFace !== null && typeof localeFace.getLocale === 'function'
      ? String(localeFace.getLocale().active || '')
      : '';
    var dict = active.indexOf('zh') === 0 ? ZH : EN;
    var text = dict[key];
    if (text === undefined) return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return name in params ? String(params[name]) : match;
    });
  }

  /** One POST to a prefix route; resolves to the parsed JSON body. */
  function callHost(subpath) {
    return fetch(API + subpath, { method: 'POST' }).then(function (res) {
      return res.json().catch(function () {
        return { error: 'HTTP ' + res.status };
      }).then(function (body) {
        if (!res.ok && !body.error) body.error = 'HTTP ' + res.status;
        return body;
      });
    }).catch(function (err) {
      return { error: String(err && err.message ? err.message : err) };
    });
  }

  /**
   * The six action rows, defined ONCE at module level. Component identity
   * stability matters here: when the panel re-renders (status retries, the
   * auto-start toggle, theme changes) React must keep each row MOUNTED so
   * its busy/result state survives — otherwise the user's query results
   * vanish the moment anything else updates. Results therefore persist
   * until the panel unmounts (leaving the plugin page), which is the
   * intended "收起发生在退出页面之后" behavior.
   */
  var ROW_DEFS = [
    {
      key: 'start',
      title: 'startTitle',
      desc: 'startDesc',
      button: 'startButton',
      buttonDisabledLabel: 'startDisabledLabel',
      waitingKey: 'startWaiting',
      run: function () {
        return callHost('/start');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.error) {
          return { text: translate('startError', { error: outcome.error }), tone: 'fail' };
        }
        if (outcome.started === true && outcome.reason === 'not-ready-within-30s') {
          return { text: translate('startNotReady', { pid: outcome.pid }), tone: 'wait' };
        }
        if (outcome.started === true) {
          return { text: translate('startStarted', { pid: outcome.pid }), tone: 'ok' };
        }
        return { text: translate('startSkipped'), tone: 'ok' };
      }
    },
    {
      key: 'models',
      title: 'modelsTitle',
      desc: 'modelsDesc',
      button: 'modelsButton',
      run: function () {
        return callHost('/models');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.ok !== true) {
          return { text: translate('modelsFail', { error: outcome.error || 'no response' }), tone: 'fail' };
        }
        if (outcome.source === 'cli') {
          var parts = [];
          var listRows = outcome.list && Array.isArray(outcome.list.rows) ? outcome.list.rows : [];
          var psRows = outcome.ps && Array.isArray(outcome.ps.rows) ? outcome.ps.rows : [];
          var kv = function (label, value) {
            return value ? label + ': ' + value : '';
          };
          // Section 1: pulled models (names + sizes, localized labels).
          if (outcome.list && outcome.list.error) {
            parts.push(translate('modelsListFailed', { error: String(outcome.list.error).slice(0, 80) }));
          } else if (listRows.length === 0) {
            parts.push(translate('modelsHeadList') + '\n' + translate('modelsNone'));
          } else {
            parts.push(translate('modelsHeadList') + '\n' + listRows.map(function (r) {
              return '· ' + r.name + '  ' + [
                kv(translate('modelsSizeLabel'), r.size),
                kv(translate('modelsModifiedLabel'), r.modified)
              ].filter(Boolean).join('  ');
            }).join('\n'));
          }
          // Section 2: currently loaded models (usage + runtime, localized).
          var anySectionError = (outcome.list && !!outcome.list.error) || (outcome.ps && !!outcome.ps.error);
          if (outcome.ps && outcome.ps.error) {
            parts.push(translate('modelsPsFailed', { error: String(outcome.ps.error).slice(0, 80) }));
          } else if (psRows.length === 0) {
            parts.push(translate('modelsHeadPs') + '\n' + translate('modelsPsEmpty'));
          } else {
            parts.push(translate('modelsHeadPs') + '\n' + psRows.map(function (r) {
              return '· ' + r.name + '  ' + [
                kv(translate('modelsUsageLabel'), r.size),
                kv(translate('modelsProcessorLabel'), r.processor),
                kv(translate('modelsContextLabel'), r.context),
                kv(translate('modelsRunnerLabel'), r.runner),
                kv(translate('modelsUntilLabel'), r.until)
              ].filter(Boolean).join('  ');
            }).join('\n'));
          }
          return {
            text: parts.join('\n\n'),
            tone: anySectionError ? 'fail' : ((listRows.length > 0 || psRows.length > 0) ? 'ok' : 'wait')
          };
        }
        // api fallback (/api/tags): names only, no sizes.
        if (Array.isArray(outcome.models)) {
          if (outcome.models.length === 0) {
            return { text: translate('modelsApiEmpty'), tone: 'wait' };
          }
          var lines = outcome.models.map(function (name) { return '· ' + name; }).join('\n');
          return {
            text: translate('modelsApiOk', { count: outcome.models.length }) + '\n' + lines,
            tone: 'ok'
          };
        }
        return { text: translate('modelsFail', { error: 'no response' }), tone: 'fail' };
      }
    },
    {
      key: 'listen',
      title: 'listenTitle',
      desc: 'listenDesc',
      button: 'listenButton',
      run: function () {
        return callHost('/health');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.enabled === true) {
          return {
            text: translate('listenEnabled', { models: outcome.modelCount !== null && outcome.modelCount !== undefined ? outcome.modelCount : '?' }),
            tone: 'ok'
          };
        }
        return {
          text: translate('listenDisabled', { error: outcome.error || 'no response' }),
          tone: 'fail'
        };
      }
    },
    {
      key: 'embed',
      title: 'embedTitle',
      desc: 'embedDesc',
      button: 'embedButton',
      run: function () {
        return callHost('/embed-test');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.ok === true) {
          return {
            text: translate('embedOk', {
              count: outcome.count,
              dimension: outcome.dimension !== null && outcome.dimension !== undefined ? outcome.dimension : '?'
            }),
            tone: 'ok'
          };
        }
        return {
          text: translate('embedFail', { error: outcome.error || 'no response' }),
          tone: 'fail'
        };
      }
    },
    {
      key: 'version',
      title: 'versionTitle',
      desc: 'versionDesc',
      button: 'versionButton',
      run: function () {
        return callHost('/version');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.ok === true && outcome.version) {
          return { text: translate('versionResult', { version: outcome.version }), tone: 'ok' };
        }
        return {
          text: translate('versionFail', { error: outcome.error || 'unknown' }),
          tone: 'fail'
        };
      }
    },
    {
      key: 'ipv4',
      title: 'ipv4Title',
      desc: 'ipv4Desc',
      button: 'ipv4Button',
      run: function () {
        return callHost('/ipv4-cli');
      },
      renderResult: function (outcome, translate) {
        if (outcome === null || outcome === undefined) return null;
        if (outcome.ok === true) {
          return { text: translate('ipv4Ok'), tone: 'ok' };
        }
        return {
          text: translate('ipv4Fail', {
            code: outcome.code !== null && outcome.code !== undefined ? outcome.code : '?',
            output: String(outcome.output || '').slice(0, 160)
          }),
          tone: 'fail'
        };
      }
    }
  ];

  /**
   * The single stable row component shared by all action rows.
   * @param {object} props - { ctx, t, spec, disabled, seedResult, onDone }
   */
  function ActionRow(props) {
    var t = makeTranslator(props.ctx);
    var spec = props.spec;
    var busy = React.useState(false);
    var result = React.useState(null);
    /** Seed view (host boot-time facts, e.g. the auto version check) shows
     *  until the user's own click produces a result for this row. */
    var seedView = null;
    if (props.seedResult !== null && props.seedResult !== undefined) {
      var s = spec.renderResult(props.seedResult, t, {});
      if (s && s.text) seedView = s;
    }

    /** The button click: mark busy, run, keep the last outcome. */
    function onAction(event) {
      if (event && event.currentTarget) event.currentTarget.disabled = true;
      busy[1](true);
      result[1]({ text: t('waiting'), tone: 'wait' });
      spec.run(props.ctx, t).then(function (outcome) {
        busy[1](false);
        var view = spec.renderResult(outcome, t, {});
        result[1](view && view.text ? view : null);
        if (props.onDone) props.onDone(outcome);
      }).catch(function () {
        busy[1](false);
        result[1]({ text: t('apiError', { error: 'unknown' }), tone: 'fail' });
      });
    }

    var shown = result[0] !== null ? result[0] : seedView;
    var disabled = busy[0] || (props.disabled === true);

    return React.createElement(
      'div',
      { className: 'oa_row' },
      React.createElement(
        'div',
        { className: 'oa_text' },
        React.createElement('div', { className: 'oa_title', children: t(spec.title) }),
        React.createElement('div', {
          className: 'oa_desc',
          children: spec.desc === null ? null : t(spec.desc)
        }),
        shown
          ? React.createElement('div', {
            className: 'oa_result oa_result_' + (shown.tone || ''),
            children: shown.text
          })
          : null
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          className: 'oa_btn',
          disabled: disabled,
          onClick: onAction
        },
        busy[0]
          ? t(spec.waitingKey || 'waiting')
          : (spec.buttonDisabledLabel !== undefined && props.disabled === true
            ? t(spec.buttonDisabledLabel)
            : t(spec.button))
      )
    );
  }
  ActionRow.displayName = 'ActionRow';

  /**
   * The auto-start switch row: a real toggle (role="switch"), seeded from the
   * host's persisted preference. Flipping ON also starts the service now;
   * flipping OFF only changes the next host boot. Stable module-level
   * component (same reasoning as ActionRow): its result survives panel
   * re-renders until the page is left.
   * @param {object} rowProps - { ctx, t, autoStart, busy, onToggle }
   */
  function AutoStartRow(rowProps) {
      var t = makeTranslator(rowProps.ctx);
      var result = React.useState(null);
      var on = rowProps.autoStart !== false;

      var toggle = function () {
        if (rowProps.busy) return;
        rowProps.onToggle(!on).then(function (outcome) {
          if (outcome === null || outcome === undefined) return;
          if (outcome.error) {
            result[1]({ text: t('autoStartToggleFail', { error: outcome.error }), tone: 'fail' });
            return;
          }
          if (outcome.autoStart === true) {
            var detail = outcome.started === true
              ? (outcome.reason === 'not-ready-within-30s'
                ? t('autoStartDetailNotReady', { pid: outcome.pid })
                : t('autoStartDetailStarted', { pid: outcome.pid }))
              : t('autoStartDetailRunning');
            result[1]({ text: t('autoStartOn', { detail: detail }), tone: 'ok' });
          } else {
            result[1]({ text: t('autoStartOff'), tone: 'ok' });
          }
        });
      };

      return React.createElement(
        'div',
        { className: 'oa_row' },
        React.createElement(
          'div',
          { className: 'oa_text' },
          React.createElement('div', { className: 'oa_title', children: t('autoStartTitle') }),
          React.createElement('div', { className: 'oa_desc', children: t('autoStartDesc') }),
          result[0]
            ? React.createElement('div', {
              className: 'oa_result oa_result_' + (result[0].tone || ''),
              children: result[0].text
            })
            : null
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'oa_switch',
            'aria-checked': on,
            'aria-label': t('autoStartTitle'),
            disabled: rowProps.busy,
            onClick: toggle
          },
          React.createElement('span', { className: 'oa_switch_knob', 'aria-hidden': 'true' })
        )
      );
  }
  AutoStartRow.displayName = 'AutoStartRow';

  /**
   * The panel body: reads the host's status once on mount so the start row
   * can render its disabled "already running" state, and wires the rows to
   * their prefix routes (auto-start switch + five action rows).
   * @param {object} ctx - the plugin's client cordis context.
   */
  function makePanel(ctx) {
    function OllamaPanel(props) {
      var t = makeTranslator(ctx);

      var liveState = React.useState(null);
      var setLiveState = liveState[1];
      /** The ACTUAL status snapshot (the second half of the useState tuple is
       *  the setter; reading fields off the tuple itself would always be
       *  undefined — the very bug that kept the start row from greying out). */
      var live = liveState[0];
      var toggleBusy = React.useState(false);

      /**
       * Poll the host's status for the panel's whole mounted life.
       *
       * A one-shot fetch pins whatever the host answered at mount time — and
       * this page can outlive host restarts and ollama state changes (the
       * launcher's tab stays open while the host underneath it is replaced).
       * A stale "not running" answer then keeps the start row un-greyed
       * forever, which is exactly the reported bug. A light 5 s poll
       * converges the panel to the live host state within one interval, and
       * stops as soon as the user leaves the plugin page (the effect's
       * cleanup clears the timer).
       */
      React.useEffect(function () {
        var stopped = false;
        var timer = null;
        var POLL_MS = 5000;
        var RETRY_MS = 1500;
        /**
         * Direct Ollama probe, fully client-side: the browser talks straight
         * to the Ollama server (Ollama's CORS echoes our origin back), so
         * the start row's "already running" grey-out never depends on the
         * host process's state machine or on when this page was loaded.
         */
        function probeOllama(endpoint) {
          if (!endpoint) return Promise.resolve(null);
          return fetch(endpoint + '/api/version', { mode: 'cors' })
            .then(function (res) {
              if (res.ok) {
                return res.json().then(function (body) {
                  return { running: true, version: (body && body.version) || null };
                });
              }
              return null;
            })
            .catch(function () { return null; }); // refused / offline → not running
        }
        function tick() {
          fetch(API + '/')
            .then(function (res) {
              return res && res.ok ? res.json() : null;
            })
            .then(function (status) {
              if (stopped) return;
              if (status && (typeof status.listening === 'boolean' || typeof status.running === 'boolean')) {
                var endpoint = 'http://' + status.host + ':' + status.port;
                probeOllama(endpoint).then(function (probe) {
                  if (stopped) return;
                  setLiveState(function (prev) {
                    var next = prev ? Object.assign({}, prev) : {};
                    next.listening = status.listening;
                    next.startedByUs = status.startedByUs;
                    next.pid = status.pid;
                    next.host = status.host;
                    next.port = status.port;
                    next.autoStart = (status.autoStart !== null && status.autoStart !== undefined)
                      ? status.autoStart
                      : next.autoStart;
                    // FRESH each tick (no sticky-true): host fact + this tick's
                    // direct Ollama probe. Stops → un-grey within one poll.
                    next.directRunning = !!probe;
                    next.running = !!(status.running || status.listening || probe);
                    if (probe && probe.version) {
                      next.version = probe.version;
                      next.versionChecked = true;
                    } else if (status.version) {
                      next.version = status.version;
                      next.versionChecked = status.versionChecked || next.versionChecked;
                    }
                    next.ollamaEndpoint = endpoint;
                    return next;
                  });
                });
                timer = setTimeout(tick, POLL_MS);
              } else {
                timer = setTimeout(tick, RETRY_MS);
              }
            })
            .catch(function () {
              if (stopped) return;
              timer = setTimeout(tick, RETRY_MS);
            });
        }
        tick();
        /** Browsers throttle timers in background tabs; when the user comes
         *  back to this page, re-sync immediately. */
        var onVisible = function () {
          if (stopped) return;
          if (document.visibilityState === 'visible') tick();
        };
        document.addEventListener('visibilitychange', onVisible);
        return function () {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, []);

      /** POST the switch change; resolves to the host's outcome. */
      function onToggle(enabled) {
        toggleBusy[1](true);
        return fetch(API + '/auto-start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: enabled })
        })
          .then(function (res) { return res.json().catch(function () { return { error: 'HTTP ' + res.status }; }); })
          .then(function (outcome) {
            setLiveState(function (prev) {
              var next = prev === null || prev === undefined ? {} : prev;
              next.autoStart = enabled;
              return next;
            });
            return outcome;
          })
          .catch(function (err) {
            return { error: String(err && err.message ? err.message : err) };
          })
          .then(function (outcome) {
            toggleBusy[1](false);
            refreshLive();
            return outcome;
          });
      }

      /** Refresh live facts after an action that mutates them. */
      function refreshLive() {
        fetch(API + '/')
          .then(function (res) { return res.json(); })
          .then(setLiveState)
          .catch(function () { /* keep the previous snapshot */ });
      }

      /** Grey the start row when ANY source says Ollama is up: the host's
       *  boot-time port check, the host's live listening probe, or this
       *  panel's own direct Ollama API probe (which is authoritative and
       *  independent of how old this page load is). */
      var running = live !== null && live !== undefined
        ? !!(live.running || live.listening || live.directRunning)
        : false;

      // The host booted and ran the automatic version check; surface its
      // cached value as the version row's seed result (until the user
      // runs the check again). Row state itself stays with the (stable)
      // ActionRow components, so results persist until the panel unmounts.
      var versionSeed = live !== null && live !== undefined && live.versionChecked
        ? (live.version
          ? { ok: true, version: live.version }
          : { ok: false, error: 'boot check failed' })
        : null;

      return React.createElement(
        'div',
        { className: 'oa_panel' },
        React.createElement('h3', {
          className: 'oa_panel_title',
          children: t('panelTitle')
        }),
        React.createElement(AutoStartRow, {
          key: 'auto-start',
          ctx: ctx,
          autoStart: live !== null && live !== undefined ? live.autoStart : undefined,
          busy: toggleBusy[0],
          onToggle: onToggle
        }),
        ROW_DEFS.map(function (def) {
          return React.createElement(ActionRow, {
            key: def.key,
            ctx: ctx,
            spec: def,
            disabled: def.key === 'start' ? running : undefined,
            seedResult: def.key === 'version' ? versionSeed : null,
            onDone: def.key === 'start' ? refreshLive : undefined
          });
        })
      );
    }
    OllamaPanel.displayName = 'OllamaPanel';
    return OllamaPanel;
  }

  var styleElement = null;

  function installStyles() {
    if (styleElement !== null || typeof document === 'undefined') return;
    var el = document.createElement('style');
    el.textContent = PANEL_CSS;
    el.setAttribute('data-dsh-ollama-autostart', 'panel');
    var parent = document.head !== null ? document.head : document.documentElement;
    if (parent === null) return;
    parent.appendChild(el);
    styleElement = el;
  }

  function restoreStyles() {
    if (styleElement === null) return;
    var el = styleElement;
    styleElement = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        React = require('react');

        return {
          inject: ['slots', 'locale'],
          /**
           * Client plugin body: own the dictionaries, keep the panel styles in
           * <head>, and contribute the control panel to this bundle's
           * Plugins page (the keyed `plugins.bundle.config` slot dispatches
           * by the bundle's package name — PLUGIN_ID above).
           */
          apply: function (ctx) {
            localeFace = ctx.locale;

            ctx.effect(function () {
              installStyles();
              return restoreStyles;
            }, PLUGIN_ID + ': panel styles');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'en', EN);
            }, PLUGIN_ID + ': en dictionary');
            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'zh', ZH);
            }, PLUGIN_ID + ': zh dictionary');

            ctx.slots.inject(CONFIG_SLOT, function () {
              return ctx.slots.register({
                name: CONFIG_SLOT,
                key: PLUGIN_ID,
                locale: LOCALE_NS
              }, makePanel(ctx));
            });
          }
        };
      }
    });
  }
})();
