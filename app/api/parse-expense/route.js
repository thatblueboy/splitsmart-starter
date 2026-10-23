import { NextResponse } from 'next/server';

function parseFallbackExpense(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) {
    return {
      id: 'e-' + Date.now(),
      emoji: '🧾',
      name: 'Expense',
      paidBy: 'You',
      amount: 0,
    };
  }

  const clauses = cleaned
    .replace(/^\s*(?:add|record|new)\s+/i, '')
    .replace(/\bexpenses?\b/gi, '')
    .split(/\s+(?:and|plus)\s+|\s*,\s*(?:and\s+)?|\s*;\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (clauses.length > 1) {
    return clauses.map((clause) => {
      const match = clause.match(/(.*?)(\d[\d,]*(?:\.\d+)?)\b/i);
      if (!match) {
        return {
          id: 'e-' + Date.now() + Math.random(),
          emoji: '🧾',
          name: 'Expense',
          paidBy: 'You',
          amount: 0,
        };
      }

      const amount = Number(match[2].replace(/,/g, ''));
      const name = match[1]
        .replace(/^(?:for|on|of|to|with|and|another|one|two|three|four|five)\b\s*/i, '')
        .replace(/^(?:for|on|of)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim() || 'Expense';

      return {
        id: 'e-' + Date.now() + Math.random(),
        emoji: '🧾',
        name: name.charAt(0).toUpperCase() + name.slice(1),
        paidBy: 'You',
        amount,
      };
    });
  }

  const amountMatch = cleaned.match(/\d[\d,]*(\.\d+)?/);
  const amount = amountMatch ? Number(amountMatch[0].replace(/,/g, '')) : 0;
  const name = cleaned.replace(/\d[\d,]*(\.\d+)?/, '').replace(/\s+/g, ' ').trim() || 'Expense';

  return {
    id: 'e-' + Date.now(),
    emoji: '🧾',
    name: name.charAt(0).toUpperCase() + name.slice(1),
    paidBy: 'You',
    amount,
  };
}

function extractJsonObject(rawText) {
  if (!rawText) return null;

  const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = codeBlockMatch ? codeBlockMatch[1] : rawText;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);

  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function normalizeExpenseResult(payload, text) {
  const fallback = parseFallbackExpense(text);

  if (!payload || typeof payload !== 'object') {
    return fallback;
  }

  const amount = Number(payload.amount ?? fallback.amount);
  const people = Number(payload.people ?? 1);
  const each = Number(payload.each ?? (people > 0 ? amount / people : amount));
  const description = String(payload.description || text || 'Expense').trim();

  return {
    id: 'e-' + Date.now(),
    emoji: '🧾',
    name: description || fallback.name,
    paidBy: 'You',
    amount: Number.isFinite(amount) ? amount : fallback.amount,
    people: Number.isFinite(people) && people > 0 ? people : 1,
    each: Number.isFinite(each) ? each : amount,
  };
}

export async function POST(request) {
  let payload = {};

  try {
    const rawBody = await request.text();
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    payload = {};
  }

  try {
    const { text } = payload;
    const cleanText = String(text || '').trim();

    if (!cleanText) {
      return NextResponse.json({
        error: { code: 'EMPTY_TEXT', message: 'No expense text was provided.' },
        source: 'validation',
      }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({
        error: { code: 'NO_GEMINI_API_KEY', message: 'GEMINI_API_KEY is missing.' },
        source: 'config',
      }, { status: 500 });
    }

    const prompt = `
You are a receipt parser. Read the user's sentence and return JSON only.

Rules:
- Always reply ONLY as JSON.
- Return the total amount, number of people, amount each, and a short description.
- Use this exact format: { "amount": 1200, "people": 3, "each": 400, "description": "dinner" }
- If the sentence is vague, infer the most likely values.
- Use the real total amount from the message, not the per-person share.
- Ignore filler words like "split", "with", "paid by", and "for".
- Example input: "me, raj and priya had dinner for 1200"
- Example output: { "amount": 1200, "people": 3, "each": 400, "description": "dinner" }

Sentence: ${cleanText}
`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0,
            maxOutputTokens: 256,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({
        error: {
          code: 'GEMINI_API_ERROR',
          httpStatus: response.status,
          message: errorText || 'Gemini request failed.',
        },
        source: 'gemini',
      }, { status: response.status });
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((part) => part.text).join('') || '';
    const parsed = extractJsonObject(raw) || {};
    const normalized = normalizeExpenseResult(parsed, cleanText);

    return NextResponse.json({
      expense: {
        id: normalized.id,
        emoji: normalized.emoji,
        name: normalized.name,
        paidBy: normalized.paidBy,
        amount: normalized.amount,
      },
      source: 'gemini',
    });
  } catch (error) {
    return NextResponse.json({
      error: {
        code: 'UNHANDLED_ROUTE_ERROR',
        message: error instanceof Error ? error.message : 'Unknown server error',
      },
      source: 'server',
    }, { status: 500 });
  }
}
