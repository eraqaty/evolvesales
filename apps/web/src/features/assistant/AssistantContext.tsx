import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { RequestChangeDrawer } from './RequestChangeDrawer';

export interface OpenOptions {
  /** Continue the thread of this change request (answering clarification questions). */
  changeRequestId?: string;
}

interface AssistantContextValue {
  open: (options?: OpenOptions) => void;
}

const AssistantContext = createContext<AssistantContextValue | null>(null);

/** Hosts the Request a Change drawer once per signed-in layout. */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState(false);
  const [target, setTarget] = useState<OpenOptions>({});
  // Bumping the session forces a fresh conversation for a new target.
  const [session, setSession] = useState(0);

  const open = useCallback((options: OpenOptions = {}) => {
    setTarget((prev) => {
      if (prev.changeRequestId !== options.changeRequestId) setSession((s) => s + 1);
      return options;
    });
    setOpened(true);
  }, []);

  const value = useMemo(() => ({ open }), [open]);
  return (
    <AssistantContext.Provider value={value}>
      {children}
      <RequestChangeDrawer
        key={session}
        opened={opened}
        onClose={() => setOpened(false)}
        changeRequestId={target.changeRequestId}
        onNewConversation={() => setSession((s) => s + 1)}
      />
    </AssistantContext.Provider>
  );
}

export function useAssistant(): AssistantContextValue {
  const ctx = useContext(AssistantContext);
  if (!ctx) throw new Error('useAssistant must be used inside <AssistantProvider>');
  return ctx;
}
