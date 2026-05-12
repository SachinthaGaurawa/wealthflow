// ==================== WealthFlow Type Definitions ====================
// Central type definitions for the entire application.
// Used by hooks, services, and components.
// =====================================================================

export interface IncomeSource {
  id: string;
  name: string;
  monthly: number;
  type?: string;
  start: string;        // YYYY-MM-DD
  end?: string;         // YYYY-MM-DD
  freq?: 'monthly' | 'annual' | 'quarterly';
  amount?: number;
  rate?: number;
  notes?: string;
}

export interface Loan {
  id: string;
  name: string;
  bank: string;
  amount: number;
  rate: number;
  duration: number;     // months
  monthly: number;
  start: string;        // YYYY-MM-DD
  paymentMethod?: 'emi' | 'reducing';
  payments?: LoanPayment[];
  notes?: string;
}

export interface LoanPayment {
  month: string;        // YYYY-MM
  paid: boolean;
  amount: number;
  paidAt?: number;      // timestamp
  notes?: string;
  editedAt?: number;    // timestamp
}

export interface CCInstallment {
  id: string;
  product: string;
  bank: string;
  total: number;
  monthly: number;
  duration: number;
  rate?: number;
  date: string;         // YYYY-MM-DD
  status?: 'active' | 'completed';
  payments?: any[];
}

export interface CCOneTime {
  id: string;
  desc: string;
  bank: string;
  amount: number;
  date: string;         // YYYY-MM-DD
  paid?: boolean;
  paidAt?: number;
}

export interface Cheque {
  id: string;
  name: string;
  bank: string;
  amount: number;
  date: string;         // YYYY-MM-DD
  chequeNo?: string;
  status?: 'pending' | 'cleared' | 'bounced';
  notes?: string;
}

export interface Expense {
  id: string;
  desc: string;
  category?: string;
  amount: number;
  month: string;        // YYYY-MM
  date?: string;        // YYYY-MM-DD
  notes?: string;
}

export interface SavingsTarget {
  id: string;
  name: string;
  amount: number;
  deadline?: string;    // YYYY-MM-DD
  savings?: { amount: number; date: string }[];
  notes?: string;
}

export interface BalanceData {
  total: number;
  flows: BalanceFlow[];
}

export interface BalanceFlow {
  id: string;
  desc: string;
  amount: number;
  type: 'in' | 'out';
  date: string;         // YYYY-MM-DD
}

export interface WealthSettings {
  backupFreq: string;
  lastBackup: string | null;
  theme: 'dark' | 'light';
  autoLock: number;
  haptics: boolean;
  currency: string;
  notifications: boolean;
  compactMode: boolean;
  geminiKey?: string;
  aiAdvisorPersona?: string;
  aiLang?: string;
  autoCategory?: boolean;
  autoBackupFreq?: string;
}

export interface SessionInfo {
  id: string;
  device?: string;
  browser?: string;
  ip?: string;
  isp?: string;
  city?: string;
  country?: string;
  lastActive?: number;
  loginAt?: number;
  isOnline?: boolean;
}

export interface Subscription {
  id: string;
  name: string;
  category?: string;
  amount: number;
  day: number;
  cycle?: 'monthly' | 'quarterly' | 'yearly';
  anomaly?: boolean;
  notes?: string;
}

export interface AuthData {
  pin?: string;
  decoyPin?: string;
  _pinChangedAt?: number;
  recoveryEmail?: string;
}

export interface AppData {
  auth: AuthData;
  income: IncomeSource[];
  loans: Loan[];
  ccinstall: CCInstallment[];
  cconetime: CCOneTime[];
  cheques: Cheque[];
  expenses: Expense[];
  targets: SavingsTarget[];
  balance: BalanceData;
  settings: WealthSettings;
  sessions?: SessionInfo[];
  subscriptions?: Subscription[];
  revokedSessions?: string[];
}

// AI-related types
export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  provider?: string;
  image?: string;
}

export interface AIPersonaProfile {
  style: 'supportive' | 'balanced' | 'strict' | 'aggressive';
  interests: string[];
  questionCount: number;
  avgMsgLen: number;
  formality: 'casual' | 'neutral' | 'formal';
  emojiUser: boolean;
  preferredTopics: Record<string, number>;
  lastInteraction: number;
  typingPattern?: 'detailed' | 'concise';
  regionalDialect?: string;
}
