import { useState, useEffect, useCallback } from 'react';
import { AppData, WealthSettings, AIPersonaProfile, AIMessage } from '../types';
import { db, auth, handleFirestoreError, OperationType } from '../lib/firebase';
import { onSnapshot, doc, setDoc, getDoc, collection } from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';

const INITIAL_SETTINGS: WealthSettings = {
  backupFreq: 'weekly',
  lastBackup: null,
  theme: 'dark',
  autoLock: 15,
  haptics: true,
  currency: 'LKR',
  notifications: true,
  compactMode: false,
};

const INITIAL_DATA: AppData = {
  auth: {},
  income: [],
  loans: [],
  ccinstall: [],
  cconetime: [],
  cheques: [],
  expenses: [],
  targets: [],
  balance: { total: 0, flows: [] },
  settings: INITIAL_SETTINGS,
  sessions: [],
};

export function useWealthData() {
  const [data, setData] = useState<AppData>(INITIAL_DATA);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiHistory, setAiHistory] = useState<AIMessage[]>([]);
  const [aiPersona, setAiPersona] = useState<AIPersonaProfile | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setLoading(false);
        setData(INITIAL_DATA);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) return;

    const dataDoc = doc(db, 'users', user.uid);
    const unsub = onSnapshot(dataDoc, (snap) => {
      if (snap.exists()) {
        const cloudData = snap.data() as AppData;
        setData((prev) => ({ ...prev, ...cloudData }));
      } else {
        // Init cloud doc if missing
        setDoc(dataDoc, INITIAL_DATA).catch(e => handleFirestoreError(e, OperationType.WRITE, `users/${user.uid}`));
      }
      setLoading(false);
    }, (error) => {
      setLoading(false); // Stop loading on error to prevent stuck spinner
      handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
    });

    // Also sync AI context separately for better reactivity if needed, or keep it in the same doc
    const aiDoc = doc(db, 'userAI', user.uid);
    const unsubAI = onSnapshot(aiDoc, (snap) => {
      if (snap.exists()) {
        const aiData = snap.data();
        if (aiData.history) setAiHistory(aiData.history);
        if (aiData.persona) setAiPersona(aiData.persona);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `userAI/${user.uid}`);
    });

    return () => {
      unsub();
      unsubAI();
    };
  }, [user]);

  const updateData = useCallback(async (updates: Partial<AppData>) => {
    if (!user) return;
    const newData = { ...data, ...updates };
    setData(newData);
    try {
      await setDoc(doc(db, 'users', user.uid), updates, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `users/${user.uid}`);
    }
  }, [data, user]);

  const saveAIMessage = useCallback(async (msg: AIMessage) => {
    if (!user) return;
    const newHistory = [...aiHistory, msg].slice(-50);
    setAiHistory(newHistory);
    try {
      await setDoc(doc(db, 'userAI', user.uid), { history: newHistory }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `userAI/${user.uid}`);
    }
  }, [aiHistory, user]);

  const clearHistory = useCallback(async () => {
    if (!user) return;
    setAiHistory([]);
    try {
      await setDoc(doc(db, 'userAI', user.uid), { history: [] }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `userAI/${user.uid}`);
    }
  }, [user]);

  const updateAIPersona = useCallback(async (updates: Partial<AIPersonaProfile>) => {
    if (!user) return;
    const newPersona = aiPersona ? { ...aiPersona, ...updates } : { 
      style: 'balanced', 
      interests: [], 
      questionCount: 1, 
      avgMsgLen: 0, 
      formality: 'neutral', 
      emojiUser: false, 
      preferredTopics: {}, 
      lastInteraction: Date.now(),
      ...updates 
    } as AIPersonaProfile;
    
    setAiPersona(newPersona);
    try {
      await setDoc(doc(db, 'userAI', user.uid), { persona: newPersona }, { merge: true });
    } catch (e) {
      handleFirestoreError(e, OperationType.UPDATE, `userAI/${user.uid}`);
    }
  }, [aiPersona, user]);

  return { 
    data, 
    updateData, 
    user, 
    loading, 
    aiHistory, 
    saveAIMessage, 
    clearHistory,
    aiPersona, 
    updateAIPersona 
  };
}
