import { useState, useCallback, createContext, useContext, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  subtitle?: string;
  heading?: string;
  type: "success" | "error" | "info";
}

export type ToastOptions = {
  subtitle?: string;
  heading?: string;
};

interface ToastContextType {
  showToast: (
    message: string,
    type?: "success" | "error" | "info",
    options?: ToastOptions
  ) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback(
    (
      message: string,
      type: "success" | "error" | "info" = "info",
      options?: ToastOptions
    ) => {
      const id = nextId++;
      const subtitle = options?.subtitle;
      const heading = options?.heading;
      setToasts((prev) => [
        ...prev,
        { id, message, type, subtitle, heading }
      ]);
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
    },
    []
  );

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-container">
        {toasts.map((t) => {
          const stacked = Boolean(t.heading || t.subtitle);
          return (
            <div
              key={t.id}
              className={`toast-item toast-${t.type}${
                stacked ? " toast-item-stacked" : ""
              }`}
              onClick={() => dismiss(t.id)}
            >
              <span className="toast-icon">
                {t.type === "success" ? "✓" : t.type === "error" ? "✕" : "ℹ"}
              </span>
              <span className="toast-message">
                {stacked ? (
                  <>
                    {t.heading ? (
                      <span className="toast-line-heading">{t.heading}</span>
                    ) : null}
                    <span className="toast-line-primary">{t.message}</span>
                    {t.subtitle ? (
                      <span className="toast-line-secondary">{t.subtitle}</span>
                    ) : null}
                  </>
                ) : (
                  t.message
                )}
              </span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
