import type { ScreenContext } from '@evolvesales/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

/** Git SHA (or "dev") baked into the build; sent with requests so engineers know the version. */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev';

interface Registry {
  set: (ctx: ScreenContext | null) => void;
  get: () => ScreenContext;
}

const ScreenContextRegistry = createContext<Registry | null>(null);

/**
 * Holds what the user is looking at (§6 "screen context capture"). Pages register their context;
 * the Request Assistant reads it when it opens. It is sent to the server as untrusted data.
 */
export function ScreenContextProvider({ children }: { children: ReactNode }) {
  const current = useRef<ScreenContext | null>(null);
  const set = useCallback((ctx: ScreenContext | null) => {
    current.current = ctx;
  }, []);
  const get = useCallback(
    (): ScreenContext =>
      current.current ?? {
        screen: 'other',
        route: window.location.pathname,
        appVersion: APP_VERSION,
        locale: navigator.language,
      },
    [],
  );
  const value = useMemo(() => ({ set, get }), [set, get]);
  return <ScreenContextRegistry.Provider value={value}>{children}</ScreenContextRegistry.Provider>;
}

function useRegistry(): Registry {
  const registry = useContext(ScreenContextRegistry);
  if (!registry) throw new Error('ScreenContextProvider is missing');
  return registry;
}

/** Registers the calling page's context while it is mounted. */
export function useScreenContext(
  ctx: Omit<ScreenContext, 'appVersion' | 'locale' | 'route'>,
): void {
  const { set } = useRegistry();
  const key = JSON.stringify(ctx);
  useEffect(() => {
    set({
      ...(JSON.parse(key) as Omit<ScreenContext, 'appVersion' | 'locale' | 'route'>),
      route: window.location.pathname + window.location.search,
      appVersion: APP_VERSION,
      locale: navigator.language,
    });
    return () => set(null);
  }, [key, set]);
}

/** Reads the current screen context (called when the assistant opens). */
export function useCurrentScreenContext(): () => ScreenContext {
  return useRegistry().get;
}
