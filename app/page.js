'use client';

import { useEffect, useMemo, useState } from 'react';
import { computeBalances, settleUp } from '../lib/split';
import { getSupabaseClient } from '../lib/supabaseClient';

const DEFAULT_PEOPLE = ['Aisha', 'Raj', 'Priya', 'You'];
const STORAGE_KEYS = {
  people: 'splitsmart.people',
};

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

function getErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const parts = [
      error.message,
      error.details,
      error.hint,
      error.code ? `code ${error.code}` : '',
    ].filter((part) => typeof part === 'string' && part);
    if (parts.length) return parts.join(' — ');
  }
  return 'Unknown error';
}

function normalizeExpense(row) {
  return {
    id: row.id,
    emoji: row.emoji || '🧾',
    name: row.name,
    paidBy: row.paid_by,
    amount: Number(row.amount),
    splitBetween: row.split_between || [],
  };
}

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
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [manualExpense, setManualExpense] = useState({
    description: '',
    amount: '',
    paidBy: 'You',
    splitBetween: ['You'],
  });
  const [error, setError] = useState('');
  const ownerEmail = typeof user?.user_metadata?.unverified_email === 'string'
    ? user.user_metadata.unverified_email.trim().toLowerCase()
    : '';

  useEffect(() => {
    let supabase;
    try {
      supabase = getSupabaseClient();
    } catch (clientError) {
      setError(`Could not initialize Supabase: ${getErrorMessage(clientError)}`);
      setAuthLoading(false);
      return undefined;
    }

    let mounted = true;
    const sessionTimeout = setTimeout(() => {
      if (!mounted) return;
      setError('Could not check sign-in status: Supabase auth did not respond. Check your connection and reload the page.');
      setAuthLoading(false);
    }, 15000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      clearTimeout(sessionTimeout);
      setUser(session?.user || null);
      setExpenses([]);
      setExpensesLoading(Boolean(session?.user));
      setAuthLoading(false);
      setError('');
    });

    supabase.auth.getSession().then(({ data: { session }, error: sessionError }) => {
      if (!mounted) return;
      clearTimeout(sessionTimeout);
      if (sessionError) {
        setError(`Could not check sign-in status: ${sessionError.message}`);
      }
      setUser(session?.user || null);
      setExpensesLoading(Boolean(session?.user));
      setAuthLoading(false);
    }).catch((sessionError) => {
      if (!mounted) return;
      clearTimeout(sessionTimeout);
      setError(`Could not check sign-in status: ${getErrorMessage(sessionError)}`);
      setAuthLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(sessionTimeout);
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    try {
      const savedPeople = JSON.parse(localStorage.getItem(STORAGE_KEYS.people) || 'null');

      if (Array.isArray(savedPeople) && savedPeople.length > 0) {
        setPeople(savedPeople);
      }
    } catch {
      // Ignore corrupted local storage data.
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !ownerEmail) {
      setExpenses([]);
      setExpensesLoading(false);
      return;
    }

    let cancelled = false;
    const loadExpenses = async () => {
      try {
        const { data, error: loadError } = await getSupabaseClient()
          .from('expenses')
          .select('*')
          .eq('owner_email', ownerEmail);

        if (loadError) throw loadError;
        if (!cancelled) setExpenses((data || []).map(normalizeExpense));
      } catch (loadError) {
        if (!cancelled) {
          setError(`Could not load expenses: ${getErrorMessage(loadError)}`);
        }
      } finally {
        if (!cancelled) setExpensesLoading(false);
      }
    };

    loadExpenses();

    return () => {
      cancelled = true;
    };
  }, [authLoading, ownerEmail, user]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEYS.people, JSON.stringify(people));
    } catch {}
  }, [people]);

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

  const insertExpense = async (expense) => {
    if (!user || !ownerEmail) throw new Error('Enter your email before adding an expense.');

    const { data, error: insertError } = await getSupabaseClient()
      .from('expenses')
      .insert({
        user_id: user.id,
        owner_email: ownerEmail,
        name: expense.name,
        emoji: expense.emoji || '🧾',
        paid_by: expense.paidBy,
        amount: expense.amount,
        split_between: expense.splitBetween,
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const savedExpense = normalizeExpense(data);
    setExpenses((current) => [...current, savedExpense]);
    setError('');
  };

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

  const removePerson = (person) => {
    if (people.length <= 1) {
      setError('At least one person must remain in the group.');
      return;
    }

    const remainingPeople = people.filter((item) => item !== person);
    const replacementPayer = remainingPeople.includes('You') ? 'You' : remainingPeople[0];

    const updatedExpenses = expenses.map((expense) => {
      const paidBy = expense.paidBy === person ? replacementPayer : expense.paidBy;
      const splitBetween = (expense.splitBetween || []).filter((item) => item !== person);

      return {
        ...expense,
        paidBy,
        splitBetween: splitBetween.length ? splitBetween : [paidBy],
      };
    });

    const changedExpenses = updatedExpenses.filter((expense, index) => (
      expense.paidBy !== expenses[index].paidBy
      || expense.splitBetween.join('\0') !== (expenses[index].splitBetween || []).join('\0')
    ));

    const persistChanges = async () => {
      try {
        for (const expense of changedExpenses) {
          const { error: updateError } = await getSupabaseClient()
            .from('expenses')
            .update({
              paid_by: expense.paidBy,
              split_between: expense.splitBetween,
            })
                .eq('id', expense.id)
                .eq('owner_email', ownerEmail);

          if (updateError) throw updateError;
        }

        setPeople(remainingPeople);
        setExpenses(updatedExpenses);
        setError('');
      } catch (updateError) {
        setError(`Could not update expenses for ${person}: ${getErrorMessage(updateError)}`);
      }
    };

    persistChanges();
  };

  const continueWithEmail = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim();

    setAuthBusy(true);
    setError('');

    try {
      const { error: signInError } = await getSupabaseClient().auth.signInAnonymously({
        options: {
          data: { unverified_email: normalizedEmail },
        },
      });

      if (signInError) throw signInError;
    } catch (authError) {
      setError(`Could not continue: ${getErrorMessage(authError)}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    setAuthBusy(true);
    setError('');

    try {
      const { error: signOutError } = await getSupabaseClient().auth.signOut();
      if (signOutError) throw signOutError;
    } catch (signOutError) {
      setError(`Could not sign out: ${getErrorMessage(signOutError)}`);
    } finally {
      setAuthBusy(false);
    }
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

  const addManualExpense = async () => {
    const description = manualExpense.description.trim();
    const amount = Number(manualExpense.amount);
    const splitBetween = manualExpense.splitBetween.length ? manualExpense.splitBetween : [manualExpense.paidBy];

    if (!description || !Number.isFinite(amount) || amount <= 0) {
      setError('Add a description and a valid amount before saving the expense.');
      return;
    }

    try {
      await insertExpense({
        emoji: '🧾',
        name: description,
        paidBy: manualExpense.paidBy,
        amount,
        splitBetween,
      });

      setManualExpense({
        description: '',
        amount: '',
        paidBy: manualExpense.paidBy,
        splitBetween: [manualExpense.paidBy],
      });
    } catch (insertError) {
      setError(`Could not save expense: ${getErrorMessage(insertError)}`);
    }
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

      await insertExpense({
        emoji: '🤖',
        name: parsedExpense.name || 'AI expense',
        paidBy: people.includes(parsedExpense.paidBy) ? parsedExpense.paidBy : 'You',
        amount: Number(parsedExpense.amount || 0),
        splitBetween: people.length ? [...people] : ['You'],
      });

      setAiText('');
    } catch (err) {
      setError(`CLIENT_ERROR: ${getErrorMessage(err)}`);
    }
  };

  const removeExpense = async (id) => {
    try {
      const { error: deleteError } = await getSupabaseClient()
        .from('expenses')
        .delete()
        .eq('id', id)
        .eq('owner_email', ownerEmail);

      if (deleteError) throw deleteError;
      setExpenses((current) => current.filter((expense) => expense.id !== id));
      setError('');
    } catch (deleteError) {
      setError(`Could not delete expense: ${getErrorMessage(deleteError)}`);
    }
  };

  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <div style={styles.header}>
          <div style={styles.brand}>
            <div style={styles.logo}>S</div>
            <div style={styles.title}>Aditya’s SplitSmart</div>
          </div>
          {user && (
            <div style={styles.accountActions}>
              <div style={styles.groupPill}>{people.length} people</div>
              <button type="button" style={styles.secondaryBtn} onClick={signOut} disabled={authBusy}>
                Sign out
              </button>
            </div>
          )}
        </div>

        {!user && (
          <section style={styles.section}>
            {authLoading ? (
              <div style={styles.empty}>Checking sign-in status…</div>
            ) : (
              <form onSubmit={continueWithEmail}>
                <div style={styles.sectionHeader}>Continue with email</div>
                <div style={styles.authFields}>
                  <input
                    style={styles.input}
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Email address"
                    aria-label="Email address"
                    required
                  />
                  <button type="submit" style={styles.primaryBtnWide} disabled={authBusy}>
                    {authBusy ? 'Please wait…' : 'Continue'}
                  </button>
                </div>
                <div style={styles.authNotice}>
                  No email will be sent. Anyone who enters the same unverified address can view and change
                  expenses saved under it.
                </div>
              </form>
            )}
          </section>
        )}

        {user && (
          <>
        <div style={styles.identityWarning}>
          Expenses for <strong>{ownerEmail || 'this session'}</strong> are shared by entered email. Email ownership is not verified.
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
              <span key={person} style={styles.personChip}>
                {person}
                <button
                  type="button"
                  style={styles.removePerson}
                  onClick={() => removePerson(person)}
                  aria-label={`Remove ${person}`}
                  title={`Remove ${person}`}
                >
                  ×
                </button>
              </span>
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
            {expensesLoading ? (
              <div style={styles.empty}>Loading expenses…</div>
            ) : expenses.length === 0 ? (
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
          </>
        )}
        {error && <div style={styles.errorBox}>{error}</div>}
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
  accountActions: { display: 'flex', alignItems: 'center', gap: 8 },
  secondaryBtn: { border: '1px solid #dbe2ef', borderRadius: 10, padding: '6px 10px', background: '#fff', color: '#334155', fontWeight: 700, cursor: 'pointer' },
  section: { marginBottom: 18 },
  sectionHeader: { fontSize: 13, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.08, color: '#475569', marginBottom: 8 },
  peopleRow: { display: 'flex', gap: 10, marginBottom: 10 },
  authFields: { display: 'grid', gap: 10 },
  authNotice: { color: '#64748b', fontSize: 12, lineHeight: 1.5, marginTop: 10 },
  identityWarning: { background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', borderRadius: 12, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, marginBottom: 14 },
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
    display: 'inline-flex', alignItems: 'center', gap: 4, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe', borderRadius: 999, padding: '4px 6px 4px 10px', fontSize: 12, fontWeight: 700,
  },
  removePerson: { border: 'none', background: 'transparent', color: '#64748b', fontSize: 16, lineHeight: 1, width: 18, height: 18, padding: 0, borderRadius: 999, cursor: 'pointer' },
  splitBox: { marginTop: 12, border: '1px solid #e2e8f0', borderRadius: 14, padding: 12, background: '#f8fafc' },
  splitLabel: { fontWeight: 700, marginBottom: 10, fontSize: 13 },
  checkList: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  checkItem: { display: 'flex', alignItems: 'center', gap: 6, background: '#fff', border: '1px solid #dbe2ef', borderRadius: 999, padding: '6px 10px', fontSize: 12 },
  errorBox: { background: '#fff1f1', border: '1px solid #f7c7c7', color: '#8a1f1f', borderRadius: 12, padding: '10px 12px', fontSize: 12.5, marginBottom: 14 },
  successBox: { background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#14532d', borderRadius: 12, padding: '10px 12px', fontSize: 13, marginTop: 10 },
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
