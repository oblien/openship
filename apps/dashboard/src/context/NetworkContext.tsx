import React, { createContext, useContext, ReactNode } from 'react';

interface NetworkContextType {
  networkId: string;
  networkName?: string;
}

const NetworkContext = createContext<NetworkContextType | null>(null);

export const useNetworkContext = () => {
  const context = useContext(NetworkContext);
  return context; // Can be null when not in a network context
};

interface NetworkProviderProps {
  networkId: string;
  networkName?: string;
  children: ReactNode;
}

export const NetworkProvider: React.FC<NetworkProviderProps> = ({
  networkId,
  networkName,
  children,
}) => {
  return (
    <NetworkContext.Provider value={{ networkId, networkName }}>
      {children}
    </NetworkContext.Provider>
  );
};

