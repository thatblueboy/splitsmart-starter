import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBalances, settleUp } from './split.js';

test('computeBalances totals paid and net owed', () => {
  const people = ['Aisha', 'Raj', 'Priya'];
  const expenses = [
    { paidBy: 'Aisha', amount: 1200, splitBetween: ['Aisha', 'Raj', 'Priya'] },
    { paidBy: 'Raj', amount: 600, splitBetween: ['Aisha', 'Raj', 'Priya'] },
  ];

  assert.deepEqual(computeBalances(people, expenses), {
    Aisha: 600,
    Raj: 0,
    Priya: -600,
  });
});

test('settleUp creates minimal transfers', () => {
  const balances = {
    Aisha: 600,
    Raj: 0,
    Priya: -600,
  };

  assert.deepEqual(settleUp(balances), [
    { from: 'Priya', to: 'Aisha', amount: 600 },
  ]);
});
