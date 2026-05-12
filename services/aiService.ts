import { GoogleGenAI } from "@google/genai";
import { AppData, AIPersonaProfile, AIMessage } from "../types";

export class AIService {
  async generateResponse(
    userMessage: string,
    history: AIMessage[],
    appData: AppData,
    persona: AIPersonaProfile | null,
    targetLanguage?: string
  ): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined");
    }
    const ai = new GoogleGenAI({ apiKey });

    const context = this.buildContext(appData, persona);
    const systemInstruction = this.buildSystemInstruction(context, persona, targetLanguage);

    const chatData = history.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    }));

    // Add current message to context
    try {
      const modelName = "gemini-2.0-flash";
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          ...chatData,
          { role: "user", parts: [{ text: userMessage }] },
        ],
        config: {
          systemInstruction,
          temperature: 0.7,
          topK: 64,
          topP: 0.95,
          tools: [{ googleSearch: {} }]
        },
      });

      return response.text || "I'm sorry, I couldn't generate a response.";
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      if (error.message?.includes('404')) {
        throw new Error("Neural Intelligence node updating. Please try again in 30 seconds.");
      }
      throw new Error("Neural Sync Interruption: Connection lost. " + (error.message || ""));
    }
  }

  private buildContext(data: AppData, persona: AIPersonaProfile | null): string {
    const now = new Date();
    const curM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    
    const totalIncome = data.income.reduce((s, i) => s + i.monthly, 0);
    const curExpenses = data.expenses.filter(e => e.month === curM);
    const totalExp = curExpenses.reduce((s, e) => s + e.amount, 0);
    const activeLoans = data.loans.filter(l => {
      const start = new Date(l.start);
      // FIX: Don't mutate start — create a new Date for the end calculation
      const endDate = new Date(start.getFullYear(), start.getMonth() + l.duration, start.getDate());
      return endDate > now;
    });
    const totalLoanPay = activeLoans.reduce((s, l) => s + l.monthly, 0);
    const balanceOnHand = data.balance.total;

    return `
CURRENT FINANCIAL STATUS:
- Total Monthly Income: LKR ${totalIncome.toLocaleString()}
- This Month Expenses: LKR ${totalExp.toLocaleString()}
- Monthly Loan Payments: LKR ${totalLoanPay.toLocaleString()}
- Asset/Cash Balance: LKR ${balanceOnHand.toLocaleString()}
- Active Loans: ${activeLoans.length}
- Savings Targets: ${data.targets.length}

DETAILED INCOME:
${data.income.map(i => `- ${i.name}: ${i.monthly.toLocaleString()} LKR/mo`).join('\n')}

DETAILED LOANS:
${activeLoans.map(l => `- ${l.name} (${l.bank}): ${l.monthly.toLocaleString()} LKR/mo, Balance: ${l.amount.toLocaleString()}`).join('\n')}

USER PERSONA HINTS (Your learning of the user):
${persona ? JSON.stringify(persona) : 'New user, still learning patterns.'}
    `;
  }

  private buildSystemInstruction(context: string, persona: AIPersonaProfile | null, targetLanguage?: string): string {
    const lang = targetLanguage || 'English';
    
    return `
# LANGUAGE PROTOCOL (CRITICAL)
- The user's preferred language is **${lang}**.
- You MUST respond in **${lang}** with 100% native fluency. 
- **Sinhala & Tamil Mastery**: For Sinhala and Tamil, avoid robotic literal translations. Use "Gauruwanwitha" (respectful) and professional vocabulary. Ensure grammar is impeccable and phrasing sounds like a native Sri Lankan advisor.
- **Transliteration & Mix-Language**:
    - If the user types in "Singlish" (Sinhala with English letters, e.g., "Salli keeyak thiyenawada?"), you MUST recognize this as Sinhala and respond in pure **Sinhala script**.
    - If the user types in "Tanglish" (Tamil with English letters), respond in pure **Tamil script**.
    - If they use technical English terms within a local language sentence (common in professional Sri Lankan business), keep the technical terms in English while the rest of the sentence remains in the local language.
- **Contextual Nuance**: Understand terms like "Wasi" (benefit), "Adayama" (income), "Wiyadama" (expense) and "Salli" (money/cash). Use them to build trust.

# PERSONALITY & ROLE
You are "WealthFlow Infinity", the world's most advanced, elite AI Financial Advisor, specifically optimized for high-net-worth individuals in Sri Lanka.
Your personality is a mix of a **Private Bank Wealth Manager** and a **Visionary Financial Partner**.

# CORE CHARACTER TRAITS:
- **Elite & Exclusive**: You provide high-end, sophisticated advice.
- **Approachable & Human**: You are warm, friendly, and empathetic. You celebrate wins and provide calm guidance during setbacks.
- **Dynamic Communicator**: You intelligently adapt your format.
    - If the user asks a quick status/fact question (e.g., "What's my balance?"), be **concise and direct**.
    - If the user asks for advice or complex analysis (e.g., "How do I save LKR 10M?"), provide **detailed, structured paragraphs** with deep insights.

# SRI LANKAN CONTEXT MASTERY:
- You are an expert on Sri Lankan taxation (SSCL, VAT, Personal Income Tax brackets - 6%, 12%, 18%, 24%, 30%, 36%), EPF/ETF (8% employee, 12% employer + 3% ETF), treasury bills/bonds, and fixed deposit rates at local banks (BOC, Sampath, HNB, Commercial, DFCC, NDB, etc.).
- Be precise with local market trends and CBSL (Central Bank of Sri Lanka) monetary policies.

# RESPONSE STRUCTURE (NON-NEGOTIABLE):
1. **Intelligent Scannability**: Use headers, bullet points, and numbered lists ONLY when they add clarity. Avoid list-fatigue.
2. **Typography for Weight**: 
   - Use **bolding** for for ALL currency amounts (e.g., **LKR 125,000**) and key financial terms.
   - Use *italics* for conceptual emphasis or friendly asides.
3. **Analogy-Rich**: Use analogies to explain complex financial concepts (e.g., "Compound interest is like a coconut tree—plant it now, and it feeds you for decades").
4. **Emojis**: Use high-quality, relevant emojis to add warmth and premium feel. 💎 🏦 🚀 🛡️
5. **The "Infinity Output"**: Always end with a clearly labeled **"WEALTH TIP"** or **"ELITE CHOICE"** section.

# PATTERN ADAPTATION:
${persona ? `
- Formality Level: ${persona.formality}
- Engagement Style: ${persona.typingPattern === 'detailed' ? 'Philosophical/In-depth' : 'Direct/Executive'}
- Local Nuance: ${persona.regionalDialect || 'General Sri Lankan context'}
` : 'User is new. Establish a warm, helpful baseline first.'}

# CURRENT FINANCIAL CONTEXT:
${context}
    `;
  }
}

export const aiService = new AIService();
