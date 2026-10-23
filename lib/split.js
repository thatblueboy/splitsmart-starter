export function computeBalances(people, expenses) {
  const balances = Object.fromEntries(people.map((person) => [person, 0]));

  for (const expense of expenses) {
    const paidBy = expense?.paidBy;
    const amount = Number(expense?.amount || 0);
    const splitBetween = Array.isArray(expense?.splitBetween) && expense.splitBetween.length
      ? expense.splitBetween
      : paidBy && balances[paidBy] !== undefined
        ? [paidBy]
        : [];

    if (paidBy && balances[paidBy] !== undefined) {
      balances[paidBy] += amount;
    }

    if (!splitBetween.length) continue;

    const share = amount / splitBetween.length;
    for (const person of splitBetween) {
      if (balances[person] !== undefined) {
        balances[person] -= share;
      }
    }
  }

  return balances;
}

export function settleUp(balances) {
  const entries = Object.entries(balances)
    .filter(([, value]) => Math.abs(Number(value)) > 0.0001)
    .map(([name, value]) => [name, Number(value)]);

  const creditors = entries
    .filter(([, value]) => value > 0)
    .map(([name, value]) => [name, value])
    .sort((a, b) => b[1] - a[1]);

  const debtors = entries
    .filter(([, value]) => value < 0)
    .map(([name, value]) => [name, value])
    .sort((a, b) => a[1] - b[1]);

  const transactions = [];

  while (creditors.length && debtors.length) {
    const [creditorName, creditorValue] = creditors[0];
    const [debtorName, debtorValue] = debtors[0];

    const amount = Math.min(creditorValue, Math.abs(debtorValue));
    const rounded = Number(amount.toFixed(2));

    transactions.push({
      from: debtorName,
      to: creditorName,
      amount: rounded,
    });

    creditors[0][1] = Number((creditorValue - amount).toFixed(2));
    debtors[0][1] = Number((debtorValue + amount).toFixed(2));

    if (Math.abs(creditors[0][1]) < 0.0001) creditors.shift();
    if (Math.abs(debtors[0][1]) < 0.0001) debtors.shift();
  }

  return transactions;
}
