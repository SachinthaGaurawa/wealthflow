import { NextApiRequest, NextApiResponse } from 'next';
import { adminDb } from '@/lib/firebaseAdmin'; // Ensure your Admin SDK is initialised
import { z } from 'zod';

// Define strict schema for 0% validation errors
const RequestSchema = z.object({
  recordId: z.string(),
  type: z.enum(['INCOME', 'LOAN', 'PAYMENT']),
  amount: z.number(),
  currency: z.string().min(1).max(5), // Dynamically handles LKR, USD, etc.
  status: z.literal('RECEIVED'),
  securityToken: z.string(),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 1. Force POST method for security
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 2. Validate the payload using Zed
    // We now extract 'currency' from the validated body
    const { recordId, type, amount, currency, securityToken } = RequestSchema.parse(req.body);

    // 3. Security Audit: Verify the token matches your environment secret
    if (securityToken !== process.env.WEALTHFLOW_INTERNAL_TOKEN) {
      console.error('Security Breach Attempt: Invalid Token');
      return res.status(401).json({ error: 'Unauthorised' });
    }

    // 4. Atomic Database Update
    const recordRef = adminDb.collection('wealthflow_records').doc(recordId);
    
    await recordRef.update({
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
      verifiedBy: 'NOTIFICATION_ACTION',
      transactionLog: adminDb.FieldValue.arrayUnion({
        action: 'YES_CLICK',
        timestamp: new Date().toISOString(),
        // Logic updated to use the dynamic currency passed from the app
        note: `Confirmed ${type.toLowerCase()} of ${currency} ${amount.toLocaleString()}`,
      }),
    });

    // 5. Success Response
    return res.status(200).json({ 
      success: true, 
      message: `WealthFlow System Updated: ${type} of ${currency} ${amount} confirmed.` 
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid Request Format', details: error.errors });
    }
    console.error('WealthFlow Critical Error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
