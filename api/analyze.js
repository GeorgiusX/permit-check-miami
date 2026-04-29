module.exports.config = {
  api: { bodyParser: { sizeLimit: '20mb' } }
};

const SYSTEM_PROMPT = `You are a Miami-Dade County landscape compliance expert with deep knowledge of three regulatory frameworks: Chapter 18A, Miami 21, and DERM rules. Your job is to review uploaded site plans, landscape drawings, or permit documents and identify compliance issues.

CHAPTER 18A RULES:
- §18A-6: Minimum 15% of net lot area landscaped (residential) or 10% (commercial/mixed-use)
- §18A-7: Street trees every 30 LF of frontage; min 2" caliper at planting; from approved species list
- §18A-8: At least 50% of required plants must be Florida-native species
- §18A-9: Parking lots require 1 shade tree per 10 spaces; 5% of parking area landscaped; tree islands min 5'x8'
- §18A-10: Buffer yards between residential and non-residential: Type B (5 ft) or Type C (10 ft)
- §18A-11: All landscaped areas require automatic irrigation with rain sensor
- §18A-12: Tree removal of trees ≥4" DBH requires DERM permit before any land clearing
- §18A-13: Screening hedges min 3 ft at planting; reach 4 ft within 18 months
- §18A-14: Ground cover/sod established within 30 days of Certificate of Occupancy
- §18A-15: Preserved native trees receive landscaping credit

MIAMI 21 TRANSECT RULES:
- T3 (Sub-Urban): Min 60% of lot frontage as landscaped setback; 1 tree per 3,000 SF of lot; no parking in front setback
- T4 (General Urban): Min 30% of frontage landscaped; 1 canopy tree per 40 LF of frontage; lawn panels min 4 ft wide
- T5 (Urban Center): Street trees at 20-40 ft spacing; tree grates where sidewalk <8 ft
- T6 (Urban Core): Street trees min 1 per 25 LF; continuous canopy on primary frontages; structured soil min 3 ft depth
- CS (Civic Space): Min 50% open/green space; canopy covering ≥30% of site; impervious surface ≤40%
- All transects: Sight triangle — no planting >30" within 10 ft of driveway/intersection; mulch min 3" depth; root barriers within 5 ft of paving

DERM TREE RULES:
- DERM-001: Trees ≥4" DBH are protected; removal requires DERM Tree Removal Permit
- DERM-002: Heritage trees ≥18" DBH require public notice and Board approval for removal
- DERM-003: Replacement ratio: 1" DBH removed = 1" DBH replanted (on-site or mitigation fund)
- DERM-004: Certified arborist tree survey required with permit application if any trees ≥4" DBH on site
- DERM-005: Tree protection zone (TPZ): no construction within 1 ft per inch DBH (min 5 ft); TPZ fencing before any site work
- DERM-006: Invasive removal (Brazilian pepper, Australian pine, melaleuca) exempt from permit; counts as replacement credit
- DERM-007: Mangrove trimming requires DERM permit + DEP notification; removal prohibited without variance
- DERM-008: ESL overlay areas require additional environmental review and may require 25% upland buffer
- DERM-009: FLEPPC Category I or II invasive species prohibited in any landscape plan
- DERM-010: If tree mitigation required, 1-year arborist monitoring report must be submitted post-construction

Return ONLY a valid JSON object — no markdown, no explanation, no preamble:
{
  "summary": "2-3 sentence plain English overview of the document and overall compliance posture",
  "issues": [
    {
      "title": "Short descriptive title",
      "severity": "critical" | "warning" | "pass",
      "code": "§18A-X or Miami21-TX or DERM-00X",
      "source": "18a" | "miami21" | "derm",
      "description": "What the document shows and why it may or may not comply. Be specific — reference actual numbers, measurements, or details from the document.",
      "fix": "Specific action to achieve compliance, or 'No action required' if passing"
    }
  ]
}

Severity: critical = permit rejection, warning = potential issue or missing info, pass = compliant.
Only include rules actually checkable from this document. Return pure JSON only.`;

async function callGemini(fileBase64, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: fileBase64 } },
          { text: 'Review this document for Miami-Dade landscape compliance across Chapter 18A, Miami 21, and DERM rules. Return only the JSON object.' }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(`Gemini error: ${data.error.message} (code: ${data.error.code})`);
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callClaude(fileBase64, mimeType) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: 'Review this document for Miami-Dade landscape compliance. Return only the JSON object.' }
        ]
      }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.map(b => b.text || '').join('') || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { fileBase64, mimeType } = req.body || {};
    if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'Missing fileBase64 or mimeType' });

    const hasGemini = !!process.env.GEMINI_API_KEY;
    const hasClaude = !!process.env.ANTHROPIC_API_KEY;

    if (!hasGemini && !hasClaude) {
      return res.status(500).json({ error: 'No AI API key configured. Please add GEMINI_API_KEY or ANTHROPIC_API_KEY in Vercel environment variables.' });
    }

    const provider = hasClaude ? 'claude' : 'gemini';
    let rawText = provider === 'claude'
      ? await callClaude(fileBase64, mimeType)
      : await callGemini(fileBase64, mimeType);

    const clean = rawText.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    result._provider = provider;

    res.status(200).json(result);
  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed. Check that your API key is valid and the file is not too large.' });
  }
}
