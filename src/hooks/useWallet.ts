"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  connectFreighter,
  connectWalletConnect,
  disconnectWalletConnect,
  getFreighterPublicKey,
  getWalletConnectPublicKey,
} from "@/lib/freighter";
import type { WalletType } from "@/lib/freighter";

const STORAGE_KEY = "stellarsplit_wallets";
const LEGACY_STORAGE_KEY = "stellarsplit_wallet";

export interface WalletConnection {
  address: string;
  walletType: WalletType;
  connectedAt: number;
}

interface PersistedWallets {
  connections: WalletConnection[];
  activeAddress: string | null;
}

interface WalletState {
  connections: WalletConnection[];
  activeAddress: string | null;
  activeWalletType: WalletType | null;
  connecting: boolean;
  error: string | null;
  freighterInstalled: boolean | null;
}

function isWalletType(value: unknown): value is WalletType {
  return value === "freighter" || value === "walletconnect";
}

function parseConnections(raw: unknown): WalletConnection[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const connections: WalletConnection[] = [];
  for (const entry of raw) {
    if (
      typeof entry?.address === "string" &&
      isWalletType(entry?.walletType) &&
      !seen.has(entry.address)
    ) {
      seen.add(entry.address);
      connections.push({
        address: entry.address,
        walletType: entry.walletType,
        connectedAt: typeof entry.connectedAt === "number" ? entry.connectedAt : Date.now(),
      });
    }
  }
  return connections;
}

function readCache(): PersistedWallets {
  const empty: PersistedWallets = { connections: [], activeAddress: null };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const connections = parseConnections(parsed?.connections);
      const activeAddress =
        typeof parsed?.activeAddress === "string" &&
        connections.some((c) => c.address === parsed.activeAddress)
          ? parsed.activeAddress
          : connections[0]?.address ?? null;
      return { connections, activeAddress };
    }

    // Migrate a single connection from the legacy sessionStorage key.
    const legacyRaw = window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (typeof legacy?.address === "string" && isWalletType(legacy?.walletType)) {
        const migrated: PersistedWallets = {
          connections: [
            { address: legacy.address, walletType: legacy.walletType, connectedAt: Date.now() },
          ],
          activeAddress: legacy.address,
        };
        writeCache(migrated);
        window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
        return migrated;
      }
    }
    return empty;
  } catch {
    return empty;
  }
}

function writeCache(wallets: PersistedWallets) {
  if (typeof window === "undefined") return;
  try {
    if (wallets.connections.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(wallets));
    }
  } catch {
    // localStorage unavailable (private mode, etc.) — connection state
    // just won't persist across a refresh.
  }
}

function toPersisted(state: WalletState): PersistedWallets {
  return { connections: state.connections, activeAddress: state.activeAddress };
}

function activeType(
  connections: WalletConnection[],
  activeAddress: string | null
): WalletType | null {
  if (!activeAddress) return null;
  return connections.find((c) => c.address === activeAddress)?.walletType ?? null;
}

/**
 * Shared multi-wallet connection state (Freighter + WalletConnect).
 *
 * Reads the persisted connection list from localStorage synchronously (so
 * the first paint already reflects previously-granted connections), then
 * silently re-verifies each stored connection against its wallet before
 * paint via useLayoutEffect — no approval popup when the wallet already
 * granted permission. Connections that fail verification are dropped.
 */
