// dsh-deepseek-web — browser half (client plugin bundle).
//
// Loaded by dsh-client-modules and executed through the vendored cordis
// Loader's lazy-CJS module table. The factory body is plain CJS with `require`
// resolved against the shell's platform module table — no build step, no JSX
// syntax.
//
// It registers one Settings page that owns the credential and the sync trigger.
// Everything the page shows comes from the Host route, so the page itself owns
// no state that must survive a reload.
//
// NOTE on the element helper: `react/jsx-runtime`'s `jsx(type, props, key)`
// takes its third argument as the React KEY, and children live in
// `props.children`. Passing text as the third argument silently drops it, which
// renders an empty page. `h()` below always folds children into props so that
// mistake cannot recur.
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const seedProbe = { lastError: null };
    const requireSeed = (name) => {
      try {
        return require(name);
      } catch (error) {
        seedProbe.lastError = error;
        return null;
      }
    };
    const jsxRuntime = requireSeed('react/jsx-runtime');
    const react = requireSeed('react');
    if (jsxRuntime === null || react === null) {
      try {
        console.warn(
          '[dsh-deepseek-web] required platform modules unavailable — plugin disabled for this session:',
          seedProbe.lastError && seedProbe.lastError.message,
        );
      } catch {
        /* nothing else to do */
      }
      exports.apply = () => {};
      exports.inject = [];
      return module.exports;
    }

    const { jsx } = jsxRuntime;
    const { useCallback, useEffect, useRef, useState } = react;

    /**
     * Build one element with children folded into props.
     * @param {string | Function} type
     * @param {object | null} props
     * @param {...unknown} children
     */
    function h(type, props, ...children) {
      const base = props === null || props === undefined ? {} : props;
      if (children.length === 0) return jsx(type, base);
      const value = children.length === 1 ? children[0] : children;
      return jsx(type, { ...base, children: value });
    }

    /** Dictionary namespace owned by this plugin. */
    const NS = 'deepseek-web';
    /** Same-origin Host route. */
    const API_PATH = new URL('dsh-deepseek-web/api', document.baseURI || 'http://localhost/').pathname;

    /** Display strings, registered with the locale service. */
    const dictionaries = {
      zh: {
        'nav': 'DeepSeek 网页版',
        'connection.title': '连接',
        'connection.hint': '把 chat.deepseek.com 的登录凭证（user token）存进来。插件用它读取网页版对话，并在网页端模型上运行对话——这部分用量记在网页产品上，不消耗 API 余额。',
        'connection.placeholder': '粘贴 user token',
        'connection.placeholderSaved': '已保存 {tail}（留空表示不修改）',
        'connection.save': '保存并验证',
        'connection.saving': '验证中…',
        'connection.verify': '检测当前凭证',
        'connection.verifying': '检测中…',
        'connection.state': '状态',
        'connection.configured': '已配置',
        'connection.missing': '未配置',
        'connection.stateFile': '数据文件',
        'connection.howTo': '如何获取 user token',
        'connection.howTo.step1': '在浏览器里登录 chat.deepseek.com',
        'connection.howTo.step2': '按 F12 打开开发者工具，切到 Console（控制台）面板',
        'connection.howTo.step3': '粘贴并运行下面这行命令，复制它输出的那串字符',
        'connection.howTo.step4': '粘贴到上面的输入框，点「保存并验证」',
        'connection.howTo.command': 'JSON.parse(localStorage.userToken).value',
        'connection.howTo.note': '本地存储里它的形式是 {"value":"…","__version":"0"}，只需要 value 引号里的那一串。token 等同于你的登录凭证，不要分享给他人。',
        'sync.title': '对话同步',
        'sync.hint': '网页版的全部对话会作为一个独立的「{workspace}」工作区出现在侧边栏，每个对话是一条普通 DSH 会话：可以展开、搜索、折叠，点开就能看历史并继续聊。',
        'sync.now': '立即同步',
        'sync.running': '同步中…',
        'sync.reloadHint': '同步完成后，如果侧边栏没有立刻出现新对话，点「热重载并刷新」：热重载会重建会话索引，页面随后自动刷新。',
        'sync.reload': '热重载并刷新',
        'sync.reloading': '重载中…',
        'error.reload': '热重载失败：{message}',
        'error.reloadUnavailable': '当前 Host 没有启用 HMR，无法热重载；请手动刷新页面（Ctrl+R），或重启 DSH。',
        'undo.label': '撤销导入',
        'undo.running': '撤销中…',
        'undo.confirm': '撤销会归档本插件导入的全部会话、删除「对话」工作区，并清空导入记录。\n\n网页版上的对话不受影响，随时可以重新同步。\n\n继续吗？',
        'sync.imported': '已导入',
        'sync.count': '{count} 个对话',
        'sync.window': '同步范围',
        'sync.windowWeek': '最近 7 天（{since} 起）',
        'sync.windowMonth': '本月（{since} 起）',
        'sync.windowDays': '最近 {days} 天',
        'sync.windowAll': '全部对话',
        'sync.last': '上次同步',
        'sync.never': '从未',
        'sync.workspace': '工作区',
        'sync.workspaceMissing': '尚未创建',
        'sync.dir': '对话目录',
        'sync.autoInterval': '自动同步',
        'sync.autoIntervalValue': '每 {minutes} 分钟（上下浮动 30%）',
        'sync.autoIntervalOff': '已关闭（仅手动）',
        'models.title': '模型',
        'models.hint': '在输入框的模型选择器里选「DeepSeek 网页版」即可使用。',
        'limits.title': '能力说明',
        'limits.body': '网页端接口只接受一段文本 prompt，没有函数调用通道，所以这个模型不会发起工具调用；为保证「不写本地文件」，这些会话里的写入类工具也被额外拦截。',
        'loading': '正在读取…',
        'error.status': '无法读取插件状态：{message}',
        'error.workspace': '工作区创建失败：{message}',
        'error.syncItem': '对话导入失败：{message}',
        'error.emptyToken': '请先粘贴网页版 token。',
        'error.save': '保存失败：{message}',
        'error.invalidToken': '验证失败：{message}',
        'error.sync': '同步请求失败：{message}',
        'error.syncReport': '同步失败：{message}',
        'error.persist': '状态写入失败：{message}',
        'error.undo': '撤销失败：{message}',
        'error.verify': '验证请求失败：{message}',
        'error.verifyBad': '凭证无效：{message}',
        'ok.saved': 'token 已保存并验证通过{who}。',
        'ok.verified': '凭证有效：{who}',
        'ok.synced': '同步完成：共 {listed} 个对话，新导入 {imported} 个，已存在 {skipped} 个，已归组 {attached} 个',
        'ok.syncedFailed': '，失败 {failed} 个',
        'ok.undone': '已撤销：归档 {archived} 个会话，清理 {removed} 个会话文件。',
        'ok.undoneLocal': ' 其中 {local} 个是你在 DSH 内新建的对话，已归档并保留文件。',
        'ok.undoneUnknown': ' 另有 {unknown} 个无法确认来源（早期版本写入的记录），按保守策略保留了文件。',
        'ok.undoneArchiveFailed': ' 还有 {failed} 个归档失败，文件同样保留，可稍后重试撤销。',
        'time.justNow': '刚刚',
        'time.minutes': '{n} 分钟前',
        'time.hours': '{n} 小时前',
        'time.days': '{n} 天前',
        'qa.tab.title': '快捷侧问',
        'qa.entry.label': '快捷侧问（DeepSeek 网页版）',
        'qa.title': '快捷侧问',
        'qa.hint': '在这里向 DeepSeek 网页版提问。面板打开时已把当前对话压缩成背景发给它；问答只留在这个面板里，不会写进当前对话。',
        'qa.placeholder': '问点什么…（Enter 发送，Shift+Enter 换行）',
        'qa.send': '发送',
        'qa.reset': '刷新背景',
        'qa.resetHint': '丢弃当前侧问线程，用当前对话的最新内容重新生成压缩背景。',
        'qa.noToken': '尚未配置 user token：到 设置 → DeepSeek 网页版 保存后再来。',
        'qa.empty': '还没有提问，直接输入即可。',
        'qa.context': '背景 {chars} 字',
        'qa.contextNone': '无背景（当前对话还没有内容）',
        'qa.error': '出错了：{message}',
        'qa.streamError': '回复中断：{message}',
        'qa.busy': '上一条回复还在进行中',
        'qa.showHint': '显示说明',
        'qa.hideHint': '隐藏说明',
        'qa.hintTitle': '快捷侧问说明',
        'qa.copy': '复制',
        'qa.copied': '已复制',
      },
      en: {
        'nav': 'DeepSeek Web',
        'connection.title': 'Connection',
        'connection.hint': 'Store the chat.deepseek.com user token. The plugin uses it to read your web conversations and to run turns on the web model — that usage is billed to the web product, not to your API balance.',
        'connection.placeholder': 'Paste the user token',
        'connection.placeholderSaved': 'Saved {tail} (leave blank to keep)',
        'connection.save': 'Save and verify',
        'connection.saving': 'Verifying…',
        'connection.verify': 'Check current token',
        'connection.verifying': 'Checking…',
        'connection.state': 'Status',
        'connection.configured': 'Configured',
        'connection.missing': 'Not configured',
        'connection.stateFile': 'Data file',
        'connection.howTo': 'How to get a user token',
        'connection.howTo.step1': 'Sign in to chat.deepseek.com in your browser',
        'connection.howTo.step2': 'Press F12, open the Console panel',
        'connection.howTo.step3': 'Paste and run the command below, then copy what it prints',
        'connection.howTo.step4': 'Paste it into the field above and press "Save and verify"',
        'connection.howTo.command': 'JSON.parse(localStorage.userToken).value',
        'connection.howTo.note': 'It is stored as {"value":"…","__version":"0"} — only the string inside value is needed. The token is your login credential; never share it.',
        'sync.title': 'Conversation sync',
        'sync.hint': 'Every web conversation appears under a dedicated "{workspace}" workspace in the sidebar, one ordinary DSH session each: fold, search, open to read the history and keep chatting.',
        'sync.now': 'Sync now',
        'sync.running': 'Syncing…',
        'sync.reloadHint': 'If the new conversations do not show up in the sidebar right after syncing, press "Hot reload and refresh": the reload rebuilds the session indexes and the page then refreshes itself.',
        'sync.reload': 'Hot reload and refresh',
        'sync.reloading': 'Reloading…',
        'error.reload': 'Hot reload failed: {message}',
        'error.reloadUnavailable': 'This Host has no HMR service, so it cannot hot reload; refresh the page (Ctrl+R) or restart DSH.',
        'undo.label': 'Undo import',
        'undo.running': 'Undoing…',
        'undo.confirm': 'This archives every session this plugin imported, removes the workspace, and clears the import ledger.\n\nYour conversations on the web are untouched, and you can sync again at any time.\n\nContinue?',
        'sync.imported': 'Imported',
        'sync.count': '{count} conversations',
        'sync.window': 'Scope',
        'sync.windowWeek': 'last 7 days (from {since})',
        'sync.windowMonth': 'this month (from {since})',
        'sync.windowDays': 'last {days} days',
        'sync.windowAll': 'all conversations',
        'sync.last': 'Last sync',
        'sync.never': 'never',
        'sync.workspace': 'Workspace',
        'sync.workspaceMissing': 'not created yet',
        'sync.dir': 'Directory',
        'sync.autoInterval': 'Auto-sync',
        'sync.autoIntervalValue': 'every {minutes} min (±30% jitter)',
        'sync.autoIntervalOff': 'off (manual only)',
        'models.title': 'Models',
        'models.hint': 'Pick "DeepSeek Web" in the composer model selector.',
        'limits.title': 'Capabilities',
        'limits.body': 'The web endpoint accepts one text prompt and has no function-calling channel, so this model never issues tool calls; file-writing tools are also blocked inside these sessions so nothing is written locally.',
        'loading': 'Loading…',
        'error.status': 'Could not read the plugin status: {message}',
        'error.workspace': 'Could not create the workspace: {message}',
        'error.syncItem': 'Conversation import failed: {message}',
        'error.emptyToken': 'Paste a web token first.',
        'error.save': 'Save failed: {message}',
        'error.invalidToken': 'Verification failed: {message}',
        'error.sync': 'Sync request failed: {message}',
        'error.syncReport': 'Sync failed: {message}',
        'error.persist': 'Could not write state: {message}',
        'error.undo': 'Undo failed: {message}',
        'error.verify': 'Check request failed: {message}',
        'error.verifyBad': 'Token is not valid: {message}',
        'ok.saved': 'Token saved and verified{who}.',
        'ok.verified': 'Token is valid: {who}',
        'ok.synced': 'Synced {listed} conversations, imported {imported}, already present {skipped}, grouped {attached}',
        'ok.syncedFailed': ', {failed} failed',
        'ok.undone': 'Undone: archived {archived} sessions and cleaned {removed} session files.',
        'ok.undoneLocal': ' {local} of them were started in DSH; they are archived with their files kept.',
        'ok.undoneUnknown': ' {unknown} more predate provenance tracking and were kept on the safe side.',
        'ok.undoneArchiveFailed': ' {failed} could not be archived; their files were kept so a retry is possible.',
        'time.justNow': 'just now',
        'time.minutes': '{n} min ago',
        'time.hours': '{n} h ago',
        'time.days': '{n} d ago',
        'qa.tab.title': 'Quick ask',
        'qa.entry.label': 'Quick ask (DeepSeek Web)',
        'qa.title': 'Quick ask',
        'qa.hint': 'Ask the DeepSeek web model here. The panel seeds a throwaway web thread with a compressed digest of this conversation when it opens; the exchange stays in this panel and never enters the conversation.',
        'qa.placeholder': 'Ask anything… (Enter to send, Shift+Enter for newline)',
        'qa.send': 'Send',
        'qa.reset': 'Refresh context',
        'qa.resetHint': 'Drop the current side thread and reseed it with the latest digest of this conversation.',
        'qa.noToken': 'No user token yet: save one in Settings → DeepSeek Web first.',
        'qa.empty': 'Nothing asked yet — type below.',
        'qa.context': '{chars} chars of context',
        'qa.contextNone': 'No context (this conversation is still empty)',
        'qa.error': 'Failed: {message}',
        'qa.streamError': 'Reply interrupted: {message}',
        'qa.busy': 'A reply is still streaming',
        'qa.showHint': 'Show explanation',
        'qa.hideHint': 'Hide explanation',
        'qa.hintTitle': 'About quick ask',
        'qa.copy': 'Copy',
        'qa.copied': 'Copied',
      },
    };

    /** Format one dictionary string. */
    function format(template, values) {
      if (typeof template !== 'string') return '';
      if (values === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }

    /** A calendar day for the sync-scope row. */
    function formatDay(ms) {
      try {
        return new Date(ms).toLocaleDateString();
      } catch {
        return String(ms);
      }
    }

    /** Shared inline style vocabulary so the page looks like the shell. */
    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '4px 0 24px' },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        border: '1px solid rgba(128, 128, 128, 0.22)',
        borderRadius: '10px',
        padding: '14px 16px',
      },
      title: { fontSize: '13px', fontWeight: 600, letterSpacing: '0.01em' },
      hint: { fontSize: '12px', lineHeight: 1.6, opacity: 0.62 },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      input: {
        flex: '1 1 260px',
        minWidth: '220px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(128, 128, 128, 0.35)',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'inherit',
        outline: 'none',
      },
      button: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid rgba(128, 128, 128, 0.35)',
        background: 'rgba(128, 128, 128, 0.09)',
        color: 'inherit',
        fontSize: '13px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: '#4d6bfe',
        color: '#ffffff',
        fontSize: '13px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      },
      buttonDanger: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: '1px solid #e03131',
        background: 'transparent',
        color: '#e03131',
        fontSize: '13px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      kv: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '12.5px' },
      k: { opacity: 0.55 },
      v: { fontVariantNumeric: 'tabular-nums', wordBreak: 'break-all' },
      ok: { color: '#2f9e44' },
      bad: { color: '#e03131' },
      notice: {
        fontSize: '12.5px',
        lineHeight: 1.55,
        borderRadius: '8px',
        padding: '8px 12px',
        background: 'rgba(128, 128, 128, 0.09)',
      },
      howto: { marginTop: '2px' },
      summary: {
        fontSize: '12.5px',
        cursor: 'pointer',
        opacity: 0.78,
        userSelect: 'none',
        padding: '2px 0',
      },
      steps: { margin: '6px 0 0 18px', padding: 0, fontSize: '12px', lineHeight: 1.75, opacity: 0.7 },
      code: {
        margin: '8px 0 0',
        padding: '8px 10px',
        borderRadius: '7px',
        background: 'rgba(128, 128, 128, 0.13)',
        fontSize: '11.5px',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        overflowX: 'auto',
        userSelect: 'all',
        whiteSpace: 'pre',
        opacity: 0.9,
      },
    };

    /** One labelled row of the status grid. */
    function Row({ name, children }) {
      return h('div', { style: { display: 'contents' } }, [
        h('div', { key: 'k', style: styles.k }, name),
        h('div', { key: 'v', style: styles.v }, children),
      ]);
    }

    /** The settings page. */
    function DeepSeekWebSettings() {
      const [status, setStatus] = useState(null);
      const [token, setToken] = useState('');
      const [busy, setBusy] = useState('');
      const [notice, setNotice] = useState(null);
      const [localeId, setLocaleId] = useState('zh');

      const t = useCallback(
        (key, values) => {
          const dictionary = dictionaries[localeId] ?? dictionaries.zh;
          return format(dictionary[key] ?? key, values);
        },
        [localeId],
      );

      // Follow the shell language without binding a locale store this plugin
      // does not own.
      useEffect(() => {
        try {
          const lang = String(document.documentElement?.lang ?? '');
          setLocaleId(lang.toLowerCase().startsWith('zh') ? 'zh' : 'en');
        } catch {
          /* keep the default */
        }
      }, []);

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(API_PATH + '/status', { credentials: 'same-origin' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          setStatus(await response.json());
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.status', { message: String(error && error.message ? error.message : error) }) });
        }
      }, [t]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      const saveToken = useCallback(async () => {
        const value = token.trim();
        if (value === '') {
          setNotice({ kind: 'bad', text: t('error.emptyToken') });
          return;
        }
        setBusy('token');
        setNotice(null);
        try {
          const response = await fetch(API_PATH + '/token', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: value }),
          });
          const body = await response.json();
          if (!body.ok) {
            setNotice({ kind: 'bad', text: t('error.invalidToken', { message: body.detail || body.error || '?' }) });
          } else {
            setToken('');
            const account = body.account || {};
            const who = account.name ? `（${account.name}）` : '';
            setNotice({ kind: 'ok', text: t('ok.saved', { who }) });
            await refresh();
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.save', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy('');
        }
      }, [token, refresh, t]);

      /**
       * Recompose the plugin tree, then refresh the page.
       *
       * The import writes sessions and their workspace membership, but the
       * sidebar rows come from indexes that only a recomposition rebuilds; the
       * page reload afterwards is what shows them.
       */
      const reloadNow = useCallback(async () => {
        setBusy('reload');
        setNotice(null);
        try {
          const response = await fetch(API_PATH + '/reload', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const body = await response.json();
          if (!body.ok) {
            const message = body.error === 'hmr-unavailable'
              ? t('error.reloadUnavailable')
              : t('error.reload', { message: body.error || '?' });
            setNotice({ kind: 'bad', text: message });
            setBusy('');
            return;
          }
          setNotice({ kind: 'ok', text: t('sync.reloading') });
          // Give the Host a moment to push the recomposition, then refresh.
          window.setTimeout(() => {
            try {
              window.location.reload();
            } catch {
              /* the page may already be navigating */
            }
          }, 450);
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.reload', { message: String(error && error.message ? error.message : error) }) });
          setBusy('');
        }
      }, [t]);

      const syncNow = useCallback(async () => {
        setBusy('sync');
        setNotice(null);
        try {
          const response = await fetch(API_PATH + '/sync', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const report = await response.json();
          if (report.error) {
            setNotice({ kind: 'bad', text: t('error.syncReport', { message: report.error }) });
          } else {
            const tail = report.failed ? t('ok.syncedFailed', { failed: report.failed }) : '';
            const firstError = Array.isArray(report.errors) && report.errors.length > 0
              ? ` ${report.errors[0].error}`
              : '';
            setNotice({
              kind: report.failed > 0 ? 'bad' : 'ok',
              text: t('ok.synced', {
                listed: report.listed,
                imported: report.imported,
                skipped: report.skipped,
                attached: report.attached || 0,
              }) + tail + firstError,
            });
          }
          await refresh();
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.sync', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy('');
        }
      }, [refresh, t]);

      /**
       * Remove everything the import created: this plugin's session files, the
       * workspace, and the ledger. The credential stays, so re-importing is one
       * click.
       */
      const undo = useCallback(async () => {
        let confirmed = true;
        try {
          confirmed = window.confirm(t('undo.confirm'));
        } catch {
          /* a blocked confirm still proceeds: pressing the button is the intent */
        }
        if (!confirmed) return;
        setBusy('undo');
        setNotice(null);
        try {
          const response = await fetch(API_PATH + '/undo', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const body = await response.json();
          if (body.ok === false) {
            setNotice({ kind: 'bad', text: t('error.undo', { message: body.error || body.workspaceError || '?' }) });
          } else {
            // Files can legitimately remain: local conversations keep their log, and
            // so do ledger rows whose provenance predates the origin field, or whose
            // archive failed. Say so — "cleaned N" alone would look like a leak.
            const details = [
              (body.archivedLocal || 0) > 0 ? t('ok.undoneLocal', { local: body.archivedLocal }) : '',
              (body.keptUnknown || 0) > 0 ? t('ok.undoneUnknown', { unknown: body.keptUnknown }) : '',
              (body.keptArchiveFailed || 0) > 0 ? t('ok.undoneArchiveFailed', { failed: body.keptArchiveFailed }) : '',
            ].join('');
            setNotice({
              kind: 'ok',
              text: t('ok.undone', {
                archived: body.archivedSessions || 0,
                removed: body.removedSessions || 0,
              }) + details,
            });
          }
          await refresh();
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.undo', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy('');
        }
      }, [refresh, t]);

      const verify = useCallback(async () => {
        setBusy('verify');
        setNotice(null);
        try {
          const response = await fetch(API_PATH + '/verify', { method: 'POST', credentials: 'same-origin' });
          const body = await response.json();
          if (body.ok) {
            const account = body.account || {};
            const who = account.name || account.id || '?';
            setNotice({ kind: 'ok', text: t('ok.verified', { who: account.email ? `${who} · ${account.email}` : who }) });
          } else {
            setNotice({ kind: 'bad', text: t('error.verifyBad', { message: body.detail || '?' }) });
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: t('error.verify', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy('');
        }
      }, [t]);

      /** Render a timestamp the way the sidebar does. */
      const relative = useCallback((ms) => {
        if (!ms) return t('sync.never');
        const delta = Date.now() - ms;
        if (delta < 60_000) return t('time.justNow');
        if (delta < 3_600_000) return t('time.minutes', { n: Math.floor(delta / 60_000) });
        if (delta < 86_400_000) return t('time.hours', { n: Math.floor(delta / 3_600_000) });
        return t('time.days', { n: Math.floor(delta / 86_400_000) });
      }, [t]);

      // Loading and failure states both stay visible: an error notice must never
      // be replaced by a silent "loading" line.
      if (status === null) {
        return h('div', { style: styles.root }, [
          h('div', { key: 'loading', style: styles.hint }, t('loading')),
          notice === null
            ? null
            : h('div', { key: 'notice', style: { ...styles.notice, ...(notice.kind === 'ok' ? styles.ok : styles.bad) } }, notice.text),
        ]);
      }

      const models = Array.isArray(status.models) ? status.models : [];
      const title = status.workspaceTitle || '对话';

      // The window the background/main sync looks at, spelled out for the user.
      const windowStart = Number(status.windowStart) || 0;
      const windowSetting = status.syncWindow;
      let scopeLabel;
      if (windowStart === 0 || windowSetting === 'all' || windowSetting === undefined) {
        scopeLabel = t('sync.windowAll');
      } else if (typeof windowSetting === 'number' || /^\d+$/u.test(String(windowSetting))) {
        scopeLabel = t('sync.windowDays', { days: windowSetting });
      } else if (windowSetting === 'month') {
        // Without this branch a monthly scope was labelled as "this week".
        scopeLabel = t('sync.windowMonth', { since: formatDay(windowStart) });
      } else {
        scopeLabel = t('sync.windowWeek', { since: formatDay(windowStart) });
      }

      return h('div', { style: styles.root }, [
        h('div', { key: 'connection', style: styles.section }, [
          h('div', { key: 't', style: styles.title }, t('connection.title')),
          h('div', { key: 'hint', style: styles.hint }, t('connection.hint')),
          h('div', { key: 'row', style: styles.row }, [
            h('input', {
              key: 'input',
              style: styles.input,
              type: 'password',
              placeholder: status.hasToken ? t('connection.placeholderSaved', { tail: status.tokenTail }) : t('connection.placeholder'),
              value: token,
              onChange: (event) => setToken(event.target.value),
              spellCheck: false,
              autoComplete: 'off',
            }),
            h('button', {
              key: 'save',
              style: styles.buttonPrimary,
              type: 'button',
              disabled: busy !== '',
              onClick: saveToken,
            }, busy === 'token' ? t('connection.saving') : t('connection.save')),
            h('button', {
              key: 'verify',
              style: styles.button,
              type: 'button',
              disabled: busy !== '',
              onClick: verify,
            }, busy === 'verify' ? t('connection.verifying') : t('connection.verify')),
          ]),
          h('div', { key: 'kv', style: styles.kv }, [
            h(Row, { key: 'state', name: t('connection.state') },
              h('span', { style: status.hasToken ? styles.ok : styles.bad },
                status.hasToken ? t('connection.configured') : t('connection.missing'))),
            h(Row, { key: 'file', name: t('connection.stateFile') }, String(status.stateFile ?? '')),
          ]),
          // Collapsed by default: the guide is only needed once.
          h('details', { key: 'howto', style: styles.howto }, [
            h('summary', { key: 'summary', style: styles.summary }, t('connection.howTo')),
            h('ol', { key: 'steps', style: styles.steps }, [
              h('li', { key: 's1' }, t('connection.howTo.step1')),
              h('li', { key: 's2' }, t('connection.howTo.step2')),
              h('li', { key: 's3' }, t('connection.howTo.step3')),
              h('li', { key: 's4' }, t('connection.howTo.step4')),
            ]),
            h('pre', { key: 'cmd', style: styles.code }, t('connection.howTo.command')),
            h('div', { key: 'note', style: { ...styles.hint, marginTop: '8px' } }, t('connection.howTo.note')),
          ]),
        ]),

        h('div', { key: 'sync', style: styles.section }, [
          h('div', { key: 't', style: styles.title }, t('sync.title')),
          h('div', { key: 'hint', style: styles.hint }, t('sync.hint', { workspace: title })),
          h('div', { key: 'row', style: styles.row }, [
            h('button', {
              key: 'sync',
              style: styles.buttonPrimary,
              type: 'button',
              disabled: busy !== '' || !status.hasToken,
              onClick: syncNow,
            }, busy === 'sync' ? t('sync.running') : t('sync.now')),
            h('button', {
              key: 'undo',
              style: styles.buttonDanger,
              type: 'button',
              disabled: busy !== '' || (status.imported === 0 && !status.workspaceId),
              onClick: undo,
            }, busy === 'undo' ? t('undo.running') : t('undo.label')),
            h('button', {
              key: 'reload',
              style: styles.button,
              type: 'button',
              disabled: busy !== '',
              onClick: reloadNow,
            }, busy === 'reload' ? t('sync.reloading') : t('sync.reload')),
          ]),
          h('div', { key: 'reloadHint', style: styles.hint }, t('sync.reloadHint')),
          h('div', { key: 'kv', style: styles.kv }, [
            h(Row, { key: 'imported', name: t('sync.imported') }, t('sync.count', { count: status.imported || 0 })),
            h(Row, { key: 'scope', name: t('sync.window') }, scopeLabel),
            h(Row, { key: 'auto', name: t('sync.autoInterval') },
              (status.autoSyncSeconds || 0) > 0
                ? t('sync.autoIntervalValue', { minutes: Math.round(status.autoSyncSeconds / 60) })
                : t('sync.autoIntervalOff')),
            h(Row, { key: 'last', name: t('sync.last') }, relative(status.lastSyncAt)),
            h(Row, { key: 'ws', name: t('sync.workspace') }, status.workspaceId || t('sync.workspaceMissing')),
            h(Row, { key: 'dir', name: t('sync.dir') }, String(status.conversationDir ?? '')),
          ]),
          status.lastWorkspaceError
            ? h('div', { key: 'wserr', style: { ...styles.notice, ...styles.bad } },
                t('error.workspace', { message: status.lastWorkspaceError }))
            : null,
          status.lastSyncError
            ? h('div', { key: 'syncerr', style: { ...styles.notice, ...styles.bad } },
                t('error.syncItem', { message: status.lastSyncError }))
            : null,
          status.lastWriteError
            ? h('div', { key: 'writeerr', style: { ...styles.notice, ...styles.bad } },
                t('error.persist', { message: status.lastWriteError }))
            : null,
        ]),

        h('div', { key: 'models', style: styles.section }, [
          h('div', { key: 't', style: styles.title }, t('models.title')),
          h('div', { key: 'hint', style: styles.hint }, t('models.hint')),
          h('div', { key: 'kv', style: styles.kv }, models.map((model, index) =>
            h(Row, { key: 'model-' + index, name: model.name }, model.description))),
          h('div', { key: 'limits', style: styles.notice }, [
            h('div', { key: 'lt' }, t('limits.title')),
            h('div', { key: 'lb', style: { marginTop: '6px', opacity: 0.72 } }, t('limits.body')),
          ]),
        ]),

        notice === null
          ? null
          : h('div', {
              key: 'notice',
              style: { ...styles.notice, ...(notice.kind === 'ok' ? styles.ok : styles.bad) },
            }, notice.text),
      ]);
    }

    /**
     * The composer's model choices, mirroring the host's `MODELS` table.
     *
     * The status route ships the same rows (with their thinking/search flags);
     * this fallback keeps the menu usable in the first frames, before the
     * first status response arrives.
     */
    const QUICK_ASK_MODEL_FALLBACK = [
      { id: 'deepseek-web-chat', name: 'DeepSeek 网页版', description: '普通对话', thinking: false, search: false },
      { id: 'deepseek-web-reasoner', name: 'DeepSeek 网页版 · 深度思考', description: '展示推理过程', thinking: true, search: false },
      { id: 'deepseek-web-search', name: 'DeepSeek 网页版 · 智能搜索', description: '联网查证并给出引用', thinking: false, search: true },
      { id: 'deepseek-web-search-think', name: 'DeepSeek 网页版 · 搜索 + 深度思考', description: '联网搜索后推理', thinking: true, search: true },
    ];

    /**
     * The quick-ask panel body: a throwaway Q&A thread about the current
     * conversation, answered on the web model. Renders the persisted
     * transcript, streams the in-flight reply, and never writes anything back
     * into the conversation.
     */
    function QuickAskPanel({ sessionId }) {
      const [status, setStatus] = useState(null);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [live, setLive] = useState(null);
      const [notice, setNotice] = useState(null);
      // The explanation is hideable; the choice survives remounts of the tab
      // body (a reload is the only thing that forgets it).
      const [hintOpen, setHintOpen] = useState(() => {
        try {
          return localStorage.getItem('dsh.quick-ask.hint-open') !== '0';
        } catch {
          return true;
        }
      });
      const toggleHint = useCallback(() => {
        setHintOpen((open) => {
          const next = !open;
          try {
            localStorage.setItem('dsh.quick-ask.hint-open', next ? '1' : '0');
          } catch {
            /* private mode may refuse storage; the toggle still works */
          }
          return next;
        });
      }, []);
      const [localeId] = useState(
        (() => {
          try {
            const lang = String(document.documentElement?.lang ?? '');
            return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
          } catch {
            return 'zh';
          }
        })(),
      );
      // The composer's model menu replaces the shell's permission picker.
      const [modelId, setModelId] = useState(QUICK_ASK_MODEL_FALLBACK[0].id);
      const [modelOpen, setModelOpen] = useState(false);
      // Which message's copy button just copied (brief check-mark feedback).
      const [copiedKey, setCopiedKey] = useState(null);
      const t = useCallback(
        (key, values) => {
          const dictionary = dictionaries[localeId] ?? dictionaries.zh;
          return format(dictionary[key] ?? key, values);
        },
        [localeId],
      );

      /** Clock time for one message; older records have no `at` and show none. */
      const formatTime = useCallback((ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
        try {
          return new Date(ms).toLocaleTimeString(localeId === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
        } catch {
          return '';
        }
      }, [localeId]);

      /**
       * Copy one message's text, then flash the button into a check mark.
       *
       * The clipboard API covers the shell's Chromium; the textarea fallback
       * keeps the button working in compositions that withhold it.
       */
      const copyMessage = useCallback(async (key, text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText !== undefined) {
            await navigator.clipboard.writeText(text);
          } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            document.body.removeChild(area);
          }
          setCopiedKey(key);
          setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1600);
        } catch (error) {
          setNotice({ kind: 'bad', text: t('qa.error', { message: String(error && error.message ? error.message : error) }) });
        }
      }, [t]);

      const refresh = useCallback(async () => {
        try {
          const response = await fetch(`${API_PATH}/quick-ask/status?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          setStatus(await response.json());
        } catch (error) {
          setNotice({ kind: 'bad', text: t('qa.error', { message: String(error && error.message ? error.message : error) }) });
        }
      }, [sessionId, t]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      // Keep the newest turn in view: the transcript scrolls to the bottom as
      // the answer streams and when a settled exchange arrives.
      const listRef = useRef(null);
      const exchangeCount = status !== null && Array.isArray(status.exchanges) ? status.exchanges.length : 0;
      const liveLength = live === null ? 0 : (live.answer?.length ?? 0) + (live.reasoning?.length ?? 0);
      useEffect(() => {
        const node = listRef.current;
        if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight;
      }, [exchangeCount, liveLength]);

      /**
       * Send one question and consume the SSE reply.
       *
       * The stream carries the answer fragments as they arrive; a premature
       * close or error keeps the partial text visible with a notice. The
       * composer's model chip decides the web request flags.
       */
      const send = useCallback(async () => {
        const prompt = draft.trim();
        if (prompt === '' || busy) return;
        const options = Array.isArray(status?.models) && status.models.length > 0 ? status.models : QUICK_ASK_MODEL_FALLBACK;
        const selected = options.find((entry) => entry.id === modelId) ?? options[0];
        setBusy(true);
        setNotice(null);
        setLive({ answer: '', reasoning: '', prompt, at: Date.now() });
        setDraft('');
        try {
          const response = await fetch(`${API_PATH}/quick-ask/send`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              prompt,
              thinking: selected.thinking === true,
              search: selected.search === true,
            }),
          });
          if (!response.ok || response.body === null) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${response.status}`);
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const line = frame.split('\n').find((row) => row.startsWith('data:'));
              if (line === undefined) continue;
              let event;
              try {
                event = JSON.parse(line.slice(5).trim());
              } catch {
                continue;
              }
              if (event.kind === 'answer' || event.kind === 'reasoning') {
                setLive((prev) => (prev === null ? prev : { ...prev, [event.kind === 'answer' ? 'answer' : 'reasoning']: (prev[event.kind === 'answer' ? 'answer' : 'reasoning'] ?? '') + event.text }));
              } else if (event.kind === 'error') {
                setNotice({ kind: 'bad', text: t('qa.streamError', { message: event.message || '?' }) });
              }
            }
          }
        } catch (error) {
          setNotice({ kind: 'bad', text: t('qa.error', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy(false);
          setLive(null);
          await refresh();
        }
      }, [sessionId, draft, busy, status, modelId, t]);
      const reset = useCallback(async () => {
        setBusy(true);
        setNotice(null);
        try {
          const response = await fetch(`${API_PATH}/quick-ask/reset`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId }),
          });
          const body = await response.json().catch(() => ({}));
          if (!body.ok) throw new Error(body.error || `HTTP ${response.status}`);
          await refresh();
        } catch (error) {
          setNotice({ kind: 'bad', text: t('qa.error', { message: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy(false);
        }
      }, [sessionId, refresh, t]);

      if (status !== null && status.ready === false) {
        return h('div', { className: 'dsh-qa-root' }, h('div', { className: 'dsh-qa-hint' }, t('qa.noToken')));
      }

      const exchanges = status === null ? [] : Array.isArray(status.exchanges) ? status.exchanges : [];
      const rows = exchanges.slice();
      if (live !== null) {
        rows.push({ role: 'user', text: live.prompt ?? '' });
        rows.push({ role: 'assistant', text: live.answer || live.reasoning || '…', live: true });
      }

      const metaText = status !== null
        ? (status.contextChars > 0 ? t('qa.context', { chars: status.contextChars }) : t('qa.contextNone'))
        : '';

      const options = Array.isArray(status?.models) && status.models.length > 0 ? status.models : QUICK_ASK_MODEL_FALLBACK;
      const selectedModel = options.find((entry) => entry.id === modelId) ?? options[0];

      return h('div', { className: 'dsh-qa-root' }, [
        h('div', { key: 'head', className: 'dsh-qa-head' }, [
          h('div', { key: 'headrow', className: 'dsh-qa-headrow' }, [
            h('div', { key: 'meta', className: 'dsh-qa-meta' }, metaText),
            h('button', {
              key: 'reset',
              className: 'dsh-qa-ghost',
              type: 'button',
              title: t('qa.resetHint'),
              disabled: busy || (status !== null && !status.hasThread),
              onClick: reset,
            }, t('qa.reset')),
          ]),
          // The explanation lives in its own card: the title row is the
          // toggle, so the hide affordance and the box always move together.
          h('div', { key: 'hint', className: 'dsh-qa-hintcard' }, [
            h('button', {
              key: 'bar',
              className: 'dsh-qa-hintbar',
              type: 'button',
              'aria-expanded': hintOpen ? 'true' : 'false',
              'aria-label': hintOpen ? t('qa.hideHint') : t('qa.showHint'),
              onClick: toggleHint,
            }, [
              h(InfoIcon, { key: 'info' }),
              h('span', { key: 'label', className: 'dsh-qa-hintlabel' }, t('qa.hintTitle')),
              h(ChevronIcon, { key: 'chevron', className: 'dsh-qa-hintchev' }),
            ]),
            h('div', { key: 'body', className: 'dsh-qa-hintbody', hidden: hintOpen ? undefined : true }, t('qa.hint')),
          ]),
        ]),
        notice === null ? null : h('div', { key: 'notice', className: 'dsh-qa-notice', 'data-kind': notice.kind }, notice.text),
        h('div', { key: 'list', className: 'dsh-qa-list', ref: listRef },
          rows.length === 0
            ? h('div', { key: 'empty', className: 'dsh-qa-empty' }, t('qa.empty'))
            : rows.map((row, index) => {
                const rowKey = String(index);
                const isUser = row.role === 'user';
                const at = row.at ?? (row.live === true ? live?.at : undefined);
                return h('div', { key: rowKey, className: `dsh-qa-msg ${isUser ? 'dsh-qa-msg-user' : 'dsh-qa-msg-assistant'}` }, [
                  h('div', { key: 'bubble', className: isUser ? 'dsh-qa-user' : 'dsh-qa-assistant' },
                    isUser ? row.text : renderMarkdown(row.text)),
                  h('div', { key: 'meta', className: 'dsh-qa-msgmeta' }, [
                    h('button', {
                      key: 'copy',
                      className: 'dsh-qa-copy',
                      type: 'button',
                      title: copiedKey === rowKey ? t('qa.copied') : t('qa.copy'),
                      'aria-label': copiedKey === rowKey ? t('qa.copied') : t('qa.copy'),
                      onClick: () => copyMessage(rowKey, row.text),
                    }, copiedKey === rowKey ? h(CheckIcon) : h(CopyIcon)),
                    h('span', { key: 'time', className: 'dsh-qa-time' }, formatTime(at)),
                  ]),
                ]);
              })),
        h('div', { key: 'input', className: 'dsh-qa-composer' }, [
          h('textarea', {
            key: 'text',
            className: 'dsh-qa-textarea',
            rows: 2,
            placeholder: t('qa.placeholder'),
            value: draft,
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                event.preventDefault();
                send();
              }
            },
          }),
          h('div', { key: 'bar', className: 'dsh-qa-composerbar' }, [
            // The shell's permission picker is replaced by the web-model
            // picker: the quick-ask panel never runs local tools, so the
            // meaningful choice here is which web route answers.
            h('div', { key: 'modelwrap', className: 'dsh-qa-modelwrap' }, [
              h('button', {
                key: 'model',
                className: 'dsh-qa-model',
                type: 'button',
                'aria-haspopup': 'listbox',
                'aria-expanded': modelOpen ? 'true' : 'false',
                title: selectedModel?.description ?? '',
                onClick: () => setModelOpen((open) => !open),
              }, [
                h('span', { key: 'name', className: 'dsh-qa-modelname' }, selectedModel?.name ?? ''),
                h(ChevronIcon, { key: 'chev', className: 'dsh-qa-modelchev' }),
              ]),
              modelOpen
                ? [
                    h('div', {
                      key: 'backdrop',
                      className: 'dsh-qa-modelbackdrop',
                      onClick: () => setModelOpen(false),
                    }),
                    h('div', { key: 'menu', className: 'dsh-qa-modelmenu', role: 'listbox' },
                      options.map((entry) => h('button', {
                        key: entry.id,
                        className: 'dsh-qa-modelrow',
                        type: 'button',
                        role: 'option',
                        'aria-selected': entry.id === modelId ? 'true' : 'false',
                        onClick: () => {
                          setModelId(entry.id);
                          setModelOpen(false);
                        },
                      }, [
                        h('span', { key: 'n', className: 'dsh-qa-modelrowname' }, entry.name),
                        h('span', { key: 'd', className: 'dsh-qa-modelrowdesc' }, entry.description),
                      ]))),
                  ]
                : null,
            ]),
            h('button', {
              key: 'send',
              className: 'dsh-qa-send',
              type: 'button',
              'aria-label': t('qa.send'),
              title: t('qa.send'),
              disabled: busy || draft.trim() === '',
              onClick: send,
            }, h(SendIcon)),
          ]),
        ]),
      ]);
    }

    /**
     * The quick-ask stylesheet.
     *
     * Written against the shell's own theme tokens (`--dsw-*`), the same ones
     * the chat transcript and composer use, so the panel follows the
     * light/dark switch with no per-theme code. Every token carries a fallback
     * for compositions that render the plugin outside the themed shell.
     */
    const QA_CSS = [
      '.dsh-qa-entry{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;transition:background-color .1s,color .1s}',
      '.dsh-qa-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09));color:var(--dsw-alias-label-primary,inherit)}',
      '.dsh-qa-entry:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}',
      '.dsh-qa-entry svg{width:15px;height:15px;display:block}',
      '.dsh-qa-root{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;height:100%;min-height:0;padding:10px 10% 12px;font-size:var(--dsh-content-font-size,14px)}',
      '.dsh-qa-head{display:flex;flex-direction:column;gap:6px;flex:none}',
      '.dsh-qa-headrow{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh-qa-meta{flex:1 1 auto;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-qa-hintcard{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05));overflow:hidden}',
      '.dsh-qa-hintbar{display:flex;align-items:center;gap:6px;width:100%;padding:6px 8px 6px 10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;font-family:inherit;text-align:left;cursor:pointer;user-select:none}',
      '.dsh-qa-hintbar:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.07))}',
      '.dsh-qa-hintbar:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:-2px}',
      '.dsh-qa-hintbar svg{width:13px;height:13px;flex:none}',
      '.dsh-qa-hintlabel{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-qa-hintchev{transition:transform .15s ease}',
      '.dsh-qa-hintbar[aria-expanded="false"] .dsh-qa-hintchev{transform:rotate(-90deg)}',
      '.dsh-qa-hintbody{padding:0 10px 8px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsh-qa-hintbody[hidden]{display:none}',
      '.dsh-qa-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#81858c);padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.05))}',
      '.dsh-qa-ghost{padding:4px 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}',
      '.dsh-qa-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09))}',
      '.dsh-qa-ghost:disabled{opacity:.45;cursor:default}',
      '.dsh-qa-notice{font-size:12.5px;line-height:1.55;border-radius:var(--dsw-radius-sm,8px);padding:8px 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09))}',
      '.dsh-qa-notice[data-kind="bad"]{color:var(--dsw-alias-label-error,#e03131)}',
      '.dsh-qa-list{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:2px 2px 2px 0;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.dsh-qa-msg{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsh-qa-msg-user{align-items:flex-end}',
      '.dsh-qa-msg-assistant{align-items:flex-start}',
      '.dsh-qa-user{max-width:86%;padding:7px 11px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-bubble,#edf3fe);color:var(--dsw-alias-label-primary,inherit);font-size:var(--dsh-content-font-size,14px);line-height:1.55;white-space:pre-wrap;word-break:break-word}',
      '.dsh-qa-assistant{max-width:100%;padding:7px 11px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.07));color:var(--dsw-alias-label-primary,inherit);font-size:var(--dsh-content-font-size,14px);line-height:1.65;word-break:break-word;overflow-wrap:anywhere}',
      '.dsh-qa-msgmeta{display:flex;align-items:center;gap:6px;min-height:22px;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsh-qa-copy{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.75}',
      '.dsh-qa-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09));opacity:1}',
      '.dsh-qa-copy svg{width:13px;height:13px}',
      '.dsh-qa-time{font-variant-numeric:tabular-nums}',
      '.dsh-qa-assistant > :first-child{margin-top:0}',
      '.dsh-qa-assistant > :last-child{margin-bottom:0}',
      '.dsh-qa-assistant p{margin:0 0 8px}',
      '.dsh-qa-assistant h1,.dsh-qa-assistant h2,.dsh-qa-assistant h3,.dsh-qa-assistant h4{margin:10px 0 6px;font-weight:600;line-height:1.35}',
      '.dsh-qa-assistant h1{font-size:17px}',
      '.dsh-qa-assistant h2{font-size:15px}',
      '.dsh-qa-assistant h3{font-size:14px}',
      '.dsh-qa-assistant h4{font-size:13.5px}',
      '.dsh-qa-assistant ul,.dsh-qa-assistant ol{margin:0 0 8px;padding-left:20px}',
      '.dsh-qa-assistant li{margin:2px 0}',
      '.dsh-qa-assistant blockquote{margin:0 0 8px;padding:2px 10px;border-left:3px solid var(--dsw-alias-border-l3,rgba(128,128,128,.35));color:var(--dsw-alias-label-secondary,inherit)}',
      '.dsh-qa-assistant blockquote p{margin:0 0 4px}',
      '.dsh-qa-assistant code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px}',
      '.dsh-qa-assistant :not(pre) > code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))}',
      '.dsh-qa-assistant pre{margin:0 0 8px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.12));overflow-x:auto}',
      '.dsh-qa-assistant pre code{white-space:pre}',
      '.dsh-qa-assistant a{color:var(--dsw-alias-state-business-primary,#4176e6);text-decoration:none}',
      '.dsh-qa-assistant a:hover{text-decoration:underline}',
      '.dsh-qa-assistant hr{margin:8px 0;border:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}',
      '.dsh-qa-assistant table{border-collapse:collapse;margin:0 0 8px;font-size:13px;display:block;overflow-x:auto}',
      '.dsh-qa-assistant th,.dsh-qa-assistant td{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));padding:4px 8px;text-align:left}',
      '.dsh-qa-assistant th{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));font-weight:600}',
      '.dsh-qa-empty{font-size:12.5px;color:var(--dsw-alias-label-tertiary,#81858c);padding:6px 2px}',
      '.dsh-qa-composer{position:relative;display:flex;flex-direction:column;gap:6px;padding:8px 10px 8px 14px;border-radius:var(--dsw-radius-panel,28px);background:color-mix(in srgb, var(--dsw-specific-input-major,#fff) 58%, transparent);-webkit-backdrop-filter:blur(20px) saturate(1.7);backdrop-filter:blur(20px) saturate(1.7);border:1px solid color-mix(in srgb, var(--dsw-alias-border-l2,rgba(0,0,0,.12)) 70%, transparent);box-shadow:var(--dsw-elevation-soft,0 4px 16px rgba(0,0,0,.05)),inset 0 1px 0 color-mix(in srgb, var(--dsw-static-neutral-bluish-00,#fff) 60%, transparent)}',
      '.dsh-qa-textarea{flex:1 1 auto;min-height:38px;max-height:120px;resize:none;padding:2px 2px 0;border:none;background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:var(--dsh-content-font-size,14px);font-family:inherit;line-height:1.55;outline:none}',
      '.dsh-qa-textarea::placeholder{color:var(--dsw-alias-label-tertiary,#81858c)}',
      '.dsh-qa-composerbar{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px}',
      '.dsh-qa-modelwrap{position:relative;min-width:0;display:flex}',
      '.dsh-qa-model{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;height:26px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;font-family:inherit;cursor:pointer}',
      '.dsh-qa-model:hover,.dsh-qa-model[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09));color:var(--dsw-alias-label-secondary,#61666b)}',
      '.dsh-qa-modelname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-qa-modelchev{width:12px;height:12px;flex:none;transition:transform .15s ease}',
      '.dsh-qa-model[aria-expanded="true"] .dsh-qa-modelchev{transform:rotate(180deg)}',
      '.dsh-qa-modelbackdrop{position:fixed;inset:0;z-index:9}',
      '.dsh-qa-modelmenu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:10;display:flex;flex-direction:column;min-width:240px;max-width:min(320px,75vw);padding:4px;border-radius:var(--dsw-radius-md,12px);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-specific-menu,rgba(255,255,255,.9));-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);box-shadow:var(--dsw-elevation-panel,0 8px 24px rgba(0,0,0,.12));overflow:hidden}',
      '.dsh-qa-modelrow{display:flex;flex-direction:column;gap:1px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;text-align:left;cursor:pointer}',
      '.dsh-qa-modelrow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.09))}',
      '.dsh-qa-modelrow[aria-selected="true"]{background:var(--dsw-alias-state-business-tertiary,rgba(77,107,254,.12))}',
      '.dsh-qa-modelrowname{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-qa-modelrowdesc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-qa-send{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;padding:0;border:none;border-radius:50%;background:var(--dsw-alias-button-primary-fill,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff);cursor:pointer}',
      '.dsh-qa-send svg{width:16px;height:16px}',
      '.dsh-qa-send:hover:not(:disabled){opacity:.92}',
      '.dsh-qa-send:disabled{opacity:.4;cursor:default}',
      '.dsh-qa-send:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}',
    ].join('\n');

    /** Inject the panel stylesheet once; cosmetic failures never break the panel. */
    function injectQuickAskStyles() {
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function' || document.head === undefined) return;
        if (document.querySelector('style[data-plugin-css="dsh-deepseek-web/quick-ask"]') !== null) return;
        const tag = document.createElement('style');
        tag.dataset.pluginCss = 'dsh-deepseek-web/quick-ask';
        tag.textContent = QA_CSS;
        document.head.appendChild(tag);
      } catch {
        /* the fallback inline styles still render a usable panel */
      }
    }

    /** The DSH sparkle glyph, drawn with the shell's own outline paths. */
    function QuickAskIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'p1', d: 'M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { key: 'p2', d: 'M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { key: 'p3', d: 'M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }

    /** The DSH chevron, used by the collapsible hint. */
    function ChevronIcon({ className }) {
      return h('svg', { className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'c', d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }

    /** The DSH info glyph, used by the hint card's title row. */
    function InfoIcon() {
      return h('svg', { viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'i1', d: 'M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z', fill: 'currentColor' }),
        h('path', { key: 'i2', d: 'M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z', fill: 'currentColor' }),
        h('path', { key: 'i3', d: 'M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z', fill: 'currentColor' }),
      ]);
    }

    /** The DSH send glyph, used by the composer's send button. */
    function SendIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 's1', d: 'M4.74024 9.11029L1.82882 7.79865C1.75022 7.76323 1.75026 7.65161 1.82889 7.61626L12.9665 2.60943C13.0354 2.57846 13.1125 2.63213 13.1073 2.70749L12.3914 13.1388C12.3864 13.2117 12.3073 13.2548 12.2433 13.2194L6.12677 9.83657', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { key: 's2', d: 'M8.44336 11.0825L6.2832 13.2843C6.22048 13.3482 6.11182 13.3038 6.11182 13.2143V9.86772C6.11182 9.84165 6.122 9.8166 6.1402 9.79793L12.972 2.78748', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }

    /** The DSH copy glyph, used by each message's copy button. */
    function CopyIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('rect', { key: 'c1', x: '1.52075', y: '4.07373', width: '10.3932', height: '10.3932', rx: '2', stroke: 'currentColor', strokeWidth: 1 }),
        h('path', { key: 'c2', d: 'M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z', fill: 'currentColor' }),
      ]);
    }

    /** The DSH check glyph, shown briefly after a copy. */
    function CheckIcon() {
      return h('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
        h('path', { key: 'k', d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4', stroke: 'currentColor', strokeWidth: 1 }),
      ]);
    }

    // ── markdown ────────────────────────────────────────────────────────────
    // A deliberately small Markdown subset for the transcript: fenced code,
    // headings, lists, blockquotes, rules, pipe tables, paragraphs, and the
    // usual inline marks. It builds React nodes directly (never HTML strings),
    // so model output cannot inject markup, and it tolerates partial text
    // while the answer streams (an unclosed fence renders as code).

    /** One Markdown table row split on pipes (outer pipes stripped). */
    function splitRow(line) {
      return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
    }

    /** Whether one line opens a block (used to end a paragraph). */
    function isBlockStart(line) {
      return /^\s*(```|~~~)/u.test(line)
        || /^#{1,6}\s/u.test(line)
        || /^\s*>/u.test(line)
        || /^\s*([-*+]|\d+[.)])\s+/u.test(line)
        || /^\s*([-*_])\1{2,}\s*$/u.test(line);
    }

    /** Inline marks: code, bold, strike, links, italic. */
    function inlineNodes(text, key) {
      const nodes = [];
      let buffer = '';
      let i = 0;
      const flush = () => {
        if (buffer !== '') {
          nodes.push(buffer);
          buffer = '';
        }
      };
      while (i < text.length) {
        if (text[i] === '`') {
          const end = text.indexOf('`', i + 1);
          if (end > i + 1) {
            flush();
            nodes.push(h('code', { key: `${key}-c${nodes.length}` }, text.slice(i + 1, end)));
            i = end + 1;
            continue;
          }
        }
        if (text.startsWith('**', i)) {
          const end = text.indexOf('**', i + 2);
          if (end > i + 2) {
            flush();
            nodes.push(h('strong', { key: `${key}-b${nodes.length}` }, inlineNodes(text.slice(i + 2, end), `${key}-b`)));
            i = end + 2;
            continue;
          }
        }
        if (text.startsWith('~~', i)) {
          const end = text.indexOf('~~', i + 2);
          if (end > i + 2) {
            flush();
            nodes.push(h('del', { key: `${key}-s${nodes.length}` }, inlineNodes(text.slice(i + 2, end), `${key}-s`)));
            i = end + 2;
            continue;
          }
        }
        if (text[i] === '[') {
          const close = text.indexOf('](', i);
          const end = close > i ? text.indexOf(')', close + 2) : -1;
          if (close > i && end > close) {
            const href = text.slice(close + 2, end).trim();
            if (/^(https?:|mailto:)/iu.test(href)) {
              flush();
              nodes.push(h('a', { key: `${key}-a${nodes.length}`, href, target: '_blank', rel: 'noreferrer noopener' }, text.slice(i + 1, close)));
              i = end + 1;
              continue;
            }
          }
        }
        if (text[i] === '*') {
          const end = text.indexOf('*', i + 1);
          if (end > i + 1 && !text.slice(i + 1, end).includes('\n')) {
            flush();
            nodes.push(h('em', { key: `${key}-i${nodes.length}` }, inlineNodes(text.slice(i + 1, end), `${key}-i`)));
            i = end + 1;
            continue;
          }
        }
        buffer += text[i];
        i += 1;
      }
      flush();
      return nodes;
    }

    /**
     * Render one Markdown document as an element tree.
     * @param {string} source
     * @returns {unknown}
     */
    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/gu, '\n').split('\n');
      /** @type {unknown[]} */
      const blocks = [];
      let i = 0;
      let key = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '') {
          i += 1;
          continue;
        }
        const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)\s*$/u);
        if (fence !== null) {
          const opener = fence[1];
          const body = [];
          i += 1;
          while (i < lines.length && !lines[i].trim().startsWith(opener)) {
            body.push(lines[i]);
            i += 1;
          }
          if (i < lines.length) i += 1;
          blocks.push(h('pre', { key: `code-${key++}`, className: 'dsh-qa-code' }, h('code', {
            className: fence[2] !== '' ? `language-${fence[2]}` : undefined,
          }, body.join('\n'))));
          continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.*)$/u);
        if (heading !== null) {
          const level = Math.min(heading[1].length, 4);
          blocks.push(h(`h${level}`, { key: `h-${key++}` }, inlineNodes(heading[2], `h-${key}`)));
          i += 1;
          continue;
        }
        if (/^\s*([-*_])\1{2,}\s*$/u.test(line)) {
          blocks.push(h('hr', { key: `hr-${key++}` }));
          i += 1;
          continue;
        }
        if (/^\s*>/u.test(line)) {
          const quote = [];
          while (i < lines.length && /^\s*>/u.test(lines[i])) {
            quote.push(lines[i].replace(/^\s*>\s?/u, ''));
            i += 1;
          }
          blocks.push(h('blockquote', { key: `q-${key++}` }, renderMarkdown(quote.join('\n'))));
          continue;
        }
        const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/u);
        if (item !== null) {
          const ordered = /^\d/u.test(item[2]);
          const items = [];
          while (i < lines.length) {
            const next = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/u);
            if (next === null || /^\d/u.test(next[2]) !== ordered) break;
            items.push(h('li', { key: `li-${key}-${items.length}` }, inlineNodes(next[3], `li-${key}`)));
            i += 1;
          }
          blocks.push(h(ordered ? 'ol' : 'ul', { key: `list-${key++}` }, items));
          continue;
        }
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/u.test(lines[i + 1])) {
          const header = splitRow(line);
          i += 2;
          const rows = [];
          while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
            rows.push(splitRow(lines[i]));
            i += 1;
          }
          blocks.push(h('table', { key: `tbl-${key++}` }, [
            h('thead', { key: 'head' }, h('tr', null, header.map((cell, idx) => h('th', { key: String(idx) }, inlineNodes(cell, `th-${idx}`))))),
            h('tbody', { key: 'body' }, rows.map((row, ridx) => h('tr', { key: String(ridx) }, row.map((cell, cidx) => h('td', { key: String(cidx) }, inlineNodes(cell, `td-${cidx}`)))))),
          ]));
          continue;
        }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/u.test(lines[i + 1]))) {
          para.push(lines[i]);
          i += 1;
        }
        if (para.length === 0) {
          para.push(line);
          i += 1;
        }
        const children = [];
        para.forEach((row, idx) => {
          if (idx > 0) children.push(h('br', { key: `br-${idx}` }));
          children.push(...inlineNodes(row, `p-${key}-${idx}`));
        });
        blocks.push(h('p', { key: `p-${key++}` }, children));
      }
      return blocks;
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'];

    function apply(ctx) {
      // Register the dictionaries so the nav label and every string resolve
      // through the shell's locale service.
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-deepseek-web: dictionaries');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'deepseek-web',
        order: 120,
        label: 'DeepSeek 网页版',
        locale: NS,
      }, DeepSeekWebSettings));

      // ── quick-ask panel ─────────────────────────────────────────────────────
      // Tab type + body through the public two-stage path (the same one
      // document preview uses). Services beyond slots/locale are optional: a
      // composition without the right sidebar leaves the entry button off
      // instead of breaking the settings page.
      const sidebarRight = (() => {
        try {
          return ctx.sidebarRight;
        } catch {
          return undefined;
        }
      })();
      const sidebarRightTabs = (() => {
        try {
          return ctx.sidebarRightTabs;
        } catch {
          return undefined;
        }
      })();

      if (sidebarRightTabs !== undefined && sidebarRight !== undefined) {
        injectQuickAskStyles();
        const QA_TAB_ID = 'dsh-deepseek-web/quick-ask';
        const QA_TAB_KIND = 'deepseek-web-quick-ask';
        ctx.effect(() => sidebarRightTabs.register({
          id: QA_TAB_ID,
          kind: QA_TAB_KIND,
          title: () => {
            const lang = String((typeof document !== 'undefined' && document.documentElement?.lang) ?? '');
            const dictionary = lang.toLowerCase().startsWith('en') ? dictionaries.en : dictionaries.zh;
            return dictionary['qa.tab.title'];
          },
        }), 'dsh-deepseek-web: quick-ask tab type');
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: QA_TAB_ID,
          locale: NS,
        }, QuickAskPanel), 'dsh-deepseek-web: quick-ask tab body');

        // The entry: a small persistent button next to the header's
        // more-actions button, opening (and revealing) the panel tab.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'deepseek-web-quick-ask',
          order: 10,
          locale: NS,
        }, (props) => {
          const open = () => {
            try {
              sidebarRight.openTab(QA_TAB_KIND, { preferNewPane: true });
            } catch (error) {
              console.warn('[dsh-deepseek-web] could not open the quick-ask panel:', error);
            }
          };
          return h('button', {
            type: 'button',
            className: 'dsh-qa-entry',
            title: t9n('qa.entry.label'),
            'aria-label': t9n('qa.entry.label'),
            onClick: open,
          }, h(QuickAskIcon));
        }));
      }
    }

    /** Locale lookup for components outside the settings page (no hook state). */
    function t9n(key) {
      try {
        const lang = String(document.documentElement?.lang ?? '');
        const dictionary = lang.toLowerCase().startsWith('en') ? dictionaries.en : dictionaries.zh;
        return dictionary[key] ?? key;
      } catch {
        return key;
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
