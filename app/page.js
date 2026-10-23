'use client';

import { useEffect, useMemo, useState } from 'react';
import { computeBalances, settleUp } from '../lib/split';

const DEFAULT_PEOPLE = ['Aisha', 'Raj', 'Priya', 'You'];
const STORAGE_KEYS = {
  people: 'splitsmart.people',
  expenses: 'splitsmart.expenses',
};

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function parseExpense(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return [];

  const clauses = cleaned
    .replace(/^\s*(?:add|record|new)\s+/i, '')
    .replace(/\bexpenses?\b/gi, '')
    .split(/\s+(?:and|plus)\s+|\s*,\s*(?:and\s+)?|\s*;\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!clauses.length) return [];

  const parsed = clauses.flatMap((clause) => {
    const match = clause.match(/(.*?)(\d[\d,]*(?:\.\d+)?)\b/i);
    if (!match) return [];

    const amount = Number(match[2].replace(/,/g, ''));
    const name = match[1]
      .replace(/^(?:for|on|of|to|with|and|another|one|two|three|four|five|null)\b\s*/i, '')
      .replace(/^(?:for|on|of)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Expense';

    return [{
      id: 'e-' + Date.now() + Math.random(),
      name: name.charAt(0).toUpperCase() + name.slice(1),
      paidBy: 'You',
      amount,
      splitBetween: ['You'],
    }];
  });

  return parsed.length ? parsed : [{
    id: 'e-' + Date.now(),
    name: 'Expense',
    paidBy: 'You',
    amount: Number(cleaned.match(/\d[\d,]*(?:\.\d+)?/)?.[0]?.replace(/,/g, '') || 0),
    splitBetween: ['You'],
  }];
}

export default function Home() {
  const [people, setPeople] = useState(DEFAULT_PEOPLE);
  const [newPerson, setNewPerson] = useState('');
  const [aiText, setAiText] = useState('');
  const [expenses, setExpenses] = useState([
    { id: 'seed-1', emoji: '🍽️', name: 'Dinner', paidBy: 'Aisha', amount: 1800, splitBetween: ['Aisha', 'Raj', 'Priya', 'You'] },
    { id: 'seed-2', emoji: '🚕', name: 'Cab', paidBy: 'Raj', amount: 400, splitBetween: ['Raj', 'Aisha'] },
  ]);
  const [manualExpense, setManualExpense] = useState({
    description: '',
    amount: '',
    paidBy: 'You',
    splitBetween: ['You'],
  });
  const [error, setError] = useState('');

  useEffect(() => {
    try {
      const savedPeople = JSON.parse(localStorage.getItem(STORAGE_KEYS.people) || 'null');
      const savedExpenses = JSON.parse(localStorage.getItem(STORAGE_KEYS.expenses) || 'null');

      if (Array.isArray(savedPeople) && savedPeople.length > 0) {
        setPeople(savedPeople);
      }
      if (Array.isArray(savedExpenses) && savedExpenses.length > 0) {
        setExpenses(savedExpenses);
      }
    } catch {
      // Ignore corrupted local storage data.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.people, JSON.stringify(people));
    } catch {}
  }, [people]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.expenses, JSON.stringify(expenses));
    } catch {}
  }, [expenses]);

  useEffect(() => {
    setManualExpense((current) => {
      const validPeople = people.filter((person) => current.splitBetween.includes(person));
      const normalizedSplit = validPeople.length ? validPeople : [...people];
      const nextPaidBy = people.includes(current.paidBy) ? current.paidBy : people[0] || 'You';
      return {
        ...current,
        paidBy: nextPaidBy,
        splitBetween: normalizedSplit,
      };
    });
  }, [people]);

  const balances = useMemo(() => computeBalances(people, expenses), [people, expenses]);
  const settlement = useMemo(() => settleUp(balances), [balances]);
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  const addPerson = () => {
    const trimmed = newPerson.trim();
    if (!trimmed) return;
    if (people.some((person) => person.toLowerCase() === trimmed.toLowerCase())) {
      setNewPerson('');
      return;
    }

    setPeople((current) => [...current, trimmed]);
    setManualExpense((current) => ({
      ...current,
      splitBetween: [...current.splitBetween, trimmed],
      paidBy: current.paidBy || trimmed,
    }));
    setNewPerson('');
  };

  const toggleSplitPerson = (person) => {
    setManualExpense((current) => {
      const exists = current.splitBetween.includes(person);
      const next = exists
        ? current.splitBetween.filter((item) => item !== person)
        : [...current.splitBetween, person];
      return {
        ...current,
        splitBetween: next.length ? next : [person],
      };
    });
  };

  const addManualExpense = () => {
    const description = manualExpense.description.trim();
    const amount = Number(manualExpense.amount);
    const splitBetween = manualExpense.splitBetween.length ? manualExpense.splitBetween : [manualExpense.paidBy];

    if (!description || !Number.isFinite(amount) || amount <= 0) {
      setError('Add a description and a valid amount before saving the expense.');
      return;
    }

    setExpenses((current) => [
      ...current,
      {
        id: 'expense-' + Date.now(),
        emoji: '🧾',
        name: description,
        paidBy: manualExpense.paidBy,
        amount,
        splitBetween,
      },
    ]);

    setManualExpense({
      description: '',
      amount: '',
      paidBy: manualExpense.paidBy,
      splitBetween: [manualExpense.paidBy],
    });
    setError('');
  };

  const addParsedExpense = async () => {
    const text = aiText.trim();
    if (!text) return;

    try {
      const response = await fetch('/api/parse-expense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const data = await response.json();

      if (data?.error) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }

      const parsedExpense = Array.isArray(data.expense) ? data.expense[0] : (data.expense || parseExpense(text)[0]);

      if (!parsedExpense || !Number(parsedExpense.amount)) {
        setError('The AI did not return a valid expense.');
        return;
      }

      setExpenses((current) => [
        ...current,
        {
          id: 'ai-' + Date.now(),
          emoji: '🤖',
          name: parsedExpense.name || 'AI expense',
          paidBy: people.includes(parsedExpense.paidBy) ? parsedExpense.paidBy : 'You',
          amount: Number(parsedExpense.amount || 0),
          splitBetween: people.length ? [...people] : ['You'],
        },
      ]);

      setAiText('');
      setError('');
    } catch (err) {
      setError(`CLIENT_ERROR: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const removeExpense = (id) => {
    setExpenses((current) => current.filter((expense) => expense.id !== id));
  };

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.brand}>
            <div style={styles.logo}>S</div>
            <div style={styles.title}>Aditya’s SplitSmart</div>
          </div>
          <div style={styles.groupPill}>{people.length} people</div>
        </div>

        <section style={styles.section}>
          <div style={styles.peopleRow}>
            <input
              style={styles.input}
              value={newPerson}
              onChange={(e) => setNewPerson(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPerson()}
              placeholder="Add a person"
              aria-label="Add a person"
            />
            <button style={styles.primaryBtn} onClick={addPerson}>Add</button>
          </div>
          <div style={styles.peopleList}>
            {people.map((person) => (
              <span key={person} style={styles.personChip}>{person}</span>
            ))}
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.addRow}>
            <input
              style={styles.input}
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addParsedExpense()}
              placeholder="Dinner for 1800 split 4 ways"
            />
            <button style={styles.primaryBtn} onClick={addParsedExpense}>Create</button>
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.formGrid}>
            <input
              style={styles.input}
              value={manualExpense.description}
              onChange={(e) => setManualExpense((current) => ({ ...current, description: e.target.value }))}
              placeholder="Expense name"
            />
            <input
              style={styles.input}
              type="number"
              min="0"
              step="0.01"
              value={manualExpense.amount}
              onChange={(e) => setManualExpense((current) => ({ ...current, amount: e.target.value }))}
              placeholder="Amount"
            />
            <select
              style={styles.select}
              value={manualExpense.paidBy}
              onChange={(e) => setManualExpense((current) => ({ ...current, paidBy: e.target.value }))}
            >
              {people.map((person) => (
                <option key={person} value={person}>{person}</option>
              ))}
            </select>
          </div>

          <div style={styles.splitBox}>
            <div style={styles.splitLabel}>Split between</div>
            <div style={styles.checkList}>
              {people.map((person) => (
                <label key={person} style={styles.checkItem}>
                  <input
                    type="checkbox"
                    checked={manualExpense.splitBetween.includes(person)}
                    onChange={() => toggleSplitPerson(person)}
                  />
                  <span>{person}</span>
                </label>
              ))}
            </div>
          </div>

          <button style={styles.primaryBtnWide} onClick={addManualExpense}>Save expense</button>
        </section>

        {error && <div style={styles.errorBox}>{error}</div>}

        <section style={styles.section}>
          <div style={styles.list}>
            {expenses.length === 0 ? (
              <div style={styles.empty}>No expenses yet.</div>
            ) : (
              expenses.map((expense) => (
                <div key={expense.id} style={styles.item}>
                  <div style={styles.itemEmoji}>{expense.emoji || '🧾'}</div>
                  <div style={styles.itemMain}>
                    <div style={styles.itemName}>{expense.name}</div>
                    <div style={styles.itemMeta}>paid by {expense.paidBy} · split {expense.splitBetween?.join(', ') || 'n/a'}</div>
                  </div>
                  <div style={styles.itemAmount}>{inr(expense.amount)}</div>
                  <button style={styles.remove} onClick={() => removeExpense(expense.id)} aria-label={`Remove ${expense.name}`}>×</button>
                </div>
              ))
            )}
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.balanceList}>
            {people.map((person) => {
              const amount = balances[person] || 0;
              return (
                <div key={person} style={styles.balanceRow}>
                  <span>{person}</span>
                  <strong style={{ color: amount >= 0 ? '#0a7a44' : '#9b2c2c' }}>
                    {amount >= 0 ? '+' : '-'}{inr(Math.abs(amount))}
                  </strong>
                </div>
              );
            })}
          </div>
        </section>

        <section style={styles.section}>
          <div style={styles.settleList}>
            {settlement.length === 0 ? (
              <div style={styles.empty}>Everyone is settled.</div>
            ) : (
              settlement.map((item, index) => (
                <div key={`${item.from}-${item.to}-${index}`} style={styles.settleRow}>
                  <span>{item.from} pays {item.to}</span>
                  <strong>{inr(item.amount)}</strong>
                </div>
              ))
            )}
          </div>
        </section>

        <div style={styles.total}>Total {inr(total)}</div>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px 16px 40px',
    background: 'linear-gradient(180deg, #f2f6ff 0%, #eef2f8 100%)',
  },
  card: {
    width: '100%',
    maxWidth: 540,
    background: '#fff',
    borderRadius: 26,
    border: '1px solid #e2e8f0',
    boxShadow: '0 18px 44px -24px rgba(15, 23, 42, 0.28)',
    padding: 20,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  brand: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: {
    width: 36, height: 36, borderRadius: 12, background: 'linear-gradient(135deg, #0f2c7a, #3b82f6)',
    color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 800,
  },
  title: { fontWeight: 800, fontSize: 20 },
  groupPill: {
    fontSize: 12, fontWeight: 700, color: '#1d4ed8', background: '#dbeafe', padding: '6px 10px', borderRadius: 999,
  },
  section: { marginBottom: 18 },
  sectionHeader: { fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: '#475569', marginBottom: 8 },
  peopleRow: { display: 'flex', gap: 10, marginBottom: 10 },
  addRow: { display: 'flex', gap: 10 },
  formGrid: { display: 'grid', gap: 10 },
  input: {
    width: '100%', border: '1px solid #dbe2ef', borderRadius: 12, padding: '12px 14px', fontSize: 15, outline: 'none', color: '#0f172a',
    background: '#f8fafc',
  },
  select: {
    width: '100%', border: '1px solid #dbe2ef', borderRadius: 12, padding: '12px 14px', fontSize: 15, background: '#f8fafc', color: '#0f172a',
  },
  primaryBtn: {
    border: 'none', borderRadius: 12, padding: '0 14px', background: '#0f2c7a', color: '#fff', fontWeight: 700, minWidth: 74,
  },
  primaryBtnWide: {
    width: '100%', marginTop: 12, border: 'none', borderRadius: 12, padding: '12px 14px', background: '#0f2c7a', color: '#fff', fontWeight: 700,
  },
  peopleList: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  personChip: {
    background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 999, padding: '6px 10px', fontSize: 12, fontWeight: 700,
  },
  splitBox: { marginTop: 12, border: '1px solid #e2e8f0', borderRadius: 14, padding: 12, background: '#f8fafc' },
  splitLabel: { fontWeight: 700, marginBottom: 10, fontSize: 13 },
  checkList: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  checkItem: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #dbe2ef', borderRadius: 999, padding: '6px 10px', fontSize: 12 },
  errorBox: { background: '#fff1f1', border: '1px solid #f7c7c7', color: '#8a1f1f', borderRadius: 12, padding: '10px 12px', fontSize: 12.5, marginBottom: 14 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { color: '#64748b', textAlign: 'center', padding: '20px 0', fontSize: 14 },
  item: {
    display: 'flex', alignItems: 'center', gap: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 14, padding: '12px 10px',
  },
  itemEmoji: { width: 36, height: 36, borderRadius: 10, background: '#fff', border: '1px solid #dbe2ef', display: 'grid', placeItems: 'center' },
  itemMain: { flex: 1, minWidth: 0 },
  itemName: { fontWeight: 700, fontSize: 15 },
  itemMeta: { color: '#64748b', fontSize: 12, marginTop: 2 },
  itemAmount: { fontWeight: 800, fontSize: 14 },
  remove: { border: 'none', background: 'transparent', color: '#64748b', fontSize: 20, width: 26, height: 26, borderRadius: 8 },
  balanceList: { display: 'flex', flexDirection: 'column', gap: 8 },
  balanceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '10px 12px' },
  settleList: { display: 'flex', flexDirection: 'column', gap: 8 },
  settleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#ecfdf5', border: '1px solid #bbf7d0', borderRadius: 12, padding: '10px 12px', color: '#14532d' },
  total: { marginTop: 12, paddingTop: 14, borderTop: '1px solid #e2e8f0', textAlign: 'center', fontWeight: 800, fontSize: 16 },
};
