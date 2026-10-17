"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { useWallet, type UseWalletReturn } from "@/hooks/useWallet";
import { useSep10Auth, type Sep10AuthState } from "@/hooks/useSep10Auth";

export type WalletContextValue = UseWalletReturn & {
  sep10: Sep10AuthState & {
    authenticate: (publicKey: string) => Promise<void>;
    handleUnauthorized: () => void;
  };
};

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const sep10 = useSep10Auth();

  // Auto-authenticate when the active wallet address becomes available.
  // Keying off activeAddress ensures switching wallets re-authenticates.
  useEffect(() => {
    if (wallet.activeAddress && !sep10.isAuthenticated && !sep10.isAuthenticating) {
      sep10.authenticate(wallet.activeAddress);
    }
  }, [
    wallet.activeAddress,
    sep10.isAuthenticated,
    sep10.isAuthenticating,
    sep10.authenticate,
  ]);

  const value: WalletContextValue = { ...wallet, sep10 };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** Access shared wallet connection state. Must be used within <WalletProvider>. */
export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWalletContext must be used within a WalletProvider");
  }
  return ctx;
}