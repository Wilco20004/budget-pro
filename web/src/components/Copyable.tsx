import { useState } from 'react';

// navigator.clipboard only exists in a secure context (HTTPS/localhost) — the
// add-on is usually on plain HTTP, so fall back to execCommand, and failing
// that tell the user to copy by hand rather than silently doing nothing.
function copyText(text: string): boolean {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => undefined);
    return true;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export default function Copyable({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      className="small"
      onClick={() => {
        setState(copyText(text) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 2500);
      }}
    >
      {state === 'ok' ? 'Copied ✓' : state === 'fail' ? 'Select & copy manually' : label}
    </button>
  );
}
