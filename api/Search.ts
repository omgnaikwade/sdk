import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Saavn } from '@saavn-labs/sdk';

const saavn = new Saavn();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const query = req.query.q as string;

  if (!query) {
    return res.status(400).json({ error: 'Please provide a search query using ?q=something' });
  }

  try {
    // Note: SDK ke README mein check kar lena exact method ka naam
    const results = await saavn.search(query); 
    
    return res.status(200).json({
      success: true,
      query: query,
      data: results
    });
  } catch (error: any) {
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch songs', 
      details: error.message 
    });
  }
}
