import { GoogleGenAI } from "@google/genai";
import { AppData } from "../types";

export interface WealthProjection {
  year: number;
  bull: number;
  base: number;
  bear: number;
  events: string[];
}

export async function generateWealthProjection(data: AppData): Promise<WealthProjection[]> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const prompt = `
    You are a Strategic Wealth Analyst. Given the following financial data, project the user's Total Net Assets over the next 5 years (Year 1 to Year 5).
    
    Data:
    - Monthly Income total: LKR ${data.income.reduce((s, i) => s + i.monthly, 0)}
    - Monthly Expenses (estimated): LKR ${data.expenses.length > 0 ? (data.expenses.reduce((s, e) => s + e.amount, 0) / 1) : 0}
    - Total Monthly Loan Commitments: LKR ${data.loans.reduce((s, l) => s + l.monthly, 0)}
    - Total Savings Targets being chased: ${data.targets.length} targets totalling LKR ${data.targets.reduce((s, t) => s + t.amount, 0)}
    
    Current Sentiment: Strategic and Calculated.
    
    Return a JSON array of 5 objects, each with:
    - year: number (1-5)
    - bull: number (Best case projection, high yield)
    - base: number (Expected projection)
    - bear: number (Worst case, high inflation/leakage)
    - events: string[] (Significant financial milestones predicted for this year)
  `;

  try {
    const result = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
      }
    });

    const text = result.text || "";
    return JSON.parse(text);
  } catch (error) {
    console.error("Projection failed:", error);
    // Fallback static projection if AI fails
    return [
      { year: 1, base: 1000000, bull: 1200000, bear: 800000, events: ["Market Entry"] },
      { year: 2, base: 1500000, bull: 1800000, bear: 1200000, events: ["Asset Accumulation"] },
      { year: 3, base: 2200000, bull: 2800000, bear: 1700000, events: ["Strategic Rebalance"] },
      { year: 4, base: 3100000, bull: 4000000, bear: 2300000, events: ["Portfolio Maturity"] },
      { year: 5, base: 4500000, bull: 6000000, bear: 3200000, events: ["Wealth Freedom Milestone"] },
    ];
  }
}
