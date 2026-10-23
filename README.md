# SplitSmart — starter

The starter app for the **deepEntra Academy · Build & Ship It** course. It's a basic
expense-splitter (one group, a list of expenses, a running total). Over the course you'll
give it an **AI brain** (Hour 3) and a **real database with logins** (Hour 5), then polish
and ship it to your own domain (Hours 7–8).

This is the **"My Group"** app you see on the course slide — the basic version you deploy in
Hour 2, before you add the magic.

<p align="center"><b>SplitSmart · My Group</b><br/>🍽️ Dinner — paid by Aisha — ₹1,800<br/>🚕 Cab — paid by Raj — ₹400<br/><b>Total ₹2,200</b></p>

---

## Hour 2 — get it on your laptop & ship it

### 1. Fork this repo
Click **Fork** (top-right) → you get your own copy under your GitHub account.

### 2. Clone your fork and open it
Ask your AI assistant: *"Clone my fork and open it in VS Code."* Or, in a terminal:

```bash
git clone https://github.com/<your-username>/splitsmart-starter.git
cd splitsmart-starter
```

### 3. Install the app's parts
```bash
npm install
```

### 4. Run it
```bash
npm run dev
```
Open **http://localhost:3000** — SplitSmart is alive on your laptop. 🎉

### 5. Make one tiny change
Ask your AI: *"Change the title to 'Raj's SplitSmart' and keep the button deepEntra blue."*
Save → the browser updates instantly. Then snapshot it:

```bash
git add -A
git commit -m "My first change"
git push
```

### 6. Put it on the internet — Vercel 🚀

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/maheshbaxi/splitsmart-starter)

- Import your fork into **[Vercel](https://vercel.com/new)** (it finds your GitHub repo).
- Click **Deploy** → ~1 minute → you get a live `…vercel.app` link. Open it on your phone and
  text it to a friend.
- From now on, **every `git push` redeploys your live site automatically.**

> 🔒 **Keep your API keys private** — never paste them into a screenshot, a commit, or a shared
> doc. Secrets go in Vercel's **Environment Variables** (and in `.env.local` locally, which is
> git-ignored).

## Supabase expenses

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in `.env.local` for local
development and in the Vercel project’s Environment Variables for deployment. The app reads
and writes expenses in the `public.expenses` table. Enable anonymous sign-ins in Supabase Auth.
The app asks for an email address, then creates an anonymous session immediately; it does not
send an email or require a password. Expenses are looked up by the entered email, so entering
the same address in another browser shows the same list. This address is not verified: anyone
who enters it can view, add, change, or delete expenses associated with it. Do not use this
approach for sensitive data.

For a new database, create the table and email-keyed access policies:

```sql
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_email text not null,
  name text not null,
  emoji text not null default '🧾',
  paid_by text not null,
  amount numeric not null,
  split_between text[] not null default '{}'
);

alter table public.expenses enable row level security;

create policy "Email users can read expenses"
  on public.expenses for select to authenticated
  using (lower(owner_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email')));

create policy "Email users can add expenses"
  on public.expenses for insert to authenticated
  with check (lower(owner_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email')));

create policy "Email users can update expenses"
  on public.expenses for update to authenticated
  using (lower(owner_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email')))
  with check (lower(owner_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email')));

create policy "Email users can delete expenses"
  on public.expenses for delete to authenticated
  using (lower(owner_email) = lower((select auth.jwt() -> 'user_metadata' ->> 'unverified_email')));
```

For an existing expenses table, add `owner_email`, then backfill it from the existing
auth user's metadata (or `auth.users.email` for verified accounts) before making it `not null`:

```sql
alter table public.expenses add column if not exists owner_email text;

update public.expenses as expense
set owner_email = lower(coalesce(
  auth_user.raw_user_meta_data ->> 'unverified_email',
  auth_user.email
))
from auth.users as auth_user
where expense.user_id = auth_user.id
  and expense.owner_email is null;

select count(*) as expenses_without_owner_email
from public.expenses
where owner_email is null;

-- After resolving any rows returned above:
alter table public.expenses alter column owner_email set not null;

drop policy if exists "Users can read their expenses" on public.expenses;
drop policy if exists "Users can add their expenses" on public.expenses;
drop policy if exists "Users can update their expenses" on public.expenses;
drop policy if exists "Users can delete their expenses" on public.expenses;
```

Resolve any remaining rows before setting `owner_email` to `not null`, then create the
email-keyed policies above. Existing policies based on `user_id = auth.uid()` would prevent
access from a different anonymous session using the same email.

## Hour 6 — private groups

Run the Hour 6 groups SQL from the course after the expense table is configured. It creates
`groups`, `group_members`, `join_group(code)`, and adds `group_id` to expenses. This app then
lets you create and switch groups, share a group's join code, join by code, and view/add/remove
expenses only in the active group.

After applying the course SQL, run [`supabase/schema_hour6_identity.sql`](./supabase/schema_hour6_identity.sql)
in the Supabase SQL Editor. It adds the email label to memberships, backfills existing memberships
from Supabase auth metadata, creates the membership-recovery RPC and supporting policies, and
updates historical "You" expense labels where the owner email can be matched. It is safe to run
again. The app calls `restore_email_group_memberships()` at sign-in, so groups are restored when
the same email is entered in a new anonymous session or browser.

Existing expenses with `group_id is null` won't appear in a group. After creating a group, copy
its UUID from the `groups` table and assign only the intended legacy rows in the SQL Editor,
for example:

```sql
update expenses
set group_id = 'YOUR-GROUP-UUID'
where group_id is null
  and owner_email = lower('you@example.com');
```

The group members list represents people who belong to the group, not who's currently online.
Names are inferred from the email local part (`jane.doe@example.com` becomes "Jane Doe"), and
the current member is marked "(you)" and used as the payer for new expenses. Email addresses
are not verified: anyone entering another person's email can claim their memberships and view
that person's group data. Use only with this limitation understood; verified authentication is
needed before treating email as a secure identity.

---

## What's inside

| | |
| --- | --- |
| **Framework** | [Next.js](https://nextjs.org) (App Router) + React |
| **The app** | `app/page.js` — the whole SplitSmart UI (one file to start) |
| **Styles** | `app/globals.css` + inline styles (deepEntra blue) |
| **Data** | Expenses, groups, and group members are stored in Supabase |

## Scripts
```bash
npm run dev     # local dev → http://localhost:3000
npm run build   # production build
npm run start   # run the production build
```

---

Made for **deepEntra Academy** · [academy.deepentra.ai](https://academy.deepentra.ai)
