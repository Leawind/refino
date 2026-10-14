/**
 * Imperative feedback seam between non-component modules (node operations,
 * shortcuts) and the naive-ui feedback providers: `useMessage`/`useDialog`
 * resolve only inside their providers, so a mounted registrar component
 * (WorkspaceToasts, CanvasDialogs) hands its API over here and plain
 * modules call `notify`/`confirmAction`. Unregistered seams no-op — caller
 * code stays straight-line either way.
 */

export type NoticeType = "info" | "success" | "warning" | "error";

type Messenger = (message: string, type: NoticeType) => void;

interface ConfirmOptions {
  title: string;
  content: string;
  positiveText: string;
  onConfirm(): void;
}

type Confirmer = (options: ConfirmOptions) => void;

let messenger: Messenger | null = null;
let confirmer: Confirmer | null = null;

export function setMessenger(value: Messenger | null): void {
  messenger = value;
}

export function setConfirmer(value: Confirmer | null): void {
  confirmer = value;
}

export function notify(message: string, type: NoticeType = "info"): void {
  messenger?.(message, type);
}

export function confirmAction(options: ConfirmOptions): void {
  confirmer?.(options);
}
