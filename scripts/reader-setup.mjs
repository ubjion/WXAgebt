import path from 'node:path';
import { spawn } from 'node:child_process';

// Credentials travel over stdin and the private result channel, never argv or job logs.
export function runReaderSetup({ root, python, request, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', path.join(root, 'scripts', 'reader_setup.py')], {
      cwd: root, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
    let pending = '', result, diagnostic = '', finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('READER_SETUP_TIMEOUT')); }, 210000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 128000) { child.kill(); finish(new Error('READER_SETUP_PROTOCOL')); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress' && typeof event.message === 'string') onProgress(event.message);
          if (event.type === 'result') result = event;
        } catch { /* Third-party diagnostics are private and are never forwarded. */ }
      }
    });
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8000); });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(new Error('READER_RUNTIME_MISSING')));
    child.once('close', () => {
      if (result) finish(null, result);
      else finish(new Error(/ModuleNotFoundError|ImportError|DLL load failed/.test(diagnostic) ? 'READER_DEPENDENCY_MISSING' : 'READER_SETUP_FAILED'));
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export const readerSetupMessages = {
  READER_PATH_MISSING: '没有找到账号数据库。请先在微信登录并等待同步，再选择包含 db_storage 的账号文件夹或 xwechat_files 文件夹。',
  READER_DATABASE_MISSING: '账号目录已找到，但消息或联系人数据库尚未同步完成。请在微信打开几个聊天，等待同步后重试。',
  READER_KEY_INVALID: '读取密钥与所选账号不匹配。请填写该账号已有的有效密钥后重新验证。',
  READER_KEY_REQUIRED: '没有可用的缓存密钥。请手动填写所选账号已有的有效数据库密钥。',
  READER_SECRET_UNAVAILABLE: '旧凭据无法在当前 Windows 用户下读取。请手动填写该账号已有的有效密钥。',
  READER_DATABASE_UNREADABLE: '密钥验证通过，但数据库暂时无法完整读取。请等待微信同步完成后重试；若仍失败，请使用“验证内置环境”检查安装文件。',
  READER_DEPENDENCY_MISSING: '读取组件不完整或无法加载。请重新安装更新后的安装包，再使用“验证内置环境”检查。',
  READER_RUNTIME_MISSING: '找不到内置 Python 运行环境。请重新安装更新后的安装包。',
  READER_KEY_COMPONENT_MISSING: '本模式不使用密钥提取组件。请填写该账号已有的有效密钥。',
  WECHAT_NOT_RUNNING: '微信尚未打开。请打开普通微信、登录所选账号并等待同步后重试。',
  WECHAT_LOGIN_REQUIRED: '未发现微信占用所选账号的数据库。请完成登录并等待同步后重试；仅存在微信进程不代表已登录。',
  WECHAT_ACCOUNT_MISMATCH: '微信当前占用的账号数据库与所选目录不一致。请选择当前账号目录，或登录目标账号后重试。',
  WECHAT_MULTIPLE_ACCOUNT_DATABASES: '微信同时占用多个账号的数据库，无法确认当前账号。请退出多余账号后重试。',
  WECHAT_MULTIPLE_PROCESSES: '检测到多个独立微信客户端。请从托盘退出多余客户端，保留目标账号后重试。',
  WECHAT_PROCESS_IDENTITY_UNCLEAR: '无法确认微信主进程。请从托盘完整退出微信后重新打开并登录。',
  WECHAT_ACCOUNT_PROBE_FAILED: '无法通过系统文件占用核对登录账号。请检查微信与助手权限并重试；原配置已保留。',
  WECHAT_ACCOUNT_PROBE_TIMEOUT: '系统文件占用核对超时。请确认微信正常运行并等待同步后重试；原配置已保留。',
  WECHAT_HOOK_PRESENT: '检测到微信程序目录存在 version.dll，无法确认是无 Hook 客户端。请退出该客户端并使用未加载 Hook 的普通微信后重试。',
  READER_ACCOUNT_STATE_INVALID: '账号状态无法安全切换。请检查账号状态文件或目录；原账号配置已保留。',
  READER_ACCOUNT_RESULT_MISMATCH: '验证返回的账号与所选目录不一致，原账号配置已保留。请重新识别账号目录后再连接。',
  READER_KEY_ACCESS_DENIED: '无法连接微信进程。请以相同的 Windows 用户和权限打开微信与助手后重试。',
  READER_SETUP_TIMEOUT: '数据库验证超时。请检查账号目录、已有密钥及微信同步状态后重试。',
  READER_SETUP_FAILED: '数据库连接未完成。请确认微信已登录、目录对应当前账号且已有密钥有效后重试；原有配置已保留。',
};

export function readerSetupMessage(code) {
  return readerSetupMessages[code] ?? readerSetupMessages.READER_SETUP_FAILED;
}
