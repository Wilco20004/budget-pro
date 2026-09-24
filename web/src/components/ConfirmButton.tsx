import { ReactNode, useState } from 'react';

/** A button that asks "are you sure?" inline before acting. The browser's
 *  own confirm() is blocked in some embedded views (the Home Assistant
 *  companion app's WebView answers it with an instant "no"), which made
 *  Delete buttons silently do nothing — so the question is part of the page. */
export default function ConfirmButton({
  children,
  question,
  yes = 'Yes',
  onConfirm,
  className = '',
  disabled,
}: {
  children: ReactNode;
  question: string;
  yes?: string;
  onConfirm: () => unknown;
  className?: string;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button className={className} disabled={disabled} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="row small" style={{ gap: 6, display: 'inline-flex' }}>
      <span>{question}</span>
      <button
        className="danger small"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {yes}
      </button>
      <button className="small" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}