export function useWallet() {
  const [state, setState] = useState<WalletState>(() => {
    const cached = readCache();
    return {
      connections: cached.connections,
      activeAddress: cached.activeAddress,
      activeWalletType: activeType(cached.connections, cached.activeAddress),
      connecting: false,
      error: null,
      freighterInstalled: null,
    };
  });

  const verified = useRef(false);

  useLayoutEffect(() => {
    if (verified.current) return;
    verified.current = true;

    let cancelled = false;

    const verify = async () => {
      const cached = readCache();
      let freighterConnected = false;

      try {
        const { isConnected } = await import("@stellar/freighter-api");
        const result = await isConnected();
        if (cancelled) return;
        freighterConnected = result.isConnected === true;
        setState((prev) => ({ ...prev, freighterInstalled: !result.error }));
      } catch {
        if (!cancelled) {
          setState((prev) => ({ ...prev, freighterInstalled: null }));
        }
      }

      if (cached.connections.length === 0) return;

      const valid: WalletConnection[] = [];
      for (const connection of cached.connections) {
        // For Freighter, only skip straight to getPublicKey() (no popup) when
        // isConnected() confirms the extension already granted this origin
        // access. For WalletConnect there's no equivalent probe — fall back
        // to the existing silent getWalletConnectPublicKey() check.
        if (connection.walletType === "freighter" && !freighterConnected) continue;

        try {
          const key =
            connection.walletType === "freighter"
              ? await getFreighterPublicKey()
              : await getWalletConnectPublicKey();
          if (cancelled) return;
          if (key && key === connection.address) {
            valid.push(connection);
          }
        } catch {
          // Drop connections that fail silent verification.
        }
      }

      if (cancelled) return;

      const activeAddress =
        cached.activeAddress && valid.some((c) => c.address === cached.activeAddress)
          ? cached.activeAddress
          : valid[0]?.address ?? null;

      const next: PersistedWallets = { connections: valid, activeAddress };
      writeCache(next);
      setState((prev) => ({
        ...prev,
        connections: valid,
        activeAddress,
        activeWalletType: activeType(valid, activeAddress),
      }));
    };

    verify();

    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (type: WalletType) => {
    setState((prev) => ({ ...prev, connecting: true, error: null }));
    try {
      let address: string;
      let uri: string | undefined;

      if (type === "freighter") {
        address = await connectFreighter();
      } else {
        const result = await connectWalletConnect();
        address = result.publicKey;
        uri = result.uri;
      }

      setState((prev) => {
        const existing = prev.connections.find((c) => c.address === address);
        const connection: WalletConnection = existing
          ? { ...existing, walletType: type }
          : { address, walletType: type, connectedAt: Date.now() };
        const connections = existing
          ? prev.connections.map((c) => (c.address === address ? connection : c))
          : [...prev.connections, connection];
        const next: WalletState = {
          ...prev,
          connections,
          activeAddress: address,
          activeWalletType: type,
          connecting: false,
          error: null,
        };
        writeCache(toPersisted(next));
        return next;
      });

      return { address, walletType: type, uri };
    } catch (e) {
      setState((prev) => ({ ...prev, connecting: false, error: String(e) }));
      throw e;
    }
  }, []);

  const switchTo = useCallback((address: string) => {
    setState((prev) => {
      const connection = prev.connections.find((c) => c.address === address);
      if (!connection) return prev;
      const next: WalletState = {
        ...prev,
        activeAddress: address,
        activeWalletType: connection.walletType,
        error: null,
      };
      writeCache(toPersisted(next));
      return next;
    });
  }, []);

  const disconnect = useCallback(async (address?: string) => {
    const target = address ?? state.activeAddress;
    const connection = state.connections.find((c) => c.address === target);

    if (connection?.walletType === "walletconnect") {
      try {
        await disconnectWalletConnect();
      } catch {
        // Ignore WalletConnect teardown failures — local state is cleared
        // regardless so the user is never stuck "connected".
      }
    }

    setState((prev) => {
      const connections = target
        ? prev.connections.filter((c) => c.address !== target)
        : [];
      const activeAddress =
        prev.activeAddress && connections.some((c) => c.address === prev.activeAddress)
          ? prev.activeAddress
          : connections[0]?.address ?? null;
      const next: WalletState = {
        ...prev,
        connections,
        activeAddress,
        activeWalletType: activeType(connections, activeAddress),
        error: null,
      };
      writeCache(toPersisted(next));
      return next;
    });
  }, [state.activeAddress, state.connections]);

  const reconnect = useCallback(async (address: string) => {
    const connection = state.connections.find((c) => c.address === address);
    if (!connection) return;

    setState((prev) => ({ ...prev, connecting: true, error: null }));
    try {
      const key =
        connection.walletType === "freighter"
          ? await getFreighterPublicKey()
          : await getWalletConnectPublicKey();

      if (!key || key !== connection.address) {
        throw new Error("Wallet did not return the expected account.");
      }

      setState((prev) => ({ ...prev, connecting: false, error: null }));
    } catch (e) {
      setState((prev) => ({ ...prev, connecting: false, error: String(e) }));
      throw e;
    }
  }, [state.connections]);

  return {
    address: state.activeAddress,
    walletType: state.activeWalletType,
    connections: state.connections,
    activeAddress: state.activeAddress,
    activeWalletType: state.activeWalletType,
    connecting: state.connecting,
    error: state.error,
    freighterInstalled: state.freighterInstalled,
    connect,
    switchTo,
    disconnect,
    reconnect,
  };
}

export type UseWalletReturn = ReturnType<typeof useWallet>;
