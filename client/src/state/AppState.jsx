import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../services/api';

const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [datasets, setDatasets] = useState([]);
  const [activeDatasetId, setActiveDatasetId] = useState(null);
  const [linkedDatasetIds, setLinkedDatasetIds] = useState([]); // datasets included in the next chat query
  const [sessionId, setSessionId] = useState(null);
  const [loadingDatasets, setLoadingDatasets] = useState(false);

  const refreshDatasets = useCallback(async () => {
    setLoadingDatasets(true);
    try {
      const list = await api.listDatasets();
      setDatasets(list);
      // Auto-select the first ready dataset if nothing is selected yet.
      setActiveDatasetId((prev) => {
        if (prev && list.some((d) => d.dataset_id === prev)) return prev;
        const firstReady = list.find((d) => d.status === 'ready');
        return firstReady ? firstReady.dataset_id : prev;
      });
      // Drop any linked datasets that no longer exist.
      setLinkedDatasetIds((prev) => prev.filter((id) => list.some((d) => d.dataset_id === id)));
    } finally {
      setLoadingDatasets(false);
    }
  }, []);

  function toggleLinkedDataset(id) {
    setLinkedDatasetIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  useEffect(() => {
    refreshDatasets();
  }, [refreshDatasets]);

  const activeDataset = datasets.find((d) => d.dataset_id === activeDatasetId) || null;

  const value = {
    datasets,
    loadingDatasets,
    refreshDatasets,
    activeDatasetId,
    setActiveDatasetId,
    activeDataset,
    linkedDatasetIds,
    toggleLinkedDataset,
    sessionId,
    setSessionId,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}
