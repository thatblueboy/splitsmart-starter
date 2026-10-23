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
and writes expenses in the `public.expenses` table. Enable **Email** as a Supabase Auth provider,
and add your local and deployed app URLs to Supabase Auth's allowed redirect URLs. The app
requests an email magic link and returns users to the app's current origin.

For a new database, create the table and per-user access policies:

```sql
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  emoji text not null default '🧾',
  paid_by text not null,
  amount numeric not null,
  split_between text[] not null default '{}'
);

alter table public.expenses enable row level security;

create policy "Users can read their expenses"
  on public.expenses for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can add their expenses"
  on public.expenses for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their expenses"
  on public.expenses for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their expenses"
  on public.expenses for delete to authenticated
  using ((select auth.uid()) = user_id);
```

For an existing expenses table, add and backfill `user_id` for existing rows before making it
`not null`, then enable row-level security and create the policies above. Expenses are only
queried and modified for the signed-in user's ID.

---

## What's inside

| | |
| --- | --- |
| **Framework** | [Next.js](https://nextjs.org) (App Router) + React |
| **The app** | `app/page.js` — the whole SplitSmart UI (one file to start) |
| **Styles** | `app/globals.css` + inline styles (deepEntra blue) |
| **Data** | Expenses are stored in Supabase; the people list remains in this browser's `localStorage` |

## Scripts
```bash
npm run dev     # local dev → http://localhost:3000
npm run build   # production build
npm run start   # run the production build
```

---

Made for **deepEntra Academy** · [academy.deepentra.ai](https://academy.deepentra.ai)
