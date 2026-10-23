'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { computeBalances, settleUp } from '../lib/split';
import { getSupabaseClient } from '../lib/supabaseClient';

const STORAGE_KEYS = {
  selectedGroup: 'splitsmart.selectedGroup',
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

function nameFromEmail(email) {
  const localPart = String(email || '').split('@')[0] || '';
  const name = localPart
    .replace(/[._+-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return name || 'Member';
}

function normalizeMembers(rows) {
  const members = (rows || []).map((row) => ({
    userId: row.user_id,
    email: row.member_email || '',
    name: row.member_email
      ? nameFromEmail(row.member_email)
      : `Member ${String(row.user_id).slice(0, 6)}`,
  }));
  const nameCounts = new Map();

  for (const member of members) {
    nameCounts.set(member.name, (nameCounts.get(member.name) || 0) + 1);
  }

  return members.map((member) => ({
    ...member,
    name: nameCounts.get(member.name) > 1 && member.email.includes('@')
      ? `${member.name} (${member.email.split('@')[1]})`
      : member.name,
  }));
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
  const [groupMembers, setGroupMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [aiText, setAiText] = useState('');
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [expenses, setExpenses] = useState([]);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState('');
  const [showGroupPicker, setShowGroupPicker] = useState(true);
  const [newGroupName, setNewGroupName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [manualExpense, setManualExpense] = useState({
    description: '',
    amount: '',
    paidBy: '',
    splitBetween: [],
  });
  const [error, setError] = useState('');
  const authIdentityRef = useRef(null);
  const ownerEmail = typeof user?.user_metadata?.unverified_email === 'string'
    ? user.user_metadata.unverified_email.trim().toLowerCase()
    : '';
  const people = useMemo(() => groupMembers.map((member) => member.name), [groupMembers]);
  const activeGroup = groups.find((group) => group.id === activeGroupId);
  const currentPerson = groupMembers.find((member) => member.userId === user?.id)?.name
    || nameFromEmail(ownerEmail);

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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      clearTimeout(sessionTimeout);
      if (event === 'TOKEN_REFRESHED') return;

      const nextUser = session?.user || null;
      const nextIdentity = nextUser
        ? `${nextUser.id}:${nextUser.user_metadata?.unverified_email || ''}`
        : '';
      if (authIdentityRef.current === nextIdentity) {
        setAuthLoading(false);
        return;
      }

      authIdentityRef.current = nextIdentity;
      setUser(nextUser);
      setShowGroupPicker(true);
      setExpenses([]);
      setGroupMembers([]);
      setAuthLoading(false);
      setError('');
    });

    supabase.auth.getSession().then(({ data: { session }, error: sessionError }) => {
      if (!mounted) return;
      clearTimeout(sessionTimeout);
      if (sessionError) {
        setError(`Could not check sign-in status: ${sessionError.message}`);
      }
      const nextUser = session?.user || null;
      const nextIdentity = nextUser
        ? `${nextUser.id}:${nextUser.user_metadata?.unverified_email || ''}`
        : '';
      if (authIdentityRef.current !== nextIdentity) {
        authIdentityRef.current = nextIdentity;
        setUser(nextUser);
        setShowGroupPicker(true);
      }
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

  const loadGroups = async (preferredGroupId = activeGroupId) => {
    if (!user) return;
    setGroupsLoading(true);

    try {
      const supabase = getSupabaseClient();
      const { error: restoreError } = await supabase.rpc('restore_email_group_memberships');
      if (restoreError) {
        throw new Error(`Could not restore group membership. Run supabase/schema_hour6_identity.sql: ${getErrorMessage(restoreError)}`);
      }

      const { data, error: groupsError } = await supabase
        .from('groups')
        .select('id, name, join_code, created_at')
        .order('created_at', { ascending: true });

      if (groupsError) throw groupsError;

      const nextGroups = data || [];
      const selected = nextGroups.some((group) => group.id === preferredGroupId)
        ? preferredGroupId
        : nextGroups[0]?.id || '';
      setGroups(nextGroups);
      setActiveGroupId(selected);
      if (selected) localStorage.setItem(STORAGE_KEYS.selectedGroup, selected);
      else localStorage.removeItem(STORAGE_KEYS.selectedGroup);
    } catch (groupsError) {
      setError(`Could not load groups: ${getErrorMessage(groupsError)}`);
    } finally {
      setGroupsLoading(false);
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setGroups([]);
      setActiveGroupId('');
      setGroupsLoading(false);
      setGroupMembers([]);
      setMembersLoading(false);
      return;
    }

    let preferredGroupId = '';
    try {
      preferredGroupId = localStorage.getItem(STORAGE_KEYS.selectedGroup) || '';
    } catch (storageError) {
      setError(`Could not read the selected group: ${getErrorMessage(storageError)}`);
    }
    loadGroups(preferredGroupId);
  }, [authLoading, user]);

  useEffect(() => {
    if (!user || !activeGroupId) {
      setGroupMembers([]);
      setMembersLoading(false);
      return;
    }

    let cancelled = false;
    setMembersLoading(true);
    const loadMembers = async () => {
      try {
        const { data, error: membersError } = await getSupabaseClient()
          .from('group_members')
          .select('user_id, member_email, joined_at')
          .eq('group_id', activeGroupId)
          .order('joined_at', { ascending: true });

        if (membersError) throw membersError;
        if (!cancelled) setGroupMembers(normalizeMembers(data));
      } catch (membersError) {
        if (!cancelled) {
          setGroupMembers([]);
          setError(`Could not load group members: ${getErrorMessage(membersError)}`);
        }
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    };

    loadMembers();
    return () => {
      cancelled = true;
    };
  }, [activeGroupId, user]);

  useEffect(() => {
    if (!user || !activeGroupId) {
      setExpenses([]);
      setExpensesLoading(false);
      return;
    }

    let cancelled = false;
    setExpensesLoading(true);
    const loadExpenses = async () => {
      try {
        const { data, error: loadError } = await getSupabaseClient()
          .from('expenses')
          .select('*')
          .eq('group_id', activeGroupId);

        if (loadError) throw loadError;
        if (!cancelled) setExpenses((data || []).map(normalizeExpense));
      } catch (loadError) {
        if (!cancelled) {
          setExpenses([]);
          setError(`Could not load group expenses: ${getErrorMessage(loadError)}`);
        }
      } finally {
        if (!cancelled) setExpensesLoading(false);
      }
    };

    loadExpenses();
    return () => {
      cancelled = true;
    };
  }, [activeGroupId, user]);

  useEffect(() => {
    setManualExpense((current) => {
      const validPeople = people.filter((person) => current.splitBetween.includes(person));
      const normalizedSplit = validPeople.length ? validPeople : [...people];
      const nextPaidBy = people.includes(current.paidBy) ? current.paidBy : currentPerson;
      return {
        ...current,
        paidBy: nextPaidBy,
        splitBetween: normalizedSplit,
      };
    });
  }, [currentPerson, people]);

  const balances = useMemo(() => computeBalances(people, expenses), [people, expenses]);
  const settlement = useMemo(() => settleUp(balances), [balances]);
  const total = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  const insertExpense = async (expense) => {
    if (!user || !ownerEmail) throw new Error('Enter your email before adding an expense.');
    if (!activeGroupId) throw new Error('Create or join a group before adding an expense.');

    const { data, error: insertError } = await getSupabaseClient()
      .from('expenses')
      .insert({
        user_id: user.id,
        owner_email: ownerEmail,
        group_id: activeGroupId,
        name: expense.name,
        emoji: expense.emoji || '🧾',
        paid_by: expense.paidBy || currentPerson,
        amount: expense.amount,
        split_between: expense.splitBetween.length ? expense.splitBetween : [currentPerson],
      })
      .select()
      .single();

    if (insertError) throw insertError;

    const savedExpense = normalizeExpense(data);
    setExpenses((current) => [...current, savedExpense]);
    setError('');
  };

  const createGroup = async (event) => {
    event.preventDefault();
    const name = newGroupName.trim();
    if (!name || !user) return;

    setAuthBusy(true);
    setError('');
    try {
      const supabase = getSupabaseClient();
      const { data: { user: currentUser }, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!currentUser) throw new Error('No authenticated Supabase user was found. Reload and continue again.');

      const { data: group, error: createError } = await supabase
        .from('groups')
        .insert({ name, created_by: currentUser.id })
        .select('id, name, join_code, created_at')
        .single();

      if (createError) throw createError;

      const { error: membershipError } = await supabase
        .from('group_members')
        .insert({
          group_id: group.id,
          user_id: currentUser.id,
          member_email: ownerEmail,
        });

      if (membershipError) {
        throw new Error(`Group was created but membership could not be added: ${getErrorMessage(membershipError)}`);
      }

      setNewGroupName('');
      await loadGroups(group.id);
      setShowGroupPicker(false);
    } catch (createError) {
      setError(`Could not create group: ${getErrorMessage(createError)}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const joinGroup = async (event) => {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!code) return;

    setAuthBusy(true);
    setError('');
    try {
      const { data: groupId, error: joinError } = await getSupabaseClient()
        .rpc('join_group', { code });

      if (joinError) throw joinError;
      if (!groupId) throw new Error('The join function did not return a group ID.');

      setJoinCode('');
      await loadGroups(groupId);
      setShowGroupPicker(false);
    } catch (joinError) {
      setError(`Could not join group: ${getErrorMessage(joinError)}`);
    } finally {
      setAuthBusy(false);
    }
  };

  const selectGroup = (groupId) => {
    setActiveGroupId(groupId);
    setExpenses([]);
    setExpensesLoading(Boolean(groupId));
    try {
      localStorage.setItem(STORAGE_KEYS.selectedGroup, groupId);
    } catch (storageError) {
      setError(`Could not save the selected group: ${getErrorMessage(storageError)}`);
    }
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
        paidBy: currentPerson,
        amount: Number(parsedExpense.amount || 0),
        splitBetween: [...people],
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
        .eq('group_id', activeGroupId);

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
              {!showGroupPicker && activeGroup && (
                <>
                  <div style={styles.groupPill}>{activeGroup.name}</div>
                  <button
                    type="button"
                    style={styles.secondaryBtn}
                    onClick={() => setShowGroupPicker(true)}
                  >
                    Back to groups
                  </button>
                </>
              )}
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
                  No email will be sent. This address is unverified and is used to restore group
                  memberships, so anyone entering it can access that email's groups.
                </div>
              </form>
            )}
          </section>
        )}

        {user && (
          <>
        {showGroupPicker || !activeGroupId ? (
        <section style={styles.section}>
          <div style={styles.sectionHeader}>Choose a group</div>
          {groups.length > 0 && (
            <div style={styles.groupList} aria-label="Groups you belong to">
              {groups.map((group) => {
                return (
                  <button
                    key={group.id}
                    type="button"
                    style={styles.groupOption}
                    onClick={() => {
                      selectGroup(group.id);
                      setShowGroupPicker(false);
                    }}
                  >
                    <span style={styles.groupOptionName}>
                      {group.name}
                    </span>
                    <span style={styles.groupCode}>Invite code: <strong>{group.join_code}</strong></span>
                  </button>
                );
              })}
            </div>
          )}
          {groupsLoading && <div style={styles.empty}>Loading groups…</div>}
          {!groupsLoading && groups.length === 0 && (
            <div style={styles.empty}>Create a group or join one with an invite code.</div>
          )}
          <div style={styles.groupForms}>
            <form onSubmit={createGroup} style={styles.groupForm}>
              <input
                style={styles.input}
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                placeholder="New group name"
                aria-label="New group name"
                required
              />
              <button type="submit" style={styles.primaryBtn} disabled={authBusy}>Create</button>
            </form>
            <form onSubmit={joinGroup} style={styles.groupForm}>
              <input
                style={styles.input}
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                placeholder="Group invite code"
                aria-label="Group invite code"
                required
              />
              <button type="submit" style={styles.primaryBtn} disabled={authBusy}>Join</button>
            </form>
          </div>
        </section>
        ) : (
          <>
        <section style={styles.section}>
          <div style={styles.sectionHeader}>People in this group</div>
          <div style={styles.peopleList}>
            {membersLoading
              ? <span style={styles.empty}>Loading members…</span>
              : groupMembers.length
                ? groupMembers.map((member) => (
                  <span key={member.userId} style={styles.personChip}>
                    {member.name}{member.userId === user.id ? ' (you)' : ''}
                  </span>
                ))
                : <span style={styles.empty}>No one has joined this group yet.</span>}
          </div>
        </section>

        <section style={{ ...styles.section, ...styles.entryMethod }}>
          <div style={styles.entryMethodTitle}>Add with natural language</div>
          <div style={styles.entryMethodDescription}>
            Describe the expense in a sentence, for example “Dinner for 1800 split 4 ways.”
          </div>
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

        <div style={styles.methodDivider} aria-hidden="true">
          <span style={styles.methodDividerLine} />
          <strong>OR ENTER DETAILS</strong>
          <span style={styles.methodDividerLine} />
        </div>

        <section style={{ ...styles.section, ...styles.entryMethod }}>
          <div style={styles.entryMethodTitle}>Add manually</div>
          <div style={styles.entryMethodDescription}>
            Enter the expense name, amount, payer, and who will split it.
          </div>
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

        <section style={styles.section}>
          <div style={styles.sectionHeader}>Expenses</div>
          <div style={styles.list}>
            {!expensesLoading && expenses.length === 0 ? (
              <div style={styles.empty}>No expenses yet.</div>
            ) : !expensesLoading && (
              expenses.map((expense) => (
                <div key={expense.id} style={styles.item}>
                  <div style={styles.itemEmoji}>{expense.emoji || '🧾'}</div>
                  <div style={styles.itemMain}>
                    <div style={styles.itemName}>{expense.name}</div>
                    <div style={styles.itemMeta}>paid by {expense.paidBy} · split {expense.splitBetween?.join(', ') || 'n/a'}</div>
                  </div>
                  <div style={styles.itemAmount}>{inr(expense.amount)}</div>
                  <button
                    type="button"
                    style={styles.remove}
                    onClick={() => removeExpense(expense.id)}
                    aria-label={`Remove ${expense.name}`}
                  >
                    ×
                  </button>
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
  entryMethod: { border: '1px solid #dbe2ef', borderRadius: 16, padding: 14, background: '#f8fafc' },
  entryMethodTitle: { color: '#0f172a', fontSize: 15, fontWeight: 800, marginBottom: 4 },
  entryMethodDescription: { color: '#64748b', fontSize: 12, lineHeight: 1.5, marginBottom: 12 },
  methodDivider: { display: 'flex', alignItems: 'center', gap: 10, margin: '-4px 0 14px', color: '#64748b', fontSize: 10, letterSpacing: 0.08 },
  methodDividerLine: { height: 1, flex: 1, background: '#e2e8f0' },
  authFields: { display: 'grid', gap: 10 },
  authNotice: { color: '#64748b', fontSize: 12, lineHeight: 1.5, marginTop: 10 },
  identityWarning: { background: '#fff7ed', border: '1px solid #fed7aa', color: '#9a3412', borderRadius: 12, padding: '10px 12px', fontSize: 12, lineHeight: 1.5, marginBottom: 14 },
  groupList: { display: 'grid', gap: 8, marginBottom: 10 },
  groupOption: { display: 'grid', gap: 4, width: '100%', textAlign: 'left', border: '1px solid #dbe2ef', borderRadius: 12, padding: '10px 12px', background: '#fff', color: '#0f172a', cursor: 'pointer' },
  groupOptionActive: { display: 'grid', gap: 4, width: '100%', textAlign: 'left', border: '1px solid #93c5fd', borderRadius: 12, padding: '10px 12px', background: '#eff6ff', color: '#0f2c7a', cursor: 'pointer' },
  groupOptionName: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 700, fontSize: 14 },
  currentGroup: { color: '#1d4ed8', fontWeight: 700, fontSize: 11, textTransform: 'uppercase' },
  groupCode: { color: '#475569', fontSize: 12 },
  groupForms: { display: 'grid', gap: 8, marginTop: 10 },
  groupForm: { display: 'flex', gap: 8 },
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
