import { render } from 'preact';
import { App } from './App';
import './styles.css';

window.addEventListener('error', (e) => {
  const msg = e.error?.stack || e.message || String(e);
  const div = document.getElementById('app')!;
  div.innerHTML = `<div style="padding:20px;color:#f85149;font-size:14px;word-break:break-all;white-space:pre-wrap;">JS 错误:\n\n${msg}</div>`;
});

window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.stack || e.reason?.message || String(e.reason);
  const div = document.getElementById('app')!;
  div.innerHTML += `<div style="padding:20px;color:#f85149;font-size:14px;word-break:break-all;white-space:pre-wrap;">Promise 错误:\n\n${msg}</div>`;
});

try {
  render(<App />, document.getElementById('app')!);
} catch (err) {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  const div = document.getElementById('app')!;
  div.innerHTML = `<div style="padding:20px;color:#f85149;font-size:14px;word-break:break-all;white-space:pre-wrap;">渲染错误:\n\n${msg}</div>`;
}
